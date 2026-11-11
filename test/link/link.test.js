/**
 * Task 13 · link/link.js 装配与断链清理 — 单元测试（TDD）
 *
 * 覆盖 docs/04 Task 13 的 9 条验收：
 *   1. 断链先清 frame-io（队列 reject / acks clear / msgIds releaseAll /
 *      reassembler clear），再 emit 一次 disconnected（顺序断言）。
 *   2. Link 不持有业务状态，disconnected 一定发出（含 stop() 主动断开）。
 *   3. 重连必须重新握手：ready=false、info 重置。
 *   4. 意外断开按 [1000,2000,5000,10000,20000,30000]ms 退避重连；主动 stop() 不重连。
 *   5. sendAudio 走 AUDIO 通道，不占消息号、不登记 ACK。
 *   6. 未 ready 时业务 send() 抛 WireError(NOT_CONNECTED)，白名单放行。
 *   7. T9 回归：断链 releaseAll 后新连接立刻复用旧号。
 *
 * 全部用注入的假 transport + 假时钟，不依赖 ble 层真实实现。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { Link, LEGAL_TRANSITIONS, assertLegalTransition } from '../../src/link/link.js';
import * as linkIndex from '../../src/link/index.js';
import { EventEmitter } from 'node:events';
import { WireError, ERR } from '../../src/wire/errors.js';
import { encodeFrames, decodeHeader, frameBody } from '../../src/wire/frame.js';
import { MSG, CHANNEL_CONTROL, CHANNEL_AUDIO, FLAG_ACK_REQ } from '../../src/wire/constants.js';
import {
  MsgIdAllocator,
} from '../../src/wire/msgid.js';
import { PendingAcks } from '../../src/wire/acks.js';
import { Reassembler } from '../../src/wire/reassembler.js';


// ---------------------------------------------------------------------------
// t48-F20：suite 级兜底
// 每个用例都有 per-test 超时；若某个用例因遗留 worker/timer 永不 settle，
// 看门狗会在超时后打印明确原因并强制 exit 1，避免整个文件「挂住」。
// 所有 makeLink() 创建的 Link 都登记下来，after() 统一 stop，确保失败用例
// 留下的在飞操作不会拖住测试进程。
// ---------------------------------------------------------------------------
const PER_TEST_TIMEOUT_MS = 12_000;
const CREATED_LINKS = new Set();
/** 仍未结束的用例；after() 若发现残留，说明有等待永远不会 settle。 */
const OPEN_TESTS = new Set();

function boundedTest(name, fn) {
  test(name, { timeout: PER_TEST_TIMEOUT_MS }, async (t) => {
    OPEN_TESTS.add(name);
    const watchdog = setTimeout(() => {
      console.error(
        `[t48] 测试「${name}」超过 ${PER_TEST_TIMEOUT_MS + 1_000}ms 仍未结束：` +
          '仍有未 settle 的等待/pending worker，强制以失败退出',
      );
      process.exit(1);
    }, PER_TEST_TIMEOUT_MS + 1_000);
    try {
      return await fn(t);
    } finally {
      OPEN_TESTS.delete(name);
      clearTimeout(watchdog);
    }
  });
}

after(async () => {
  // suite 级兜底：正常路径下所有用例都已结束；若仍有登记项，说明某个等待
  // 永远不会 settle（挂住）。主动失败，让 CI 得到 exit 1 而不是超时被杀。
  if (OPEN_TESTS.size > 0) {
    throw new Error(`[t48] 仍有未 settle 的用例：${[...OPEN_TESTS].join(' / ')}`);
  }
  for (const { link } of CREATED_LINKS) {
    await Promise.race([
      Promise.resolve(link.stop('suite-cleanup')).catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 50)),
    ]);
  }
  CREATED_LINKS.clear();
});

const JSON_ENCODER = new TextEncoder();

// ---------------------------------------------------------------------------
// 测试基建
// ---------------------------------------------------------------------------

/** 假时钟：setTimer/clearTimer/now 三件套，advance 触发到期回调。 */
function makeClock() {
  let now = 0;
  const timers = new Map();
  let seq = 0;
  return {
    now: () => now,
    setTimer(fn, ms) {
      const id = ++seq;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let nextAt = null;
        let nextId = null;
        for (const [id, t] of timers) {
          if (t.at <= end && (nextAt === null || t.at < nextAt)) {
            nextAt = t.at;
            nextId = id;
          }
        }
        if (nextId === null) break;
        const t = timers.get(nextId);
        timers.delete(nextId);
        now = t.at;
        t.fn();
      }
      now = end;
    },
    pendingCount() {
      return timers.size;
    },
  };
}

/** 假传输层：满足 FrameIO / Transport 形状，可注入 connect 失败次数。 */
class FakeTransport extends EventEmitter {
  constructor() {
    super();
    this.state = 'idle';
    this.sent = [];
    this.connectCalls = 0;
    this.connectFailures = 0;
    this.stopped = false;
  }

  async start() {
    this.state = 'scanning';
  }

  async stop() {
    this.stopped = true;
    this.state = 'idle';
  }

  async restartScan() {
    this.state = 'scanning';
  }

  async connect() {
    this.connectCalls += 1;
    if (this.connectFailures > 0) {
      this.connectFailures -= 1;
      this.state = 'failed';
      throw new Error('connect failed (injected)');
    }
    this.state = 'connected';
    // 模拟真设备（MockTransport 行为）：connect 成功后主动发 hello。
    // 用宏任务（晚于 buildPipeline 挂监听），由用例通过 onConnect 注入。
    if (this.onConnect) setTimeout(() => this.onConnect(), 0);
  }

  async disconnect() {
    this.emit('disconnected', { unexpected: false, reason: '主动断开' });
    this.state = 'scanning';
  }

  async send(frame) {
    this.sent.push(Buffer.from(frame));
  }
}

/** 假信任表：纯内存。 */
function makeStore(seed = {}) {
  const table = { ...seed };
  return {
    table,
    load: async () => ({ ...table }),
    save: async (next) => {
      for (const k of Object.keys(table)) delete table[k];
      Object.assign(table, next);
    },
  };
}

/** 构造设备 hello 帧（单帧，CONTROL 通道）。 */
function helloFrame(extra = {}, msgId = 1) {
  const obj = {
    type: MSG.HELLO,
    proto: 2,
    caps: 63,
    maxPayload: 8192,
    fw: '1.0.0-test',
    ...extra,
  };
  return encodeFrames({
    msgId,
    payload: JSON_ENCODER.encode(JSON.stringify(obj)),
    chunkPayload: 510,
    channel: CHANNEL_CONTROL,
  })[0];
}

/** 构造设备侧任意 JSON 消息帧。 */
function deviceMsg(obj, msgId = 2, channel = CHANNEL_CONTROL) {
  return encodeFrames({
    msgId,
    payload: JSON_ENCODER.encode(JSON.stringify(obj)),
    chunkPayload: 510,
    channel,
  })[0];
}

/** 默认 Link 配置：注入时钟/存储/拆解件。 */
function makeLink({
  transport = new FakeTransport(),
  clock = makeClock(),
  store = makeStore({ 'test-dev': 'tok-abc' }),
  inject = {},
} = {}) {
  const link = new Link({
    transport,
    store,
    chunkPayload: 510,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...inject,
  });
  CREATED_LINKS.add({ link, transport });
  return { link, transport, clock, store };
}

/** 启动并完成握手（设备发带 token 的 hello）。 */
async function connectAndReady({ link, transport }, helloExtra = {}) {
  await link.start();
  transport.emit('data', helloFrame({ deviceId: 'test-dev', token: 'tok-abc', ...helloExtra }), {
    channel: 'control',
  });
  await waitFor(() => link.ready);
}

function waitFor(fn, timeoutMs = 2000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let v;
      try {
        v = fn();
      } catch (e) {
        reject(e);
        return;
      }
      if (v) resolve(v);
      else if (Date.now() - started > timeoutMs) reject(new Error('waitFor 超时'));
      else setTimeout(tick, 5);
    };
    tick();
  });
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('M2 · Link 启动与握手', () => {
  boundedTest('start() 后依次进入 scanning→connecting→connected，设备 hello 后 ready', async () => {
    const { link, transport } = makeLink();
    const states = [];
    link.on('state', (s) => states.push(s));

    await link.start();
    assert.equal(link.state, 'connected');
    assert.equal(link.ready, false);

    transport.emit('data', helloFrame({ deviceId: 'test-dev', token: 'tok-abc' }), {
      channel: 'control',
    });
    await waitFor(() => link.ready);

    assert.equal(link.ready, true);
    assert.deepEqual(states, ['scanning', 'connecting', 'connected']);
    assert.deepEqual(link.info, {
      deviceId: 'test-dev',
      name: null, // Handshake 仅在 deviceName 注入或 hello.name 时有 name
      firmware: '1.0.0-test',
      maxPayload: 8160, // min(8192, 16×510=8160, 8160)
      maxChunks: 16,
      capabilities: 63,
      paired: true,
    });
    void transport;
  });

  boundedTest('重复 start() 幂等：不重复 connect', async () => {
    const { link, transport } = makeLink();
    await link.start();
    await link.start();
    assert.equal(transport.connectCalls, 1);
  });
});

describe('M2 · 断链清理顺序（验收 1）', () => {
  boundedTest('disconnected 事件到达时：队列已 reject、acks 已 clear、msgIds 已 releaseAll、reassembler 已 clear', async () => {
    const msgIds = new MsgIdAllocator();
    const acks = new PendingAcks({ send: () => {} });
    const reassembler = new Reassembler({ maxMessageBytes: 8160 });
    const { link, transport } = makeLink({ inject: { msgIds, acks, reassembler } });
    await connectAndReady({ link, transport });

    // 制造"脏状态"：一条待确认消息 + 一个手动占用的消息号 + reassembler 半条
    const pending = link.send('session.state', { n: 1 });
    const rejections = [];
    pending.catch((e) => rejections.push(e));
    // sendMessage 是异步管线（enqueue→发送→track），等它真正入册
    await waitFor(() => acks.size === 1);
    msgIds.allocate(); // 手动再占一个号
    assert.ok(msgIds.size >= 2);

    let atEvent = null;
    let eventCount = 0;
    link.on('disconnected', () => {
      eventCount += 1;
      atEvent = {
        msgIdSize: msgIds.size,
        ackSize: acks.size,
        rejected: rejections.length,
        rejectionCode: rejections[0]?.code,
        ready: link.ready,
        info: link.info,
      };
    });

    transport.emit('disconnected', { unexpected: true, reason: '链路丢失' });
    await waitFor(() => eventCount > 0);

    // 事件到达时清理必须已经完成（顺序不能反）。
    // rejected 的 promise catch 回调是微任务，此刻还未执行——在事件后单独断言。
    assert.deepEqual(
      atEvent,
      {
        msgIdSize: 0,
        ackSize: 0,
        rejected: 0,
        rejectionCode: undefined,
        ready: false,
        info: null,
      },
      'disconnected 事件到达时 frame-io 尚未清理干净',
    );
    await assert.rejects(() => pending, (e) => e instanceof WireError);
    assert.equal(rejections.length, 1, '在途 ack 等待必须被 reject');
    assert.match(rejections[0].code, /^(ACK_TIMEOUT|NOT_CONNECTED)$/);
    assert.equal(eventCount, 1, '断链只应广播一次 disconnected');
    assert.equal(link.state, 'reconnecting');
  });

  boundedTest('reassembler.clear 生效：断链后注入的 reassembler 不残留半条消息', async () => {
    const reassembler = new Reassembler({ maxMessageBytes: 8160 });
    const { link, transport } = makeLink({ inject: { reassembler } });
    await connectAndReady({ link, transport });

    // 喂半个分片给 FrameIO（经 transport data 事件）→ reassembler 持有 pending
    const frames = encodeFrames({
      msgId: 9,
      payload: JSON_ENCODER.encode(JSON.stringify({ type: 'x', a: 1 })),
      chunkPayload: 4,
      channel: CHANNEL_CONTROL,
    });
    transport.emit('data', frames[0], { channel: 'control' });
    assert.ok(reassembler.size >= 1);

    let atEvent = -1;
    link.on('disconnected', () => {
      atEvent = reassembler.size;
    });
    transport.emit('disconnected', { unexpected: true, reason: 'x' });
    await waitFor(() => atEvent >= 0);
    assert.equal(atEvent, 0, '断链时 reassembler 未清空');
  });
});

describe('M2 · Link 不持有业务状态 + stop() 也发 disconnected（验收 2）', () => {
  boundedTest('stop() 主动断开：disconnected{unexpected:false} 恰好一次，不重连', async () => {
    const { link, transport, clock } = makeLink();
    await connectAndReady({ link, transport });

    const events = [];
    link.on('disconnected', (p) => events.push(p));

    await link.stop('用户关闭');
    assert.equal(link.state, 'idle');
    assert.equal(link.ready, false);
    assert.equal(transport.stopped, true);
    assert.equal(events.length, 1);
    assert.equal(events[0].unexpected, false);
    assert.equal(events[0].reason, '用户关闭');

    // 不重连：推进 60 秒也没有新 connect
    clock.advance(60_000);
    assert.equal(transport.connectCalls, 1);
    assert.equal(link.state, 'idle');
  });

  // 真 transport（src/ble/transport.js:200-203/:214）在执行 stop/restartScan 时
  // 自己会 emit disconnected；Link 若再直接 emit 就会双发。FakeTransport 默认
  // 静默，这里显式模拟真 transport 的断链事件，锁死“恰好一次”的契约。
  boundedTest('stop()：transport 自己也 emit disconnected 时不得双发（只广播一次）', async () => {
    const { link, transport } = makeLink();
    await connectAndReady({ link, transport });
    transport.stop = async (reason) => {
      transport.emit('disconnected', { unexpected: false, reason });
      transport.stopped = true;
      transport.state = 'idle';
    };

    const events = [];
    link.on('disconnected', (p) => events.push(p));

    await link.stop('用户关闭');
    assert.deepEqual(
      events,
      [{ unexpected: false, reason: '用户关闭' }],
      `主动 stop 只应广播一次 disconnected（实际 ${JSON.stringify(events)}）`,
    );
    assert.equal(link.state, 'idle');
  });

  boundedTest('restartScan()：transport 自己也 emit disconnected 时不得双发（只广播一次）', async () => {
    const { link, transport } = makeLink();
    await connectAndReady({ link, transport });
    transport.restartScan = async (reason) => {
      transport.emit('disconnected', { unexpected: false, reason });
      transport.state = 'scanning';
    };

    const events = [];
    link.on('disconnected', (p) => events.push(p));

    await link.restartScan('切换设备');
    assert.deepEqual(
      events,
      [{ unexpected: false, reason: '切换设备' }],
      `restartScan 只应广播一次 disconnected（实际 ${JSON.stringify(events)}）`,
    );
    assert.equal(link.state, 'scanning');
    assert.equal(link.ready, false);
  });

  boundedTest('Link 只广播链路事件，不替上层清理 pending（无业务字段挂在本层）', async () => {
    const { link, transport } = makeLink();
    await connectAndReady({ link, transport });
    const ownKeys = Object.keys(link).filter(
      (k) => !['domain', '_events', '_eventsCount', '_maxListeners'].includes(k),
    );
    for (const k of ownKeys) {
      assert.ok(
        !/approval|question|asr|session|pending/i.test(k),
        `Link 不应持有业务状态字段：${k}`,
      );
    }
    void transport;
  });
});

describe('M2 · 重连必须重新握手（验收 3）', () => {
  boundedTest('意外断开后 ready 曾为 false、info 被重置；重连后重新握手产生全新 info', async () => {
    const { link, transport, clock } = makeLink();
    await connectAndReady({ link, transport });
    const firstInfo = link.info;

    const observations = [];
    link.on('disconnected', () => {
      observations.push({ ready: link.ready, info: link.info, state: link.state });
    });

    transport.emit('disconnected', { unexpected: true, reason: '掉线' });
    assert.equal(link.ready, false);
    assert.equal(link.info, null);

    clock.advance(1000); // 第一次退避到期 → 重连
    await waitFor(() => transport.connectCalls === 2);
    assert.equal(link.state, 'connected');
    assert.equal(link.ready, false, '重连后未握手前必须 not ready');

    transport.emit('data', helloFrame({ deviceId: 'test-dev', token: 'tok-abc' }), {
      channel: 'control',
    });
    await waitFor(() => link.ready);

    assert.notEqual(link.info, firstInfo, 'info 必须是新对象，不沿用旧协商结果');
    assert.deepEqual(observations, [
      { ready: false, info: null, state: 'reconnecting' },
    ]);
  });
});

describe('M2 · 退避重连（验收 4）', () => {
  boundedTest('意外断开按 [1000,2000,5000,…] 退避重试；连接失败继续退避', async () => {
    const { link, transport, clock } = makeLink();
    await connectAndReady({ link, transport });
    assert.equal(transport.connectCalls, 1);
    transport.connectFailures = 2; // 首连成功后再注入：前两次重连失败，第三次成功

    transport.emit('disconnected', { unexpected: true, reason: '掉线' });
    assert.equal(link.state, 'reconnecting');

    clock.advance(999);
    assert.equal(transport.connectCalls, 1, '1000ms 退避未到不应重连');
    clock.advance(1);
    // t43：意图 + 单 worker 模型下，timer 到期只是把「reconnect 意图」写回
    // worker；connect 发生在 worker 的下一轮（微任务），不再像旧实现那样在
    // 假时钟 advance 的同步栈里就调用 transport.connect。等它发生再断言，
    // 强度不变（仍要求恰好 2 次）。
    await waitFor(() => transport.connectCalls === 2, '第一次退避 1000ms 应触发重连');
    // 重连失败链是 async（openSession 抛错→catch→再排定），等它落回 reconnecting
    await waitFor(() => link.state === 'reconnecting');

    clock.advance(1999);
    assert.equal(transport.connectCalls, 2);
    clock.advance(1);
    await waitFor(() => transport.connectCalls === 3, '第二次退避 2000ms 应触发重连');
    await waitFor(() => link.state === 'reconnecting');

    clock.advance(4999);
    assert.equal(transport.connectCalls, 3);
    clock.advance(1);
    await waitFor(() => transport.connectCalls === 4, '第三次退避 5000ms 应触发重连（成功）');
    // openSession 是 async：connect 成功后还要在微任务里重建 FrameIO/Handshake，
    // 等 state 落到 connected 再发 hello（否则 hello 落在旧管线上被丢弃）。
    await waitFor(() => link.state === 'connected');

    transport.emit('data', helloFrame({ deviceId: 'test-dev', token: 'tok-abc' }), {
      channel: 'control',
    });
    await waitFor(() => link.ready);
    assert.equal(link.state, 'connected');
  });

  boundedTest('重连成功（ready）后退避序号复位：下次断开从 1000ms 重新开始', async () => {
    const { link, transport, clock } = makeLink();
    await connectAndReady({ link, transport });

    transport.emit('disconnected', { unexpected: true, reason: '第一次' });
    clock.advance(1000);
    await waitFor(() => transport.connectCalls === 2);
    transport.emit('data', helloFrame(), { channel: 'control' });
    await waitFor(() => link.ready);

    transport.emit('disconnected', { unexpected: true, reason: '第二次' });
    clock.advance(999);
    assert.equal(transport.connectCalls, 2);
    clock.advance(1);
    await waitFor(() => transport.connectCalls === 3, '退避序号应复位，1000ms 即重连');
  });
});

describe('M2 · sendAudio 不占消息号、不登记 ACK（验收 5）', () => {
  boundedTest('sendAudio 切分走 AUDIO 通道；msgIds 占用数不变；acks 不新增', async () => {
    const msgIds = new MsgIdAllocator();
    const acks = new PendingAcks({ send: () => {} });
    const { link, transport } = makeLink({ inject: { msgIds, acks } });
    await connectAndReady({ link, transport });

    const sizeBefore = msgIds.size;
    const acksBefore = acks.size;
    const audio = new Uint8Array(1200).fill(0x5a);
    await link.sendAudio(audio, 'req-1');

    assert.equal(msgIds.size, sizeBefore, 'sendAudio 不得分配消息号');
    assert.equal(acks.size, acksBefore, 'sendAudio 不得登记 ACK');

    const audioFrames = transport.sent.filter(
      (f) => decodeHeader(f).channel === CHANNEL_AUDIO,
    );
    const expected = Math.ceil(1200 / 510);
    assert.equal(audioFrames.length, expected, '应按 chunkPayload=510 切分');
    for (const f of audioFrames) {
      assert.equal(decodeHeader(f).flags & FLAG_ACK_REQ, 0, '音频帧不带 ACK_REQ');
    }
    const bytes = Buffer.concat(audioFrames.map((f) => Buffer.from(frameBody(f))));
    assert.ok(bytes.equals(Buffer.from(audio)), '音频字节应完整发出');
  });
});

describe('M2 · 未 ready 时 send() 白名单语义（验收 6）', () => {
  boundedTest('业务消息抛 WireError(NOT_CONNECTED)；白名单 ping 放行', async () => {
    const { link, transport } = makeLink();
    await link.start();
    assert.equal(link.ready, false);

    await assert.rejects(
      () => link.send('session.state', { x: 1 }),
      (e) => e instanceof WireError && e.code === ERR.NOT_CONNECTED,
    );

    // 白名单：链路层消息放行（用 ack:false，否则要等对端确认）
    await link.send(MSG.PING, { seq: 1 }, { ack: false });
    const pingFrames = transport.sent.filter((f) => {
      try {
        return JSON.parse(frameBody(f).toString()).type === 'ping';
      } catch {
        return false;
      }
    });
    assert.equal(pingFrames.length, 1, '白名单消息应放行发出');
  });
});

describe('M2 · T9 号段泄漏回归（验收 7）', () => {
  boundedTest('断链 releaseAll 后，新连接立刻能分配到断链前占用的号', async () => {
    const msgIds = new MsgIdAllocator();
    const { link, transport, clock } = makeLink({ inject: { msgIds } });
    await connectAndReady({ link, transport });

    // 占掉一批号（模拟 v1 泄漏场景：发送在途/gap 未释放）
    const held = [msgIds.allocate(), msgIds.allocate(), msgIds.allocate()];
    assert.equal(msgIds.size, 3);

    transport.emit('disconnected', { unexpected: true, reason: '断链' });
    await waitFor(() => link.state === 'reconnecting');
    assert.equal(msgIds.size, 0, '断链必须 releaseAll');

    clock.advance(1000);
    await waitFor(() => transport.connectCalls === 2);
    transport.emit('data', helloFrame(), { channel: 'control' });
    await waitFor(() => link.ready);

    const again = msgIds.allocate();
    assert.ok(
      held.includes(again),
      `新连接应立刻复用断链前的号：got ${again}, held=${held.join(',')}`,
    );
  });
});

describe('M2 · 消息路由与保活装配', () => {
  boundedTest('设备 ping → keepalive 自动回 pong；ready 后业务消息透传给上层', async () => {
    const { link, transport } = makeLink();
    const messages = [];
    link.on('message', (m) => messages.push(m));
    await connectAndReady({ link, transport });

    transport.emit('data', deviceMsg({ type: 'ping', seq: 5 }, 3), { channel: 'control' });
    await waitFor(() =>
      transport.sent.some((f) => {
        try {
          const o = JSON.parse(frameBody(f).toString());
          return o.type === 'pong' && o.seq === 5;
        } catch {
          return false;
        }
      }),
    );

    transport.emit('data', deviceMsg({ type: 'notice', text: 'hi' }, 4), {
      channel: 'control',
    });
    await waitFor(() => messages.length > 0);
    assert.equal(messages[0].type, 'notice');
    assert.equal(messages[0].payload.text, 'hi');
  });

  boundedTest('设备音频帧从 data 事件分流为 audio 事件，绝不进 reassembler（C6）', async () => {
    const reassembler = new Reassembler({ maxMessageBytes: 8160 });
    const { link, transport } = makeLink({ inject: { reassembler } });
    const audioEvents = [];
    link.on('audio', (a) => audioEvents.push(a));
    await connectAndReady({ link, transport });

    transport.emit(
      'data',
      encodeFrames({
        msgId: 0,
        payload: new Uint8Array([1, 2, 3, 4]),
        chunkPayload: 510,
        channel: CHANNEL_AUDIO,
      })[0],
      { channel: 'audio' },
    );
    await waitFor(() => audioEvents.length > 0);
    assert.deepEqual([...audioEvents[0].bytes], [1, 2, 3, 4]);
    assert.equal(reassembler.size, 0, 'AUDIO 帧不得进入 reassembler');
  });
});

describe('M2 · link/index.js 桶导出', () => {
  boundedTest('index.js 导出 Link 与三个子模块', () => {
    assert.equal(linkIndex.Link, Link);
    assert.ok(typeof linkIndex.FrameIO === 'function');
    assert.ok(typeof linkIndex.Handshake === 'function');
    assert.ok(typeof linkIndex.Keepalive === 'function');
  });
});

// ---------------------------------------------------------------------------
// T16 · 两个阻塞缺陷回归：判死 unhandledRejection + 判死重连卡死
// ---------------------------------------------------------------------------

describe('T16 · 缺陷①：判死不得产生 unhandledRejection', () => {
  boundedTest('判死路径的 keepalive ping 发送失败必须被 .catch 兜底（计数为 0）', async () => {
    const rejections = [];
    const onRejection = (e) => rejections.push(e);
    process.on('unhandledRejection', onRejection);
    try {
      const { link, transport, clock } = makeLink({
        inject: { backoffMs: [10] },
      });
      await connectAndReady({ link, transport });

      // 判死：advance 30000，tick@30000 判死并 dispose frameIO，
      // 判死前各 tick 发出的 in-flight ping 任务被 reject。
      clock.advance(30000);
      await waitFor(() => link.state === 'reconnecting' || link.state === 'connected');
      // 给 unhandledRejection 事件（宏任务）留出触发窗口
      await new Promise((r) => setTimeout(r, 50));
      const mine = rejections.filter(
        (e) => e instanceof WireError && e.code === ERR.NOT_CONNECTED,
      );
      assert.equal(
        mine.length,
        0,
        `判死产生了 ${mine.length} 条未兜底的 NOT_CONNECTED rejection（缺陷①未修复）`,
      );
      await link.stop();
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });
});

describe('T16 · 缺陷②：判死 → 重连 → 重新握手成功（readyCount 1 → 2）', () => {
  boundedTest('判死后排定的重连必须真正重跑 connect 与握手，ready 事件再次触发', async () => {
    const { link, transport, clock } = makeLink({
      inject: { backoffMs: [10] },
    });
    let readyCount = 0;
    link.on('ready', () => readyCount += 1);
    const disconnects = [];
    link.on('disconnected', (p) => disconnects.push(p));
    // FakeTransport 不会像 MockTransport 那样在 connect 成功后主动发 hello；
    // 用宏任务注入（晚于 buildPipeline 挂监听），模拟真设备「connect 成功即发 hello」。
    // 注意 connectAndReady 会先同步 emit 一次 hello 完成首握，onConnect 只对
    // 重连的 connect（connectCalls≥2）注入，避免首握期间双重 hello 竞态。
    transport.onConnect = () => {
      if (transport.connectCalls < 2) return;
      transport.emit('data', helloFrame({ deviceId: 'test-dev', token: 'tok-abc' }, 20 + transport.connectCalls), { channel: 'control' });
    };

    await connectAndReady({ link, transport });
    assert.equal(readyCount, 1, '首次握手应有 1 次 ready');
    assert.equal(transport.state, 'connected');

    // keepalive 判死（假时钟推 30 秒，无任何入站）
    clock.advance(30000);
    await waitFor(() => link.state === 'reconnecting');
    // 判死只广播一次，且必须是 {unexpected:true}：FakeTransport.disconnect() 与
    // 真 transport 一样会 emit disconnected{unexpected:false,'主动断开'}，
    // 该事件不得透传（T16 缺陷③回归点）。
    assert.deepEqual(disconnects, [{ unexpected: true, reason: 'keepalive-timeout' }]);
    assert.equal(transport.state, 'scanning', '判死必须真正断开 transport（离开 CONNECTED）');
    // 判死路径必须真正断开 transport（离开 CONNECTED），
    // 否则 connect() 早退、新 Handshake 永远等不到 hello。
    clock.advance(10); // backoff 10ms 到期 → 重连
    await waitFor(() => link.ready, 2000);
    assert.equal(readyCount, 2, `判死重连后应重新握手（readyCount=${readyCount}）`);
    assert.equal(link.state, 'connected');
    assert.ok(link.info, '重连后 info 应为全新协商结果');
    await link.stop();
  });
});

// ---------------------------------------------------------------------------
// t19-F1 回归：stop() 期间 in-flight 的 connect 不得让链路复活
//   CONNECT_TIMEOUT_MS = 70s（连接要等 30s 扫描 + 30s 连接 + 服务发现），
//   「点了连接、等不及、点断开」是真实可达路径。旧实现的 #openSession 在
//   await transport.connect() 之后无任何复核，晚到成功会照旧 buildPipeline +
//   setState(CONNECTED)：链路复活且 start() 因 state ∈ {CONNECTED,CONNECTING}
//   永久早退 → 除非重启进程，再也连不上。
// ---------------------------------------------------------------------------
describe('t19-F1 · stop() 期间 in-flight connect 不得复活链路', () => {
  /** 可手动放行的 connect：模拟「连接仍挂起等待，用户先点了断开」。 */
  function gateConnect(transport) {
    let release;
    const gate = new Promise((resolve) => {
      release = () => {
        // 晚到的成功：transport 自己也认为连上了
        transport.state = 'connected';
        resolve();
      };
    });
    transport.connect = () => {
      transport.connectCalls += 1;
      transport.state = 'connecting';
      return gate;
    };
    return release;
  }

  boundedTest('晚到的 connect 成功不得把链路复活为 connected', async () => {
    const { link, transport } = makeLink();
    const release = gateConnect(transport);

    const states = [];
    const disconnects = [];
    link.on('state', (s) => states.push(s));
    link.on('disconnected', (p) => disconnects.push(p));

    const started = link.start();
    await waitFor(() => transport.connectCalls === 1);

    await link.stop('用户停止');
    assert.equal(link.state, 'idle', 'stop 返回后应处于 idle');

    release(); // ★ 晚到的 connect 成功
    await started;
    await waitFor(() => transport.state === 'idle', 500);

    assert.equal(link.state, 'idle', '晚到的 connect 不得把链路复活为 connected');
    assert.equal(link.ready, false, '作废的会话不得进入 ready');
    assert.ok(
      !states.includes('connected'),
      `不应广播 state=connected（实际 ${states.join(' → ')}）`,
    );
    assert.deepEqual(
      disconnects,
      [{ unexpected: false, reason: '用户停止' }],
      `stop 只应广播一次 disconnected（实际 ${JSON.stringify(disconnects)}）`,
    );
  });

  boundedTest('restartScan() 期间 in-flight connect 晚到成功不得把链路拉回 connected', async () => {
    const { link, transport } = makeLink();
    const release = gateConnect(transport);

    const states = [];
    link.on('state', (s) => states.push(s));

    const started = link.start();
    await waitFor(() => transport.connectCalls === 1);

    await link.restartScan('切换设备');
    assert.equal(link.state, 'scanning');

    release(); // ★ 晚到的 connect 成功
    await started;
    await waitFor(() => transport.state === 'scanning', 500);

    assert.equal(link.state, 'scanning', '晚到的 connect 不得把状态改成 connected');
    assert.equal(link.ready, false);
    assert.ok(
      !states.includes('connected'),
      `不应广播 state=connected（实际 ${states.join(' → ')}）`,
    );
  });

  boundedTest('作废之后再次 start() 必须重新连接并能完成握手', async () => {
    const { link, transport } = makeLink();
    const release = gateConnect(transport);

    const started = link.start();
    await waitFor(() => transport.connectCalls === 1);
    await link.stop('用户停止');
    release();
    await started;
    assert.equal(link.state, 'idle');

    // 用户再点「连接」：必须真的重新调用 transport.connect（旧实现在此永久早退）
    transport.connect = async () => {
      transport.connectCalls += 1;
      transport.state = 'connected';
    };
    await link.start();

    assert.equal(transport.connectCalls, 2, '再次 start() 必须重新调用 transport.connect');
    assert.equal(link.state, 'connected');

    transport.emit('data', helloFrame({ deviceId: 'test-dev', token: 'tok-abc' }), {
      channel: 'control',
    });
    await waitFor(() => link.ready);
    assert.equal(link.ready, true, '作废后的下一次连接必须能重新握手到 ready');
  });
});

// ---------------------------------------------------------------------------
// t29 回归：stop()/restartScan() 期间 in-flight 的 transport.start 不得复活链路
//   真实 bridge-client 的 connect 最长 70s（30s 扫描 + 30s 连接 + 服务发现），
//   「点连接、等不及、点断开」会让 start() 的 await transport.start?.() 晚到；
//   旧实现在该 await 之后没有世代复核，晚到完成仍进入 #openSession：
//     P1 stop 返回 idle 后链路被复活成 connected；
//     P2 connect 抛「Transport 已销毁」后 state 卡死 connecting，start() 永久早退。
// ---------------------------------------------------------------------------
describe('t29 · start() 前门窗口：in-flight transport.start 不得复活链路', () => {
  /** 可手动放行的 transport.start：模拟「启动仍挂起，用户先断开/重扫」。 */
  function gateStart(transport) {
    let release;
    const gate = new Promise((resolve) => {
      release = () => {
        // transport.start 成功后的正常状态：进入扫描
        transport.state = 'scanning';
        resolve();
      };
    });
    transport.startCalls = 0;
    transport.start = () => {
      transport.startCalls += 1;
      return gate;
    };
    return release;
  }

  boundedTest('stop() 期间晚到的 transport.start 不得进入 #openSession', async () => {
    const { link, transport } = makeLink();
    const release = gateStart(transport);
    const states = [];
    const disconnects = [];
    link.on('state', (s) => states.push(s));
    link.on('disconnected', (p) => disconnects.push(p));

    const started = link.start();
    await waitFor(() => transport.startCalls === 1);
    assert.equal(link.state, 'scanning', 'start 挂起时应处于 scanning');

    await link.stop('用户停止');
    assert.equal(link.state, 'idle', 'stop 返回后应处于 idle');

    release(); // ★ 晚到的 transport.start 完成
    await started;
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(transport.connectCalls, 0, '作废的启动不得再调用 transport.connect');
    assert.equal(link.state, 'idle', 'stop 返回 idle 后不得被晚到的 start 复活');
    assert.equal(link.ready, false);
    assert.ok(
      !states.includes('connecting'),
      `不应进入 connecting（实际 ${states.join(' → ')}）`,
    );
    assert.ok(
      !states.includes('connected'),
      `不应广播 state=connected（实际 ${states.join(' → ')}）`,
    );
    assert.deepEqual(
      disconnects,
      [{ unexpected: false, reason: '用户停止' }],
      `stop 只应广播一次 disconnected（实际 ${JSON.stringify(disconnects)}）`,
    );
  });

  boundedTest('restartScan() 期间晚到的 transport.start 不得进入 #openSession', async () => {
    const { link, transport } = makeLink();
    const release = gateStart(transport);
    const states = [];
    link.on('state', (s) => states.push(s));

    const started = link.start();
    await waitFor(() => transport.startCalls === 1);

    await link.restartScan('切换设备');
    assert.equal(link.state, 'scanning');

    release(); // ★ 晚到的 transport.start 完成
    await started;
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(transport.connectCalls, 0, '作废的启动不得再调用 transport.connect');
    assert.equal(link.state, 'scanning', '晚到的 start 不得把状态改成 connected');
    assert.equal(link.ready, false);
    assert.ok(
      !states.includes('connecting') && !states.includes('connected'),
      `不应进入 connecting/connected（实际 ${states.join(' → ')}）`,
    );
  });

  boundedTest('作废之后再次 start() 必须重新启动并能完成握手', async () => {
    const { link, transport } = makeLink();
    const release = gateStart(transport);

    const started = link.start();
    await waitFor(() => transport.startCalls === 1);
    await link.stop('用户停止');
    release();
    await started;
    assert.equal(link.state, 'idle');

    // 用户再点「连接」：transport.start 正常返回，必须重新 connect 并握手
    transport.start = async () => {
      transport.startCalls += 1;
      transport.state = 'scanning';
    };
    await link.start();

    assert.equal(transport.startCalls, 2, '再次 start() 必须重新调用 transport.start');
    assert.equal(transport.connectCalls, 1, '再次 start() 必须重新调用 transport.connect');
    assert.equal(link.state, 'connected');

    transport.emit('data', helloFrame({ deviceId: 'test-dev', token: 'tok-abc' }), {
      channel: 'control',
    });
    await waitFor(() => link.ready);
    assert.equal(link.ready, true, '作废后的下一次连接必须能重新握手到 ready');
  });

  boundedTest('connect 抛错后回到 idle，可再次 start()，且 void start 不产生 unhandledRejection', async () => {
    const rejections = [];
    const onRejection = (e) => rejections.push(e);
    process.on('unhandledRejection', onRejection);
    try {
      const { link, transport } = makeLink();
      transport.connectFailures = 1; // 第一次 connect 抛「Transport 已销毁」类错误

      void link.start(); // 真实调用方常见写法：不 await
      await waitFor(() => link.state === 'idle', 1000);
      await new Promise((r) => setTimeout(r, 30));

      assert.deepEqual(rejections, [], 'void link.start() 失败不得产生 unhandledRejection');
      assert.equal(link.state, 'idle', 'connect 失败不得把 state 留在 connecting');

      // 关键：state 已落回 idle，第二次 start() 不得在入口早退
      await link.start();
      assert.equal(transport.connectCalls, 2, '再次 start() 必须重新调用 transport.connect');
      assert.equal(link.state, 'connected');
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });
});

// ---------------------------------------------------------------------------
// t34 · t32 findings F1/F2/F3/F5/F6 回归
// ---------------------------------------------------------------------------

describe('t34-F1 · 断链后晚到的 store.load 不得重新 ready / 不得 unhandledRejection', () => {
  boundedTest('store.load 挂起期间 stop()，放行后不发 hello.ack、不 emit ready、无未捕获拒绝', async () => {
    const rejections = [];
    const onRejection = (e) => rejections.push(e);
    process.on('unhandledRejection', onRejection);
    try {
      const store = makeStore({ 'test-dev': 'tok-abc' });
      let releaseLoad;
      let loadCalls = 0;
      store.load = () => {
        loadCalls += 1;
        return new Promise((resolve) => {
          releaseLoad = () => resolve({ ...store.table });
        });
      };
      const { link, transport } = makeLink({ store });
      await link.start();
      assert.equal(loadCalls, 0);

      const hs = link.handshake;
      let linkReady = 0;
      let hsReady = 0;
      link.on('ready', () => { linkReady += 1; });
      hs.on('ready', () => { hsReady += 1; });

      transport.emit('data', helloFrame({ deviceId: 'test-dev', token: 'tok-abc' }), {
        channel: 'control',
      });
      await waitFor(() => loadCalls === 1);
      assert.equal(typeof releaseLoad, 'function');

      const sentBefore = transport.sent.length;
      await link.stop('用户停止');
      assert.equal(link.ready, false);

      releaseLoad(); // ★ 断链之后才放行 store.load
      await new Promise((r) => setTimeout(r, 50));

      assert.deepEqual(rejections, [], '晚到的 hello 不得产生 unhandledRejection');
      assert.equal(linkReady, 0, '断链后晚到的 hello 不得 emit ready（link）');
      assert.equal(hsReady, 0, '断链后晚到的 hello 不得 emit ready（handshake）');
      assert.equal(link.ready, false);
      assert.equal(hs.ready, false, 'reset 后的 handshake 不得回到 ready');
      assert.equal(hs.state, 'idle');
      assert.equal(transport.sent.length, sentBefore, '不得补发 hello.ack');
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });
});

describe('t34-F2 · 判死 disconnect 挂起期间 restartScan 抢先，不得二次广播', () => {
  boundedTest('restartScan 抢先时判死 handler 不得再 onTransportDown / 排重连', async () => {
    const { link, transport, clock } = makeLink({ inject: { backoffMs: [10] } });
    await connectAndReady({ link, transport });
    const disconnects = [];
    link.on('disconnected', (p) => disconnects.push(p));

    let releaseDisconnect;
    transport.disconnect = () =>
      new Promise((resolve) => {
        releaseDisconnect = () => {
          transport.state = 'scanning';
          resolve();
        };
      });

    clock.advance(30000); // keepalive 判死 → await transport.disconnect（挂起）
    await waitFor(() => typeof releaseDisconnect === 'function');

    const rs = link.restartScan('切换设备'); // 抢先：世代 +1，广播一次
    await rs;
    assert.equal(link.state, 'scanning');

    releaseDisconnect(); // ★ 放行判死 disconnect
    await new Promise((r) => setTimeout(r, 40));

    assert.deepEqual(
      disconnects,
      [{ unexpected: false, reason: '切换设备' }],
      `restartScan 抢先时只允许一次主动断开广播（实际 ${JSON.stringify(disconnects)}）`,
    );
    assert.equal(link.state, 'scanning', '不得被晚到的判死拉回 reconnecting');
    assert.equal(clock.pendingCount(), 0, '不得排重连定时器');
    await link.stop();
  });
});

describe('t34-F3 · 并发 start() 只建一套 pipeline', () => {
  boundedTest('两次并发 start：transport.start/connect/ready/hello.ack 各一次', async () => {
    const { link, transport } = makeLink();
    const releases = [];
    let startCalls = 0;
    transport.start = () => {
      startCalls += 1;
      return new Promise((resolve) => releases.push(resolve));
    };

    const p1 = link.start();
    const p2 = link.start();
    await waitFor(() => startCalls >= 1);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(startCalls, 1, '第二次并发 start 不得再调用 transport.start');
    assert.equal(releases.length, 1);

    for (const release of releases) release();
    await Promise.all([p1, p2]);

    assert.equal(transport.connectCalls, 1, '并发 start 只能 connect 一次');
    assert.equal(link.state, 'connected');

    let readyCount = 0;
    link.on('ready', () => { readyCount += 1; });
    transport.emit('data', helloFrame({ deviceId: 'test-dev', token: 'tok-abc' }), {
      channel: 'control',
    });
    await waitFor(() => link.ready);

    assert.equal(readyCount, 1, 'ready 只能 emit 一次');
    const helloAcks = transport.sent.filter((f) => {
      try {
        return JSON.parse(frameBody(f).toString()).type === MSG.HELLO_ACK;
      } catch {
        return false;
      }
    });
    assert.equal(helloAcks.length, 1, `hello.ack 只能发一条（实际 ${helloAcks.length}）`);
    await link.stop();
  });
});

describe('t34-F5 · restartScan 挂起期间 stop()，晚到不得复活 scanning', () => {
  boundedTest('reconnecting 下 restartScan 挂起，stop 给出 idle 后不得被覆盖', async () => {
    const { link, transport } = makeLink();
    await connectAndReady({ link, transport });

    // 进入意外断开 → reconnecting（stop 的早退条件不再成立）
    transport.emit('disconnected', { unexpected: true, reason: '链路断开' });
    await waitFor(() => link.state === 'reconnecting');

    let releaseRestart;
    transport.restartScan = () =>
      new Promise((resolve) => {
        releaseRestart = resolve;
      });

    const rs = link.restartScan('切换设备');
    await waitFor(() => typeof releaseRestart === 'function');
    assert.equal(link.state, 'reconnecting', 'restartScan 挂起期间状态尚未改');

    await link.stop('用户停止');
    assert.equal(link.state, 'idle');

    releaseRestart(); // ★ 晚到的 restartScan 完成
    await rs;
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(link.state, 'idle', 'stop 的 idle 终态不得被晚到的 restartScan 改成 scanning');
  });
});

describe('t34-F6 · 并发 stop() 只广播一次', () => {
  boundedTest('第二次 stop 直接返回，disconnected 恰好一次、transport.stop 只调一次', async () => {
    const { link, transport } = makeLink();
    await connectAndReady({ link, transport });

    let releaseStop;
    let stopCalls = 0;
    transport.stop = () => {
      stopCalls += 1;
      return new Promise((resolve) => {
        releaseStop = resolve;
      });
    };

    const disconnects = [];
    link.on('disconnected', (p) => disconnects.push(p));

    const first = link.stop('用户关闭');
    await waitFor(() => stopCalls === 1);

    let secondReturned = false;
    const second = link.stop('第二次').then(() => { secondReturned = true; });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(secondReturned, true, '第二次并发 stop 必须直接返回，不等待第一次');

    releaseStop();
    await Promise.all([first, second]);
    await new Promise((r) => setTimeout(r, 10));

    assert.deepEqual(disconnects, [{ unexpected: false, reason: '用户关闭' }]);
    assert.equal(stopCalls, 1, 'transport.stop 只能调用一次');
  });
});

describe('t34-F1b · 断链后持有旧 handshake 引用调用 send 不得同步抛错', () => {
  boundedTest('stop() 后旧 handshake.beginPairing() 安全 no-op（不抛 TypeError）', async () => {
    const { link, transport } = makeLink();
    await connectAndReady({ link, transport });
    const hs = link.handshake;
    await link.stop('用户停止');

    // 旧引用在断链后仍可能被上层/定时器调用；send 闭包必须判空，
    // 不能在 `this.#frameIO` 已置 null 时同步抛 TypeError。
    await assert.doesNotReject(() => hs.beginPairing('123456'));
  });
});

// ---------------------------------------------------------------------------
// t37 · t35 findings：start/stop 生命周期串行化、restartScan 晚到、pair.ok 晚到
// ---------------------------------------------------------------------------

function countHelloAcks(transport) {
  return transport.sent.filter((f) => {
    try {
      return JSON.parse(frameBody(f).toString()).type === MSG.HELLO_ACK;
    } catch {
      return false;
    }
  }).length;
}

describe('t37-F1 · stop 挂起期间 start 必须串行等待 stop', () => {
  boundedTest('start 等待 stopPromise：无迟到 idle、无迟到 disconnected、无重复 pipeline', async () => {
    const { link, transport } = makeLink();
    // 先进入 SCANNING（stop 的早退条件不成立），构造真实可竞争窗口
    await link.restartScan('准备扫描');
    assert.equal(link.state, 'scanning');

    let startCalls = 0;
    transport.start = async () => {
      startCalls += 1;
      transport.state = 'scanning';
    };
    let releaseStop;
    transport.stop = () =>
      new Promise((resolve) => {
        releaseStop = resolve;
      });

    const states = [];
    const disconnects = [];
    link.on('state', (s) => states.push(s));
    link.on('disconnected', (p) => disconnects.push(p));

    const stopP = link.stop('用户关闭');
    await waitFor(() => typeof releaseStop === 'function');

    const startP = link.start();
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(startCalls, 0, 'stop 未完成前 start 不得调用 transport.start');

    releaseStop();
    await Promise.all([stopP, startP]);

    assert.equal(transport.connectCalls, 1, 'start 只能 connect 一次');
    assert.equal(link.state, 'connected');
    // Link 常驻 1 个 data 监听（keepalive touch），活跃管线另加 1 个。
    assert.equal(transport.listenerCount('data') - 1, 1, '只允许一套 pipeline 监听 data');
    transport.emit('data', helloFrame({ deviceId: 'test-dev', token: 'tok-abc' }), {
      channel: 'control',
    });
    await waitFor(() => link.ready);

    const lastConnected = states.lastIndexOf('connected');
    assert.ok(lastConnected >= 0, `应进入 connected（实际 ${states.join(' → ')}）`);
    assert.ok(
      !states.slice(lastConnected + 1).includes('idle'),
      `connected 之后不得出现迟到 idle（实际 ${states.join(' → ')}）`,
    );
    assert.equal(disconnects.length, 1, '只允许 stop 自己的一次 disconnected');
    assert.deepEqual(disconnects[0], { unexpected: false, reason: '用户关闭' });
    assert.equal(countHelloAcks(transport), 1, '不得出现第二套 pipeline / 第二条 hello.ack');
  });
});

describe('t37-F1b · stop 挂起期间 restartScan：stop 不得迟到落 idle/广播', () => {
  boundedTest('restartScan 已开启新世代后，旧 stop 完成后不得覆盖 scanning', async () => {
    const { link, transport } = makeLink();
    await connectAndReady({ link, transport });

    let releaseStop;
    transport.stop = () =>
      new Promise((resolve) => {
        releaseStop = resolve;
      });

    const disconnects = [];
    link.on('disconnected', (p) => disconnects.push(p));

    const stopP = link.stop('用户关闭');
    await waitFor(() => typeof releaseStop === 'function');

    // stop 尚未落终态时 restartScan 抢先：世代 +1 并广播一次主动断开
    const rs = link.restartScan('切换设备');
    await rs;
    assert.equal(link.state, 'scanning');

    releaseStop(); // ★ 旧 stop 完成
    await stopP;
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(link.state, 'scanning', '旧 stop 不得把 restartScan 的 scanning 改成 idle');
    // 语义说明（t37 第二轮）：stop 是先生效的动作，它在拆完管线、等
    // transport.stop 之前就已完成唯一一次广播；后到的 restartScan 只负责
    // 重新扫描，不再补发第二条事件。两条用户动作合计仍恰好一次。
    assert.deepEqual(
      disconnects,
      [{ unexpected: false, reason: '用户关闭' }],
      `只允许 stop 的一条 disconnected（实际 ${JSON.stringify(disconnects)}）`,
    );
  });
});

describe('t37-F2 · restartScan 挂起期间 start 不得被晚到 restartScan 改写', () => {
  boundedTest('late restartScan 不改写 connected，且不产生第二套 pipeline', async () => {
    const { link, transport } = makeLink();
    await connectAndReady({ link, transport });
    assert.equal(transport.connectCalls, 1);

    // 进入 reconnecting，让 restartScan 走「非 CONNECTED」分支并挂起
    transport.emit('disconnected', { unexpected: true, reason: '链路断开' });
    await waitFor(() => link.state === 'reconnecting');

    let releaseRestart;
    let restartCalls = 0;
    transport.restartScan = () => {
      restartCalls += 1;
      return new Promise((resolve) => {
        releaseRestart = resolve;
      });
    };
    const rs = link.restartScan('切换设备');
    await waitFor(() => restartCalls === 1);

    // start 在 restartScan 挂起期间完成一条新会话
    await link.start();
    assert.equal(link.state, 'connected');
    const acksBefore = countHelloAcks(transport);
    transport.emit('data', helloFrame({ deviceId: 'test-dev', token: 'tok-abc' }), {
      channel: 'control',
    });
    await waitFor(() => link.ready);

    releaseRestart(); // ★ 晚到的 restartScan 完成
    await rs;
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(link.state, 'connected', '晚到的 restartScan 不得把 connected 改成 scanning');
    assert.equal(link.ready, true);
    // Link 常驻 1 个 data 监听（keepalive touch），活跃管线另加 1 个。
    assert.equal(transport.listenerCount('data') - 1, 1, '只允许一套 pipeline 监听 data');
    assert.equal(transport.connectCalls, 2, '初始 1 次 + start 1 次，不得多建 pipeline');
    assert.equal(countHelloAcks(transport) - acksBefore, 1, '不得重复 hello.ack');
  });
});

describe('t37-F3 · 断链后晚到的 pair.ok 不得 emit paired', () => {
  boundedTest('pair.ok 的 store.load 挂起期间 stop：不 emit paired、不写信任表（t37 决策）', async () => {
    const { link, transport, store } = makeLink();
    await connectAndReady({ link, transport });
    const hs = link.handshake;

    let releaseLoad;
    let loadCalls = 0;
    store.load = () => {
      loadCalls += 1;
      return new Promise((resolve) => {
        releaseLoad = () => resolve({ ...store.table });
      });
    };
    const paired = [];
    hs.on('paired', (p) => paired.push(p));
    let linkPaired = 0;
    link.on('paired', () => { linkPaired += 1; });

    transport.emit(
      'data',
      deviceMsg({ type: MSG.PAIR_OK, deviceId: 'test-dev', token: 'tok-new' }, 30),
      { channel: 'control' },
    );
    await waitFor(() => loadCalls === 1);

    await link.stop('用户停止');
    releaseLoad(); // ★ 断链之后才放行 load
    await new Promise((r) => setTimeout(r, 40));

    assert.equal(paired.length, 0, '晚到的 pair.ok 不得 emit paired');
    assert.equal(linkPaired, 0, 'Link 也不得转发 paired');
    assert.equal(hs.state, 'idle');
    // t37 显式决策：load 后、写表前发现世代已变 → 旧会话的迟到 pair.ok
    // 不产生任何副作用，信任表保持原值。
    assert.equal(store.table['test-dev'], 'tok-abc', '晚到的 pair.ok 不得写信任表');
  });

  boundedTest('pair.ok 的 store.save 挂起期间 stop：save 后复核，不 emit paired', async () => {
    const { link, transport, store } = makeLink();
    await connectAndReady({ link, transport });
    const hs = link.handshake;

    let releaseSave;
    let saveCalls = 0;
    store.save = (next) =>
      new Promise((resolve) => {
        saveCalls += 1;
        releaseSave = () => {
          Object.assign(store.table, next);
          resolve();
        };
      });
    const paired = [];
    hs.on('paired', (p) => paired.push(p));

    transport.emit(
      'data',
      deviceMsg({ type: MSG.PAIR_OK, deviceId: 'test-dev', token: 'tok-saved' }, 31),
      { channel: 'control' },
    );
    await waitFor(() => saveCalls === 1);

    await link.stop('用户停止');
    releaseSave(); // ★ 断链之后才放行 save
    await new Promise((r) => setTimeout(r, 40));

    assert.equal(paired.length, 0, 'save 晚到也不得 emit paired');
    assert.equal(hs.state, 'idle');
    assert.equal(store.table['test-dev'], 'tok-saved', '信任表仍应落盘');
  });
});

describe('t37 · 生命周期不变量（start/stop/restartScan 交织序列）', () => {
  /** 可手动放行每个 transport 异步调用的假 transport。 */
  class GatedTransport extends EventEmitter {
    constructor() {
      super();
      this.state = 'idle';
      this.sent = [];
      this.connectCalls = 0;
      this.startCalls = 0;
      this.stopCalls = 0;
      this.restartCalls = 0;
      this.gates = [];
    }

    #gate() {
      return new Promise((resolve) => {
        this.gates.push(resolve);
      });
    }

    start() {
      this.startCalls += 1;
      this.state = 'scanning';
      return this.#gate();
    }

    stop() {
      this.stopCalls += 1;
      return this.#gate().then(() => {
        this.state = 'idle';
      });
    }

    restartScan() {
      this.restartCalls += 1;
      return this.#gate().then(() => {
        this.state = 'scanning';
      });
    }

    connect() {
      this.connectCalls += 1;
      return this.#gate().then(() => {
        this.state = 'connected';
      });
    }

    async disconnect() {
      this.state = 'scanning';
    }

    async send() {}

    releaseAll() {
      const gates = this.gates.splice(0);
      for (const resolve of gates) resolve();
      return gates.length;
    }
  }

  const OPS = ['start', 'stop', 'restartScan'];
  const sequences = [];
  for (const a of OPS) for (const b of OPS) for (const c of OPS) sequences.push([a, b, c]);
  for (const a of OPS) for (const b of OPS) sequences.push([a, b]);

  const invoke = (link, op) => {
    if (op === 'start') return link.start();
    if (op === 'stop') return link.stop('seq-stop');
    return link.restartScan('seq-rs');
  };

  boundedTest('31 种交织后：data 监听器 0/1、connected⇔活跃管线、陈旧组件无监听器', async () => {
    const runSequence = async (seq) => {
        const transport = new GatedTransport();
        const { link } = makeLink({ transport, clock: makeClock() });
        const seen = new Set();
        const snap = () => {
          if (link.handshake) seen.add(link.handshake);
          if (link.keepalive) seen.add(link.keepalive);
        };

        const inflight = [];
        for (const op of seq) {
          snap();
          inflight.push(Promise.resolve(invoke(link, op)).catch(() => {}));
          snap();
        }

        let settled = false;
        for (let i = 0; i < 40 && !settled; i += 1) {
          transport.releaseAll();
          snap();
          settled = await Promise.race([
            Promise.all(inflight).then(() => true),
            new Promise((resolve) => setTimeout(() => resolve(false), 0)),
          ]);
          snap();
        }
        assert.ok(settled, `序列 ${seq.join('→')} 未收敛`);

        // 收尾：序列可能停在 connected，主动 stop 让下一轮从干净状态开始。
        if (link.handshake) {
          const cleanup = link.stop('cleanup');
          for (let i = 0; i < 10; i += 1) {
            transport.releaseAll();
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
          await cleanup.catch(() => {});
        }
        snap();

        // (a) transport 上的 data 监听器 = Link 常驻 1 个 + 活跃管线数（0/1）。
        const dataListeners = transport.listenerCount('data');
        const pipelineDataListeners = dataListeners - 1;
        assert.ok(
          pipelineDataListeners === 0 || pipelineDataListeners === 1,
          `序列 ${seq.join('→')}：transport data 监听器=${dataListeners}`,
        );

        // (b) connected ⇔ 有活跃 pipeline 且 transport 也 connected。
        const hasPipeline = link.handshake !== null;
        assert.equal(
          link.state === 'connected',
          hasPipeline && transport.state === 'connected',
          `序列 ${seq.join('→')}：state=${link.state} pipeline=${hasPipeline} transport=${transport.state}`,
        );
        assert.equal(
          pipelineDataListeners,
          hasPipeline ? 1 : 0,
          `序列 ${seq.join('→')}：pipeline data 监听器数应与活跃管线一致`,
        );

        // (c) 已被拆掉的 Handshake/Keepalive 实例不得残留任何监听器
        //     （ready=false 时也不允许旧实例继续 emit ready/paired）。
        for (const handle of seen) {
          if (handle === link.handshake || handle === link.keepalive) continue;
          assert.deepEqual(
            handle.eventNames(),
            [],
            `序列 ${seq.join('→')}：陈旧 ${handle.constructor.name} 仍有监听器`,
          );
        }

    };

    for (const seq of sequences) {
      await Promise.race([
        runSequence(seq),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(`序列 ${seq.join('→')} 未收敛（1500ms 超时）`)),
            1500,
          ),
        ),
      ]);
    }
  });
});

// ---------------------------------------------------------------------------
// t43 · 收敛 worker：每推进一轮就断言不变量，而不是只在全部 settle 后看一眼。
// 旧 t37 交织用例是「settle 后单点断言」，对「删掉所有世代自增」这类变异全绿
// （F13 假绿灯）；这里改为每放行一个 gate / 让出一轮事件循环都重新采样。
// ---------------------------------------------------------------------------
describe('t43 · 收敛 worker 每轮不变量（max pipeline = 1）', () => {
  class RoundTransport extends EventEmitter {
    constructor() {
      super();
      this.state = 'idle';
      this.sent = [];
      this.gates = [];
    }

    #gate() {
      return new Promise((resolve) => this.gates.push(resolve));
    }

    start() {
      this.state = 'scanning';
      return this.#gate();
    }

    stop() {
      return this.#gate().then(() => {
        this.state = 'idle';
      });
    }

    restartScan() {
      return this.#gate().then(() => {
        this.state = 'scanning';
      });
    }

    connect() {
      return this.#gate().then(() => {
        this.state = 'connected';
      });
    }

    async disconnect() {
      this.state = 'scanning';
    }

    async send() {}
  }

  const OPS = ['start', 'stop', 'restartScan'];
  const sequences = [];
  for (const a of OPS) for (const b of OPS) for (const c of OPS) sequences.push([a, b, c]);
  for (const a of OPS) for (const b of OPS) sequences.push([a, b]);

  const invoke = (link, op) =>
    op === 'start' ? link.start() : op === 'stop' ? link.stop('round-stop') : link.restartScan('round-rs');
  const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

  boundedTest('31 种交织：每轮采样 data 监听器/connected⇔pipeline/陈旧组件，峰值恒 1', async () => {
    const runSequence = async (seq) => {
        const transport = new RoundTransport();
        const { link } = makeLink({ transport, clock: makeClock() });
        const stale = new Set();
        let previousHandles = new Set();
        let maxPipelines = 0;
        let connectedSinceDown = true;
        const states = [];
        let lastNonStartMark = 0;

        link.on('state', (s) => {
          states.push(s);
          if (s === 'connected') connectedSinceDown = true;
        });
        link.on('disconnected', (payload) => {
          assert.ok(
            connectedSinceDown,
            `序列 ${seq.join('→')}：两次 disconnected 之间没有重新 connected（${JSON.stringify(payload)}）`,
          );
          connectedSinceDown = false;
        });

        const snapshotHandles = () => {
          for (const h of previousHandles) {
            if (h !== link.handshake && h !== link.keepalive) stale.add(h);
          }
          previousHandles = new Set([link.handshake, link.keepalive].filter(Boolean));
        };

        const check = (label) => {
          const dataListeners = transport.listenerCount('data');
          const pipelines = dataListeners - 1; // Link 常驻 1 个 data 监听
          assert.ok(pipelines === 0 || pipelines === 1, `${label}：pipeline data 监听器=${dataListeners}`);
          maxPipelines = Math.max(maxPipelines, pipelines);
          const hasPipeline = link.handshake !== null;
          assert.equal(
            link.state === 'connected',
            hasPipeline && transport.state === 'connected',
            `${label}：state=${link.state} pipeline=${hasPipeline} transport=${transport.state}`,
          );
          assert.equal(pipelines, hasPipeline ? 1 : 0, `${label}：pipeline 数与活跃管线不一致`);
          if (link.ready) {
            assert.equal(
              transport.state,
              'connected',
              `${label}：ready=true 但 transport=${transport.state}`,
            );
          }
          for (const h of stale) {
            assert.deepEqual(h.eventNames(), [], `${label}：陈旧 ${h.constructor.name} 仍残留监听器`);
          }
        };

        const inflight = [];
        // 每次调用后放行一个 gate 再进入下一个操作，刻意制造「connect 在飞时
        // 用户又点 stop/restartScan」的窗口（只背靠背调用是撞不到这个窗口的）。
        for (const op of seq) {
          if (op !== 'start') lastNonStartMark = states.length;
          snapshotHandles();
          inflight.push(Promise.resolve(invoke(link, op)).catch(() => {}));
          snapshotHandles();
          check(`序列 ${seq.join('→')} 调用 ${op} 后`);
          if (transport.gates.length > 0) transport.gates.shift()();
          await turn();
          snapshotHandles();
          check(`序列 ${seq.join('→')} 调用 ${op} 并推进一轮后`);
        }

        let settled = false;
        Promise.all(inflight).then(() => {
          settled = true;
        });
        for (let i = 0; i < 80 && !settled; i += 1) {
          if (transport.gates.length > 0) transport.gates.shift()();
          await turn();
          snapshotHandles();
          check(`序列 ${seq.join('→')} 收尾第 ${i + 1} 轮`);
        }
        await Promise.race([Promise.all(inflight), turn()]);
        assert.ok(settled, `序列 ${seq.join('→')} 未收敛`);

        snapshotHandles();
        check(`序列 ${seq.join('→')} 收敛后`);
        const last = seq.at(-1);
        const expected = last === 'stop' ? 'idle' : last === 'restartScan' ? 'scanning' : 'connected';
        assert.equal(
          link.state,
          expected,
          `序列 ${seq.join('→')}：最终状态必须等于最后一个意图（${expected}）`,
        );
        if (last !== 'start') {
          // 最后一次 stop/restartScan 之后不得再出现 connected：被作废的
          // connect 即使晚到成功，也只能由 worker 清理，不能复活链路。
          assert.ok(
            !states.slice(lastNonStartMark).includes('connected'),
            `序列 ${seq.join('→')}：最后一次非 start 意图之后仍出现 connected（${states.join(' → ')}）`,
          );
        }
        assert.ok(maxPipelines <= 1, `序列 ${seq.join('→')}：pipeline 峰值=${maxPipelines}`);
        assert.equal(
          maxPipelines,
          expected === 'connected' ? 1 : maxPipelines,
          `序列 ${seq.join('→')}：收敛到 connected 时峰值必须为 1`,
        );

        const cleanup = link.stop('cleanup').catch(() => {});
        for (let i = 0; i < 10; i += 1) {
          if (transport.gates.length > 0) transport.gates.shift()();
          await turn();
        }
        await Promise.race([cleanup, turn(), turn()]);

    };

    for (const seq of sequences) {
      await Promise.race([
        runSequence(seq),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(`序列 ${seq.join('→')} 未收敛（1500ms 超时）`)),
            1500,
          ),
        ),
      ]);
    }
  });

  boundedTest('t43 不变量：退避 timer 在跑时用户 start 不得等 timer', async () => {
    const transport = new RoundTransport();
    const { link } = makeLink({ transport, inject: { backoffMs: [60_000] } });
    const states = [];
    link.on('state', (s) => states.push(s));
    const first = link.start().catch(() => {});
    for (let i = 0; i < 20 && link.state !== 'connected'; i += 1) {
      if (transport.gates.length > 0) transport.gates.shift()();
      await turn();
    }
    assert.equal(link.state, 'connected', `首次建链未到 connected（states=${states.join('→')}）`);

    transport.emit('disconnected', { unexpected: true, reason: '不变量-掉线' });
    for (let i = 0; i < 20 && link.state !== 'reconnecting'; i += 1) await turn();
    assert.equal(link.state, 'reconnecting', `意外断链未进入 reconnecting（states=${states.join('→')}）`);

    // 退避 timer 是 60s；用户立刻抬手连接，必须取消退避而不是等 timer。
    const again = link.start().catch(() => {});
    const deadline = Date.now() + 500;
    while (link.state !== 'connected' && Date.now() < deadline) {
      if (transport.gates.length > 0) transport.gates.shift()();
      await turn();
    }
    assert.equal(
      link.state,
      'connected',
      `退避 timer 在跑时用户 start() 被吞（states=${states.join('→')}）`,
    );
    await Promise.race([Promise.all([first, again]), turn(), turn()]);
  });
});

describe('t44 · 退避等待期内用户动作不得被静默吞掉', () => {
  boundedTest('退避等待期内用户 start() 必须立刻取消退避并重连（不 advance 60s）', async () => {
    const { link, transport } = makeLink({ inject: { backoffMs: [60_000] } });
    // 首次连接由 connectAndReady 手动注入 hello；只给重连的 connect 注入。
    transport.onConnect = () => {
      if (transport.connectCalls >= 2) {
        transport.emit(
          'data',
          helloFrame({ deviceId: 'test-dev', token: 'tok-abc' }, 40 + transport.connectCalls),
          { channel: 'control' },
        );
      }
    };
    await connectAndReady({ link, transport });
    const connectsBefore = transport.connectCalls;
    assert.equal(connectsBefore, 1);

    const disconnects = [];
    link.on('disconnected', (p) => disconnects.push(p));
    transport.emit('disconnected', { unexpected: true, reason: '掉线' });
    await waitFor(() => link.state === 'reconnecting');

    // 用户立刻点「重新连接」：退避 timer 是 60s，测试不推进假时钟。
    await link.start();
    try {
      await waitFor(() => link.ready, 100);
    } catch {
      assert.fail(
        `用户 start() 被退避 timer 吞掉：100ms 内未 ready（state=${link.state}, ` +
          `connectCalls=${transport.connectCalls}, 期望 ${connectsBefore + 1}）`,
      );
    }
    assert.equal(transport.connectCalls, connectsBefore + 1, '用户动作只能触发一次 connect');
    assert.equal(link.state, 'connected');
    assert.deepEqual(disconnects, [{ unexpected: true, reason: '掉线' }]);

    await link.stop();
  });

  boundedTest('退避 timer 到期与用户 start() 同一 tick 竞速只建立一条链路', async () => {
    const { link, transport, clock } = makeLink({ inject: { backoffMs: [10] } });
    transport.onConnect = () => {
      if (transport.connectCalls >= 2) {
        transport.emit(
          'data',
          helloFrame({ deviceId: 'test-dev', token: 'tok-abc' }, 60 + transport.connectCalls),
          { channel: 'control' },
        );
      }
    };
    await connectAndReady({ link, transport });
    const connectsBefore = transport.connectCalls;
    let readyCount = 0;
    link.on('ready', () => (readyCount += 1));

    transport.emit('disconnected', { unexpected: true, reason: '掉线' });
    await waitFor(() => link.state === 'reconnecting');

    clock.advance(10); // 退避 timer 到期（会发布一次 reconnect 意图）
    const startP = link.start(); // 同一 tick 用户也点连接
    await startP;
    await waitFor(() => link.ready, 200);

    assert.equal(
      transport.connectCalls,
      connectsBefore + 1,
      `竞速下只能多一次 connect（实际 ${transport.connectCalls - connectsBefore}）`,
    );
    assert.equal(readyCount, 1, '只能完成一次握手');
    assert.equal(link.state, 'connected');

    await link.stop();
  });
});

// ---------------------------------------------------------------------------
// t46 · F15/F16/F18 + 无进展防呆：把「永远收敛不了」变成可失败的测试
// ---------------------------------------------------------------------------

describe('t46-F15 · stop 挂起 + restartScan 抛已销毁：不得热循环', () => {
  boundedTest('stop() 100ms 内收敛、restartScan ≤2 次、无 unhandledRejection', async () => {
    const rejections = [];
    const onRejection = (e) => rejections.push(e);
    process.on('unhandledRejection', onRejection);
    try {
      const { link, transport } = makeLink();
      await connectAndReady({ link, transport });

      const realStop = transport.stop.bind(transport);
      const realRestart = transport.restartScan.bind(transport);
      transport.disposed = false;
      transport.restartScanCalls = 0;
      let releaseStop = null;
      transport.stop = (reason) => {
        // 真实 transport 在 stop 开始即进入销毁；restartScan 此时会抛「已销毁」。
        transport.disposed = true;
        return new Promise((resolve) => {
          releaseStop = () => {
            realStop(reason);
            resolve();
          };
        });
      };
      transport.restartScan = async (reason) => {
        transport.restartScanCalls += 1;
        // 让出一轮宏任务：若实现退回热循环，测试的超时 timer 仍能触发，
        // 失败会以 AssertionError 呈现而不是把整个进程饿死。
        await new Promise((r) => setTimeout(r, 0));
        if (transport.disposed) throw new Error('Transport 已销毁');
        return realRestart(reason);
      };

      const stopPromise = link.stop('用户关闭');
      await new Promise((r) => setTimeout(r, 0));
      assert.equal(transport.restartScanCalls, 0, 'stop 尚未放行时不应调用 restartScan');

      const rsPromise = link.restartScan('切换设备');
      await new Promise((r) => setTimeout(r, 0));
      releaseStop();

      await Promise.race([
        stopPromise,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('stop() 100ms 内未 resolve（F15 热循环）')), 100),
        ),
      ]);
      await rsPromise.catch(() => {});
      await new Promise((r) => setTimeout(r, 50));

      assert.ok(
        transport.restartScanCalls <= 2,
        `restartScan 被调用 ${transport.restartScanCalls} 次（要求 ≤2，F15 热循环）`,
      );
      assert.equal(link.state, 'idle', `restartScan 失败后必须落回 idle，实际 ${link.state}`);
      const mine = rejections.filter((e) => String(e?.message ?? e).includes('已销毁') || e?.message?.includes('restartScan'));
      assert.equal(mine.length, 0, `F15 产生了 ${mine.length} 条 unhandledRejection`);

      // 子场景：restartScan 成功返回但 transport 永不进入 scanning。错误处理
      // 不会触发，只能靠无进展防呆（变异删防呆时本用例必须失败，而不是挂死）。
      const second = makeLink();
      second.transport.restartScan = async () => {
        await new Promise((r) => setTimeout(r, 0));
      };
      const pending = second.link.restartScan('永不收敛');
      let timer;
      const outcome = await Promise.race([
        pending.then(
          () => ({ kind: 'resolved' }),
          (error) => ({ kind: 'rejected', error }),
        ),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve({ kind: 'timeout' }), 500);
        }),
      ]).finally(() => clearTimeout(timer));
      // 无防呆时 pending 永不 settle；先发布 stop 打断热循环再断言失败。
      void second.link.stop('cleanup').catch(() => {});
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(outcome.kind, 'rejected', '无进展时必须失败，而不是挂住或静默成功');
      assert.match(String(outcome.error?.message), /Link 收敛无进展/);
      assert.equal(second.link.state, 'idle');
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });
});

describe('t46-F16 · 晚到 restartScan 不得让 ready 与 transport 错位', () => {
  boundedTest('新连接 ready 后放行旧 restartScan：Link 必须把 transport 拉回 connected', async () => {
    const { link, transport } = makeLink();
    await connectAndReady({ link, transport });

    let releaseLate = null;
    const realRestart = transport.restartScan.bind(transport);
    transport.restartScan = () =>
      new Promise((resolve) => {
        releaseLate = () => {
          realRestart(); // 真实 transport：把自身置回 scanning
          resolve();
        };
      });

    const late = link.restartScan('切换设备');
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(link.state, 'scanning', 'restartScan 应先拆管线进入 scanning');

    const stopped = link.stop('用户关闭');
    await stopped;

    // 每次新 connect 都注入 hello（模拟设备 connect 成功即发 hello）。
    transport.onConnect = () => {
      transport.emit(
        'data',
        helloFrame({ deviceId: 'test-dev', token: 'tok-abc' }, 40 + transport.connectCalls),
        { channel: 'control' },
      );
    };
    await link.start();
    await waitFor(() => link.ready);
    assert.equal(transport.state, 'connected');

    // F22：从这里开始只观察「漂移对齐」这一次操作，不得出现 disconnected。
    const driftDisconnects = [];
    let driftReady = 0;
    link.on('disconnected', (e) => driftDisconnects.push(e));
    link.on('ready', () => {
      driftReady += 1;
    });

    // 放行晚到的 restartScan：它把 transport 置 scanning，但 Link 已是新会话。
    // 后续规划会用新的 restartScan 重新对齐（这里恢复可用实现）。
    transport.restartScan = async () => {
      transport.state = 'scanning';
    };
    releaseLate();
    await late.catch(() => {});

    await waitFor(() => link.ready && transport.state === 'connected', 1500);
    assert.equal(transport.state, 'connected', `F16：ready=${link.ready} 但 transport=${transport.state}`);
    assert.equal(
      driftDisconnects.length,
      0,
      `F22：漂移对齐不得广播误导性的 disconnected，实际=${JSON.stringify(driftDisconnects)}`,
    );
    assert.equal(driftReady, 1, 'F22：漂移对齐后 ready 应恰好重新发出 1 次');
    const before = transport.sent.length;
    await link.send('notice', { hello: 1 }, { ack: false });
    assert.ok(transport.sent.length > before, '对齐后业务 send 必须可发送');
  });
});

describe('t46-F18 · 非法状态跃迁双向验证', () => {
  boundedTest('合法边全部放行；idle→connected 与 connected→connecting 必须抛', async () => {
    for (const [from, targets] of Object.entries(LEGAL_TRANSITIONS)) {
      for (const to of targets) {
        assert.doesNotThrow(() => assertLegalTransition(from, to, { mode: 'idle' }));
      }
    }
    assert.throws(
      () => assertLegalTransition('idle', 'connected', { mode: 'connected' }),
      /非法状态跃迁 idle→connected/,
    );
    assert.throws(
      () => assertLegalTransition('connected', 'connecting', { mode: 'connected' }),
      /非法状态跃迁 connected→connecting/,
    );
    // 真实方法路径：stop 后直接 start 会先 scanning 再 connecting，不得 idle→connected。
    const { link, transport } = makeLink();
    await connectAndReady({ link, transport });
    await link.stop();
    assert.equal(link.state, 'idle');
  });
});

describe('t48-F21 · 非法状态跃迁走公共 API', () => {
  test('规划器产出 idle→connecting：link.start() 必须拒绝且落回 idle', async () => {
    const { link } = makeLink({ inject: { planHook: () => ({ type: 'connect' }) } });
    await assert.rejects(link.start(), /非法状态跃迁 idle→connecting/);
    assert.equal(link.state, 'idle', '拒绝后不得停在 connecting');
  });
});

describe('t46 · 无进展防呆', () => {
  boundedTest('同一 (step,intent) 连续 8 轮且状态不变：落 idle 并抛错，而不是挂死', async () => {
    const errors = [];
    const logger = { debug() {}, warn() {}, error: (msg) => errors.push(String(msg)) };
    const { link, transport } = makeLink({
      inject: { logger, planHook: () => ({ type: 'settle' }) },
    });
    let stopCalls = 0;
    transport.stop = async () => {
      stopCalls += 1;
      transport.state = 'idle';
    };
    let noProgress = null;
    link.on('no-progress', (p) => {
      noProgress = p;
    });

    await assert.rejects(link.start(), /Link 收敛无进展/);
    assert.equal(stopCalls, 8, `防呆应在第 8 轮停下，实际 stopCalls=${stopCalls}`);
    assert.equal(link.state, 'idle');
    assert.ok(noProgress, '应广播一次 no-progress');
    assert.equal(noProgress.step, 'settle');
    assert.ok(errors.some((m) => m.includes('无进展')), '应记录 error 日志');
  });

  test('abort 后收拾 transport，且 stray kick 不再执行任何步骤（F23-②③）', async () => {
    const { link, transport } = makeLink({
      inject: {
        planHook: () => {
          planCalls += 1;
          return { type: 'settle' };
        },
      },
    });
    let planCalls = 0;
    // 模拟「Link 已 idle，但 transport 仍 connected」：settle 步骤里的 8 次
    // stop 都不改状态，只有紧急收尾的那一次把 transport 拉回 idle。
    transport.state = 'connected';
    let stopCalls = 0;
    transport.stop = async () => {
      stopCalls += 1;
      if (stopCalls >= 9) transport.state = 'idle';
    };
    let noProgress = 0;
    link.on('no-progress', () => {
      noProgress += 1;
    });

    await assert.rejects(link.start(), /Link 收敛无进展/);
    assert.equal(stopCalls, 9, '8 次 settle + 1 次紧急收尾 stop');
    assert.equal(transport.state, 'idle', 'abort 后 transport 不得仍 connected');
    assert.equal(noProgress, 1);

    const before = planCalls;
    await link.start(); // #aborted 后必须立即返回，不再规划/执行步骤
    assert.equal(planCalls, before, 'abort 后 stray kick 不得拉起 worker');
    assert.equal(link.state, 'idle');
  });
});

