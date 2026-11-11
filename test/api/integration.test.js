/**
 * M4 集成（mock 端到端）：M2 传输 + M3 链路 + M4 协议。
 *
 * 这一层刻意使用**真实** MockTransport / Link / ApiServer，而不是 FakeLink：
 * 想验证的是各层拼起来之后的行为——分片、握手白名单、节流、竞速、断链清理。
 * 只有机型（设备）一侧用 MockTransport 的虚拟设备代替。
 *
 * 设备 → 主机：`transport._onData(frame)` 注入编码后的设备帧（MockTransport 没有
 * 公开的"设备端发消息"接口，_onData 是传输层接收数据的公共入口）。
 * 主机 → 设备：包一层 `transport.send`，用独立 Reassembler 收集完整 JSON 消息。
 *
 * 假时钟只注入 push/sessions/control（节流、done 保持、组装超时），Link 的
 * keepalive/重连仍用真实计时器——本文件不测 30s 判死，重连退避是 10ms。
 */

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { describe, test } from 'node:test';

import { MockTransport } from '../../src/ble/mock-transport.js';
import { Link } from '../../src/link/link.js';
import { ApiServer } from '../../src/api/server.js';
import { PushCapability } from '../../src/api/push.js';
import { ControlCapability } from '../../src/api/control.js';
import { Sessions } from '../../src/host/sessions.js';
import { Approvals } from '../../src/host/approvals.js';
import { Questions } from '../../src/host/questions.js';
import { Reassembler } from '../../src/wire/reassembler.js';
import { decodeHeader, encodeFrames } from '../../src/wire/frame.js';
import {
  ATTENTION,
  CHANNEL_CONTROL,
  MSG,
} from '../../src/wire/constants.js';

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs = 2000, stepMs = 5) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fn()) return;
    if (Date.now() > deadline) throw new Error(`waitFor 超时（${timeoutMs}ms）`);
    await sleep(stepMs);
  }
}

/** 假时钟：只服务 push/sessions/control。 */
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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * 在 transport.send 上收集主机→设备的完整消息。
 * 只关心 CONTROL 通道；PING/PONG/ACK 等也解析出来，由调用方按 type 过滤。
 */
function recordOutbound(transport) {
  const reassembler = new Reassembler({ maxMessageBytes: 8192 });
  const messages = [];
  const origSend = transport.send.bind(transport);
  transport.send = async (frame, options) => {
    try {
      const head = decodeHeader(frame);
      if (head.channel === CHANNEL_CONTROL) {
        const res = reassembler.push(frame);
        if (res.kind === 'message') {
          messages.push(JSON.parse(Buffer.from(res.payload).toString('utf8')));
        }
      }
    } catch {
      // 非 JSON / 非法帧：只观察，不影响发送
    }
    return origSend(frame, options);
  };
  return messages;
}

let deviceMsgId = 100;

/** 以设备身份注入一条消息（自动分片）。 */
function deviceSend(transport, message, { msgId, ackRequired = false } = {}) {
  const id = msgId ?? (deviceMsgId++ & 0x0fff);
  const payload = new TextEncoder().encode(JSON.stringify(message));
  const frames = encodeFrames({
    msgId: id,
    payload,
    chunkPayload: 240,
    channel: CHANNEL_CONTROL,
    ackRequired,
  });
  for (const frame of frames) transport._onData(frame, { channel: 'control' });
}

// ---------------------------------------------------------------------------
// 组装全栈
// ---------------------------------------------------------------------------

function makeStack({ store = memoryStore(), backoffMs = [10] } = {}) {
  const clock = makeFakeClock();
  const transport = new MockTransport({ mtuPayload: 240 });
  const log = makeLog();
  const link = new Link({
    transport,
    chunkPayload: 240,
    backoffMs,
    store,
    // Link 默认的 setTimer 返回 undefined（setTimeout(...).unref?.() 的返回值），
    // 导致它自己的重连 timer 实际无法被 clear。这里注入一个正确返还句柄的
    // real-timer 包装：keepalive 仍走真实时钟，只是"重连可取消"变成真的。
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
  const deliveries = [];
  const host = {
    sessions,
    approvals: null,
    questions: null,
    // 宿主投递入口：control 找不到 sessions.input 时回落到这里
    input: async (info) => {
      deliveries.push(info);
      return { ok: true };
    },
    cancelSession: async () => true,
  };
  const approvals = new Approvals({
    link,
    log,
    config: { approval: { deviceToolScope: 'all' } },
    sessions,
  });
  const questions = new Questions({ link, log, sessions });
  host.approvals = approvals;
  host.questions = questions;

  const push = new PushCapability({
    link,
    log,
    host,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const control = new ControlCapability({
    link,
    log,
    host,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const server = new ApiServer({
    link,
    log,
    host,
    capabilities: [push, control],
  });

  // src/host 还没有协调器把 Link 断链转发给 approvals/questions，
  // 集成测试在这里扮演装配者（与 ApiServer 转发给 capability 的职责一致）。
  const onDisconnected = () => {
    approvals.onDisconnect();
    questions.onDisconnect();
  };
  link.on('disconnected', onDisconnected);

  return {
    clock,
    transport,
    link,
    log,
    sessions,
    approvals,
    questions,
    push,
    control,
    server,
    host,
    deliveries,
  };
}

async function startStack(stack) {
  stack.outbound = recordOutbound(stack.transport);
  await stack.server.start();
  await stack.link.start();
  await waitFor(() => stack.link.ready, 3000);
  return stack;
}

/** 建栈 → 起服务 → 握手 ready；结束后统一清理。 */
async function setup(t, options) {
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
    try {
      stack.sessions.dispose();
    } catch {
      // 同上
    }
  });
  return startStack(stack);
}

/**
 * 让 mock 设备以"已配对"身份重发 hello（协议 §3.1 的配对后 hello）。
 * MockTransport 的 hello 不带 deviceId/token，首连永远是 paired:false；
 * 这里补发一条带 token 的 hello，走真实握手的 token 校验路径。
 */
async function pairDevice(stack) {
  deviceSend(stack.transport, {
    type: MSG.HELLO,
    proto: 2,
    caps: 63,
    maxPayload: 8192,
    fw: '2.0.0-mock',
    deviceId: TRUSTED_DEVICE.deviceId,
    token: TRUSTED_DEVICE.token,
  });
  await waitFor(() => stack.link.info?.paired === true, 1000);
}

const stateMessages = (stack) =>
  stack.outbound.filter((m) => m?.type === MSG.SESSION_STATE);

const resultMessages = (stack) =>
  stack.outbound.filter((m) => m?.type === MSG.SESSION_RESULT);

const ackMessages = (stack) =>
  stack.outbound.filter((m) => m?.type === MSG.SESSION_INPUT_ACK);

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('M4 集成（mock 端到端）', () => {
  test('1. 状态推送字段完整：role/parentId/state/title/model/cwd/attention', async (t) => {
    const stack = await setup(t);
    const { sessions, clock } = stack;

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
      startedAt: clock.now(),
    });

    // 第一次变化立即推送；第二次落在节流窗口内。beginAttention 触发豁免，
    // 让第二条（含两个会话）立即发出，避免依赖推进时钟。
    sessions.beginAttention('main', 'approval', 'ap_1');

    await waitFor(() => stateMessages(stack).length >= 2);
    const last = stateMessages(stack).at(-1);
    assert.equal(last.type, MSG.SESSION_STATE);
    assert.equal(last.part, 1);
    assert.equal(last.parts, 1);
    assert.equal(last.sessions.length, 2);

    const main = last.sessions.find((s) => s.id === 'main');
    const sub = last.sessions.find((s) => s.id === 'sub');
    assert.ok(main && sub, '快照必须同时包含主/子会话');
    assert.equal(main.role, 'main');
    assert.equal(Object.hasOwn(main, 'parentId'), false);
    assert.equal(main.state, 'idle');
    assert.equal(main.title, '主会话');
    assert.equal(main.model, 'deepseek-chat');
    assert.equal(main.cwd, '/tmp/project');
    assert.equal(main.attention, ATTENTION.APPROVAL);

    assert.equal(sub.role, 'sub');
    assert.equal(sub.parentId, 'main');
    assert.equal(sub.state, 'running');
    assert.equal(sub.title, '子任务');
    assert.equal(typeof sub.elapsedMs, 'number');
    assert.ok(sub.elapsedMs >= 0);
    // 未知字段按协议省略，而不是填 null/0
    assert.equal(Object.hasOwn(sub, 'model'), false);
    assert.equal(Object.hasOwn(sub, 'cwd'), false);
    assert.equal(sub.attention, ATTENTION.NONE);

    // ver 从 1 开始，两次推送各自递增
    const vers = stateMessages(stack).map((m) => m.ver);
    assert.deepEqual(vers, [1, 2]);
  });

  test('2. 500ms 尾沿节流：1 秒内多次变化只推 2 次且推最后状态', async (t) => {
    const stack = await setup(t);
    const { sessions, clock } = stack;

    sessions.upsert('s1', { state: 'idle', title: 'v0' });
    await waitFor(() => stateMessages(stack).length === 1);

    clock.advance(100);
    sessions.upsert('s1', { state: 'idle', title: 'v1' });
    clock.advance(100);
    sessions.upsert('s1', { state: 'idle', title: 'v2' });
    clock.advance(200);
    sessions.upsert('s1', { state: 'idle', title: 'v3' });

    // 窗口内不推送；只有一个尾沿计时器（不排队）
    await sleep(20);
    assert.equal(stateMessages(stack).length, 1);
    assert.equal(clock.pending(), 1, '窗口内只允许一个节流计时器');

    clock.advance(100); // t=500
    await waitFor(() => stateMessages(stack).length === 2);
    const last = stateMessages(stack).at(-1);
    assert.equal(last.ver, 2);
    assert.equal(last.sessions[0].title, 'v3', '推的是最后一次状态，不是排队积压');
    assert.equal(clock.pending(), 0);

    clock.advance(1000);
    await sleep(20);
    assert.equal(stateMessages(stack).length, 2, '无变化不得补推');
  });

  test('3. attention 跃迁在节流窗口内立即推送（与普通变化对照）', async (t) => {
    const stack = await setup(t);
    const { sessions, clock } = stack;

    sessions.upsert('s1', { state: 'idle', title: 'base' });
    await waitFor(() => stateMessages(stack).length === 1);

    clock.advance(100);
    sessions.upsert('s1', { state: 'idle', title: 'throttled' });
    await sleep(20);
    assert.equal(stateMessages(stack).length, 1, '同一窗口内的普通字段变化必须被节流');

    clock.advance(50); // t=150，仍在上一条的 500ms 窗口内
    sessions.beginAttention('s1', 'approval', 'ap_9');
    await waitFor(() => stateMessages(stack).length === 2);
    assert.equal(stateMessages(stack).at(-1).sessions[0].attention, ATTENTION.APPROVAL);
    assert.equal(clock.pending(), 0, '立刻推送后应清掉尾沿计时器');

    // 对照的后半段：attention 已推过，普通变化回到节流
    clock.advance(10);
    sessions.upsert('s1', { state: 'idle', title: 'after' });
    await sleep(20);
    assert.equal(stateMessages(stack).length, 2);
    assert.equal(clock.pending(), 1);
  });

  test('4. session.result 不受节流、按 turn 独立、立即发出', async (t) => {
    const stack = await setup(t);
    const { sessions, clock } = stack;

    sessions.upsert('s1', { state: 'running', title: 'r' });
    await waitFor(() => stateMessages(stack).length === 1);

    clock.advance(100); // 处于节流窗口内
    sessions.emit('result', {
      sessionId: 's1',
      turnId: 'turn-1',
      state: 'done',
      text: '第一条结果',
      elapsedMs: 1234,
    });

    await waitFor(() => resultMessages(stack).length === 1);
    const first = resultMessages(stack)[0];
    assert.equal(first.type, MSG.SESSION_RESULT);
    assert.equal(first.sessionId, 's1');
    assert.equal(first.turnId, 'turn-1');
    assert.equal(first.state, 'done');
    assert.equal(first.text, '第一条结果');
    assert.equal(first.truncated, 0);
    assert.equal(first.part, 1);
    assert.equal(first.parts, 1);
    assert.equal(first.ver, 1);
    assert.equal(first.elapsedMs, 1234);
    assert.equal(typeof first.hostEpochSec, 'number');
    // 状态推送没有被它带出来
    assert.equal(stateMessages(stack).length, 1);

    sessions.emit('result', {
      sessionId: 's1',
      turnId: 'turn-2',
      state: 'error',
      text: '第二条结果',
    });
    await waitFor(() => resultMessages(stack).length === 2);
    assert.equal(resultMessages(stack)[1].ver, 2, 'session.result 的 ver 独立递增');
    assert.equal(stateMessages(stack).length, 1, 'result 不触发 state 推送');
  });

  test('5. 审批竞速双向：设备先答 decidedBy=device，电脑先答 decidedBy=pc', async (t) => {
    // --- 设备先答 ---------------------------------------------------------
    const a = await setup(t, { store: trustedStore() });
    await pairDevice(a);
    assert.equal(a.link.info.paired, true);
    a.sessions.upsert('s1', { state: 'idle', title: 'approval' });

    const pcGate = deferred();
    let pcAborted = false;
    const pcBranch = (_req, { signal }) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          pcAborted = true;
          resolve('cancelled');
        });
        pcGate.resolve = resolve;
      });

    const first = a.approvals.handle(
      { sessionId: 's1', toolName: 'bash', readOnly: false },
      pcBranch,
    );
    await waitFor(() => a.outbound.some((m) => m?.type === MSG.APPROVAL_ASKED));
    const asked = a.outbound.find((m) => m?.type === MSG.APPROVAL_ASKED);
    assert.equal(typeof asked.id, 'string');
    assert.equal(asked.risk, 'high');

    deviceSend(a.transport, {
      type: MSG.APPROVAL_DECIDE,
      id: asked.id,
      decision: 'allow',
    });

    assert.equal(await first, 'allowed-once');
    await waitFor(() =>
      a.outbound.some((m) => m?.type === MSG.APPROVAL_DONE && m.id === asked.id),
    );
    const doneA = a.outbound.find(
      (m) => m?.type === MSG.APPROVAL_DONE && m.id === asked.id,
    );
    assert.equal(doneA.outcome, 'allowed-once');
    assert.equal(doneA.decidedBy, 'device');
    assert.equal(pcAborted, true, '设备胜出后必须 abort 电脑卡片');

    // --- 电脑先答 ---------------------------------------------------------
    const b = await setup(t, { store: trustedStore() });
    await pairDevice(b);
    b.sessions.upsert('s1', { state: 'idle', title: 'approval' });

    // 关键时序：等设备**真的收到卡片**之后电脑再答。否则电脑会在
    // approval.asked 还没发出去时抢先结算，走的是「卡片送达时已结算」的
    // 兜底补发分支，测不到 #settle 里 PC 胜出的收卡片路径。
    const pcAnswer = deferred();
    const second = b.approvals.handle(
      { sessionId: 's1', toolName: 'read_file', readOnly: true },
      async () => {
        await pcAnswer.promise;
        return 'rejected';
      },
    );
    await waitFor(() =>
      b.outbound.some((m) => m?.type === MSG.APPROVAL_ASKED),
    );
    const askedB = b.outbound.find((m) => m?.type === MSG.APPROVAL_ASKED);
    assert.equal(typeof askedB.id, 'string');
    // 等 asked 的 ack 回来（stats.asked 在 notified=true 之后才自增）。
    // 只等「帧出现在线上」不够：那一刻电脑分支赢也只是走
    // 「卡片送达时已结算」的兜底补发，测不到 #settle 的 PC 胜出路径。
    await waitFor(() => b.approvals.stats.asked === 1);

    pcAnswer.resolve('rejected');
    assert.equal(await second, 'rejected');

    await waitFor(() =>
      b.outbound.some((m) => m?.type === MSG.APPROVAL_DONE),
    );
    const doneB = b.outbound.find((m) => m?.type === MSG.APPROVAL_DONE);
    assert.equal(doneB.outcome, 'rejected');
    assert.equal(doneB.decidedBy, 'pc');
    assert.equal(doneB.id, askedB.id, 'done 必须收回同一张卡片');
    assert.equal(b.approvals.stats.pcWins >= 1, true);
  });

  test('6. 断链：在途审批/提问结算 cancelled、清节流计时器、重连重推全量', async (t) => {
    // 退避拉长到 60s：本用例要手动控制重连时刻，否则 10ms 自动重连会和
    // 「断链期间不得补推」的断言赛跑（假绿灯/假红灯都来自这个竞态）。
    const stack = await setup(t, { store: trustedStore(), backoffMs: [60_000] });
    await pairDevice(stack);
    const { sessions, approvals, questions, clock, transport, link } = stack;

    sessions.upsert('s1', { state: 'idle', title: 'base' });
    await waitFor(() => stateMessages(stack).length === 1);

    clock.advance(100);
    sessions.upsert('s1', { state: 'idle', title: 'pending' });
    assert.equal(clock.pending(), 1, '节流计时器已挂起');

    const pcGate = deferred();
    const pcBranch = (_req, { signal }) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve('cancelled'));
        pcGate.resolve = resolve;
      });

    const approvalPromise = approvals.handle(
      { sessionId: 's1', toolName: 'bash', readOnly: false },
      pcBranch,
    );
    const questionPromise = questions.handle({
      sessionId: 's1',
      kind: 'choice',
      deadlineMs: 0,
      questions: [{ id: 'q1', question: '继续吗？', options: ['继续', '停止'] }],
    });

    await waitFor(
      () =>
        stack.outbound.some((m) => m?.type === MSG.APPROVAL_ASKED) &&
        stack.outbound.some((m) => m?.type === MSG.QUESTION_ASKED),
    );

    // 只观察，不改变发送行为；断链后的 done 发送会失败，但尝试必须被记录
    const attempts = [];
    const origSend = link.send.bind(link);
    link.send = (type, payload, opts) => {
      attempts.push({ type, payload });
      return origSend(type, payload, opts);
    };

    transport.simulateDisconnect('模拟断链');

    // ApiServer/push 的断链清理是同步的：simulateDisconnect 返回时计时器
    // 必须已经清空，不能等一拍再「碰巧」清掉。
    assert.equal(clock.pending(), 0, '断链后节流计时器必须立即清空');

    const questionResult = await questionPromise;
    assert.equal(questionResult.cancelled, true);
    assert.equal(questionResult.reason, 'disconnect');

    // 审批不 abort 电脑分支：用户仍可在电脑上完成
    pcGate.resolve('cancelled');
    assert.equal(await approvalPromise, 'cancelled');

    await waitFor(() => attempts.some((a) => a.type === MSG.APPROVAL_DONE));
    const approvalDone = attempts.find((a) => a.type === MSG.APPROVAL_DONE);
    assert.equal(approvalDone.payload.outcome, 'cancelled');
    assert.equal(approvalDone.payload.decidedBy, 'disconnect');

    const questionDone = attempts.find((a) => a.type === MSG.QUESTION_DONE);
    assert.ok(questionDone, '断链时必须给设备发 question.done');
    assert.equal(questionDone.payload.outcome, 'cancelled');
    assert.equal(questionDone.payload.by, 'disconnect');

    // 断链期间推进假时钟：链路未 ready，旧尾沿计时器不得补推任何状态。
    assert.equal(link.ready, false, '此刻必须仍处于断链状态');
    const beforeReconnect = stateMessages(stack).length;
    clock.advance(2000);
    await sleep(30);
    assert.equal(
      stateMessages(stack).length,
      beforeReconnect,
      '断链期间不得用旧计时器补推',
    );

    // 手动重连（自动重连退避 60s，本用例不等待它）——走真实 Link.start 路径。
    await link.start();
    await waitFor(() => link.ready, 3000);
    await waitFor(() => stateMessages(stack).length === beforeReconnect + 1);
    const reconnected = stateMessages(stack).at(-1);
    // 断链期间的变化（含 approvals/questions 清 attention 触发的 changed）
    // 只在 push 内部置 dirty，不消耗 ver；重连首推必须重新从 ver=1 开始。
    assert.equal(reconnected.ver, 1, '重连首份全量 ver 必须为 1，未 ready 期间不得消耗编号');
    assert.equal(reconnected.part, 1);
    assert.equal(reconnected.parts, 1);
    assert.equal(reconnected.sessions.length, 1);
    assert.equal(reconnected.sessions[0].id, 's1');
    assert.equal(reconnected.sessions[0].attention, ATTENTION.NONE);

    await sleep(100);
    assert.equal(stateMessages(stack).length, beforeReconnect + 1, '全量只重推一次');
  });

  test('7. session.input 乱序 3 片：正确拼装且只回一次 ack', async (t) => {
    const stack = await setup(t);
    const { sessions, transport } = stack;

    sessions.upsert('s1', { state: 'idle', title: 'input' });
    await waitFor(() => stateMessages(stack).length === 1);

    // 故意乱序：2 → 1 → 3
    deviceSend(transport, {
      type: MSG.SESSION_INPUT,
      sessionId: 's1',
      reqId: 'req-1',
      part: 2,
      parts: 3,
      text: 'B',
    });
    await sleep(20);
    assert.equal(ackMessages(stack).length, 0, '中间片不得回 ack');

    deviceSend(transport, {
      type: MSG.SESSION_INPUT,
      sessionId: 's1',
      reqId: 'req-1',
      part: 1,
      parts: 3,
      text: 'A',
    });
    await sleep(20);
    assert.equal(ackMessages(stack).length, 0);

    deviceSend(transport, {
      type: MSG.SESSION_INPUT,
      sessionId: 's1',
      reqId: 'req-1',
      part: 3,
      parts: 3,
      text: 'C',
    });

    await waitFor(() => ackMessages(stack).length === 1);
    const acks = ackMessages(stack);
    assert.equal(acks[0].reqId, 'req-1');
    assert.equal(acks[0].ok, true);
    assert.deepEqual(stack.deliveries, [{ sessionId: 's1', text: 'ABC' }]);

    // 收齐后再来的重复片不能产生第二次投递/ack
    deviceSend(transport, {
      type: MSG.SESSION_INPUT,
      sessionId: 's1',
      reqId: 'req-1',
      part: 2,
      parts: 3,
      text: 'B',
    });
    await sleep(30);
    assert.equal(ackMessages(stack).length, 1);
    assert.equal(stack.deliveries.length, 1);
  });

  test('8. 未 ready 不推送业务消息；ready 后重推一次全量快照', async (t) => {
    const stack = makeStack({ store: trustedStore() });
    t.after(async () => {
      try {
        await stack.server.stop();
      } catch {}
      try {
        await stack.link.stop('测试结束');
      } catch {}
      try {
        stack.sessions.dispose();
      } catch {}
    });

    const outbound = recordOutbound(stack.transport);
    const attempts = [];
    const linkSend = stack.link.send.bind(stack.link);
    stack.link.send = (type, payload, options) => {
      attempts.push(type);
      return linkSend(type, payload, options);
    };

    // 真实配对场景：能力已订阅（server.start），但链路还没 start/握手。
    await stack.server.start();
    stack.sessions.upsert('s1', { state: 'idle', title: 'pre-ready' });
    await sleep(30);
    assert.equal(stack.link.ready, false);
    assert.equal(
      outbound.filter((m) => m?.type === MSG.SESSION_STATE).length,
      0,
      '链路未 ready 时不得发送业务消息',
    );
    assert.equal(
      attempts.filter((type) => type === MSG.SESSION_STATE).length,
      0,
      '未 ready 时连 link.send 都不能尝试（不得消耗 ver/写签名）',
    );

    await stack.link.start();
    await waitFor(() => stack.link.ready, 3000);
    await waitFor(
      () => outbound.filter((m) => m?.type === MSG.SESSION_STATE).length === 1,
    );

    const pushed = outbound.filter((m) => m?.type === MSG.SESSION_STATE);
    assert.equal(pushed.length, 1, 'ready 后只补推一次全量');
    assert.equal(pushed[0].ver, 1, '首份全量 ver 从 1 开始（未 ready 期间不消耗编号）');
    assert.equal(pushed[0].part, 1);
    assert.equal(pushed[0].parts, 1);
    assert.equal(pushed[0].sessions.length, 1);
    assert.equal(pushed[0].sessions[0].id, 's1');
    assert.equal(pushed[0].sessions[0].title, 'pre-ready');

    // 配对完成（hello 带 token 重发）不产生新的全量推送。
    await pairDevice(stack);
    await sleep(100);
    assert.equal(
      outbound.filter((m) => m?.type === MSG.SESSION_STATE).length,
      1,
      '配对完成不得重复推送',
    );

    // ready 之后的真实变化：过 500ms 尾沿窗口后 ver=2。
    stack.sessions.upsert('s1', { title: 'post-ready' });
    stack.clock.advance(500);
    await waitFor(
      () => outbound.filter((m) => m?.type === MSG.SESSION_STATE).length === 2,
      3000,
    );
    const second = outbound.filter((m) => m?.type === MSG.SESSION_STATE)[1];
    assert.equal(second.ver, 2);
    assert.equal(second.sessions[0].title, 'post-ready');
  });

  test('9. question.asked 超大 detail 按 §5.1.2 拆片，设备侧 Reassembler 还原整批', async (t) => {
    const stack = await setup(t, { store: trustedStore() });
    await pairDevice(stack);
    const detail = '评审正文 §5.4.1：计划详情照常下发，不截断。'.repeat(400); // ~10KB UTF-8

    const pending = stack.questions.handle({
      sessionId: 's1',
      callId: 'q_big',
      kind: 'plan',
      deadlineMs: 0,
      questions: [
        {
          id: 'q1',
          question: '确认执行计划？',
          detail,
          multiSelect: false,
          custom: false,
          options: [],
        },
      ],
    });

    await waitFor(() => {
      const parts = stack.outbound.filter((m) => m?.type === MSG.QUESTION_ASKED);
      return parts.length > 1 && parts.length === parts[0].parts;
    });
    const asked = stack.outbound.filter((m) => m?.type === MSG.QUESTION_ASKED);
    assert.equal(new Set(asked.map((m) => m.ver)).size, 1, '同一批 question.asked 共用 ver');
    assert.deepEqual(
      asked.map((m) => m.part),
      asked.map((_, i) => i + 1),
      'part 连续从 1 开始',
    );
    assert.ok(asked.every((m) => m.parts === asked.length), 'parts 必须等于实际片数');
    const max = stack.link.info.maxPayload;
    for (const message of asked) {
      assert.ok(
        Buffer.byteLength(JSON.stringify(message), 'utf8') <= max,
        `part ${message.part} 超过协商 maxPayload=${max}`,
      );
    }

    // 设备侧组装规则：同 (type,ver) 按 part 顺序拼接业务字段。
    const assembledDetail = asked
      .flatMap((m) => m.questions.filter((q) => q.id === 'q1'))
      .map((q) => q.detail)
      .join('');
    assert.equal(assembledDetail, detail, '设备拼回的计划正文必须与原文完全一致（不截断）');

    deviceSend(stack.transport, {
      type: MSG.QUESTION_ANSWER,
      callId: 'q_big',
      action: 'submit',
      answers: [{ id: 'q1', selected: [], custom: '同意' }],
    });
    const result = await pending;
    assert.deepEqual(result, { answers: [{ id: 'q1', selected: [], custom: '同意' }] });
    await waitFor(
      () =>
        stack.outbound.filter(
          (m) => m?.type === MSG.QUESTION_DONE && m.callId === 'q_big',
        ).length === 1,
    );
    assert.equal(
      stack.outbound.filter(
        (m) => m?.type === MSG.QUESTION_DONE && m.callId === 'q_big',
      ).length,
      1,
      '同一批问题只结算一次',
    );
  });

  test('10. approval.asked 超大 detail 按 §5.1.2 拆片，设备只渲染一张卡片', async (t) => {
    const stack = await setup(t, { store: trustedStore() });
    await pairDevice(stack);
    stack.sessions.upsert('s1', { state: 'idle', title: 'big-approval' });
    const command = 'rm -rf 临时目录 && echo 继续'.repeat(500); // ~15KB UTF-8
    const pcGate = deferred();
    let pcAborted = false;

    const outcome = stack.approvals.handle(
      {
        sessionId: 's1',
        toolName: 'bash',
        reason: '执行危险命令',
        readOnly: false,
        callId: 'call_big',
        detail: { command, cwd: '/work' },
      },
      (_req, { signal }) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            pcAborted = true;
            resolve('cancelled');
          });
          pcGate.resolve = resolve;
        }),
    );

    await waitFor(() => {
      const parts = stack.outbound.filter((m) => m?.type === MSG.APPROVAL_ASKED);
      return parts.length > 1 && parts.length === parts[0].parts;
    });
    const asked = stack.outbound.filter((m) => m?.type === MSG.APPROVAL_ASKED);
    const approvalId = asked[0].id;
    assert.ok(
      typeof approvalId === 'string' && asked.every((m) => m.id === approvalId),
      '所有片必须共用同一个审批 id（设备据此只渲染一张卡片）',
    );
    assert.equal(new Set(asked.map((m) => m.ver)).size, 1);
    assert.deepEqual(
      asked.map((m) => m.part),
      asked.map((_, i) => i + 1),
    );
    assert.ok(asked.every((m) => m.parts === asked.length));
    const max = stack.link.info.maxPayload;
    for (const message of asked) {
      assert.ok(
        Buffer.byteLength(JSON.stringify(message), 'utf8') <= max,
        `part ${message.part} 超过协商 maxPayload=${max}`,
      );
    }

    // 设备重组 detail：同一路径字符串按 part 顺序拼接，其余字段合并。
    const merged = {};
    for (const message of asked) {
      for (const [key, value] of Object.entries(message.detail)) {
        if (typeof value === 'string' && typeof merged[key] === 'string') merged[key] += value;
        else merged[key] = value;
      }
    }
    assert.equal(merged.command, command, 'detail.command 完整还原，不截断');
    assert.equal(merged.cwd, '/work');

    deviceSend(stack.transport, {
      type: MSG.APPROVAL_DECIDE,
      id: approvalId,
      decision: 'allow',
    });
    assert.equal(await outcome, 'allowed-once');
    await waitFor(
      () =>
        stack.outbound.filter(
          (m) => m?.type === MSG.APPROVAL_DONE && m.id === approvalId,
        ).length === 1,
    );
    const done = stack.outbound.filter(
      (m) => m?.type === MSG.APPROVAL_DONE && m.id === approvalId,
    );
    assert.equal(done.length, 1, '拆成多片也只结算一张卡片');
    assert.equal(done[0].decidedBy, 'device');
    assert.equal(pcAborted, true);
  });
});
