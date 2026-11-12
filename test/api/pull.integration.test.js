/**
 * M5 集成（mock 端到端）：三段拉取。
 *
 * 真实链路：MockTransport → Link（分帧 / ACK / 握手）→ ApiServer → Push + Pull。
 * 设备侧不手工切数组：主机发出的每一帧都先走真实的 Reassembler 还原完整 JSON
 * 消息，再交给下面的 EnvelopeAssembler 按 (type, ver) 把 part 升序拼回业务字段。
 * 这样「拆了但拼不回来」「parts 标错」「丢片」都会在设备侧暴露。
 *
 * 时间线 > maxPayload 的用例刻意只断言「拼回来的 entries 与主机缓冲逐条相等」，
 * 而不是「至少收到了几条」：拆分不是裁条目的借口。
 */

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { describe, test } from 'node:test';

import { MockTransport } from '../../src/ble/mock-transport.js';
import { Link } from '../../src/link/link.js';
import { ApiServer } from '../../src/api/server.js';
import { PushCapability } from '../../src/api/push.js';
import { PullCapability } from '../../src/api/pull.js';
import { Sessions } from '../../src/host/sessions.js';
import { Timeline } from '../../src/host/timeline.js';
import { Reassembler } from '../../src/wire/reassembler.js';
import { decodeHeader, encodeFrames } from '../../src/wire/frame.js';
import {
  CHANNEL_CONTROL,
  MAX_MESSAGE_BYTES_CEILING,
  MSG,
} from '../../src/wire/constants.js';

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

async function waitFor(fn, timeoutMs = 3000, stepMs = 2) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fn()) return;
    if (Date.now() > deadline) throw new Error(`waitFor 超时（${timeoutMs}ms）`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/** 只服务 push/sessions 的假时钟；Link 的保活/重连仍用真实计时器。 */
function makeFakeClock() {
  let nowMs = 0;
  let tid = 0;
  const timers = new Map();
  const clock = {
    now: () => nowMs,
    setTimer: (fn, ms) => {
      const id = ++tid;
      timers.set(id, { fn, due: nowMs + ms });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    pending: () => timers.size,
  };
  const advance = (ms) => {
    const target = nowMs + ms;
    for (;;) {
      let nextId = null;
      let next = null;
      for (const [id, tm] of timers) {
        if (tm.due <= target && (next === null || tm.due < next.due)) {
          next = tm;
          nextId = id;
        }
      }
      if (!next) break;
      timers.delete(nextId);
      nowMs = next.due;
      next.fn();
    }
    nowMs = target;
  };
  return { ...clock, advance, get nowMs() { return nowMs; } };
}

function makeLog() {
  const entries = [];
  return {
    entries,
    debug() {},
    info() {},
    warn: (...args) => entries.push(['warn', ...args]),
    error: (...args) => entries.push(['error', ...args]),
  };
}

const memoryStore = (table = {}) => ({
  load: async () => ({ ...table }),
  save: async () => {},
});

const TRUSTED_DEVICE = { deviceId: 'mock-device-1', token: 'mock-token-1' };
const trustedStore = () =>
  memoryStore({ [TRUSTED_DEVICE.deviceId]: TRUSTED_DEVICE.token });

// ---------------------------------------------------------------------------
// 设备侧：真实帧重组 + 真实信封拼装
// ---------------------------------------------------------------------------

/** 把同一 (type, ver) 的 part 按 part 升序合并业务字段。 */
function mergeParts(slices) {
  const out = {};
  const keys = new Set();
  for (const slice of slices) for (const key of Object.keys(slice)) keys.add(key);

  for (const key of keys) {
    if (key === 'part' || key === 'parts') continue;
    const values = slices.map((slice) => slice[key]);

    // 数组字段按 part 顺序拼接；缺失片视为空数组。
    if (values.some(Array.isArray)) {
      const arrays = values.map((value) => (Array.isArray(value) ? value : []));
      out[key] = arrays.flat();
      continue;
    }

    // 信封头字段必须逐片一致，否则拼出来的消息自相矛盾。
    for (let i = 1; i < values.length; i += 1) {
      assert.deepEqual(
        values[i],
        values[0],
        `信封字段 ${key} 在 part ${i + 1} 与 part 1 不一致`,
      );
    }
    out[key] = values[0];
  }
  return out;
}

class EnvelopeAssembler {
  /** 主机发出的完整 JSON 消息（含 part/parts），按到达顺序。 */
  messages = [];
  /** 拼装完成的业务消息（去掉 part/parts）。 */
  assembled = [];
  errors = [];
  /** 每收到一条原始完整消息回调一次（用于在途断链等时序注入）。 */
  onPart = null;

  accept(message) {
    if (message === null || typeof message !== 'object') return;
    if (typeof message.type !== 'string') return;
    this.messages.push(message);
    this.onPart?.(message);

    const { part, parts } = message;
    if (!Number.isInteger(part) || !Number.isInteger(parts)) {
      // balance / notice 这类单条应答没有信封，直接视为完成。
      this.assembled.push(message);
      return;
    }

    if (parts < 1 || part < 1 || part > parts) {
      this.errors.push(new Error(`非法信封：part=${part} parts=${parts}`));
      return;
    }

    const key = `${message.type}\u0000${message.ver}`;
    let batch = this.#pending.get(key);
    if (part === 1) {
      // 协议 §5.1.2：part=1 丢弃同 type 同 ver 的残留，开始新一批。
      batch = { parts, slices: new Array(parts) };
      this.#pending.set(key, batch);
    }
    if (batch === undefined) {
      this.errors.push(new Error(`收到无首批的 part：${key} part=${part}`));
      return;
    }
    if (batch.parts !== parts) {
      this.errors.push(new Error(`parts 不一致：${key} ${batch.parts}→${parts}`));
      return;
    }
    if (batch.slices[part - 1] !== undefined) {
      this.errors.push(new Error(`重复 part：${key} part=${part}`));
      return;
    }
    batch.slices[part - 1] = message;
    // every 会跳过稀疏数组的空洞，必须先用 Array.from 实体化。
    if (!Array.from(batch.slices).every((slice) => slice !== undefined)) return;

    this.#pending.delete(key);
    const merged = mergeParts(batch.slices);
    this.assembled.push(merged);
  }

  ofType(type) {
    return this.assembled.filter((m) => m.type === type);
  }

  rawOfType(type, ver) {
    return this.messages.filter(
      (m) => m.type === type && (ver === undefined || m.ver === ver),
    );
  }

  #pending = new Map();
}

/** 在 transport.send 上挂设备侧接收链（真实 Reassembler + 信封拼装）。 */
function attachDevice(transport) {
  const assembler = new EnvelopeAssembler();
  const wire = new Reassembler({ maxMessageBytes: MAX_MESSAGE_BYTES_CEILING });
  const origSend = transport.send.bind(transport);

  transport.send = async (frame, options) => {
    try {
      const head = decodeHeader(frame);
      if (head.channel === CHANNEL_CONTROL) {
        const result = wire.push(frame);
        if (result.kind === 'message') {
          const json = Buffer.from(result.payload).toString('utf8');
          assembler.accept(JSON.parse(json));
        }
      }
    } catch (err) {
      assembler.errors.push(err);
    }
    return origSend(frame, options);
  };

  return assembler;
}

let deviceMsgId = 100;

/** 以设备身份注入一条消息（自动分片）。 */
function deviceSend(transport, message, { ackRequired = false } = {}) {
  const id = deviceMsgId++ & 0x0fff;
  const payload = new TextEncoder().encode(JSON.stringify(message));
  const frames = encodeFrames({
    msgId: id,
    payload,
    chunkPayload: 510,
    channel: CHANNEL_CONTROL,
    ackRequired,
  });
  for (const frame of frames) transport._onData(frame, { channel: 'control' });
}

const req = (type, payload = {}) => ({ type, ...payload });

// ---------------------------------------------------------------------------
// 全栈
// ---------------------------------------------------------------------------

function makeStack({
  autoRespond = true,
  balanceProvider,
  timelineLimit = 40,
  maxMessageBytes,
} = {}) {
  const clock = makeFakeClock();
  const transport = new MockTransport({ mtuPayload: 510, autoRespond });
  const log = makeLog();
  const link = new Link({
    transport,
    chunkPayload: 510,
    backoffMs: [10],
    store: trustedStore(),
    setTimer: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      timer.unref?.();
      return timer;
    },
    clearTimer: (id) => clearTimeout(id),
  });
  const sessions = new Sessions({
    log,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const timeline = new Timeline({ limit: timelineLimit, log });
  const host = { sessions };
  const push = new PushCapability({
    link,
    log,
    host,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const pull = new PullCapability({
    link,
    log,
    host,
    timeline,
    balanceProvider,
    maxMessageBytes,
  });
  const server = new ApiServer({ link, log, host, capabilities: [push, pull] });

  return { clock, transport, link, log, sessions, timeline, push, pull, server };
}

async function startStack(stack, { waitReady = true } = {}) {
  const device = attachDevice(stack.transport);
  await stack.server.start();
  await stack.link.start();
  if (waitReady) {
    await waitFor(() => stack.link.ready === true, 5000);
  } else {
    await waitFor(() => stack.link.state === 'connected', 5000);
  }
  return device;
}

async function setup(t, options = {}) {
  const stack = makeStack(options);
  t.after(async () => {
    try {
      await stack.server.stop();
    } catch {
      // 清理失败不掩盖用例断言
    }
    try {
      await stack.link.stop('测试结束');
    } catch {
      // 同上
    }
    stack.sessions.dispose();
    stack.timeline.dispose();
  });
  const device = await startStack(stack, { waitReady: options.waitReady !== false });
  return { ...stack, device };
}

// ---------------------------------------------------------------------------
// 数据构造
// ---------------------------------------------------------------------------

const SEED = { sessionId: 's1' };

function seedMixedTimeline(timeline) {
  for (let i = 1; i <= 20; i += 1) {
    if (i % 2 === 1) {
      timeline.append(SEED.sessionId, { kind: 'reasoning', text: `思考 ${i}` });
    } else {
      timeline.append(SEED.sessionId, {
        kind: 'tool',
        name: 'bash',
        args: { command: `echo step-${i}` },
      });
    }
  }
}

function seedLongTimeline(timeline, count = 20) {
  for (let i = 1; i <= count; i += 1) {
    // 总计约 19KB：第一条接近 8KB（保证有一片贴近上限），其余约 0.6KB，
    // 必定超过 8160 的单条上限，必须拆成多片。
    const filler = i === 1 ? 2650 : 190;
    timeline.append(SEED.sessionId, {
      kind: 'reasoning',
      text: `${String(i).padStart(2, '0')}·` + '长'.repeat(filler),
    });
  }
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('M5 集成（mock 端到端拉取）', () => {
  test('1. session.list 与随后推送的 session.state 的 sessions[] 深比较相等', async (t) => {
    const stack = await setup(t);
    const { sessions, clock, device } = stack;

    sessions.upsert('main', {
      state: 'idle',
      title: '主会话',
      model: 'deepseek-chat',
      cwd: '/tmp/project',
    });
    sessions.upsert('sub', {
      parentSessionId: 'main',
      state: 'running',
      title: '子任务',
    });
    // 第二次变化落在 500ms 节流窗口内，推进假时钟让尾沿推送落地。
    clock.advance(500);
    await waitFor(() => device.ofType(MSG.SESSION_STATE).length >= 1);

    deviceSend(stack.transport, req(MSG.SESSION_LIST_REQ));
    await waitFor(() => device.ofType(MSG.SESSION_LIST).length === 1);

    const list = device.ofType(MSG.SESSION_LIST)[0];
    assert.equal(list.ver, 1, '新连接第一条 session.list 的 ver 必须是 1');
    assert.equal(list.sessions.length, 2);
    assert.equal(stack.pull.stats.sessionList, 1);

    // 「随后推送」：用 push 的断链/ready 生命周期强制全量重推，期间不改会话，
    // 因此这份 session.state 与刚才 session.list 必须来自同一快照。
    stack.push.onDisconnected();
    stack.push.onLinkReady();
    await waitFor(() => device.ofType(MSG.SESSION_STATE).length >= 2);

    const state = device.ofType(MSG.SESSION_STATE).at(-1);
    assert.deepEqual(list.sessions, state.sessions);
    assert.equal(device.errors.length, 0, device.errors.map(String).join('；'));
  });

  test('2. timeline count:20 收到全部 20 条（升序、hasMore=false），count:5 只收到最后 5 条', async (t) => {
    const stack = await setup(t);
    seedMixedTimeline(stack.timeline);

    deviceSend(stack.transport, req(MSG.TIMELINE_REQ, { ...SEED, count: 20 }));
    await waitFor(() => stack.device.ofType(MSG.TIMELINE).length === 1);

    const all = stack.device.ofType(MSG.TIMELINE)[0];
    assert.equal(all.sessionId, 's1');
    assert.equal(all.entries.length, 20);
    assert.deepEqual(all.entries.map((e) => e.seq), Array.from({ length: 20 }, (_, i) => i + 1));
    assert.equal(all.hasMore, false);
    assert.equal(all.dropped, 0);
    assert.equal(all.ver, 1, 'timeline 的 ver 与 session.list 相互独立，从 1 开始');

    deviceSend(stack.transport, req(MSG.TIMELINE_REQ, { ...SEED, count: 5 }));
    await waitFor(() => stack.device.ofType(MSG.TIMELINE).length === 2);

    const last = stack.device.ofType(MSG.TIMELINE)[1];
    assert.equal(last.entries.length, 5);
    assert.deepEqual(last.entries.map((e) => e.seq), [16, 17, 18, 19, 20]);
    assert.equal(last.hasMore, true);
    assert.equal(last.dropped, 0);
    assert.equal(last.ver, 2, '同一类型的 ver 连续递增');
  });

  test('3. 约 20KB 时间线：拆多 part，设备按 part 拼回后与主机缓冲逐条相等', async (t) => {
    const stack = await setup(t);
    seedLongTimeline(stack.timeline);
    const expected = stack.timeline.recent(SEED.sessionId, 20).entries;
    assert.equal(expected.length, 20);

    deviceSend(stack.transport, req(MSG.TIMELINE_REQ, { ...SEED, count: 20 }));
    await waitFor(() => stack.device.ofType(MSG.TIMELINE).length === 1);

    const raw = stack.device.rawOfType(MSG.TIMELINE, 1);
    assert.ok(raw.length > 1, `20KB 时间线必须拆多片，实际 ${raw.length} 片`);
    assert.deepEqual(
      raw.map((m) => m.part),
      Array.from({ length: raw.length }, (_, i) => i + 1),
      'part 必须从 1 连续升序，且发送顺序不可乱',
    );
    for (const part of raw) {
      assert.ok(
        Buffer.byteLength(JSON.stringify(part), 'utf8') <= MAX_MESSAGE_BYTES_CEILING,
        `part ${part.part} 超过单条上限`,
      );
    }
    assert.ok(
      raw.some((part) => part.entries.length > 1),
      '至少一片应包含多条：否则拆分退化成「一片一条」，件数一多就会超出 parts 上限',
    );
    assert.ok(
      raw.length < expected.length,
      `20KB 时间线应远少于 ${expected.length} 片（实际 ${raw.length} 片）`,
    );
    assert.ok(
      raw.some((part) => Buffer.byteLength(JSON.stringify(part), 'utf8') >= 8000),
      '至少有一片必须接近 8160 上限（防止拆分退化成「一片一条」也全绿）',
    );

    const assembled = stack.device.ofType(MSG.TIMELINE)[0];
    assert.equal(assembled.entries.length, 20);
    assert.deepEqual(assembled.entries, expected, '拼回的 entries 必须与主机缓冲逐条相等');
    assert.equal(assembled.dropped, 0, '超长只能拆片，不许裁条目');
    assert.equal(assembled.hasMore, false);
    assert.equal(stack.pull.stats.dropped, 0);
  });

  test('4. balance 成功：字段齐全；失败：只回 notice，全程没有 balance', async (t) => {
    // 4a 成功
    const okStack = await setup(t, {
      balanceProvider: () => ({ totalBalance: 42.75, recharge: 40, bonus: 2.75 }),
    });
    deviceSend(okStack.transport, req(MSG.BALANCE_REQ));
    await waitFor(() => okStack.device.ofType(MSG.BALANCE).length === 1);

    const balance = okStack.device.ofType(MSG.BALANCE)[0];
    assert.deepEqual(balance, {
      type: MSG.BALANCE,
      currency: 'CNY',
      totalBalance: '42.75',
      recharge: '40',
      bonus: '2.75',
    });
    assert.equal(Object.hasOwn(balance, 'todayUsed'), false);
    assert.equal(okStack.device.ofType(MSG.NOTICE).length, 0);

    // 4b 失败：独立栈，确保整个用例期间一条 balance 都不存在
    const failStack = await setup(t, {
      balanceProvider: () => {
        throw new Error('网络不通');
      },
    });
    deviceSend(failStack.transport, req(MSG.BALANCE_REQ));
    await waitFor(() => failStack.device.ofType(MSG.NOTICE).length === 1);

    const notice = failStack.device.ofType(MSG.NOTICE)[0];
    assert.deepEqual(notice, {
      type: MSG.NOTICE,
      text: '未获取到余额：网络不通',
    });
    assert.equal(failStack.device.ofType(MSG.BALANCE).length, 0);
    assert.equal(failStack.pull.stats.balance, 0);
    assert.equal(failStack.pull.stats.notices, 1);
  });

  test('5. 拉取中断链：不补发、无 unhandledRejection、重连后 ver 从 1 重新开始', async (t) => {
    const stack = await setup(t);
    seedLongTimeline(stack.timeline);

    const unhandled = [];
    const onUnhandled = (err) => unhandled.push(err);
    process.on('unhandledRejection', onUnhandled);
    t.after(() => process.off('unhandledRejection', onUnhandled));

    let disconnected = false;
    stack.device.onPart = (message) => {
      // 第一片刚被主机发到线上、仍等 ACK 时掐断链路。
      if (disconnected || message.type !== MSG.TIMELINE || message.part !== 1) return;
      disconnected = true;
      // 主机刚发完第一片、仍在等 ACK 时把链路掐掉；用微任务抢在
      // MockTransport 的投递定时器之前，确保断链发生在「在途」而不是事后。
      queueMicrotask(() => stack.transport.simulateDisconnect('拉取中断链'));
    };

    deviceSend(stack.transport, req(MSG.TIMELINE_REQ, { ...SEED, count: 20 }));
    await waitFor(() => stack.device.rawOfType(MSG.TIMELINE, 1).length >= 1);
    await waitFor(() => disconnected);
    await waitFor(() => stack.link.ready === true, 5000);

    const partsWhileDown = stack.device.rawOfType(MSG.TIMELINE, 1).length;
    assert.equal(partsWhileDown, 1, `断链后不得继续补发，实际已发 ${partsWhileDown} 片`);
    assert.equal(stack.pull.stats.timeline, 1);

    // 重连不补发：等到 ready 后旧应答不能自己冒出来。
    await new Promise((r) => setImmediate(r));
    assert.equal(stack.device.rawOfType(MSG.TIMELINE, 1).length, 1);

    deviceSend(stack.transport, req(MSG.TIMELINE_REQ, { ...SEED, count: 20 }));
    await waitFor(() => stack.device.ofType(MSG.TIMELINE).length === 1);

    const resumed = stack.device.ofType(MSG.TIMELINE)[0];
    assert.equal(resumed.ver, 1, '断链归零后，新连接的 timeline ver 必须从 1 开始');
    assert.equal(resumed.entries.length, 20);
    assert.equal(stack.device.errors.length, 0, stack.device.errors.map(String).join('；'));

    await new Promise((r) => setImmediate(r));
    assert.deepEqual(unhandled, [], `出现 unhandledRejection：${unhandled.map(String).join('；')}`);
  });

  test('6. 未 ready 时的 *.req：不发任何应答、不吃 ver', async (t) => {
    // autoRespond:false → 连接已建立但设备不主动 hello，握手停在 idle。
    const stack = await setup(t, { autoRespond: false, waitReady: false });
    await waitFor(() => stack.link.state === 'connected' && stack.link.ready === false);

    for (const type of [MSG.SESSION_LIST_REQ, MSG.TIMELINE_REQ, MSG.BALANCE_REQ]) {
      deviceSend(stack.transport, req(type));
    }

    // 纵深防御：即便请求绕过握手层直接落到能力层，Pull 自己也不得发送、不得吃 ver。
    // （真实链路上握手会先吞掉这些请求；这里锁住 Pull 的 ready 守卫本身。）
    for (const type of [MSG.SESSION_LIST_REQ, MSG.TIMELINE_REQ, MSG.BALANCE_REQ]) {
      assert.equal(stack.pull.handle(type, {}), true);
    }

    // 完成握手；随后再发一条 session.list.req 作为同步点。
    deviceSend(stack.transport, {
      type: MSG.HELLO,
      proto: 2,
      caps: 63,
      maxPayload: 8192,
      fw: '2.0.0-mock',
      deviceId: TRUSTED_DEVICE.deviceId,
      token: TRUSTED_DEVICE.token,
    });
    await waitFor(() => stack.link.ready === true, 3000);

    deviceSend(stack.transport, req(MSG.SESSION_LIST_REQ));
    await waitFor(() => stack.device.ofType(MSG.SESSION_LIST).length === 1);

    assert.equal(stack.device.ofType(MSG.SESSION_LIST).length, 1, '握手前的请求不得产生应答');
    assert.equal(stack.device.ofType(MSG.TIMELINE).length, 0);
    assert.equal(stack.device.ofType(MSG.BALANCE).length, 0);
    assert.equal(stack.device.ofType(MSG.NOTICE).length, 0);
    assert.equal(stack.device.ofType(MSG.SESSION_LIST)[0].ver, 1, 'ver 不得被未 ready 的请求吃掉');
    assert.equal(stack.pull.stats.requests, 1, '未 ready 的请求不进入统计');
    assert.equal(stack.server.stats.unknownType, 0, '请求归 Pull 管，不能落成 unknown_type');
  });
});
