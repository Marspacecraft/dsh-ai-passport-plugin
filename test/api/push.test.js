/**
 * Task 20 · api/push.js 状态推送 — 单元测试（TDD）
 *
 * 覆盖 docs/04 Task 20 中 push 负责的 9 条验收：
 *   1. session.state 全量快照；ver 单连接内从 1 单调递增，断链重置。
 *   2. 内容签名去重（覆盖 sessions 全部对外字段，改 elapsedMs 也要重发）。
 *   3. 500ms 尾沿节流：窗口内多次变化只保留最后一份，1 秒内最多 2 次。
 *   4. attention none→approval/question 立即推送，绕过节流（有对照用例）。
 *   5. session.result 不节流、不去重内容、按 (sessionId,turnId) 只发一次。
 *   6. 断链清计时器 / 重置 ver / 清签名；重连重推一次全量快照。
 *   7. 超 maxMessageBytes：state 按 part 拆分；result 截断 + truncated=1 不拆分。
 *   8. 未 ready 时 link.send 抛 NOT_CONNECTED：push 吞掉并 warn，不产生
 *      unhandledRejection（未 ready 的业务消息本来就会被 link 握手层挡住）。
 *
 * 全部用假时钟 + 假 link + 假 host.sessions，不依赖真实链路。
 */

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { ApiServer } from '../../src/api/server.js';
import { PushCapability } from '../../src/api/push.js';
import { MSG, PUSH_MIN_INTERVAL_MS } from '../../src/wire/constants.js';
import { WireError, ERR } from '../../src/wire/errors.js';

// ---------------------------------------------------------------------------
// 测试基建
// ---------------------------------------------------------------------------

/** 假时钟：与 test/link/link.test.js 同款（now/setTimer/clearTimer/advance）。 */
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

function makeLog() {
  const entries = [];
  const push = (level) => (...args) => entries.push({ level, args });
  return {
    entries,
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
  };
}

function logText(entry) {
  return entry.args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
}

class FakeLink extends EventEmitter {
  constructor({ sendImpl, ready = true } = {}) {
    super();
    this.sent = [];
    this.info = { maxPayload: 8160 };
    this.sendImpl = sendImpl ?? null;
    this.ready = ready;
  }

  async send(type, payload, options = {}) {
    this.sent.push({ type, payload, options });
    if (this.sendImpl) return this.sendImpl(type, payload, options);
    return undefined;
  }
}

class FakeSessions extends EventEmitter {
  constructor() {
    super();
    this.list = [];
  }

  snapshot() {
    return { sessions: this.list.map((s) => ({ ...s })) };
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function makeSession(overrides = {}) {
  return {
    id: 's1',
    role: 'main',
    state: 'running',
    title: '修 bug',
    model: 'claude',
    cwd: '/work',
    elapsedMs: 1000,
    attention: 'none',
    ...overrides,
  };
}

function stateSends(link) {
  return link.sent.filter((s) => s.type === MSG.SESSION_STATE);
}

function resultSends(link) {
  return link.sent.filter((s) => s.type === MSG.SESSION_RESULT);
}

/** 组装 server + push + 假链路，并启动订阅。 */
async function setup({ maxMessageBytes } = {}) {
  const clock = makeClock();
  const link = new FakeLink();
  const log = makeLog();
  const sessions = new FakeSessions();
  const host = { sessions };
  const push = new PushCapability({
    link,
    log,
    host,
    now: clock.now,
    setTimer: clock.setTimer.bind(clock),
    clearTimer: clock.clearTimer.bind(clock),
    maxMessageBytes,
  });
  const server = new ApiServer({ link, log, host, capabilities: [push] });
  await server.start();
  return { clock, link, log, sessions, host, push, server };
}

// ---------------------------------------------------------------------------
// session.state · 快照 / ver / 去重
// ---------------------------------------------------------------------------

describe('PushCapability · session.state', () => {
  let ctx;

  afterEach(async () => {
    if (ctx) await ctx.server.stop();
    ctx = null;
  });

  test('首次变化推全量快照：ver=1、part=1、parts=1、ack=true', async () => {
    ctx = await setup();
    const { link, sessions } = ctx;
    const session = makeSession({ parentId: 'root' });
    sessions.list = [session];
    sessions.emit('changed');

    const sends = stateSends(link);
    assert.equal(sends.length, 1);
    assert.equal(sends[0].options.ack, true);
    assert.deepEqual(sends[0].payload, {
      type: MSG.SESSION_STATE,
      ver: 1,
      part: 1,
      parts: 1,
      sessions: [session],
    });
  });

  test('相同快照内容不重复发送（内容签名去重）', async () => {
    ctx = await setup();
    const { link, sessions, clock } = ctx;
    sessions.list = [makeSession()];
    sessions.emit('changed');
    assert.equal(stateSends(link).length, 1);

    clock.advance(1000);
    sessions.emit('changed'); // 内容完全一样
    assert.equal(stateSends(link).length, 1, '相同内容不应重发');
  });

  test('只改 elapsedMs 也会触发重发（签名覆盖全部对外字段）', async () => {
    ctx = await setup();
    const { link, sessions, clock } = ctx;
    sessions.list = [makeSession({ elapsedMs: 1000 })];
    sessions.emit('changed');

    clock.advance(1000);
    sessions.list = [makeSession({ elapsedMs: 2000 })];
    sessions.emit('changed');

    const sends = stateSends(link);
    assert.equal(sends.length, 2);
    assert.equal(sends[1].payload.sessions[0].elapsedMs, 2000);
    assert.equal(sends[1].payload.ver, 2, 'ver 随每次新快照递增');
  });
});

// ---------------------------------------------------------------------------
// 500ms 尾沿节流
// ---------------------------------------------------------------------------

describe('PushCapability · 500ms 尾沿节流', () => {
  let ctx;

  afterEach(async () => {
    if (ctx) await ctx.server.stop();
    ctx = null;
  });

  test('1 秒内多次变化只推送 2 次，且第二次是最新状态', async () => {
    ctx = await setup();
    const { link, sessions, clock } = ctx;
    sessions.list = [makeSession({ title: 'v0' })];
    sessions.emit('changed');
    assert.equal(stateSends(link).length, 1);

    for (const [i, ms] of [100, 200, 300, 400].entries()) {
      clock.advance(100);
      sessions.list = [makeSession({ title: `v${i + 1}` })];
      sessions.emit('changed');
    }
    // 窗口内不应有新的立即推送
    assert.equal(stateSends(link).length, 1);
    assert.equal(clock.pendingCount(), 1, '窗口内只保留一个尾沿计时器');

    clock.advance(100); // 到 t=500，计时器触发
    const sends = stateSends(link);
    assert.equal(sends.length, 2);
    assert.equal(sends[1].payload.sessions[0].title, 'v4', '只推最后一次状态');
    assert.equal(sends[1].payload.ver, 2);
    assert.equal(clock.pendingCount(), 0);

    clock.advance(500); // t=1000，没有新变化不应再推
    assert.equal(stateSends(link).length, 2);
  });

  test('窗口内多次变化不会排队堆积（只有一个尾沿计时器）', async () => {
    ctx = await setup();
    const { link, sessions, clock } = ctx;
    sessions.list = [makeSession()];
    sessions.emit('changed');

    for (let i = 0; i < 10; i += 1) {
      clock.advance(10);
      sessions.list = [makeSession({ title: `t${i}` })];
      sessions.emit('changed');
      assert.equal(clock.pendingCount(), 1, '任何时刻最多一个待触发的节流计时器');
    }
    assert.equal(stateSends(link).length, 1);
  });
});

// ---------------------------------------------------------------------------
// attention 跃迁
// ---------------------------------------------------------------------------

describe('PushCapability · attention 跃迁绕过节流', () => {
  let ctx;

  afterEach(async () => {
    if (ctx) await ctx.server.stop();
    ctx = null;
  });

  test('none → approval 立即推送，同时刻的普通字段变化被节流（对照）', async () => {
    ctx = await setup();
    const { link, sessions, clock } = ctx;
    sessions.list = [makeSession({ attention: 'none', title: 'a' })];
    sessions.emit('changed');
    assert.equal(stateSends(link).length, 1);

    clock.advance(100);
    sessions.list = [makeSession({ attention: 'none', title: 'b' })];
    sessions.emit('changed');
    assert.equal(stateSends(link).length, 1, '普通字段变化必须被节流');
    assert.equal(clock.pendingCount(), 1);

    clock.advance(100); // t=200，仍在 500ms 窗口内
    // 同一份快照里既有普通字段变化（title），又有 attention 跃迁：必须整体立即推
    sessions.list = [makeSession({ attention: 'approval', title: 'c' })];
    sessions.emit('changed');

    const sends = stateSends(link);
    assert.equal(sends.length, 2, 'attention 跃迁必须立即推送');
    assert.equal(sends[1].payload.sessions[0].attention, 'approval');
    assert.equal(sends[1].payload.sessions[0].title, 'c');
    assert.equal(sends[1].payload.ver, 2);
    assert.equal(clock.pendingCount(), 0, '立即推送后清掉待触发的节流计时器');
  });

  test('none → question 同样立即推送', async () => {
    ctx = await setup();
    const { link, sessions, clock } = ctx;
    sessions.list = [makeSession({ attention: 'none' })];
    sessions.emit('changed');

    clock.advance(50);
    sessions.list = [makeSession({ attention: 'question' })];
    sessions.emit('changed');

    assert.equal(stateSends(link).length, 2);
    assert.equal(stateSends(link)[1].payload.sessions[0].attention, 'question');
  });

  test('已是 approval 时普通字段变化仍按节流走', async () => {
    ctx = await setup();
    const { link, sessions, clock } = ctx;
    sessions.list = [makeSession({ attention: 'approval' })];
    sessions.emit('changed');
    assert.equal(stateSends(link).length, 1);

    clock.advance(100);
    sessions.list = [makeSession({ attention: 'approval', title: '变了' })];
    sessions.emit('changed');
    assert.equal(stateSends(link).length, 1, '不是 none→alert 的跃迁，不应立即推送');
    assert.equal(clock.pendingCount(), 1);
  });
});

// ---------------------------------------------------------------------------
// session.result
// ---------------------------------------------------------------------------

describe('PushCapability · session.result', () => {
  let ctx;

  afterEach(async () => {
    if (ctx) await ctx.server.stop();
    ctx = null;
  });

  test('节流窗口内仍立即发送，字段齐全且 parts=1', async () => {
    ctx = await setup();
    const { link, sessions, clock } = ctx;
    sessions.list = [makeSession()];
    sessions.emit('changed');
    assert.equal(stateSends(link).length, 1);

    clock.advance(10); // 远小于 500ms
    const ok = ctx.push.onSessionResult({
      sessionId: 's1',
      turnId: 't1',
      state: 'done',
      text: '完成',
      elapsedMs: 1234,
    });
    assert.equal(ok, true);

    const sends = resultSends(link);
    assert.equal(sends.length, 1, 'session.result 不受 500ms 节流');
    assert.deepEqual(sends[0].payload, {
      type: MSG.SESSION_RESULT,
      sessionId: 's1',
      ver: 1,
      part: 1,
      parts: 1,
      turnId: 't1',
      state: 'done',
      text: '完成',
      truncated: 0,
      elapsedMs: 1234,
      hostEpochSec: 0,
    });
    assert.equal(link.sent.length, 2);
  });

  test('同一 (sessionId,turnId) 只发一次；不同 turnId 的 ver 独立递增', async () => {
    ctx = await setup();
    const { link } = ctx;
    const push = ctx.push;

    push.onSessionResult({ sessionId: 's1', turnId: 't1', text: 'a' });
    push.onSessionResult({ sessionId: 's1', turnId: 't1', text: 'a' });
    assert.equal(resultSends(link).length, 1, '同一 turn 不重发');

    push.onSessionResult({ sessionId: 's1', turnId: 't2', text: 'b' });
    push.onSessionResult({ sessionId: 's2', turnId: 't1', text: 'c' });
    const sends = resultSends(link);
    assert.equal(sends.length, 3);
    assert.deepEqual(
      sends.map((s) => s.payload.ver),
      [1, 2, 3],
      'session.result 的 ver 按类型独立计数',
    );
    assert.equal(sends[1].payload.parts, 1);
  });

  test('host.sessions 的 result 事件接到 onSessionResult', async () => {
    ctx = await setup();
    const { link, sessions } = ctx;
    sessions.emit('result', { sessionId: 's1', turnId: 't9', text: '通过事件' });
    assert.equal(resultSends(link).length, 1);
    assert.equal(resultSends(link)[0].payload.turnId, 't9');
  });

  test('超 maxMessageBytes 时截断 text 并置 truncated=1，不拆分', async () => {
    ctx = await setup({ maxMessageBytes: 400 });
    const { link } = ctx;
    const text = '汉字'.repeat(300); // 600 字符 / 1800 字节
    ctx.push.onSessionResult({ sessionId: 's1', turnId: 't1', text });

    const sends = resultSends(link);
    assert.equal(sends.length, 1);
    const payload = sends[0].payload;
    assert.equal(payload.truncated, 1);
    assert.equal(payload.part, 1);
    assert.equal(payload.parts, 1, 'session.result 永不拆分');
    assert.ok(payload.text.length > 0);
    assert.ok(text.startsWith(payload.text), '保留开头');
    assert.ok(payload.text.length < text.length);
    assert.ok(
      Buffer.byteLength(JSON.stringify(payload), 'utf8') <= 400,
      '整条消息不得超过 maxMessageBytes',
    );
    assert.ok(!payload.text.includes('\uFFFD'), 'UTF-8 截断不能切出替换符');
  });

  test('未超限时 truncated=0，text 原样', async () => {
    ctx = await setup({ maxMessageBytes: 400 });
    const { link } = ctx;
    ctx.push.onSessionResult({ sessionId: 's1', turnId: 't1', text: '短文本' });
    assert.equal(resultSends(link)[0].payload.truncated, 0);
    assert.equal(resultSends(link)[0].payload.text, '短文本');
  });
});

// ---------------------------------------------------------------------------
// 断链 / 重连
// ---------------------------------------------------------------------------

describe('PushCapability · 断链与重连', () => {
  let ctx;

  afterEach(async () => {
    if (ctx) await ctx.server.stop();
    ctx = null;
  });

  test('断链清空节流计时器、重置 ver 与签名，重连重推全量快照', async () => {
    ctx = await setup();
    const { link, sessions, clock } = ctx;
    sessions.list = [makeSession({ title: 'a' })];
    sessions.emit('changed');
    assert.equal(stateSends(link).length, 1);

    clock.advance(100);
    sessions.list = [makeSession({ title: 'b' })];
    sessions.emit('changed');
    assert.equal(clock.pendingCount(), 1);

    link.emit('disconnected', { unexpected: true, reason: 'keepalive-timeout' });
    assert.equal(clock.pendingCount(), 0, '断链必须清空节流计时器');
    clock.advance(1000);
    assert.equal(stateSends(link).length, 1, '断链后不得再补发旧快照');

    // 重连（ready）后即使内容没变，也要重推一次全量快照，ver 从 1 重新开始
    link.emit('ready', { proto: 1, maxPayload: 8160 });
    const sends = stateSends(link);
    assert.equal(sends.length, 2);
    assert.equal(sends[1].payload.ver, 1, '重连后 ver 重置并从 1 开始');
    assert.equal(sends[1].payload.part, 1);
    assert.equal(sends[1].payload.parts, 1);
    assert.equal(sends[1].payload.sessions.length, 1);

    // 重连后的第一次真实变化也应从 ver=2 继续
    clock.advance(500);
    sessions.list = [makeSession({ title: 'c' })];
    sessions.emit('changed');
    assert.equal(stateSends(link).at(-1).payload.ver, 2);
  });

  test('断链期间发生的变化，重连 ready 时仍重推全量快照（签名强制失效）', async () => {
    ctx = await setup();
    const { link, sessions, clock } = ctx;
    sessions.list = [makeSession({ title: 'a' })];
    sessions.emit('changed');

    link.emit('disconnected', { unexpected: true, reason: 'x' });
    clock.advance(100);
    sessions.list = [makeSession({ title: '断链期间变了' })];
    sessions.emit('changed');
    const beforeReady = stateSends(link).length;

    link.emit('ready', {});
    const sends = stateSends(link);
    assert.equal(sends.length, beforeReady + 1, 'ready 必须无条件重推一次全量快照');
    const last = sends.at(-1);
    assert.equal(last.payload.sessions[0].title, '断链期间变了');
    assert.equal(last.payload.part, 1);
    assert.equal(last.payload.parts, 1);
  });

  test('断链不清 sentResults：同一 turn 重连后仍不重发', async () => {
    ctx = await setup();
    const { link, push } = ctx;
    push.onSessionResult({ sessionId: 's1', turnId: 't1', text: '结果' });
    assert.equal(resultSends(link).length, 1);

    link.emit('disconnected', { unexpected: true, reason: 'x' });
    push.onSessionResult({ sessionId: 's1', turnId: 't1', text: '结果' });
    assert.equal(resultSends(link).length, 1, '结果按 turn 去重，不落盘也不重发');
  });
});

// ---------------------------------------------------------------------------
// 拆分 / 未 ready / 杂项
// ---------------------------------------------------------------------------

describe('PushCapability · 拆分与边界', () => {
  let ctx;

  afterEach(async () => {
    if (ctx) await ctx.server.stop();
    ctx = null;
  });

  test('session.state 超 maxMessageBytes 时按 part 拆分，同 ver 且各片不超限', async () => {
    const maxMessageBytes = 600;
    ctx = await setup({ maxMessageBytes });
    const { link, sessions } = ctx;
    const list = Array.from({ length: 12 }, (_, i) =>
      makeSession({ id: `s${i}`, title: 'x'.repeat(50) }),
    );
    sessions.list = list;
    sessions.emit('changed');

    const sends = stateSends(link);
    assert.ok(sends.length > 1, '12 条会话应被拆成多片');
    const parts = sends[0].payload.parts;
    assert.equal(parts, sends.length);
    assert.deepEqual(
      sends.map((s) => s.payload.part),
      Array.from({ length: parts }, (_, i) => i + 1),
    );
    const versions = new Set(sends.map((s) => s.payload.ver));
    assert.deepEqual([...versions], [1], '同一次快照的所有 part 共用同一 ver');

    const collected = [];
    for (const send of sends) {
      assert.equal(send.payload.parts, parts);
      assert.equal(send.type, MSG.SESSION_STATE);
      assert.equal(send.options.ack, true);
      assert.ok(
        Buffer.byteLength(JSON.stringify(send.payload), 'utf8') <= maxMessageBytes,
        `part ${send.payload.part} 超过上限`,
      );
      collected.push(...send.payload.sessions);
    }
    assert.deepEqual(
      collected.map((s) => s.id),
      list.map((s) => s.id),
      '拆分后会话顺序与全集保持不变',
    );
  });

  test('未 ready：零发送，也不产生 unhandledRejection', async () => {
    let unhandled = 0;
    const onUnhandled = () => {
      unhandled += 1;
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const clock = makeClock();
      const log = makeLog();
      const link = new FakeLink({ ready: false });
      const sessions = new FakeSessions();
      sessions.list = [makeSession()];
      const push = new PushCapability({
        link,
        log,
        host: { sessions },
        now: clock.now,
        setTimer: clock.setTimer.bind(clock),
        clearTimer: clock.clearTimer.bind(clock),
      });

      assert.doesNotThrow(() => push.onSessionsChanged());
      await flush();
      await flush();

      assert.equal(stateSends(link).length, 0, '未 ready 时不得尝试推送业务消息');
      assert.equal(clock.pendingCount(), 0, '未 ready 时也不该挂节流计时器');
      assert.equal(unhandled, 0, '未 ready 不发送，自然不会有未处理的 rejection');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test('ready 前 changed → ready 后补推一次全量（ver=1，不丢首份快照）', async () => {
    const clock = makeClock();
    const log = makeLog();
    const link = new FakeLink({ ready: false });
    const sessions = new FakeSessions();
    sessions.list = [makeSession({ title: '配对前就存在' })];
    const push = new PushCapability({
      link,
      log,
      host: { sessions },
      now: clock.now,
      setTimer: clock.setTimer.bind(clock),
      clearTimer: clock.clearTimer.bind(clock),
    });

    push.onSessionsChanged();
    assert.equal(stateSends(link).length, 0);

    // 配对完成 / 握手成功：ready 由 false 翻为 true 后再通知能力。
    link.ready = true;
    push.onLinkReady();

    const sends = stateSends(link);
    assert.equal(sends.length, 1, 'ready 后必须补推一次全量');
    assert.equal(sends[0].payload.ver, 1, '首份全量 ver 从 1 开始，不为失败发送消耗编号');
    assert.equal(sends[0].payload.part, 1);
    assert.equal(sends[0].payload.parts, 1);
    assert.equal(sends[0].payload.sessions[0].title, '配对前就存在');

    // ready 后没有新变化：再次 ready 不重复推送。
    push.onLinkReady();
    assert.equal(stateSends(link).length, 1);
  });

  test('handle() 恒返回 false：push 没有上行消息类型', async () => {
    ctx = await setup();
    assert.equal(ctx.push.handle('session.cancel', {}), false);
    assert.equal(ctx.push.handle('anything', {}), false);
  });

  test('无变化时 onLinkReady 不会重复推送', async () => {
    ctx = await setup();
    const { link, sessions } = ctx;
    sessions.list = [makeSession()];
    sessions.emit('changed');
    assert.equal(stateSends(link).length, 1);

    link.emit('ready', {});
    assert.equal(stateSends(link).length, 1, '签名未变，ready 也不应重发');
  });
});
