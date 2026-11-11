import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { PendingAcks } from '../../src/wire/acks.js';
import { ACK_RETRY_DELAYS_MS } from '../../src/wire/constants.js';
import { WireError, ERR } from '../../src/wire/errors.js';

/**
 * 假时钟：完全接管定时器，让重传时刻可以被逐毫秒断言。
 *
 * `autoClear = false` 时 clearTimer 变成空操作，用来验证
 * "定时器迟到触发也不能重传已确认的消息"。
 */
class FakeClock {
  constructor({ autoClear = true } = {}) {
    this.t = 0;
    this.seq = 1;
    this.timers = new Map();
    this.autoClear = autoClear;
  }

  now() {
    return this.t;
  }

  setTimer(fn, ms) {
    const id = this.seq;
    this.seq += 1;
    this.timers.set(id, { fn, at: this.t + ms, ms });
    return id;
  }

  clearTimer(id) {
    if (this.autoClear) this.timers.delete(id);
  }

  unref() {}

  /** 前进 ms 毫秒，按到期顺序逐个执行回调。 */
  advance(ms) {
    const target = this.t + ms;
    for (;;) {
      let picked = null;
      for (const [id, tm] of this.timers) {
        if (tm.at > target) continue;
        if (!picked || tm.at < picked.tm.at) picked = { id, tm };
      }
      if (!picked) break;
      this.timers.delete(picked.id);
      this.t = picked.tm.at;
      picked.tm.fn();
    }
    this.t = target;
  }

  /** 当前挂着的定时器的到期时刻（毫秒，绝对）。 */
  deadlines() {
    return [...this.timers.values()].map((t) => t.at).sort((a, b) => a - b);
  }
}

/** 造一条 N 片的消息帧，内容无关紧要，只要长度对。 */
function fakeFrames(n, size = 10) {
  return Array.from({ length: n }, (_, i) => new Uint8Array(size).fill(i));
}

/** 组装一个带假时钟的 PendingAcks，并记录所有回调。 */
function makeHarness({ retryDelays, frames = fakeFrames(2), autoClear = true } = {}) {
  const clock = new FakeClock({ autoClear });
  const sends = [];
  const giveUps = [];
  const acks = new PendingAcks({
    ...(retryDelays ? { retryDelays } : {}),
    now: () => clock.now(),
    setTimer: (fn, ms) => clock.setTimer(fn, ms),
    clearTimer: (h) => clock.clearTimer(h),
    unref: () => {},
    send: (msgId, resent, frags) => sends.push({ msgId, count: resent.length, frags: [...frags], at: clock.now() }),
    onGiveUp: (msgId, info) => giveUps.push({ msgId, ...info, at: clock.now() }),
  });
  acks.track(1, frames);
  return { clock, acks, sends, giveUps, frames };
}

describe('待确认表：基本登记', () => {
  test('track 后进入待确认，未重传时 retries 为 0', () => {
    const { acks, sends } = makeHarness();
    assert.equal(acks.size, 1);
    assert.equal(acks.retriesOf(1), 0);
    assert.equal(sends.length, 0, 'track 本身不发包（调用方已发首轮）');
  });

  test('构造时 retryDelays 必须非空', () => {
    for (const bad of [[], null, 'x']) {
      assert.throws(() => new PendingAcks({ retryDelays: bad }), WireError);
    }
  });

  test('track 需要至少一个分片', () => {
    const acks = new PendingAcks();
    assert.throws(() => acks.track(1, []), (e) => e instanceof WireError && e.code === ERR.BAD_PAYLOAD);
    assert.throws(() => acks.track(1, null), WireError);
  });

  test('同号重复 track 抛错（防止两条消息共用一个号）', () => {
    const acks = new PendingAcks({ send: () => {}, setTimer: () => 1, clearTimer: () => {}, unref: () => {} });
    acks.track(1, fakeFrames(1));
    assert.throws(() => acks.track(1, fakeFrames(1)), WireError);
  });

  test('retriesOf 对未知号返回 null', () => {
    const acks = new PendingAcks();
    assert.equal(acks.retriesOf(999), null);
  });
});

describe('待确认表：ACK 正常路径', () => {
  test('首个超时前收到 ack：不再重传', () => {
    const { clock, acks, sends, giveUps } = makeHarness();
    clock.advance(399);
    assert.equal(acks.acknowledge(1), true);
    assert.equal(acks.size, 0);

    clock.advance(10000);
    assert.equal(sends.length, 0, '已确认的消息不得重传');
    assert.equal(giveUps.length, 0);
  });

  test('acknowledge 幂等：第二次返回 false，不抛错', () => {
    const { acks } = makeHarness();
    assert.equal(acks.acknowledge(1), true);
    assert.equal(acks.acknowledge(1), false);
    assert.equal(acks.acknowledge(999), false);
  });

  test('定时器迟到触发也不能重传已确认的消息（unref 后的真实风险）', () => {
    // autoClear=false 模拟 clearTimer 失效／定时器已在事件队列里排队
    const { clock, acks, sends } = makeHarness({ autoClear: false });
    acks.acknowledge(1);
    clock.advance(10000);
    assert.equal(sends.length, 0, '回调内的二次确认必须拦住');
  });
});

describe('待确认表：指数退避与放弃', () => {
  test('三次重传分别落在 400 / 1200 / 2800 ms（协议 §2.5 退避序列）', () => {
    const { clock, sends } = makeHarness();
    clock.advance(400);
    assert.equal(sends.length, 1);
    assert.equal(sends[0].at, 400, '第 1 次重传在 400ms');

    clock.advance(800);
    assert.equal(sends.length, 2);
    assert.equal(sends[1].at, 1200, '第 2 次在 400+800=1200ms');

    clock.advance(1600);
    assert.equal(sends.length, 3);
    assert.equal(sends[2].at, 2800, '第 3 次在 1200+1600=2800ms');

    clock.advance(1600);
    assert.equal(sends.length, 3, '第 3 次之后不再重传');
  });

  test('3 次重传仍无 ack → onGiveUp 报 ack-timeout 并释放', () => {
    const { clock, acks, giveUps } = makeHarness();
    clock.advance(4399);
    assert.equal(giveUps.length, 0, '4400ms 之前不能放弃');
    clock.advance(1);
    assert.equal(giveUps.length, 1);
    assert.equal(giveUps[0].msgId, 1);
    assert.equal(giveUps[0].reason, 'ack-timeout');
    assert.equal(giveUps[0].retries, 3);
    assert.equal(acks.size, 0, '放弃后必须从待确认表移除');
  });

  test('重传发送的是该消息的全部分片与全部片号', () => {
    const frames = fakeFrames(5);
    const { clock, sends } = makeHarness({ frames });
    clock.advance(400 + 800 + 1600);
    for (const s of sends) {
      assert.equal(s.count, 5, '整条重传应包含全部 5 片');
      assert.deepEqual(s.frags, [0, 1, 2, 3, 4]);
    }
  });

  test('退避序列可注入（测试与调参用）', () => {
    const { clock, sends } = makeHarness({ retryDelays: [100, 200] });
    clock.advance(100);
    assert.equal(sends.length, 1);
    clock.advance(200);
    assert.equal(sends.length, 2);
    clock.advance(200);
    assert.equal(sends.length, 2, '只有两轮重传');
  });

  test('两轮序列下第 3 个超时点放弃', () => {
    const { clock, giveUps } = makeHarness({ retryDelays: [100, 200] });
    clock.advance(499);
    assert.equal(giveUps.length, 0);
    clock.advance(1); // 100+200+200 = 500
    assert.equal(giveUps.length, 1);
    assert.equal(giveUps[0].retries, 2);
  });

  test('默认退避序列来自协议常量', () => {
    assert.deepEqual(ACK_RETRY_DELAYS_MS, [400, 800, 1600]);
    const { clock, sends } = makeHarness();
    clock.advance(400);
    assert.equal(sends.length, 1);
  });
});

describe('待确认表：NACK 与选择性重传', () => {
  test('nack 带 missing：[2,4] 只重发 2、4 两片', () => {
    const clock = new FakeClock();
    const sends = [];
    const acks = new PendingAcks({
      now: () => clock.now(),
      setTimer: (fn, ms) => clock.setTimer(fn, ms),
      clearTimer: (h) => clock.clearTimer(h),
      unref: () => {},
      send: (msgId, resent, frags) => sends.push({ msgId, count: resent.length, frags: [...frags] }),
    });
    acks.track(1, fakeFrames(5));
    acks.negativeAcknowledge(1, [2, 4]);
    assert.equal(sends.length, 1);
    assert.deepEqual(sends[0].frags, [2, 4]);
    assert.equal(sends[0].count, 2);
    assert.equal(acks.stats.selective, 1);
  });

  test('nack 无 missing 时整条重发', () => {
    const clock = new FakeClock();
    const sends = [];
    const acks = new PendingAcks({
      now: () => clock.now(),
      setTimer: (fn, ms) => clock.setTimer(fn, ms),
      clearTimer: (h) => clock.clearTimer(h),
      unref: () => {},
      send: (msgId, resent, frags) => sends.push({ msgId, count: resent.length, frags: [...frags] }),
    });
    acks.track(1, fakeFrames(4));
    acks.negativeAcknowledge(1);
    assert.equal(sends.length, 1, '整条重传应是一次调���，带上全部分片');
    assert.equal(sends[0].count, 4);
    assert.deepEqual(sends[0].frags, [0, 1, 2, 3]);
    assert.equal(acks.stats.selective, 0);
  });

  test('nack 的 missing 去重且过滤非法片号', () => {
    const clock = new FakeClock();
    const sends = [];
    const acks = new PendingAcks({
      now: () => clock.now(),
      setTimer: (fn, ms) => clock.setTimer(fn, ms),
      clearTimer: (h) => clock.clearTimer(h),
      unref: () => {},
      send: (msgId, resent, frags) => sends.push({ ...{ frags: [...frags] } }),
    });
    acks.track(1, fakeFrames(3));
    acks.negativeAcknowledge(1, [1, 1, 99, -2, 0]);
    assert.deepEqual(sends[0].frags, [1, 0], '去重、丢越界、保留合法片号（顺序按输入）');
  });

  test('nack 全是非法片号时按整条重传兜底', () => {
    const clock = new FakeClock();
    const sends = [];
    const acks = new PendingAcks({
      now: () => clock.now(),
      setTimer: (fn, ms) => clock.setTimer(fn, ms),
      clearTimer: (h) => clock.clearTimer(h),
      unref: () => {},
      send: (msgId, resent, frags) => sends.push({ count: resent.length, frags: [...frags] }),
    });
    acks.track(1, fakeFrames(3));
    acks.negativeAcknowledge(1, [99, 100]);
    assert.equal(sends.length, 1);
    assert.equal(sends[0].count, 3, '兜底应整条重发');
  });

  test('nack 不重置重试计数（反复丢片不能无限拖）', () => {
    const clock = new FakeClock();
    const giveUps = [];
    const acks = new PendingAcks({
      now: () => clock.now(),
      setTimer: (fn, ms) => clock.setTimer(fn, ms),
      clearTimer: (h) => clock.clearTimer(h),
      unref: () => {},
      send: () => {},
      onGiveUp: (msgId, info) => giveUps.push({ msgId, ...info }),
    });
    acks.track(1, fakeFrames(2));
    acks.negativeAcknowledge(1, [0]);
    assert.equal(acks.retriesOf(1), 0, 'nack 不应增加 retries');

    clock.advance(400 + 800 + 1600 + 1600);
    assert.equal(giveUps.length, 1, 'nack 之后仍按原计数走完退避并放弃');
  });

  test('nack 未知号返回 false', () => {
    const acks = new PendingAcks();
    assert.equal(acks.negativeAcknowledge(42, [0]), false);
  });
});

describe('待确认表：主动放弃与断链', () => {
  test('abandon 回调 onGiveUp 并停止重传', () => {
    const { clock, acks, sends, giveUps } = makeHarness();
    assert.equal(acks.abandon(1, 'send-failed'), true);
    assert.equal(giveUps.length, 1);
    assert.equal(giveUps[0].reason, 'send-failed');
    clock.advance(10000);
    assert.equal(sends.length, 0, '放弃后不得再重传');
  });

  test('abandon 未知号返回 false', () => {
    const acks = new PendingAcks();
    assert.equal(acks.abandon(123), false);
  });

  test('clear 清空全部并逐个回调（断链清理，协议 §9.2）', () => {
    const clock = new FakeClock();
    const giveUps = [];
    const acks = new PendingAcks({
      now: () => clock.now(),
      setTimer: (fn, ms) => clock.setTimer(fn, ms),
      clearTimer: (h) => clock.clearTimer(h),
      unref: () => {},
      send: () => {},
      onGiveUp: (msgId, info) => giveUps.push({ msgId, reason: info.reason }),
    });
    acks.track(1, fakeFrames(1));
    acks.track(2, fakeFrames(1));
    acks.track(3, fakeFrames(1));

    assert.equal(acks.clear('disconnect'), 3);
    assert.equal(acks.size, 0);
    assert.equal(giveUps.length, 3);
    assert.ok(giveUps.every((g) => g.reason === 'disconnect'));

    clock.advance(10000);
    assert.equal(giveUps.length, 3, '清空后不得再触发放弃');
  });

  test('clear 空表返回 0', () => {
    const acks = new PendingAcks();
    assert.equal(acks.clear(), 0);
  });
});

describe('待确认表：可观测性', () => {
  test('snapshot 汇总待确认数与各类计数', () => {
    const clock = new FakeClock();
    const acks = new PendingAcks({
      now: () => clock.now(),
      setTimer: (fn, ms) => clock.setTimer(fn, ms),
      clearTimer: (h) => clock.clearTimer(h),
      unref: () => {},
      send: () => {},
    });
    acks.track(1, fakeFrames(2));
    acks.track(2, fakeFrames(3));
    acks.negativeAcknowledge(2, [0]);
    acks.acknowledge(1);

    const s = acks.snapshot();
    assert.equal(s.pending, 1);
    assert.equal(s.tracked, 2);
    assert.equal(s.acked, 1);
    assert.equal(s.selective, 1);
    assert.equal(s.maxRetries, 3);
  });

  test('超时放弃也计入 timeouts', () => {
    const { clock, acks } = makeHarness();
    clock.advance(4400);
    assert.equal(acks.stats.timeouts, 1);
  });
});
