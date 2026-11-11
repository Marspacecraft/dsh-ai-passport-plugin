// Task 22 · 审批双端竞速（docs/02 §5.2 / docs/04 Task 22）
//
// 这些用例逐条对着 v1 的五次真实事故：
//   · 设备在线就不启动电脑分支 → DSH 那轮永久悬挂
//   · 落败方收不到 done → 设备上留下永远点不动的死卡片
//   · timeoutMs=0 被当成"永不超时" → 双重 bug
//   · 设备"总是允许" 被当成持久授权
//   · 断链把电脑分支也 abort 掉 → 用户无法在电脑上完成

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';

import { Approvals } from '../../src/host/approvals.js';
import { claim } from '../../src/host/race.js';

// ---------------------------------------------------------------------------
// 测试替身
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

  asked() {
    return this.sent.filter((m) => m.type === 'approval.asked');
  }

  done() {
    return this.sent.filter((m) => m.type === 'approval.done');
  }
}

function makeLogger() {
  const entries = [];
  const push = (level) => (...args) => entries.push({ level, text: args.map(String).join(' ') });
  return { entries, debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') };
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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setup({ config, link, log, sessions } = {}) {
  const deps = {
    link: link ?? new FakeLink(),
    log: log ?? makeLogger(),
    sessions: sessions ?? makeSessions(),
    config: config ?? {},
  };
  return { approvals: new Approvals(deps), ...deps };
}

function request(overrides = {}) {
  return {
    sessionId: 's1',
    toolName: 'write',
    reason: '写入工作区文件',
    readOnly: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 验收 1：电脑分支无条件启动
// ---------------------------------------------------------------------------

describe('电脑分支无条件启动（v1 事故：设备在线就抑制电脑卡片）', () => {
  test('设备不在线时电脑分支照样启动，设备没收到 approval.asked', async () => {
    const link = new FakeLink();
    link.ready = false;
    const { approvals } = setup({ link });
    const pc = deferred();
    let pcCalls = 0;

    const outcome = approvals.handle(request(), () => {
      pcCalls += 1;
      return pc.promise;
    });
    await tick();

    assert.equal(pcCalls, 1, '电脑分支必须无条件启动');
    assert.equal(link.asked().length, 0, '设备不在线不应发 approval.asked');

    pc.resolve('allowed-once');
    assert.equal(await outcome, 'allowed-once');
  });

  test('设备在线且可处理时，电脑分支也同时启动（不被设备抑制）', async () => {
    const { approvals, link } = setup();
    const pc = deferred();
    let pcCalls = 0;

    const outcome = approvals.handle(request(), () => {
      pcCalls += 1;
      return pc.promise;
    });
    await tick();

    assert.equal(pcCalls, 1);
    assert.equal(link.asked().length, 1, '符合条件的设备应收到 approval.asked');

    pc.resolve('rejected');
    assert.equal(await outcome, 'rejected');
  });

  test('设备不合格（scope=none）时仍启动电脑分支，且不发 asked', async () => {
    const link = new FakeLink();
    const { approvals } = setup({ link, config: { approval: { deviceToolScope: 'none' } } });
    const pc = deferred();
    let pcCalls = 0;

    const outcome = approvals.handle(request(), () => {
      pcCalls += 1;
      return pc.promise;
    });
    await tick();

    assert.equal(pcCalls, 1);
    assert.equal(link.asked().length, 0);

    pc.resolve('allowed-once');
    assert.equal(await outcome, 'allowed-once');
  });
});

// ---------------------------------------------------------------------------
// 验收 2：deviceEligible 三条件
// ---------------------------------------------------------------------------

describe('deviceEligible 只决定要不要通知设备（不影响电脑分支）', () => {
  test('link.ready=false → 不通知设备，电脑分支仍启动', async () => {
    const link = new FakeLink();
    link.ready = false;
    const { approvals } = setup({ link });
    const pc = deferred();

    const outcome = approvals.handle(request(), () => pc.promise);
    await tick();
    assert.equal(link.asked().length, 0);
    assert.equal(approvals.stats.inFlight, 1);

    pc.resolve('cancelled');
    assert.equal(await outcome, 'cancelled');
    assert.equal(link.asked().length, 0);
  });

  test('paired=false → 不通知设备', async () => {
    const link = new FakeLink();
    link.info = { paired: false };
    const { approvals } = setup({ link });
    const pc = deferred();

    const outcome = approvals.handle(request(), () => pc.promise);
    await tick();
    assert.equal(link.asked().length, 0);

    pc.resolve('allowed-once');
    await outcome;
  });

  test('工具不在 deviceToolScope 内 → 不通知设备', async () => {
    const { approvals, link } = setup({
      config: { approval: { deviceToolScope: 'write-only' } },
    });
    const pc = deferred();

    const outcome = approvals.handle(request({ readOnly: true }), () => pc.promise);
    await tick();
    assert.equal(link.asked().length, 0);

    pc.resolve('allowed-once');
    await outcome;
  });

  test('三条件全满足才通知设备', async () => {
    const { approvals, link } = setup();
    const pc = deferred();

    const outcome = approvals.handle(request({ readOnly: false }), () => pc.promise);
    await tick();
    assert.equal(link.asked().length, 1, 'ready + paired + scope=all 应通知设备');

    pc.resolve('allowed-once');
    await outcome;
  });
});

// ---------------------------------------------------------------------------
// 验收 1b：没有 runPc 时退化为「仅设备可答」
// ---------------------------------------------------------------------------

describe('没有电脑分支 runPc 时不得抢跑 unavailable', () => {
  test('设备在线：等设备作答，不因没有 PC 分支立即 unavailable', async () => {
    const log = makeLogger();
    const { approvals, link } = setup({ log });

    const outcome = approvals.handle(request(), undefined);
    await tick();

    assert.equal(link.asked().length, 1, '设备应收到审批卡片');
    assert.ok(
      log.entries.some((e) => e.level === 'warn' && e.text.includes('runPc')),
      '缺少 runPc 应留下 warn',
    );

    const id = link.asked()[0].payload.id;
    assert.equal(approvals.onDeviceDecide({ id, decision: 'allow' }), true);
    assert.equal(await outcome, 'allowed-once', '设备作答必须生效，不能被 unavailable 抢跑');
    assert.equal(link.done().at(-1).payload.decidedBy, 'device');
  });

  test('设备也不可用：立即 unavailable，不能永久挂起', async () => {
    const link = new FakeLink();
    link.ready = false;
    const { approvals } = setup({ link });

    const outcome = await approvals.handle(request(), undefined);
    assert.equal(outcome, 'unavailable');
    assert.equal(link.asked().length, 0);
  });
});

// ---------------------------------------------------------------------------
// 验收 3：deviceToolScope 三值枚举
// ---------------------------------------------------------------------------

describe('approval.deviceToolScope 三值枚举', () => {
  test('"all"：只读工具也通知设备', async () => {
    const { approvals, link } = setup({ config: { approval: { deviceToolScope: 'all' } } });
    const pc = deferred();
    const outcome = approvals.handle(request({ readOnly: true }), () => pc.promise);
    await tick();
    assert.equal(link.asked().length, 1);
    pc.resolve('allowed-once');
    await outcome;
  });

  test('"write-only"：只读不发，写操作发', async () => {
    const { approvals, link } = setup({ config: { approval: { deviceToolScope: 'write-only' } } });

    const pc1 = deferred();
    const p1 = approvals.handle(request({ readOnly: true }), () => pc1.promise);
    await tick();
    assert.equal(link.asked().length, 0, '只读工具不应发');
    pc1.resolve('allowed-once');
    await p1;

    const pc2 = deferred();
    const p2 = approvals.handle(request({ readOnly: false }), () => pc2.promise);
    await tick();
    assert.equal(link.asked().length, 1, '写操作应发');
    pc2.resolve('allowed-once');
    await p2;
  });

  test('"none"：一律不通知设备', async () => {
    const { approvals, link } = setup({ config: { approval: { deviceToolScope: 'none' } } });
    const pc = deferred();
    const outcome = approvals.handle(request({ readOnly: false }), () => pc.promise);
    await tick();
    assert.equal(link.asked().length, 0);
    pc.resolve('rejected');
    await outcome;
  });

  test('非法取值按 "all" 处理并记 warn（枚举不是布尔）', async () => {
    const log = makeLogger();
    const { approvals, link } = setup({ log, config: { approval: { deviceToolScope: true } } });
    const pc = deferred();
    const outcome = approvals.handle(request({ readOnly: true }), () => pc.promise);
    await tick();
    assert.equal(link.asked().length, 1);
    assert.ok(log.entries.some((e) => /deviceToolScope/.test(e.text)));
    pc.resolve('allowed-once');
    await outcome;
  });
});

// ---------------------------------------------------------------------------
// 验收 4/5/6：竞速、幂等、落败方 done、迟到裁决
// ---------------------------------------------------------------------------

describe('Promise.race + #settle 幂等', () => {
  test('设备先答：电脑分支被 abort，设备收到 done{decidedBy:"device"}', async () => {
    const { approvals, link } = setup();
    let pcSignal;
    const pc = deferred();
    const outcome = approvals.handle(request(), (_req, ctx) => {
      pcSignal = ctx.signal;
      return pc.promise;
    });
    await tick();

    const id = link.asked()[0].payload.id;
    assert.equal(approvals.onDeviceDecide({ id, decision: 'allow' }), true);
    assert.equal(await outcome, 'allowed-once');

    const done = link.done();
    assert.equal(done.length, 1);
    assert.deepEqual(
      { id: done[0].payload.id, outcome: done[0].payload.outcome, decidedBy: done[0].payload.decidedBy },
      { id, outcome: 'allowed-once', decidedBy: 'device' },
    );
    assert.equal(pcSignal.aborted, true, '设备先答必须 abort 电脑卡片');
    assert.equal(approvals.pendingCount, 0);
  });

  test('电脑先答：设备收到 done{decidedBy:"pc"} 收起卡片', async () => {
    const { approvals, link } = setup();
    const pc = deferred();
    const outcome = approvals.handle(request(), () => pc.promise);
    await tick();
    const id = link.asked()[0].payload.id;

    pc.resolve('rejected');
    assert.equal(await outcome, 'rejected');

    const done = link.done();
    assert.equal(done.length, 1);
    assert.equal(done[0].payload.id, id);
    assert.equal(done[0].payload.outcome, 'rejected');
    assert.equal(done[0].payload.decidedBy, 'pc');
    assert.equal(approvals.pendingCount, 0);
  });

  test('两端同时答只有一个生效：第二次 settle 返回 false', async () => {
    const { approvals, link } = setup();
    const pc = deferred();
    const outcome = approvals.handle(request(), () => pc.promise);
    await tick();
    const id = link.asked()[0].payload.id;

    // 同一 tick 里两端都答；设备 resolve 先入队。
    assert.equal(approvals.onDeviceDecide({ id, decision: 'deny' }), true);
    pc.resolve('allowed-once');

    assert.equal(await outcome, 'rejected');
    assert.equal(approvals.onDeviceDecide({ id, decision: 'allow' }), false);
    assert.equal(link.done().length, 1);
    assert.equal(link.done()[0].payload.decidedBy, 'device');
  });

  test('迟到裁决忽略：落定后再来不生效、不抛错、不发第二条 done', async () => {
    const { approvals, link } = setup();
    const pc = deferred();
    const outcome = approvals.handle(request(), () => pc.promise);
    await tick();
    const id = link.asked()[0].payload.id;

    pc.resolve('allowed-once');
    await outcome;

    assert.equal(approvals.onDeviceDecide({ id, decision: 'deny' }), false);
    assert.equal(approvals.onDeviceDecide({ id: 'ap_unknown', decision: 'allow' }), false);
    assert.equal(link.done().length, 1);
    assert.ok(approvals.stats.lateDecisions >= 2);
  });
});

// ---------------------------------------------------------------------------
// 验收 7：断链
// ---------------------------------------------------------------------------

describe('断链清理', () => {
  test('在途审批结算 cancelled{decidedBy:"disconnect"}，电脑分支不 abort 且仍能完成', async () => {
    const { approvals, link } = setup();
    let pcSignal;
    const pc = deferred();
    const outcome = approvals.handle(request(), (_req, ctx) => {
      pcSignal = ctx.signal;
      return pc.promise;
    });
    await tick();
    const id = link.asked()[0].payload.id;

    approvals.onDisconnect();
    await tick();

    const cancelled = link.done().find((m) => m.payload.outcome === 'cancelled');
    assert.ok(cancelled, '断链必须发 approval.done{cancelled} 给设备');
    assert.equal(cancelled.payload.id, id);
    assert.equal(cancelled.payload.decidedBy, 'disconnect');
    assert.equal(pcSignal.aborted, false, '断链不得 abort 电脑分支');

    // 用户仍可在电脑上完成。
    pc.resolve('allowed-once');
    assert.equal(await outcome, 'allowed-once');
    assert.equal(approvals.pendingCount, 0);
  });

  test('断链后设备迟到的裁决被忽略（设备侧状态已清）', async () => {
    const { approvals, link } = setup();
    const pc = deferred();
    const outcome = approvals.handle(request(), () => pc.promise);
    await tick();
    const id = link.asked()[0].payload.id;

    approvals.onDisconnect();
    await tick();
    assert.equal(approvals.onDeviceDecide({ id, decision: 'allow' }), false);

    pc.resolve('rejected');
    assert.equal(await outcome, 'rejected');
  });

  test('设备未收到 asked 时断链不发多余的 done', async () => {
    const link = new FakeLink();
    link.ready = false;
    const { approvals } = setup({ link });
    const pc = deferred();
    const outcome = approvals.handle(request(), () => pc.promise);
    await tick();

    approvals.onDisconnect();
    await tick();
    assert.equal(link.done().length, 0);

    pc.resolve('allowed-once');
    await outcome;
  });
});

// ---------------------------------------------------------------------------
// 验收 8/9/10：risk / 总是允许 / timeoutMs
// ---------------------------------------------------------------------------

describe('risk 由工具只读性决定，与 scope 无关', () => {
  test('只读工具 risk=low，写工具 risk=high', async () => {
    const { approvals, link } = setup();

    const pc1 = deferred();
    const p1 = approvals.handle(request({ readOnly: true }), () => pc1.promise);
    await tick();
    assert.equal(link.asked()[0].payload.risk, 'low');
    pc1.resolve('allowed-once');
    await p1;

    const pc2 = deferred();
    const p2 = approvals.handle(request({ readOnly: false }), () => pc2.promise);
    await tick();
    assert.equal(link.asked()[1].payload.risk, 'high');
    pc2.resolve('allowed-once');
    await p2;
  });

  test('改 deviceToolScope 不改变同一工具的 risk', async () => {
    const linkA = new FakeLink();
    const a = setup({ link: linkA, config: { approval: { deviceToolScope: 'all' } } });
    const pcA = deferred();
    const pA = a.approvals.handle(request({ readOnly: false }), () => pcA.promise);
    await tick();
    const riskAll = linkA.asked()[0].payload.risk;
    pcA.resolve('allowed-once');
    await pA;

    const linkB = new FakeLink();
    const b = setup({ link: linkB, config: { approval: { deviceToolScope: 'write-only' } } });
    const pcB = deferred();
    const pB = b.approvals.handle(request({ readOnly: false }), () => pcB.promise);
    await tick();
    const riskWriteOnly = linkB.asked()[0].payload.risk;
    pcB.resolve('allowed-once');
    await pB;

    assert.equal(riskAll, 'high');
    assert.equal(riskWriteOnly, 'high');
  });
});

describe('「总是允许」不造假持久授权', () => {
  test('设备提供 always-allow → 主机落 allowed-once 并记 warn', async () => {
    const log = makeLogger();
    const { approvals, link } = setup({ log });
    const pc = deferred();
    const outcome = approvals.handle(request(), () => pc.promise);
    await tick();
    const id = link.asked()[0].payload.id;

    assert.equal(approvals.onDeviceDecide({ id, decision: 'always-allow' }), true);
    assert.equal(await outcome, 'allowed-once');
    assert.equal(link.done()[0].payload.outcome, 'allowed-once');
    assert.ok(log.entries.some((e) => e.level === 'warn' && /always|总是/.test(e.text)));
  });
});

describe('timeoutMs 只是展示建议，主机不设审批超时', () => {
  test('timeoutMs=0 时主机不会自己超时结算', async () => {
    const { approvals, link } = setup({ config: { approval: { timeoutMs: 0 } } });
    const pc = deferred();
    const outcome = approvals.handle(request({ timeoutMs: 0 }), () => pc.promise);
    await tick();

    const state = await Promise.race([
      outcome.then(() => 'settled'),
      sleep(30).then(() => 'pending'),
    ]);
    assert.equal(state, 'pending', 'timeoutMs=0 不允许主机自结算');
    assert.equal(link.asked()[0].payload.timeoutMs, 0);

    pc.resolve('allowed-once');
    assert.equal(await outcome, 'allowed-once');
  });

  test('timeoutMs 原样带给设备作为展示建议', async () => {
    const { approvals, link } = setup({ config: { approval: { timeoutMs: 5000 } } });
    const pc = deferred();
    const outcome = approvals.handle(request({ timeoutMs: 1200 }), () => pc.promise);
    await tick();
    assert.equal(link.asked()[0].payload.timeoutMs, 1200);

    pc.resolve('allowed-once');
    await outcome;
  });
});

// ---------------------------------------------------------------------------
// 验收 11：ID 生成与回填
// ---------------------------------------------------------------------------

describe('审批 ID 生成与回填', () => {
  test('approval.asked.id 能用于 approval.decide 回填', async () => {
    const { approvals, link } = setup();
    const pc = deferred();
    const outcome = approvals.handle(request({ callId: 'call_abc' }), () => pc.promise);
    await tick();
    const asked = link.asked()[0].payload;

    assert.equal(typeof asked.id, 'string');
    assert.ok(asked.id.length > 0);
    assert.equal(asked.callId, 'call_abc', 'callId 透传');
    assert.equal(asked.toolName, 'write');
    assert.equal(asked.displayReason, '写入工作区文件');

    assert.equal(approvals.onDeviceDecide({ id: asked.id, decision: 'allow' }), true);
    assert.equal(await outcome, 'allowed-once');
    assert.equal(link.done()[0].payload.id, asked.id);
  });

  test('重复的 approval.asked 使用不同 ID', async () => {
    const { approvals, link } = setup();
    const pc1 = deferred();
    const p1 = approvals.handle(request(), () => pc1.promise);
    await tick();
    const id1 = link.asked()[0].payload.id;
    pc1.resolve('allowed-once');
    await p1;

    const pc2 = deferred();
    const p2 = approvals.handle(request(), () => pc2.promise);
    await tick();
    const id2 = link.asked()[1].payload.id;
    pc2.resolve('allowed-once');
    await p2;

    assert.notEqual(id1, id2);
  });
});

// ---------------------------------------------------------------------------
// 辅助行为：attention、发送失败、结果归一化
// ---------------------------------------------------------------------------

describe('宿主中止（request.signal）', () => {
  test('signal abort → 结算 cancelled，设备收 done{decidedBy:"abort"}，电脑卡片被 abort', async () => {
    const { approvals, link } = setup();
    const controller = new AbortController();
    let pcSignal;
    const pc = deferred();
    const outcome = approvals.handle(request({ signal: controller.signal }), (_req, ctx) => {
      pcSignal = ctx.signal;
      return pc.promise;
    });
    await tick();
    const id = link.asked()[0].payload.id;

    controller.abort();
    assert.equal(await outcome, 'cancelled');
    assert.equal(pcSignal.aborted, true, '宿主中止必须收起电脑卡片');

    const done = link.done();
    assert.equal(done.length, 1);
    assert.equal(done[0].payload.id, id);
    assert.equal(done[0].payload.outcome, 'cancelled');
    assert.equal(done[0].payload.decidedBy, 'abort');
    assert.equal(approvals.pendingCount, 0);
  });

  test('signal 在调用前已 abort → 不通知设备，直接 cancelled', async () => {
    const { approvals, link } = setup();
    const controller = new AbortController();
    controller.abort();

    const outcome = await approvals.handle(request({ signal: controller.signal }), async () => 'allowed-once');
    assert.equal(outcome, 'cancelled');
    assert.equal(link.asked().length, 0, '已中止的审批不必再打扰设备');
  });
});

describe('attention 与失败降级', () => {
  test('设备收到审批时置位 attention，结算后回落', async () => {
    const { approvals, link, sessions } = setup();
    const pc = deferred();
    const outcome = approvals.handle(request({ sessionId: 's1' }), () => pc.promise);
    await tick();
    const id = link.asked()[0].payload.id;

    assert.deepEqual(sessions.calls[0], ['begin', 's1', 'approval', id]);

    pc.resolve('allowed-once');
    await outcome;
    assert.deepEqual(sessions.calls.at(-1), ['end', 's1', 'approval', id]);
  });

  test('approval.asked 发送失败不抛、不产生 unhandled，电脑分支仍可完成', async () => {
    const link = new FakeLink();
    link.failSend = new Error('NOT_CONNECTED');
    const { approvals, log } = setup({ link });
    const pc = deferred();

    const outcome = approvals.handle(request(), () => pc.promise);
    await tick();
    pc.resolve('allowed-once');

    assert.equal(await outcome, 'allowed-once');
    assert.equal(approvals.stats.sendErrors, 1);
    assert.equal(link.asked().length, 0);
    assert.ok(
      log.entries.some((e) => e.level === 'error' && e.text.includes('approval.asked')),
      '发送失败应留下可诊断的 error',
    );
  });

  test('电脑分支返回对象 {outcome} 也能归一化', async () => {
    const { approvals } = setup();
    const outcome = await approvals.handle(request(), async () => ({ outcome: 'rejected' }));
    assert.equal(outcome, 'rejected');
  });
});

// ---------------------------------------------------------------------------
// Task 28：结算门经共享 claim()（docs/04 Task 23「共用 race/settle 但不共用类」）
// ---------------------------------------------------------------------------

describe('共享幂等结算原语（Task 28）', () => {
  test('结算走共享 claim()：final 形状一致，二次结算 false 且无副作用', async () => {
    const { approvals, link } = setup();
    const pc = deferred();

    const outcomePromise = approvals.handle(request(), () => pc.promise);
    await tick();
    const id = link.asked()[0].payload.id;

    assert.equal(approvals.onDeviceDecide({ id, decision: 'allow' }), true);
    assert.equal(await outcomePromise, 'allowed-once');

    const statsAfterFirstSettle = approvals.stats;
    const doneAfterFirstSettle = link.done();
    assert.equal(doneAfterFirstSettle.length, 1, '结算后恰好一条 approval.done');
    assert.equal(doneAfterFirstSettle[0].payload.outcome, 'allowed-once');
    assert.equal(doneAfterFirstSettle[0].payload.decidedBy, 'device');
    assert.equal(approvals.pendingCount, 0);

    // 二次结算（设备迟到的另一个裁决）必须被共享 claim() 拒绝：
    // 不重复发 done、不改统计（仅 lateDecisions 记录迟到）。
    assert.equal(approvals.onDeviceDecide({ id, decision: 'deny' }), false);
    assert.equal(link.done().length, doneAfterFirstSettle.length);
    assert.deepEqual(approvals.stats, {
      ...statsAfterFirstSettle,
      lateDecisions: statsAfterFirstSettle.lateDecisions + 1,
    });

    // claim() 写入的结构就是 #settle 传入的结构。
    const entry = {};
    assert.equal(claim(entry, { outcome: 'allowed-once', decidedBy: 'device' }), true);
    assert.deepEqual(entry.final, { outcome: 'allowed-once', decidedBy: 'device' });
    assert.equal(claim(entry, { outcome: 'rejected', decidedBy: 'pc' }), false);
    assert.deepEqual(entry.final, { outcome: 'allowed-once', decidedBy: 'device' });

    // entry 是私有状态，无法从外部 spy；静态确认生产代码接线到共享 claim。
    const source = readFileSync(new URL('../../src/host/approvals.js', import.meta.url), 'utf8');
    assert.match(source, /import \{ claim \} from '\.\/race\.js';/);
    assert.match(source, /if \(!claim\(entry, \{ outcome, decidedBy \}\)\) return false;/);
  });
});

// ---------------------------------------------------------------------------
// §5.1.2：approval.asked 超 maxPayload 的通用拆分信封
// ---------------------------------------------------------------------------

describe('approval.asked 超 maxPayload 按 §5.1.2 拆分', () => {
  test('大 detail 拆成多片：同 id/ver、每片不超限、拼接后还原且只对应一张卡片', async () => {
    const link = new FakeLink();
    link.info = { paired: true, maxPayload: 520 };
    const { approvals } = setup({ link });
    const command = 'rm -rf 临时目录 && echo 继续'.repeat(120); // 远超 520 字节
    const pc = deferred();

    const outcome = approvals.handle(
      request({ id: 'ap_big', callId: 'call_big', detail: { command, cwd: '/work' } }),
      () => pc.promise,
    );
    await tick();
    await tick();

    const asked = link.asked();
    assert.ok(asked.length > 1, `应拆成多片，实际 ${asked.length}`);
    const payloads = asked.map((m) => m.payload);
    const approvalId = payloads[0].id;
    assert.ok(
      typeof approvalId === 'string' && payloads.every((p) => p.id === approvalId),
      '所有片必须共用同一个审批 id（设备据此只渲染一张卡片）',
    );
    assert.equal(new Set(payloads.map((p) => p.ver)).size, 1, '同一逻辑消息共用 ver');
    assert.deepEqual(
      payloads.map((p) => p.part),
      payloads.map((_, i) => i + 1),
    );
    assert.ok(payloads.every((p) => p.parts === payloads.length));

    const max = link.info.maxPayload;
    for (const payload of payloads) {
      assert.ok(
        Buffer.byteLength(JSON.stringify(payload), 'utf8') <= max,
        `part ${payload.part} 超过 maxPayload=${max}`,
      );
    }

    // 对象 detail 的合并规则：同一路径的字符串按 part 顺序拼接，其余字段合并。
    const merged = {};
    for (const payload of payloads) {
      for (const [key, value] of Object.entries(payload.detail)) {
        if (typeof value === 'string' && typeof merged[key] === 'string') merged[key] += value;
        else merged[key] = value;
      }
    }
    assert.equal(merged.command, command, 'detail.command 必须完整还原，不能被截断');
    assert.equal(merged.cwd, '/work', '非字符串字段只出现在首片，合并后仍在');

    pc.resolve('allowed-once');
    assert.equal(await outcome, 'allowed-once');
    assert.equal(link.done().length, 1, '无论拆几片，只结算一张卡片');
  });
});
