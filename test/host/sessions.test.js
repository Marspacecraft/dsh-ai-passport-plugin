// host/sessions.js 验收测试（docs/04 Task 21 / docs/02 §4.5）
//
// 重点盯三处 v1 事故：
//   1. role 只能由 parentSessionId 显式判定，不能靠"第一个跑的是主会话"。
//   2. elapsedMs 起点不可靠时整字段省略，不能填 0。
//   3. emit('changed') 必须能让 push 层区分"内容变了"和"只是 elapsedMs 变了"。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { Sessions } from '../../src/host/sessions.js';

// ---------------------------------------------------------------------------
// 测试基建
// ---------------------------------------------------------------------------

/** 假时钟：setTimer/clearTimer/now，advance 按到期顺序触发。 */
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
  const warnings = [];
  const errors = [];
  const base = { warn: (...a) => warnings.push(a), error: (...a) => errors.push(a) };
  return {
    log: { ...base, info() {}, debug() {} },
    warnings,
    errors,
  };
}

function setup(extra = {}) {
  const clock = makeClock();
  const { log, warnings, errors } = makeLog();
  const sessions = new Sessions({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    log,
    ...extra,
  });
  return { sessions, clock, log: warnings, errors };
}

function rows(sessions) {
  return sessions.snapshot().sessions;
}

function row(sessions, id) {
  return rows(sessions).find((s) => s.id === id);
}

function collect(sessions) {
  const events = [];
  sessions.on('changed', (e) => events.push(e));
  return events;
}

// ---------------------------------------------------------------------------
// role
// ---------------------------------------------------------------------------

describe('role 由 parentSessionId 显式判定', () => {
  test('无 parentSessionId → main；有 → sub，且 parentId 落到线上字段', () => {
    const { sessions } = setup();
    sessions.upsert('s_main', { title: '主会话' });
    sessions.upsert('s_sub', { title: '子会话', parentSessionId: 's_main' });

    const main = row(sessions, 's_main');
    const sub = row(sessions, 's_sub');
    assert.equal(main.role, 'main');
    assert.equal('parentId' in main, false, '主会话不应带 parentId');
    assert.equal(sub.role, 'sub');
    assert.equal(sub.parentId, 's_main');
  });

  test('多会话并发：先跑的不因为"第一个"被当成主会话', () => {
    const { sessions } = setup();
    sessions.upsert('a', { state: 'running' });
    sessions.upsert('b', { state: 'running' });
    sessions.upsert('c', { state: 'running', parentSessionId: 'b' });
    sessions.upsert('d', { state: 'running', parentSessionId: 'a' });

    assert.equal(row(sessions, 'a').role, 'main');
    assert.equal(row(sessions, 'b').role, 'main');
    assert.equal(row(sessions, 'c').role, 'sub');
    assert.equal(row(sessions, 'c').parentId, 'b');
    assert.equal(row(sessions, 'd').role, 'sub');
    assert.equal(row(sessions, 'd').parentId, 'a');
  });

  test('parentSessionId: null 把子会话升回主会话', () => {
    const { sessions } = setup();
    sessions.upsert('x', { parentSessionId: 'p' });
    assert.equal(row(sessions, 'x').role, 'sub');
    sessions.upsert('x', { parentSessionId: null });
    const x = row(sessions, 'x');
    assert.equal(x.role, 'main');
    assert.equal('parentId' in x, false);
  });

  test('不传 parentSessionId 的后续 upsert 不会把既有角色重置', () => {
    const { sessions } = setup();
    sessions.upsert('x', { parentSessionId: 'p' });
    sessions.upsert('x', { title: '改名' });
    assert.equal(row(sessions, 'x').role, 'sub');
    assert.equal(row(sessions, 'x').parentId, 'p');
  });
});

// ---------------------------------------------------------------------------
// 字段
// ---------------------------------------------------------------------------

describe('会话字段', () => {
  test('新建会话默认 idle / 空标题 / attention none，未知 model/cwd 省略', () => {
    const { sessions } = setup();
    sessions.upsert('s1');
    const s = row(sessions, 's1');
    assert.deepEqual(s, {
      id: 's1',
      role: 'main',
      state: 'idle',
      title: '',
      attention: 'none',
    });
  });

  test('model / cwd 有值时透传', () => {
    const { sessions } = setup();
    sessions.upsert('s1', { model: 'deepseek-v4.1-flash', cwd: '/tmp/x' });
    const s = row(sessions, 's1');
    assert.equal(s.model, 'deepseek-v4.1-flash');
    assert.equal(s.cwd, '/tmp/x');
  });

  test('非法 state / attention 值拒绝', () => {
    const { sessions } = setup();
    sessions.upsert('s1');
    assert.throws(() => sessions.upsert('s1', { state: 'zombie' }), TypeError);
    assert.throws(() => sessions.setAttention('s1', 'busy'), TypeError);
  });
});

// ---------------------------------------------------------------------------
// elapsedMs
// ---------------------------------------------------------------------------

describe('elapsedMs', () => {
  test('观察到的 idle→running 跃迁记为可靠起点，按假时钟累计', () => {
    const { sessions, clock } = setup();
    sessions.upsert('s1');
    sessions.upsert('s1', { state: 'running' });
    clock.advance(1500);
    assert.equal(row(sessions, 's1').elapsedMs, 1500);
    clock.advance(500);
    assert.equal(row(sessions, 's1').elapsedMs, 2000);
  });

  test('起点不可靠时整个字段省略，而不是填 0', () => {
    const { sessions, clock } = setup();
    // 插件 attach 时会话已经在跑：主机不知道这轮是什么时候开始的。
    sessions.upsert('s1', { state: 'running', startedAt: null });
    clock.advance(3000);
    const s = row(sessions, 's1');
    assert.equal('elapsedMs' in s, false);
    assert.equal(s.elapsedMs, undefined);
  });

  test('首次见到会话时它已在 running：无 startedAt 视为起点不可靠', () => {
    const { sessions, clock } = setup();
    sessions.upsert('s1', { state: 'running' });
    clock.advance(3_000);
    assert.equal('elapsedMs' in row(sessions, 's1'), false);
  });

  test('显式 startedAt 可用于补齐 attach 前的已知起点', () => {
    const { sessions, clock } = setup();
    clock.advance(10_000);
    sessions.upsert('s1', { state: 'running', startedAt: 4_000 });
    assert.equal(row(sessions, 's1').elapsedMs, 6_000);
    clock.advance(1_000);
    assert.equal(row(sessions, 's1').elapsedMs, 7_000);
  });

  test('done 后 elapsedMs 冻结，转 idle 后整体省略', () => {
    const { sessions, clock } = setup();
    sessions.upsert('s1');
    sessions.upsert('s1', { state: 'running' });
    clock.advance(2_000);
    sessions.upsert('s1', { state: 'done' });
    assert.equal(row(sessions, 's1').elapsedMs, 2_000);
    clock.advance(5_000);
    assert.equal(row(sessions, 's1').elapsedMs, 2_000, 'done 期间时长应冻结');
    clock.advance(3_000); // 8s 到期 → idle
    assert.equal(row(sessions, 's1').state, 'idle');
    assert.equal('elapsedMs' in row(sessions, 's1'), false);
  });
});

// ---------------------------------------------------------------------------
// attention
// ---------------------------------------------------------------------------

describe('attention 由在途审批/提问驱动', () => {
  test('置位 approval / question，结算后回到 none', () => {
    const { sessions } = setup();
    sessions.upsert('s1');

    sessions.setAttention('s1', 'approval');
    assert.equal(row(sessions, 's1').attention, 'approval');
    sessions.setAttention('s1', 'none');
    assert.equal(row(sessions, 's1').attention, 'none');

    sessions.setAttention('s1', 'question');
    assert.equal(row(sessions, 's1').attention, 'question');
    sessions.setAttention('s1', 'none');
    assert.equal(row(sessions, 's1').attention, 'none');
  });

  test('多个在途项并存时 question 优先于 approval（结算一个回落另一个）', () => {
    const { sessions } = setup();
    sessions.upsert('s1');

    sessions.beginAttention('s1', 'approval', 'req-1');
    sessions.beginAttention('s1', 'question', 'q-1');
    assert.equal(row(sessions, 's1').attention, 'question');

    sessions.endAttention('s1', 'question', 'q-1');
    assert.equal(row(sessions, 's1').attention, 'approval');

    sessions.endAttention('s1', 'approval', 'req-1');
    assert.equal(row(sessions, 's1').attention, 'none');
  });

  test('同一 token 重复 begin/end 幂等', () => {
    const { sessions } = setup();
    sessions.upsert('s1');
    const events = collect(sessions);

    sessions.beginAttention('s1', 'approval', 'req-1');
    sessions.beginAttention('s1', 'approval', 'req-1');
    assert.equal(row(sessions, 's1').attention, 'approval');
    assert.equal(events.length, 1);

    sessions.endAttention('s1', 'approval', 'req-1');
    sessions.endAttention('s1', 'approval', 'req-1');
    assert.equal(row(sessions, 's1').attention, 'none');
    assert.equal(events.length, 2);
  });

  test('未知会话的 attention 更新不抛异常、不留状态', () => {
    const { sessions } = setup();
    assert.equal(sessions.setAttention('ghost', 'approval'), false);
    assert.equal(sessions.beginAttention('ghost', 'question', 'q'), false);
    assert.equal(sessions.endAttention('ghost', 'question', 'q'), false);
    assert.equal(rows(sessions).length, 0);
  });

  test('remove 会话时清空其 attention 挂起状态', () => {
    const { sessions } = setup();
    sessions.upsert('s1');
    sessions.beginAttention('s1', 'approval', 'req-1');
    sessions.remove('s1');
    sessions.upsert('s1');
    assert.equal(row(sessions, 's1').attention, 'none');
  });
});

// ---------------------------------------------------------------------------
// snapshot 防污染
// ---------------------------------------------------------------------------

describe('snapshot() 防污染', () => {
  test('修改返回值不影响内部状态，也不影响下一次 snapshot', () => {
    const { sessions } = setup();
    sessions.upsert('s1', { title: '原始标题', state: 'running', startedAt: 0 });

    const first = sessions.snapshot();
    first.sessions[0].title = '被篡改';
    first.sessions[0].state = 'error';
    first.sessions[0].attention = 'question';
    first.sessions.push({ id: 'fake' });
    first.sessions.length = 0;

    const second = sessions.snapshot();
    assert.equal(second.sessions.length, 1);
    assert.equal(second.sessions[0].title, '原始标题');
    assert.equal(second.sessions[0].state, 'running');
    assert.equal(second.sessions[0].attention, 'none');
  });

  test('两次 snapshot 返回不同对象/数组引用', () => {
    const { sessions } = setup();
    sessions.upsert('s1');
    const a = sessions.snapshot();
    const b = sessions.snapshot();
    assert.notEqual(a, b);
    assert.notEqual(a.sessions, b.sessions);
    assert.notEqual(a.sessions[0], b.sessions[0]);
  });
});

// ---------------------------------------------------------------------------
// changed reason
// ---------------------------------------------------------------------------

describe('changed 事件的 reason', () => {
  test('内容字段变化 → reason=content', () => {
    const { sessions } = setup();
    const events = collect(sessions);

    sessions.upsert('s1');
    assert.deepEqual(events.at(-1), { reason: 'content' });

    sessions.upsert('s1', { title: '新标题' });
    assert.deepEqual(events.at(-1), { reason: 'content' });

    sessions.upsert('s1', { state: 'running' });
    assert.deepEqual(events.at(-1), { reason: 'content' });

    sessions.setAttention('s1', 'approval');
    assert.deepEqual(events.at(-1), { reason: 'content' });

    sessions.remove('s1');
    assert.deepEqual(events.at(-1), { reason: 'content' });
  });

  test('只有 elapsedMs 随时间变化 → reason=elapsed，不是 content', () => {
    const { sessions, clock } = setup();
    sessions.upsert('s1');
    sessions.upsert('s1', { state: 'running' });
    const events = collect(sessions);

    clock.advance(1_000);
    assert.deepEqual(events, [{ reason: 'elapsed' }]);

    clock.advance(1_000);
    assert.deepEqual(events, [{ reason: 'elapsed' }, { reason: 'elapsed' }]);
    assert.equal(events.some((e) => e.reason === 'content'), false);
  });

  test('起点不可靠时不会凭空发 elapsed 事件', () => {
    const { sessions, clock } = setup();
    sessions.upsert('s1', { state: 'running', startedAt: null });
    const events = collect(sessions);
    clock.advance(5_000);
    assert.deepEqual(events, []);
  });

  test('内容与服务时长同时变化时只发 content（不让 push 误判为纯走秒）', () => {
    const { sessions, clock } = setup();
    sessions.upsert('s1');
    sessions.upsert('s1', { state: 'running' });
    clock.advance(1_500);
    const events = collect(sessions);

    sessions.upsert('s1', { title: '同时改名' });
    assert.deepEqual(events, [{ reason: 'content' }]);
  });

  test('内容没变的重复 upsert 不发事件', () => {
    const { sessions } = setup();
    sessions.upsert('s1', { title: 't' });
    const events = collect(sessions);
    sessions.upsert('s1', { title: 't' });
    assert.deepEqual(events, []);
  });
});

// ---------------------------------------------------------------------------
// 状态流转 / done → idle
// ---------------------------------------------------------------------------

describe('状态流转与 done 保持', () => {
  test('idle → running → waiting → done，8 秒后自动转 idle', () => {
    const { sessions, clock } = setup();
    const events = collect(sessions);
    sessions.upsert('s1');

    sessions.upsert('s1', { state: 'running' });
    sessions.upsert('s1', { state: 'waiting' });
    sessions.upsert('s1', { state: 'done' });
    assert.equal(row(sessions, 's1').state, 'done');

    clock.advance(7_999);
    assert.equal(row(sessions, 's1').state, 'done', '不足 8 秒必须保持 done');

    clock.advance(1);
    assert.equal(row(sessions, 's1').state, 'idle');
    assert.deepEqual(events.at(-1), { reason: 'content' });
  });

  test('done 期间被改为 error 会取消 8 秒计时', () => {
    const { sessions, clock } = setup();
    sessions.upsert('s1');
    sessions.upsert('s1', { state: 'running' });
    sessions.upsert('s1', { state: 'done' });
    clock.advance(2_000);
    sessions.upsert('s1', { state: 'error' });
    clock.advance(10_000);
    assert.equal(row(sessions, 's1').state, 'error');
  });

  test('remove 会取消 done 计时，不会攻击已删除的会话', () => {
    const { sessions, clock } = setup();
    sessions.upsert('s1');
    sessions.upsert('s1', { state: 'done' });
    sessions.remove('s1');
    const events = collect(sessions);
    clock.advance(10_000);
    assert.equal(rows(sessions).length, 0);
    assert.deepEqual(events, []);
  });

  test('error 状态可进入，且可再开新一轮 running', () => {
    const { sessions, clock } = setup();
    sessions.upsert('s1');
    sessions.upsert('s1', { state: 'running' });
    clock.advance(1_000);
    sessions.upsert('s1', { state: 'error' });
    assert.equal(row(sessions, 's1').state, 'error');
    assert.equal(row(sessions, 's1').elapsedMs, 1_000);

    clock.advance(1_000);
    sessions.upsert('s1', { state: 'running' });
    assert.equal(row(sessions, 's1').elapsedMs, 0);
    clock.advance(2_000);
    assert.equal(row(sessions, 's1').elapsedMs, 2_000);
  });

  test('remove：存在返回 true 并发 content，未知 id 返回 false 不发事件', () => {
    const { sessions } = setup();
    sessions.upsert('s1');
    const events = collect(sessions);
    assert.equal(sessions.remove('s1'), true);
    assert.deepEqual(events, [{ reason: 'content' }]);
    assert.equal(sessions.remove('s1'), false);
    assert.equal(events.length, 1);
  });

  test('dispose 后写入口统一抛错：upsert/remove/setAttention/begin-endAttention', () => {
    const { sessions } = setup();
    sessions.upsert('s1');
    sessions.dispose();

    assert.throws(() => sessions.upsert('s2'), /已 dispose/);
    assert.throws(() => sessions.remove('s1'), /已 dispose/);
    assert.throws(() => sessions.setAttention('s1', 'approval'), /已 dispose/);
    assert.throws(() => sessions.beginAttention('s1', 'approval', 't1'), /已 dispose/);
    assert.throws(() => sessions.endAttention('s1', 'approval', 't1'), /已 dispose/);
    // 只读入口不崩：设备侧仍可能读到最后一帧（由上层决定是否停推）。
    assert.equal(sessions.has('s1'), true);
    assert.equal(sessions.get('s1')?.id, 's1');
  });

  test('dispose 后不再有计时器回调', () => {
    const { sessions, clock } = setup();
    sessions.upsert('s1');
    sessions.upsert('s1', { state: 'running' });
    sessions.upsert('s1', { state: 'done' });
    const events = collect(sessions);
    sessions.dispose();
    clock.advance(20_000);
    assert.deepEqual(events, []);
    assert.equal(row(sessions, 's1').state, 'done');
  });
});
