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

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { Link } from '../../src/link/link.js';
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
  test('start() 后依次进入 scanning→connecting→connected，设备 hello 后 ready', async () => {
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

  test('重复 start() 幂等：不重复 connect', async () => {
    const { link, transport } = makeLink();
    await link.start();
    await link.start();
    assert.equal(transport.connectCalls, 1);
  });
});

describe('M2 · 断链清理顺序（验收 1）', () => {
  test('disconnected 事件到达时：队列已 reject、acks 已 clear、msgIds 已 releaseAll、reassembler 已 clear', async () => {
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

  test('reassembler.clear 生效：断链后注入的 reassembler 不残留半条消息', async () => {
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
  test('stop() 主动断开：disconnected{unexpected:false} 恰好一次，不重连', async () => {
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
  test('stop()：transport 自己也 emit disconnected 时不得双发（只广播一次）', async () => {
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

  test('restartScan()：transport 自己也 emit disconnected 时不得双发（只广播一次）', async () => {
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

  test('Link 只广播链路事件，不替上层清理 pending（无业务字段挂在本层）', async () => {
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
  test('意外断开后 ready 曾为 false、info 被重置；重连后重新握手产生全新 info', async () => {
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
  test('意外断开按 [1000,2000,5000,…] 退避重试；连接失败继续退避', async () => {
    const { link, transport, clock } = makeLink();
    await connectAndReady({ link, transport });
    assert.equal(transport.connectCalls, 1);
    transport.connectFailures = 2; // 首连成功后再注入：前两次重连失败，第三次成功

    transport.emit('disconnected', { unexpected: true, reason: '掉线' });
    assert.equal(link.state, 'reconnecting');

    clock.advance(999);
    assert.equal(transport.connectCalls, 1, '1000ms 退避未到不应重连');
    clock.advance(1);
    assert.equal(transport.connectCalls, 2, '第一次退避 1000ms 应触发重连');
    // 重连失败链是 async（openSession 抛错→catch→再排定），等它落回 reconnecting
    await waitFor(() => link.state === 'reconnecting');

    clock.advance(1999);
    assert.equal(transport.connectCalls, 2);
    clock.advance(1);
    assert.equal(transport.connectCalls, 3, '第二次退避 2000ms 应触发重连');
    await waitFor(() => link.state === 'reconnecting');

    clock.advance(4999);
    assert.equal(transport.connectCalls, 3);
    clock.advance(1);
    assert.equal(transport.connectCalls, 4, '第三次退避 5000ms 应触发重连（成功）');
    // openSession 是 async：connect 成功后还要在微任务里重建 FrameIO/Handshake，
    // 等 state 落到 connected 再发 hello（否则 hello 落在旧管线上被丢弃）。
    await waitFor(() => link.state === 'connected');

    transport.emit('data', helloFrame({ deviceId: 'test-dev', token: 'tok-abc' }), {
      channel: 'control',
    });
    await waitFor(() => link.ready);
    assert.equal(link.state, 'connected');
  });

  test('重连成功（ready）后退避序号复位：下次断开从 1000ms 重新开始', async () => {
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
    assert.equal(transport.connectCalls, 3, '退避序号应复位，1000ms 即重连');
  });
});

describe('M2 · sendAudio 不占消息号、不登记 ACK（验收 5）', () => {
  test('sendAudio 切分走 AUDIO 通道；msgIds 占用数不变；acks 不新增', async () => {
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
  test('业务消息抛 WireError(NOT_CONNECTED)；白名单 ping 放行', async () => {
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
  test('断链 releaseAll 后，新连接立刻能分配到断链前占用的号', async () => {
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
  test('设备 ping → keepalive 自动回 pong；ready 后业务消息透传给上层', async () => {
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

  test('设备音频帧从 data 事件分流为 audio 事件，绝不进 reassembler（C6）', async () => {
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
  test('index.js 导出 Link 与三个子模块', () => {
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
  test('判死路径的 keepalive ping 发送失败必须被 .catch 兜底（计数为 0）', async () => {
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
  test('判死后排定的重连必须真正重跑 connect 与握手，ready 事件再次触发', async () => {
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

  test('晚到的 connect 成功不得把链路复活为 connected', async () => {
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

  test('restartScan() 期间 in-flight connect 晚到成功不得把链路拉回 connected', async () => {
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

  test('作废之后再次 start() 必须重新连接并能完成握手', async () => {
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

  test('stop() 期间晚到的 transport.start 不得进入 #openSession', async () => {
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

  test('restartScan() 期间晚到的 transport.start 不得进入 #openSession', async () => {
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

  test('作废之后再次 start() 必须重新启动并能完成握手', async () => {
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

  test('connect 抛错后回到 idle，可再次 start()，且 void start 不产生 unhandledRejection', async () => {
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
  test('store.load 挂起期间 stop()，放行后不发 hello.ack、不 emit ready、无未捕获拒绝', async () => {
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
  test('restartScan 抢先时判死 handler 不得再 onTransportDown / 排重连', async () => {
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
  test('两次并发 start：transport.start/connect/ready/hello.ack 各一次', async () => {
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
  test('reconnecting 下 restartScan 挂起，stop 给出 idle 后不得被覆盖', async () => {
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
  test('第二次 stop 直接返回，disconnected 恰好一次、transport.stop 只调一次', async () => {
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
  test('stop() 后旧 handshake.beginPairing() 安全 no-op（不抛 TypeError）', async () => {
    const { link, transport } = makeLink();
    await connectAndReady({ link, transport });
    const hs = link.handshake;
    await link.stop('用户停止');

    // 旧引用在断链后仍可能被上层/定时器调用；send 闭包必须判空，
    // 不能在 `this.#frameIO` 已置 null 时同步抛 TypeError。
    await assert.doesNotReject(() => hs.beginPairing('123456'));
  });
});
