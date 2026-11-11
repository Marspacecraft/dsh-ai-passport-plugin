// Task 23 · host/questions.js — TDD
//
// 覆盖 docs/04 Task 23 中 questions 负责的部分：
//   1. question.asked 整批一次下发（v1 逐题下发，设备要维护导航状态）。
//   2. 只有 question.answer 结算；question.nav / question.pick 只是 UI 交互。
//   3. deadlineMs=0 不超时；>0 到点结算 timeout。
//   4. 断链时在途提问结算 cancelled、by:'disconnect'。
//   5. 与审批共用 race()/settle() 辅助函数，但不共用类（结构可查）。

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';

import { Approvals } from '../../src/host/approvals.js';
import { Questions, race, settle } from '../../src/host/questions.js';
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

function makeSessions() {
  const calls = [];
  return {
    calls,
    beginAttention: (...args) => calls.push(['begin', ...args]),
    endAttention: (...args) => calls.push(['end', ...args]),
    setAttention: (...args) => calls.push(['set', ...args]),
  };
}

function request(overrides = {}) {
  return {
    sessionId: 's1',
    callId: 'q_1',
    kind: 'choice',
    deadlineMs: 0,
    questions: [
      {
        id: 'q1',
        question: '选择要构建的目标平台',
        detail: '可选的长文本',
        multiSelect: false,
        custom: true,
        options: [
          { label: 'macOS', description: '推荐，本机平台' },
          { label: 'Windows', description: '交叉编译' },
        ],
      },
      {
        id: 'q2',
        question: '是否继续？',
        multiSelect: false,
        custom: false,
        options: [{ label: '是' }, { label: '否' }],
      },
    ],
    ...overrides,
  };
}

function setup({ clock = makeClock(), sessions = makeSessions(), raceFn, settleFn, link } = {}) {
  const theLink = link ?? new FakeLink();
  const log = makeLog();
  const questions = new Questions({
    link: theLink,
    log,
    sessions,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...(raceFn ? { race: raceFn } : {}),
    ...(settleFn ? { settle: settleFn } : {}),
  });
  return { questions, link: theLink, log, sessions, clock };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const flush = async () => {
  await tick();
  await tick();
};

// ---------------------------------------------------------------------------
// 验收 5：整批一次下发
// ---------------------------------------------------------------------------

describe('question.asked 整批一次下发', () => {
  test('两条题目只发一条 question.asked，字段完整保留', async () => {
    const { questions, link } = setup();
    const pending = questions.handle(request());
    await flush();

    const asked = link.ofType(MSG.QUESTION_ASKED);
    assert.equal(asked.length, 1, '整批只发一条，不逐题');
    const payload = asked[0].payload;
    assert.equal(payload.callId, 'q_1');
    assert.equal(payload.kind, 'choice');
    assert.equal(payload.deadlineMs, 0);
    assert.equal(payload.questions.length, 2);
    assert.equal(payload.questions[0].question, '选择要构建的目标平台');
    assert.equal(payload.questions[0].detail, '可选的长文本');
    assert.equal(payload.questions[0].custom, true);
    assert.equal(payload.questions[0].options[0].label, 'macOS');
    assert.equal(payload.questions[0].options[0].description, '推荐，本机平台');

    // 收尾，避免留下 pending promise。
    questions.onDeviceAnswer({ callId: 'q_1', action: 'cancel' });
    await pending;
  });
});

// ---------------------------------------------------------------------------
// 验收：只有 answer 结算
// ---------------------------------------------------------------------------

describe('只有 question.answer 结算', () => {
  test('submit 结算为 answered，payload 归一化，只结算一次', async () => {
    const { questions, link } = setup();
    const pending = questions.handle(request());
    await flush();

    const accepted = questions.onDeviceAnswer({
      callId: 'q_1',
      action: 'submit',
      answers: [{ id: 'q1', selected: ['macOS'], custom: '自定答案' }],
    });
    assert.equal(accepted, true);

    const result = await pending;
    assert.deepEqual(result, {
      answers: [{ id: 'q1', selected: ['macOS'], custom: '自定答案' }],
    });

    await flush();
    const done = link.ofType(MSG.QUESTION_DONE);
    assert.equal(done.length, 1, '结算只发一次 question.done');
    assert.equal(done[0].payload.outcome, 'answered');
    assert.equal(done[0].payload.by, 'device');

    assert.equal(questions.onDeviceAnswer({ callId: 'q_1', action: 'cancel' }), false, '迟到作答被忽略');
    assert.equal(link.ofType(MSG.QUESTION_DONE).length, 1);
  });

  test('nav / pick 只是 UI 交互，不影响结算状态', async () => {
    const { questions, link } = setup();
    const pending = questions.handle(request());
    await flush();

    let settled = false;
    pending.then(() => {
      settled = true;
    });

    assert.equal(questions.onDeviceNav({ callId: 'q_1', direction: 'next' }), false);
    assert.equal(questions.onDevicePick({ callId: 'q_1', questionId: 'q1', selected: ['macOS'] }), false);
    await flush();

    assert.equal(settled, false, 'nav/pick 不得结算');
    assert.equal(link.ofType(MSG.QUESTION_DONE).length, 0, 'nav/pick 不得发 done');

    questions.onDeviceAnswer({ callId: 'q_1', action: 'submit', answers: [] });
    const result = await pending;
    assert.deepEqual(result, { answers: [] });
  });

  test('未知 callId 的作答被忽略', async () => {
    const { questions, link } = setup();
    assert.equal(questions.onDeviceAnswer({ callId: 'nope', action: 'submit', answers: [] }), false);
    assert.equal(link.sent.length, 0);
  });

  test('cancel / reject 映射为 cancelled，by:device', async () => {
    for (const action of ['cancel', 'reject']) {
      const { questions, link } = setup();
      const pending = questions.handle(request({ callId: `q_${action}` }));
      await flush();

      assert.equal(questions.onDeviceAnswer({ callId: `q_${action}`, action }), true);
      const result = await pending;
      assert.deepEqual(result, { cancelled: true, reason: action });

      await flush();
      const [done] = link.ofType(MSG.QUESTION_DONE);
      assert.equal(done.payload.outcome, 'cancelled');
      assert.equal(done.payload.by, 'device');
    }
  });
});

// ---------------------------------------------------------------------------
// 验收 8：deadlineMs
// ---------------------------------------------------------------------------

describe('deadlineMs', () => {
  test('deadlineMs > 0 到点结算 timeout', async () => {
    const clock = makeClock();
    const { questions, link } = setup({ clock });
    const pending = questions.handle(request({ deadlineMs: 500 }));
    await flush();

    clock.advance(499);
    await flush();
    let settled = false;
    pending.then(() => {
      settled = true;
    });
    await flush();
    assert.equal(settled, false, '未到点不得结算');

    clock.advance(1);
    const result = await pending;
    assert.deepEqual(result, { cancelled: true, reason: 'timeout' });

    await flush();
    const [done] = link.ofType(MSG.QUESTION_DONE);
    assert.equal(done.payload.outcome, 'timeout');
    assert.equal(done.payload.by, 'timeout');
    assert.equal(questions.onDeviceAnswer({ callId: 'q_1', action: 'submit', answers: [] }), false);
  });

  test('deadlineMs = 0 表示不超时', async () => {
    const clock = makeClock();
    const { questions } = setup({ clock });
    const pending = questions.handle(request({ deadlineMs: 0 }));
    await flush();

    clock.advance(10_000_000);
    await flush();
    let settled = false;
    pending.then(() => {
      settled = true;
    });
    await flush();
    assert.equal(settled, false, '0 = 不超时');

    questions.onDeviceAnswer({ callId: 'q_1', action: 'cancel' });
    await pending;
  });
});

// ---------------------------------------------------------------------------
// 验收 9：断链
// ---------------------------------------------------------------------------

describe('断链清理', () => {
  test('在途提问结算 cancelled、by:disconnect，且只发一次 done', async () => {
    const { questions, link, sessions } = setup();
    const pending = questions.handle(request());
    await flush();

    questions.onDisconnect();
    const result = await pending;
    assert.deepEqual(result, { cancelled: true, reason: 'disconnect' });

    await flush();
    const done = link.ofType(MSG.QUESTION_DONE);
    assert.equal(done.length, 1);
    assert.equal(done[0].payload.outcome, 'cancelled');
    assert.equal(done[0].payload.by, 'disconnect');

    const ends = sessions.calls.filter(([kind]) => kind === 'end');
    assert.deepEqual(ends, [['end', 's1', 'question', 'q_1']], '断链应清掉 attention');
  });
});

// ---------------------------------------------------------------------------
// 结构：共用辅助函数、不共用类
// ---------------------------------------------------------------------------

describe('与审批共用辅助函数但不共用类', () => {
  test('Questions 不是 Approvals 的子类，也不实例化它', () => {
    assert.notEqual(Questions, Approvals);
    assert.equal(Object.getPrototypeOf(Questions.prototype), Object.prototype);
    assert.equal(Questions.prototype instanceof Approvals, false);
  });

  test('注入的 race()/settle() 会被真正调用', async () => {
    const raceCalls = [];
    const settleCalls = [];
    const raceSpy = (sources) => {
      raceCalls.push(sources);
      return race(sources);
    };
    const settleSpy = (entry, value, onSettled) => {
      settleCalls.push(value);
      return settle(entry, value, onSettled);
    };

    const { questions } = setup({ raceFn: raceSpy, settleFn: settleSpy });
    const pending = questions.handle(request());
    await flush();

    questions.onDeviceAnswer({ callId: 'q_1', action: 'cancel' });
    await pending;
    await flush();

    assert.equal(raceCalls.length, 1, 'handle 应通过注入的 race() 竞速');
    assert.equal(settleCalls.length, 1, '结算应通过注入的 settle()');
    assert.equal(settleCalls[0].outcome, 'cancelled');
  });

  test('发送失败（未 ready）不抛 unhandledRejection，handle 以 send-failed 收尾', async () => {
    const { questions, link, log } = setup();
    link.failSend = new Error('NOT_CONNECTED');

    const pending = questions.handle(request());
    const result = await pending;
    assert.deepEqual(result, { cancelled: true, reason: 'send-failed' });
    assert.ok(
      log.entries.some((e) => e.level === 'error' && e.text.includes('question.asked')),
      '拆分/发送失败必须留下可诊断 error，不能只静默 warn',
    );
    // 之后再断链是幂等的 no-op，不改变已结算结果。
    questions.onDisconnect();
    await flush();
    assert.equal(questions.stats.sendErrors, 1);
  });
});

// ---------------------------------------------------------------------------
// §5.1.2 / §5.4.1：question.asked 超 maxPayload 的通用拆分信封
// ---------------------------------------------------------------------------

describe('question.asked 超 maxPayload 按 §5.1.2 拆分', () => {
  test('长 detail 拆成多片：同 ver、part 连续、每片不超限、detail 按 part 拼接还原', async () => {
    const link = new FakeLink();
    link.info = { paired: true, maxPayload: 420 };
    const { questions } = setup({ link });
    const detail = '计划正文'.repeat(400); // 1600 个字符，远超 420 字节

    void questions.handle(
      request({
        callId: 'q_big',
        deadlineMs: 0,
        questions: [{ id: 'q1', question: '确认计划', detail, multiSelect: false, custom: false, options: [] }],
      }),
    );
    await flush();

    const asked = link.ofType(MSG.QUESTION_ASKED);
    assert.ok(asked.length > 1, `应拆成多片，实际 ${asked.length}`);
    const payloads = asked.map((m) => m.payload);
    assert.equal(new Set(payloads.map((p) => p.ver)).size, 1, '同一逻辑消息共用 ver');
    assert.deepEqual(
      payloads.map((p) => p.part),
      payloads.map((_, i) => i + 1),
      'part 必须从 1 连续递增',
    );
    assert.ok(payloads.every((p) => p.parts === payloads.length), 'parts 必须等于实际片数');
    const max = link.info.maxPayload;
    for (const payload of payloads) {
      assert.ok(
        Buffer.byteLength(JSON.stringify(payload), 'utf8') <= max,
        `part ${payload.part} 超过 maxPayload=${max}`,
      );
    }

    const mergedDetail = payloads
      .flatMap((p) => p.questions.filter((q) => q.id === 'q1'))
      .map((q) => q.detail)
      .join('');
    assert.equal(mergedDetail, detail, '设备按 part 顺序拼接 detail 应还原原文（不截断）');

    // 同 type 的 ver 继续单调；断链后归零。
    void questions.handle(request({ callId: 'q_after', questions: [] }));
    await flush();
    const lastVer = link.ofType(MSG.QUESTION_ASKED).at(-1).payload.ver;
    assert.equal(lastVer, 2, 'ver 按 question.asked 类型独立递增');

    link.emit('disconnected');
    void questions.handle(request({ callId: 'q_reset', questions: [] }));
    await flush();
    assert.equal(
      link.ofType(MSG.QUESTION_ASKED).at(-1).payload.ver,
      1,
      '握手/断链后 ver 归零，重连首条从 1 开始',
    );
  });
});
