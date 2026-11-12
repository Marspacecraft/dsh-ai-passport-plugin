/**
 * Task 30 · api/pull.js 拉取能力 — 单元测试（TDD）
 *
 * 覆盖 docs/04 Task 30 的验收：
 *   1. types 恰为三个 req 类型；handle 返回 true 表示已处理。
 *   2. session.list 带 ver/part/parts，sessions[] 与同刻 session.state 深比较相等。
 *   3. 共享快照：push 与 pull 都走 buildSessions（既有 push 测试不改）。
 *   4. timeline：sessionId 回填、seq 升序、hasMore 只在被 count 截断时为 true。
 *   5. 超 maxMessageBytes 拆多片且 dropped=0；仅单条自身超限才丢弃并计数。
 *   6. balance：注入 provider；失败回 notice{text}，不伪造 0，无 todayUsed。
 *   7. ver 按类型独立、ready/断链归零；未 ready 不消耗 ver、不 send。
 *   8. 断链作废在途应答、重连不补发、无 unhandledRejection。
 *   9. count 非法归一；未知 sessionId 回空结果。
 *
 * 全部假 link / 假 host / 真实 Timeline，不碰真实链路与定时器。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Buffer } from 'node:buffer';

import { PullCapability } from '../../src/api/pull.js';
import { PushCapability } from '../../src/api/push.js';
import { buildSessions } from '../../src/api/snapshot.js';
import { Timeline } from '../../src/host/timeline.js';
import { MSG } from '../../src/wire/constants.js';

// ---------------------------------------------------------------------------
// 测试基建
// ---------------------------------------------------------------------------

function makeLog() {
  const entries = [];
  const push = (level) => (...args) => entries.push({ level, args });
  return { entries, debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') };
}

class FakeLink extends EventEmitter {
  constructor({ ready = true, sendImpl = null, maxPayload = 8160 } = {}) {
    super();
    this.ready = ready;
    this.sent = [];
    this.sendImpl = sendImpl;
    this.info = { maxPayload };
  }

  send(type, payload, options = {}) {
    this.sent.push({ type, payload, options });
    if (this.sendImpl) return this.sendImpl(type, payload, options);
    return Promise.resolve();
  }
}

function makeHost(sessions = []) {
  return {
    sessions: {
      snapshot: () => ({ sessions: sessions.map((session) => ({ ...session })) }),
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const byPart = (messages) =>
  [...messages].sort((a, b) => (a.payload.part ?? 0) - (b.payload.part ?? 0));

function messagesOf(link, type) {
  return link.sent.filter((entry) => entry.type === type);
}

function makeTimeline(count = 0, { textLength = 20 } = {}) {
  const timeline = new Timeline({ limit: 20 });
  for (let index = 1; index <= count; index += 1) {
    if (index % 2 === 1) {
      timeline.append('s1', { kind: 'reasoning', text: `思考 ${index} ` + 'a'.repeat(textLength) });
    } else {
      timeline.append('s1', { kind: 'tool', name: 'bash', args: { command: `npm test ${index}` } });
    }
  }
  return timeline;
}

function makePull({ link, host = makeHost(), timeline = new Timeline(), balanceProvider, maxMessageBytes } = {}) {
  const actualLink = link ?? new FakeLink();
  return new PullCapability({
    link: actualLink,
    host,
    timeline,
    balanceProvider,
    maxMessageBytes,
    log: makeLog(),
  });
}

function makeSession(id, overrides = {}) {
  return {
    id,
    role: 'main',
    state: 'running',
    title: `会话 ${id}`,
    startedAt: 1000,
    attention: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 类型与分发表
// ---------------------------------------------------------------------------

describe('PullCapability · types / handle', () => {
  test('types 恰为 session.list.req、timeline.req、balance.req', () => {
    const pull = makePull();
    assert.deepEqual(pull.types, ['session.list.req', 'timeline.req', 'balance.req']);
  });

  test('handle 对三个类型都返回 true，未知类型返回 false', () => {
    const pull = makePull();
    assert.equal(pull.handle(MSG.SESSION_LIST_REQ, {}), true);
    assert.equal(pull.handle(MSG.TIMELINE_REQ, { sessionId: 's1' }), true);
    assert.equal(pull.handle(MSG.BALANCE_REQ, {}), true);
    assert.equal(pull.handle('session.state', {}), false);
    assert.equal(pull.handle(undefined, {}), false);
  });

  test('未 ready：返回 true 但绝不 send、不消耗 ver（M4-F1）', () => {
    const link = new FakeLink({ ready: false });
    const pull = makePull({ link });

    assert.equal(pull.handle(MSG.SESSION_LIST_REQ, {}), true);
    assert.equal(pull.handle(MSG.TIMELINE_REQ, { sessionId: 's1' }), true);
    assert.equal(pull.handle(MSG.BALANCE_REQ, {}), true);
    assert.equal(link.sent.length, 0);
    assert.equal(pull.stats.requests, 0);

    link.ready = true;
    pull.onLinkReady();
    pull.handle(MSG.SESSION_LIST_REQ, {});
    assert.equal(link.sent.length, 1);
    assert.equal(link.sent[0].payload.ver, 1);
  });
});

// ---------------------------------------------------------------------------
// session.list 与共享快照
// ---------------------------------------------------------------------------

describe('PullCapability · session.list', () => {
  test('应答带 ver/part/parts，内容与 host 快照逐字段一致', () => {
    const sessions = [makeSession('s1'), makeSession('s2', { role: 'sub', state: 'done' })];
    const host = makeHost(sessions);
    const link = new FakeLink();
    const pull = makePull({ link, host });

    pull.handle(MSG.SESSION_LIST_REQ, {});
    const sent = messagesOf(link, MSG.SESSION_LIST);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].payload.type, MSG.SESSION_LIST);
    assert.equal(sent[0].payload.ver, 1);
    assert.equal(sent[0].payload.part, 1);
    assert.equal(sent[0].payload.parts, 1);
    assert.deepEqual(sent[0].payload.sessions, sessions);
  });

  test('同一假 host 驱动 push 与 pull：两条消息的 sessions[] 深比较相等', () => {
    const sessions = [
      makeSession('s1', { attention: 'approval', elapsedMs: 1200 }),
      makeSession('s2', { role: 'sub', parentId: 's1', model: 'deepseek' }),
    ];
    const host = makeHost(sessions);
    const link = new FakeLink();

    const push = new PushCapability({ link, host, log: makeLog() });
    const pull = makePull({ link, host });

    push.onSessionsChanged();
    pull.handle(MSG.SESSION_LIST_REQ, {});

    const stateMsg = messagesOf(link, MSG.SESSION_STATE)[0].payload;
    const listMsg = messagesOf(link, MSG.SESSION_LIST)[0].payload;
    assert.deepEqual(listMsg.sessions, stateMsg.sessions);
    assert.deepEqual(listMsg.sessions, buildSessions(host.sessions.snapshot()));
    assert.equal(listMsg.sessions.length, 2);
  });

  test('buildSessions 是纯透传：数组原样返回，非法输入退回空数组', () => {
    const list = [{ id: 's1' }];
    assert.equal(buildSessions({ sessions: list }), list);
    assert.equal(buildSessions(list), list);
    assert.deepEqual(buildSessions(null), []);
    assert.deepEqual(buildSessions({}), []);
    assert.deepEqual(buildSessions({ sessions: null }), []);
  });

  test('ver 每次应答递增；session.list 与 timeline 互不干扰', () => {
    const host = makeHost([makeSession('s1')]);
    const link = new FakeLink();
    const timeline = makeTimeline(3);
    const pull = makePull({ link, host, timeline });

    pull.handle(MSG.SESSION_LIST_REQ, {});
    pull.handle(MSG.SESSION_LIST_REQ, {});
    pull.handle(MSG.TIMELINE_REQ, { sessionId: 's1', count: 3 });

    const listVers = messagesOf(link, MSG.SESSION_LIST).map((entry) => entry.payload.ver);
    const timelineVers = messagesOf(link, MSG.TIMELINE).map((entry) => entry.payload.ver);
    assert.deepEqual(listVers, [1, 2]);
    assert.deepEqual(timelineVers, [1]);
  });
});

// ---------------------------------------------------------------------------
// timeline
// ---------------------------------------------------------------------------

describe('PullCapability · timeline', () => {
  test('sessionId 回填、entries 按 seq 升序；count=5 有 20 条 → hasMore=true', () => {
    const timeline = makeTimeline(20);
    const link = new FakeLink();
    const pull = makePull({ link, timeline });

    pull.handle(MSG.TIMELINE_REQ, { sessionId: 's1', count: 5 });
    const payload = messagesOf(link, MSG.TIMELINE)[0].payload;

    assert.equal(payload.sessionId, 's1');
    assert.equal(payload.dropped, 0);
    assert.equal(payload.hasMore, true);
    assert.equal(payload.ver, 1);
    assert.equal(payload.part, 1);
    assert.equal(payload.parts, 1);
    assert.equal(payload.entries.length, 5);
    assert.deepEqual(
      payload.entries.map((entry) => entry.seq),
      [16, 17, 18, 19, 20],
    );
  });

  test('count=20（缓冲满）→ hasMore=false，拿全 20 条', () => {
    const timeline = makeTimeline(20);
    const link = new FakeLink();
    const pull = makePull({ link, timeline });

    pull.handle(MSG.TIMELINE_REQ, { sessionId: 's1', count: 20 });
    const payload = messagesOf(link, MSG.TIMELINE)[0].payload;
    assert.equal(payload.entries.length, 20);
    assert.equal(payload.hasMore, false);
  });

  test('count 非法（0 / -3 / "abc" / 1e9）归一到 [1, limit]，不抛错', () => {
    const timeline = makeTimeline(20);
    const link = new FakeLink();
    const pull = makePull({ link, timeline });

    for (const count of [0, -3, 'abc', 1e9]) {
      assert.doesNotThrow(() => pull.handle(MSG.TIMELINE_REQ, { sessionId: 's1', count }));
    }
    const payloads = messagesOf(link, MSG.TIMELINE).map((entry) => entry.payload);
    assert.deepEqual(
      payloads.map((payload) => payload.entries.length),
      [20, 20, 20, 20],
    );
    for (const payload of payloads) assert.equal(payload.hasMore, false);
  });

  test('未知 sessionId → 空 entries + hasMore:false + dropped:0，不报错', () => {
    const link = new FakeLink();
    const pull = makePull({ link, timeline: makeTimeline(5) });

    assert.doesNotThrow(() => pull.handle(MSG.TIMELINE_REQ, { sessionId: 'missing', count: 10 }));
    const sent = messagesOf(link, MSG.TIMELINE);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].payload.sessionId, 'missing');
    assert.deepEqual(sent[0].payload.entries, []);
    assert.equal(sent[0].payload.hasMore, false);
    assert.equal(sent[0].payload.dropped, 0);
  });

  test('超 maxMessageBytes：拆多 part 且 dropped=0，拼接后逐条相等', async () => {
    const timeline = makeTimeline(20, { textLength: 900 });
    const link = new FakeLink({ maxPayload: 1200 });
    const pull = makePull({ link, timeline, maxMessageBytes: 1200 });

    pull.handle(MSG.TIMELINE_REQ, { sessionId: 's1', count: 20 });
    await flush();

    const sent = byPart(messagesOf(link, MSG.TIMELINE));
    assert.ok(sent.length > 1, `应拆多片，实际 ${sent.length}`);
    for (const entry of sent) {
      assert.ok(Buffer.byteLength(JSON.stringify(entry.payload), 'utf8') <= 1200);
      assert.equal(entry.payload.dropped, 0);
      assert.equal(entry.payload.hasMore, false);
      assert.equal(entry.payload.sessionId, 's1');
    }
    assert.deepEqual(
      sent.map((entry) => entry.payload.part),
      Array.from({ length: sent.length }, (_, index) => index + 1),
    );
    assert.deepEqual(
      sent.flatMap((entry) => entry.payload.entries),
      timeline.recent('s1', 20).entries,
    );
  });

  test('仅单条自身超限：整条丢弃计入 dropped，其余条目仍按序送达（不截断）', async () => {
    const timeline = new Timeline({ limit: 20 });
    timeline.append('s1', { kind: 'reasoning', text: 'ok-1' });
    timeline.append('s1', { kind: 'reasoning', text: 'x'.repeat(3000) });
    timeline.append('s1', { kind: 'tool', name: 'bash', args: { command: 'echo hi' } });
    timeline.append('s1', { kind: 'reasoning', text: 'ok-2' });

    const link = new FakeLink({ maxPayload: 600 });
    const pull = makePull({ link, timeline, maxMessageBytes: 600 });

    pull.handle(MSG.TIMELINE_REQ, { sessionId: 's1', count: 20 });
    await flush();

    const sent = byPart(messagesOf(link, MSG.TIMELINE));
    const delivered = sent.flatMap((entry) => entry.payload.entries);
    assert.equal(sent[0].payload.dropped, 1);
    for (const entry of sent) assert.equal(entry.payload.dropped, 1);
    assert.deepEqual(
      delivered.map((entry) => entry.seq),
      [1, 3, 4],
    );
    assert.equal(delivered.some((entry) => entry.text?.length > 100), false);
  });
  test('header 无法容纳：warn + sendErrors，不发任何片且无 unhandledRejection', async () => {
    const timeline = new Timeline({ limit: 20 });
    timeline.append('s1', { kind: 'reasoning', text: 'hello' });
    const link = new FakeLink();
    const log = makeLog();
    const pull = new PullCapability({
      link,
      host: makeHost(),
      timeline,
      maxMessageBytes: 90,
      log,
    });

    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      pull.handle(MSG.TIMELINE_REQ, { sessionId: 's1', count: 20 });
      await flush();
      await flush();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    assert.equal(link.sent.length, 0, 'header 放不下时不得发送任何片');
    assert.equal(pull.stats.sendErrors, 1);
    assert.equal(pull.stats.dropped, 0);
    assert.equal(unhandled.length, 0);
    assert.ok(
      log.entries.some(
        (entry) => entry.level === 'warn' && String(entry.args[0]).includes('header 无法容纳'),
      ),
      '必须留下可诊断的 warn 日志',
    );
  });
});

describe('PullCapability · balance', () => {
  test('成功后走注入 provider，字段齐且不含 todayUsed', () => {
    const link = new FakeLink();
    const pull = makePull({
      link,
      balanceProvider: () => ({
        currency: 'CNY',
        totalBalance: '42.750000',
        recharge: '40.000000',
        bonus: '2.750000',
      }),
    });

    pull.handle(MSG.BALANCE_REQ, {});
    const sent = messagesOf(link, MSG.BALANCE);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].payload, {
      type: MSG.BALANCE,
      currency: 'CNY',
      totalBalance: '42.750000',
      recharge: '40.000000',
      bonus: '2.750000',
    });
    assert.equal(Object.hasOwn(sent[0].payload, 'todayUsed'), false);
  });

  test('异步 provider 成功：await 后发出 balance', async () => {
    const link = new FakeLink();
    const pull = makePull({
      link,
      balanceProvider: { getBalance: async () => ({ totalBalance: 1, recharge: 0, bonus: 1 }) },
    });

    pull.handle(MSG.BALANCE_REQ, {});
    assert.equal(messagesOf(link, MSG.BALANCE).length, 0);
    await flush();
    const payload = messagesOf(link, MSG.BALANCE)[0].payload;
    assert.deepEqual(payload, {
      type: MSG.BALANCE,
      currency: 'CNY',
      totalBalance: '1',
      recharge: '0',
      bonus: '1',
    });
  });

  test('provider 抛错 → 只发 notice{text}，绝不伪造 0 或 balance', () => {
    const link = new FakeLink();
    const pull = makePull({
      link,
      balanceProvider: () => {
        throw new Error('网络不通');
      },
    });

    pull.handle(MSG.BALANCE_REQ, {});
    assert.equal(messagesOf(link, MSG.BALANCE).length, 0);
    const notices = messagesOf(link, MSG.NOTICE);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].payload.type, MSG.NOTICE);
    assert.match(notices[0].payload.text, /网络不通/);
    assert.match(notices[0].payload.text, /未获取到余额/);
    assert.equal(Object.hasOwn(notices[0].payload, 'totalBalance'), false);
    assert.equal(Object.hasOwn(notices[0].payload, 'todayUsed'), false);
  });

  test('provider 返回字段不完整 → notice，不补 0', () => {
    const link = new FakeLink();
    const pull = makePull({ link, balanceProvider: () => ({ totalBalance: '1' }) });

    pull.handle(MSG.BALANCE_REQ, {});
    assert.equal(messagesOf(link, MSG.BALANCE).length, 0);
    assert.equal(messagesOf(link, MSG.NOTICE).length, 1);
  });

  test('未配置 provider → notice，不抛', () => {
    const link = new FakeLink();
    const pull = makePull({ link });
    assert.doesNotThrow(() => pull.handle(MSG.BALANCE_REQ, {}));
    assert.equal(messagesOf(link, MSG.BALANCE).length, 0);
    assert.match(messagesOf(link, MSG.NOTICE)[0].payload.text, /未配置/);
  });
});

// ---------------------------------------------------------------------------
// ver 归零 / 断链 / 无 unhandled
// ---------------------------------------------------------------------------

describe('PullCapability · 连接生命周期', () => {
  test('onLinkReady 与 onDisconnected 都把 ver 归零（各类型独立）', () => {
    const host = makeHost([makeSession('s1')]);
    const timeline = makeTimeline(3);
    const link = new FakeLink();
    const pull = makePull({ link, host, timeline });

    pull.handle(MSG.SESSION_LIST_REQ, {});
    pull.handle(MSG.SESSION_LIST_REQ, {});
    pull.handle(MSG.TIMELINE_REQ, { sessionId: 's1', count: 3 });

    pull.onLinkReady();
    pull.handle(MSG.SESSION_LIST_REQ, {});
    pull.handle(MSG.TIMELINE_REQ, { sessionId: 's1', count: 3 });
    assert.equal(messagesOf(link, MSG.SESSION_LIST).at(-1).payload.ver, 1);
    assert.equal(messagesOf(link, MSG.TIMELINE).at(-1).payload.ver, 1);

    pull.handle(MSG.SESSION_LIST_REQ, {});
    pull.onDisconnected();
    pull.handle(MSG.SESSION_LIST_REQ, {});
    assert.equal(messagesOf(link, MSG.SESSION_LIST).at(-1).payload.ver, 1);
  });

  test('断链作废在途应答：后续片不补发，重连后也不补发', async () => {
    const sessions = Array.from({ length: 40 }, (_, index) =>
      makeSession(`s${index}`, { title: 't'.repeat(120) }),
    );
    const host = makeHost(sessions);
    const gate = deferred();
    const link = new FakeLink({ sendImpl: () => gate.promise });
    const pull = makePull({ link, host, maxMessageBytes: 600 });

    pull.handle(MSG.SESSION_LIST_REQ, {});
    assert.equal(messagesOf(link, MSG.SESSION_LIST).length, 1);

    pull.onDisconnected();
    link.ready = false;
    pull.onLinkReady();
    link.ready = true;

    gate.resolve();
    await flush();
    await flush();

    // 只有断链前已发出的第一片；其余片既不补发，也不在重连后重发。
    assert.equal(messagesOf(link, MSG.SESSION_LIST).length, 1);
  });

  test('发送拒绝不会变成 unhandledRejection，且不重试', async () => {
    let unhandled = 0;
    const onUnhandled = () => {
      unhandled += 1;
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const link = new FakeLink({
        sendImpl: () => Promise.reject(new Error('NOT_CONNECTED')),
      });
      const pull = makePull({ link, host: makeHost([makeSession('s1')]) });

      pull.handle(MSG.SESSION_LIST_REQ, {});
      await flush();
      await flush();
      assert.equal(messagesOf(link, MSG.SESSION_LIST).length, 1);
      assert.equal(unhandled, 0);
      assert.equal(pull.stats.sendErrors, 1);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test('balance 的异步 provider 在断链后才返回 → 不发过期应答', async () => {
    const gate = deferred();
    const link = new FakeLink();
    const pull = makePull({ link, balanceProvider: () => gate.promise });

    pull.handle(MSG.BALANCE_REQ, {});
    pull.onDisconnected();
    link.ready = false;
    pull.onLinkReady();
    link.ready = true;

    gate.resolve({ totalBalance: '1', recharge: '0', bonus: '1' });
    await flush();
    assert.equal(messagesOf(link, MSG.BALANCE).length, 0);
    assert.equal(messagesOf(link, MSG.NOTICE).length, 0);
  });

  test('dispose 后 handle 不再受理', () => {
    const link = new FakeLink();
    const pull = makePull({ link });
    pull.dispose();
    assert.equal(pull.handle(MSG.SESSION_LIST_REQ, {}), false);
    assert.equal(link.sent.length, 0);
  });
});
