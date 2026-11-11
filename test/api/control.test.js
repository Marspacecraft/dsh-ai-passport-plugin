// Task 23 · api/control.js — TDD
//
// 覆盖 docs/04 Task 23 中 control 负责的部分：
//   1. 分发表登记四个入口（session.cancel / session.input / approval.decide /
//      question.answer），每个都能被正确路由。
//   2. session.cancel → 通知宿主 → 回 session.cancel.ack{reqId, ok}；失败带 code。
//   3. session.input 是**唯一**设备→主机的分片组装路径：同 reqId 的片按 part 序号
//      拼装，收齐 part === parts 才投递并只回一次 ack；中间片不回。
//   4. 组装超时 10 秒：丢半成品且**不回 ack**；之后再来的旧片不能污染新批次。
//   5. approval.decide / question.answer 迟到一律忽略：不报错、不回包。

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { ApiServer } from '../../src/api/server.js';
import { ControlCapability } from '../../src/api/control.js';
import { MSG } from '../../src/wire/constants.js';

// ---------------------------------------------------------------------------
// 测试基建
// ---------------------------------------------------------------------------

class FakeLink extends EventEmitter {
  ready = true;
  info = { paired: true };
  sent = [];
  failSend = null;

  async send(type, payload, opts = {}) {
    if (this.failSend) throw this.failSend;
    this.sent.push({ type, payload, opts });
    return { msgId: this.sent.length };
  }

  ofType(type) {
    return this.sent.filter((m) => m.type === type);
  }
}

function makeLog() {
  const entries = [];
  const push = (level) => (...args) => entries.push({ level, text: args.map(String).join(' ') });
  return { entries, debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') };
}

/** 假时钟：只跑显式 advance 触发的定时器。 */
function makeClock() {
  let now = 0;
  let timers = [];
  return {
    now: () => now,
    setTimer(fn, delay) {
      const timer = { at: now + delay, fn, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) {
      if (timer) timer.cleared = true;
    },
    advance(ms) {
      now += ms;
      const due = timers
        .filter((t) => !t.cleared && t.at <= now)
        .sort((a, b) => a.at - b.at);
      timers = timers.filter((t) => t.cleared || t.at > now);
      for (const timer of due) {
        timer.cleared = true;
        timer.fn();
      }
    },
  };
}

function makeSessions({ existing = ['s1', 's2'], cancelResult = true } = {}) {
  const calls = [];
  const canceled = new Set();
  const sessions = {
    existing: new Set(existing),
    calls,
    canceled,
    has(id) {
      return sessions.existing.has(id);
    },
    async cancel(id) {
      calls.push(['cancel', id]);
      if (cancelResult instanceof Error) throw cancelResult;
      if (cancelResult === false) return false;
      if (cancelResult && typeof cancelResult === 'object') return cancelResult;
      canceled.add(id);
      return { ok: true };
    },
    async input(message) {
      calls.push(['input', message]);
      return true;
    },
  };
  return sessions;
}

function setup({
  sessions = makeSessions(),
  clock = makeClock(),
  assemblyTimeoutMs,
  approvals,
  questions,
} = {}) {
  const link = new FakeLink();
  const log = makeLog();
  const appr =
    approvals ??
    { calls: [], onDeviceDecide(payload) { this.calls.push(payload); return false; } };
  const qs =
    questions ??
    { calls: [], onDeviceAnswer(payload) { this.calls.push(payload); return false; } };
  const host = { sessions, approvals: appr, questions: qs };
  const control = new ControlCapability({
    link,
    log,
    host,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    assemblyTimeoutMs,
  });
  return { link, log, control, host, sessions, approvals: appr, questions: qs, clock };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const flush = async () => {
  await tick();
  await tick();
};

// ---------------------------------------------------------------------------
// 验收 1：分发表登记四个入口
// ---------------------------------------------------------------------------

describe('分发表登记四个控制入口', () => {
  test('四条上行消息都被路由到对应能力，且不产生 UNKNOWN_TYPE', async () => {
    const { link, control, sessions, approvals, questions } = setup();
    const server = new ApiServer({ link, capabilities: [control] });
    await server.start();

    link.emit('message', {
      type: MSG.SESSION_CANCEL,
      payload: { sessionId: 's1', reqId: 'c1' },
      msgId: 1,
    });
    link.emit('message', {
      type: MSG.SESSION_INPUT,
      payload: { sessionId: 's2', text: '继续', reqId: 'i1', part: 1, parts: 1 },
      msgId: 2,
    });
    link.emit('message', {
      type: MSG.APPROVAL_DECIDE,
      payload: { id: 'ap_1', decision: 'allow' },
      msgId: 3,
    });
    link.emit('message', {
      type: MSG.QUESTION_ANSWER,
      payload: { callId: 'q_1', action: 'submit', answers: [] },
      msgId: 4,
    });
    await flush();

    assert.deepEqual(
      sessions.calls.filter(([kind]) => kind === 'cancel'),
      [['cancel', 's1']],
      'session.cancel 应通知被取消的会话',
    );
    assert.deepEqual(
      sessions.calls.filter(([kind]) => kind === 'input'),
      [['input', { sessionId: 's2', text: '继续' }]],
      'session.input 应投递给宿主',
    );
    assert.equal(approvals.calls.length, 1, 'approval.decide 应交给 approvals');
    assert.equal(questions.calls.length, 1, 'question.answer 应交给 questions');
    assert.equal(server.stats.dispatched, 4, '四条消息都应算作已派发');
    assert.equal(server.stats.unknownType, 0, '不应落到 UNKNOWN_TYPE');
    assert.equal(link.ofType(MSG.NACK).length, 0, '不应回 nack');
  });
});

// ---------------------------------------------------------------------------
// 验收 2：session.cancel 回 ack
// ---------------------------------------------------------------------------

describe('session.cancel 回 ack', () => {
  test('成功：通知宿主取消并回 {reqId, ok:true}', async () => {
    const { link, control, sessions } = setup();
    await control.handle(MSG.SESSION_CANCEL, { sessionId: 's1', reqId: 'c1' });

    assert.deepEqual(sessions.calls, [['cancel', 's1']]);
    assert.equal(sessions.canceled.has('s1'), true, '会话应被标记为取消');
    const acks = link.ofType(MSG.SESSION_CANCEL_ACK);
    assert.equal(acks.length, 1, '只回一条 ack');
    assert.equal(acks[0].payload.reqId, 'c1');
    assert.equal(acks[0].payload.ok, true);
    assert.equal(acks[0].opts.ack, false, 'ack 本身不应再要求链路 ack');
  });

  test('宿主拒绝：ok:false 且带 code/message', async () => {
    const sessions = makeSessions({
      cancelResult: { ok: false, code: 'CANCEL_NOT_RUNNING', message: '该会话当前没有在执行' },
    });
    const { link, control } = setup({ sessions });
    await control.handle(MSG.SESSION_CANCEL, { sessionId: 's1', reqId: 'c2' });

    const [ack] = link.ofType(MSG.SESSION_CANCEL_ACK);
    assert.equal(ack.payload.ok, false);
    assert.equal(ack.payload.code, 'CANCEL_NOT_RUNNING');
    assert.equal(ack.payload.message, '该会话当前没有在执行');
    assert.equal(sessions.canceled.size, 0, '宿主拒绝不代表标记取消');
  });

  test('会话不存在：不发 cancel，回 CANCEL_NOT_FOUND', async () => {
    const sessions = makeSessions({ existing: ['s2'] });
    const { link, control } = setup({ sessions });
    await control.handle(MSG.SESSION_CANCEL, { sessionId: 's1', reqId: 'c3' });

    assert.deepEqual(sessions.calls, [], '不存在的会话不应调用 cancel');
    const [ack] = link.ofType(MSG.SESSION_CANCEL_ACK);
    assert.equal(ack.payload.ok, false);
    assert.equal(ack.payload.code, 'CANCEL_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// 验收 3/4：session.input 分片组装
// ---------------------------------------------------------------------------

describe('session.input 分片组装（唯一设备→主机方向）', () => {
  test('乱序到达仍按 part 序号拼装，收齐后只回一次 ack', async () => {
    const { link, control, sessions } = setup();

    await control.handle(MSG.SESSION_INPUT, {
      sessionId: 's1',
      text: '世界',
      reqId: 'r1',
      part: 2,
      parts: 2,
    });
    assert.equal(link.ofType(MSG.SESSION_INPUT_ACK).length, 0, '中间片不回 ack');
    assert.equal(sessions.calls.length, 0, '未收齐不投递');

    await control.handle(MSG.SESSION_INPUT, {
      sessionId: 's1',
      text: '你好',
      reqId: 'r1',
      part: 1,
      parts: 2,
    });

    assert.deepEqual(sessions.calls, [['input', { sessionId: 's1', text: '你好世界' }]]);
    const acks = link.ofType(MSG.SESSION_INPUT_ACK);
    assert.equal(acks.length, 1, '收齐后只回一次 ack');
    assert.equal(acks[0].payload.reqId, 'r1');
    assert.equal(acks[0].payload.ok, true);
  });

  test('缺省 parts/part 视为非法分片：INPUT_FAILED + warn，不投递', async () => {
    const { link, control, sessions, log } = setup();

    await control.handle(MSG.SESSION_INPUT, {
      sessionId: 's1',
      text: '单条消息也不能省 parts',
      reqId: 'missing-parts',
    });

    assert.deepEqual(sessions.calls, [], '不合法分片不得投递');
    assert.equal(control.pendingAssemblies, 0, '不得开批');
    const [ack] = link.ofType(MSG.SESSION_INPUT_ACK);
    assert.equal(ack.payload.ok, false);
    assert.equal(ack.payload.code, 'INPUT_FAILED');
    assert.ok(
      log.entries.some((e) => e.level === 'warn' && e.text.includes('part/parts')),
      '应留下可诊断的 warn',
    );
  });

  test('parts=3 时直到最后一片才回 ack，且总计一次', async () => {
    const { link, control, sessions } = setup();
    for (const [part, text] of [[1, 'a'], [2, 'b']]) {
      await control.handle(MSG.SESSION_INPUT, { sessionId: 's1', text, reqId: 'r3', part, parts: 3 });
      assert.equal(link.ofType(MSG.SESSION_INPUT_ACK).length, 0, `第 ${part} 片不应回 ack`);
    }
    await control.handle(MSG.SESSION_INPUT, {
      sessionId: 's1',
      text: 'c',
      reqId: 'r3',
      part: 3,
      parts: 3,
    });

    assert.deepEqual(sessions.calls, [['input', { sessionId: 's1', text: 'abc' }]]);
    assert.equal(link.ofType(MSG.SESSION_INPUT_ACK).length, 1);
    assert.equal(link.ofType(MSG.SESSION_INPUT_ACK)[0].payload.reqId, 'r3');
  });

  test('组装超时：丢半成品、不回 ack；旧片不污染新批次', async () => {
    const clock = makeClock();
    const { link, control, sessions } = setup({ clock });

    await control.handle(MSG.SESSION_INPUT, {
      sessionId: 's1',
      text: '半成品',
      reqId: 'old',
      part: 1,
      parts: 2,
    });
    clock.advance(10_001);
    await flush();

    assert.equal(control.pendingAssemblies, 0, '超时后应丢弃半成品');
    assert.equal(link.ofType(MSG.SESSION_INPUT_ACK).length, 0, '超时**不回** ack');

    // 新批次用新 reqId，正常投递。
    await control.handle(MSG.SESSION_INPUT, {
      sessionId: 's1',
      text: '新消息',
      reqId: 'new',
      part: 1,
      parts: 1,
    });
    assert.deepEqual(sessions.calls, [['input', { sessionId: 's1', text: '新消息' }]]);
    assert.equal(link.ofType(MSG.SESSION_INPUT_ACK).length, 1);

    // 旧批次的残留片晚到：丢弃，不影响新批次。
    await control.handle(MSG.SESSION_INPUT, {
      sessionId: 's1',
      text: '残留',
      reqId: 'old',
      part: 2,
      parts: 2,
    });
    // 即使旧 reqId 从 part=1 重新开始，也不能复活成新批次（必须换新 reqId）。
    await control.handle(MSG.SESSION_INPUT, {
      sessionId: 's1',
      text: '残留起头',
      reqId: 'old',
      part: 1,
      parts: 2,
    });
    assert.equal(control.pendingAssemblies, 0, '作废 reqId 不得再开新批次');
    assert.deepEqual(sessions.calls, [['input', { sessionId: 's1', text: '新消息' }]]);
    assert.equal(link.ofType(MSG.SESSION_INPUT_ACK).length, 1);
  });

  test('空文本：ok:false + INPUT_EMPTY_TEXT，不投递', async () => {
    const { link, control, sessions } = setup();
    await control.handle(MSG.SESSION_INPUT, { sessionId: 's1', text: '', reqId: 'e1', part: 1, parts: 1 });

    assert.deepEqual(sessions.calls, []);
    const [ack] = link.ofType(MSG.SESSION_INPUT_ACK);
    assert.equal(ack.payload.ok, false);
    assert.equal(ack.payload.code, 'INPUT_EMPTY_TEXT');
  });

  test('会话不存在：ok:false + INPUT_NO_SUCH_SESSION', async () => {
    const sessions = makeSessions({ existing: ['s2'] });
    const { link, control } = setup({ sessions });
    await control.handle(MSG.SESSION_INPUT, { sessionId: 's1', text: 'hi', reqId: 'n1', part: 1, parts: 1 });

    const [ack] = link.ofType(MSG.SESSION_INPUT_ACK);
    assert.equal(ack.payload.ok, false);
    assert.equal(ack.payload.code, 'INPUT_NO_SUCH_SESSION');
  });

  test('ack 发送失败只记日志，不抛 unhandledRejection', async () => {
    const { link, control, sessions } = setup();
    link.failSend = new Error('NOT_CONNECTED');

    await control.handle(MSG.SESSION_INPUT, { sessionId: 's1', text: 'hi', reqId: 'f1', part: 1, parts: 1 });
    assert.deepEqual(sessions.calls, [['input', { sessionId: 's1', text: 'hi' }]]);
    await flush();
  });
});

// ---------------------------------------------------------------------------
// 验收 5：迟到裁决忽略
// ---------------------------------------------------------------------------

describe('迟到的 approval.decide / question.answer 忽略', () => {
  test('approval.decide：能力返回 false 也不报错、不回包', async () => {
    const { link, control, approvals } = setup();
    await control.handle(MSG.APPROVAL_DECIDE, { id: 'ap_late', decision: 'allow' });

    assert.equal(approvals.calls.length, 1, '仍交给 approvals 判定');
    assert.equal(link.sent.length, 0, '迟到裁决不回任何消息');
  });

  test('question.answer：能力返回 false 也不报错、不回包', async () => {
    const { link, control, questions } = setup();
    await control.handle(MSG.QUESTION_ANSWER, {
      callId: 'q_late',
      action: 'submit',
      answers: [],
    });

    assert.equal(questions.calls.length, 1);
    assert.equal(link.sent.length, 0, '迟到作答不回任何消息');
  });
});

// ---------------------------------------------------------------------------
// t41 / t39-A3：投递挂起期间同一 reqId 的重传不得二次投递
// ---------------------------------------------------------------------------

describe('session.input 同一 reqId 的重传（投递挂起窗口）', () => {
  test('投递挂起期间重传完整批次：只投递一次、只回一条 ack', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const sessions = makeSessions();
    const deliveries = [];
    sessions.input = async (message) => {
      deliveries.push(message.text);
      await gate;
      return true;
    };
    const { link, control, log } = setup({ sessions });

    // part=1 先落库；part=2 收齐后进入投递并挂起。
    await control.handle(MSG.SESSION_INPUT, {
      sessionId: 's1', text: 'AB', reqId: 'dup', part: 1, parts: 2,
    });
    const pending = control.handle(MSG.SESSION_INPUT, {
      sessionId: 's1', text: 'C', reqId: 'dup', part: 2, parts: 2,
    });
    await tick();
    assert.equal(deliveries.length, 1, '收齐后应投递一次');

    // 设备没收到 ack，重传同一批次的每一片（不得 await：缺陷实现下第二片也会挂起）。
    await control.handle(MSG.SESSION_INPUT, {
      sessionId: 's1', text: 'AB', reqId: 'dup', part: 1, parts: 2,
    });
    const retrans = control.handle(MSG.SESSION_INPUT, {
      sessionId: 's1', text: 'C', reqId: 'dup', part: 2, parts: 2,
    });
    await tick();
    assert.equal(deliveries.length, 1, '投递挂起期间重传不得二次投递');
    assert.equal(control.pendingAssemblies, 0, '重传不得重新开批');

    release();
    await Promise.all([pending, retrans]);
    await flush();

    assert.deepEqual(deliveries, ['ABC'], '用户输入只能投递一次且内容正确');
    const acks = link.ofType(MSG.SESSION_INPUT_ACK);
    assert.equal(acks.length, 1, '投递完成时只回一条 ack');
    assert.equal(acks[0].payload.reqId, 'dup');
    assert.equal(acks[0].payload.ok, true);
    assert.ok(
      log.entries.every((entry) => !entry.text.includes('ABC')),
      '用户输入不得泄漏到日志',
    );
  });

  test('投递完成后重传：重发同一 ack，不再投递', async () => {
    const sessions = makeSessions();
    const deliveries = [];
    sessions.input = async (message) => {
      deliveries.push(message.text);
      return true;
    };
    const { link, control } = setup({ sessions });

    await control.handle(MSG.SESSION_INPUT, {
      sessionId: 's1', text: 'AB', reqId: 'done', part: 1, parts: 2,
    });
    await control.handle(MSG.SESSION_INPUT, {
      sessionId: 's1', text: 'C', reqId: 'done', part: 2, parts: 2,
    });
    assert.deepEqual(deliveries, ['ABC']);
    const firstAcks = link.ofType(MSG.SESSION_INPUT_ACK);
    assert.equal(firstAcks.length, 1);

    // 设备因为 ack 丢失而重传一个分片：必须还能拿到同一条 ack（不能静默丢弃）。
    await control.handle(MSG.SESSION_INPUT, {
      sessionId: 's1', text: 'C', reqId: 'done', part: 2, parts: 2,
    });

    assert.deepEqual(deliveries, ['ABC'], '已交付 reqId 不得再次投递');
    const acks = link.ofType(MSG.SESSION_INPUT_ACK);
    assert.equal(acks.length, 2, '重传应重发同一条 ack');
    assert.deepEqual(acks[1].payload, acks[0].payload, '重发的 ack 内容必须一致');
  });
});
