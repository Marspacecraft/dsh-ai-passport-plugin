// host/state.js 验收测试（docs/04 Task 21 / docs/02 §4.5）
//
// state.js 只做对外只读快照视图：不持有业务状态、不缓存、不推断。
// 外部拿到的东西必须是深冻结的，改不动 Sessions 内部。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { StateView, createStateView } from '../../src/host/state.js';
import { Sessions } from '../../src/host/sessions.js';

function makeSessions() {
  const sessions = new Sessions();
  sessions.upsert('s1', { title: '标题一', state: 'running', startedAt: 0 });
  return sessions;
}

describe('StateView 只读视图', () => {
  test('snapshot() 深冻结，任何层级都改不动', () => {
    const view = new StateView({ sessions: makeSessions() });
    const snap = view.snapshot();

    assert.equal(Object.isFrozen(snap), true);
    assert.equal(Object.isFrozen(snap.sessions), true);
    assert.equal(Object.isFrozen(snap.sessions[0]), true);

    assert.throws(() => {
      snap.sessions[0].title = '篡改';
    }, TypeError);
    assert.throws(() => {
      snap.sessions.push({ id: 'fake' });
    }, TypeError);
    assert.throws(() => {
      snap.sessions = [];
    }, TypeError);
  });

  test('改返回值不会影响 Sessions 内部状态', () => {
    const sessions = makeSessions();
    const view = new StateView({ sessions });
    const snap = view.snapshot();

    assert.throws(() => {
      snap.sessions[0].state = 'error';
    }, TypeError);
    assert.equal(view.snapshot().sessions[0].state, 'running');
    assert.equal(sessions.snapshot().sessions[0].state, 'running');
  });

  test('不缓存：每次都反映最新的 Sessions 快照', () => {
    const sessions = makeSessions();
    const view = new StateView({ sessions });

    const before = view.snapshot();
    sessions.upsert('s1', { title: '标题二' });
    const after = view.snapshot();

    assert.equal(before.sessions[0].title, '标题一');
    assert.equal(after.sessions[0].title, '标题二');
    assert.notEqual(before, after);
  });

  test('每次调用底层 snapshot 一次（视图自身不持有副本）', () => {
    let calls = 0;
    const fake = {
      snapshot() {
        calls += 1;
        return { sessions: [] };
      },
    };
    const view = new StateView({ sessions: fake });
    view.snapshot();
    view.snapshot();
    view.count;
    assert.equal(calls, 3);
  });

  test('没有写入口：upsert/remove/setAttention 均不存在', () => {
    const view = new StateView({ sessions: makeSessions() });
    assert.equal(typeof view.upsert, 'undefined');
    assert.equal(typeof view.remove, 'undefined');
    assert.equal(typeof view.setAttention, 'undefined');
    assert.equal(typeof view.snapshot, 'function');
  });

  test('sessions getter 返回冻结数组，count 实时统计', () => {
    const sessions = makeSessions();
    const view = new StateView({ sessions });
    assert.equal(Object.isFrozen(view.sessions), true);
    assert.equal(view.sessions[0].id, 's1');
    assert.equal(view.count, 1);
    sessions.upsert('s2');
    assert.equal(view.count, 2);
  });

  test('构造参数非法时立即失败', () => {
    assert.throws(() => new StateView(), TypeError);
    assert.throws(() => new StateView({}), TypeError);
    assert.throws(() => new StateView({ sessions: { snapshot: 1 } }), TypeError);
  });

  test('createStateView 工厂等价于 new StateView', () => {
    const view = createStateView({ sessions: makeSessions() });
    assert.equal(view instanceof StateView, true);
    assert.equal(view.snapshot().sessions.length, 1);
  });
});
