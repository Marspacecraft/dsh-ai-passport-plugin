/**
 * M3 Task 12：`link/keepalive.js` 双向保活与判死单元测试。
 *
 * 覆盖 docs/04 Task 12 全部验收项 + T1 回归（docs/02 §8）：
 * - 任意入站帧刷新 lastInboundAt（touch 公开入口，ack/nack/业务帧都能续命）
 * - 每 5 秒 tick：>5000 无入站发 ping；>30000 无入站 emit('dead') 并停 tick
 * - 有业务流量时不发 ping
 * - 零计数器（无 missedHeartbeats，代码审查项——测试用「连续 N 次 ping 间
 *   没有入站也不误判」侧面验证）
 * - ping{type,seq} seq 单调；收 ping 立即回 pong{seq}；收 pong 不校验
 * - 定时器全注入假时钟，测试总时长远小于 1 秒
 * - stop() 幂等且停后不再 emit
 * - T1：只回 ack 不回 pong，假时钟推 60 秒不判死
 */

import assert from 'node:assert/strict';
import { test, describe, beforeEach } from 'node:test';

import { Keepalive } from '../../src/link/keepalive.js';

/**
 * 假时钟：手动推进的 now + 可手动触发的定时器表。
 * setTimer(fn, ms) 不真等，advance(ms) 时按到期顺序触发。
 */
function makeFakeClock() {
  let now = 1_000_000; // 任意起点
  const timers = new Map(); // handle -> {fn, at}
  let nextHandle = 1;
  const fired = [];
  return {
    get now() {
      return now;
    },
    set now(v) {
      now = v;
    },
    fired,
    setTimer(fn, ms) {
      const handle = nextHandle++;
      timers.set(handle, { fn, at: now + ms });
      fired.push({ kind: 'set', handle, at: now + ms });
      return handle;
    },
    clearTimer(handle) {
      timers.delete(handle);
      fired.push({ kind: 'clear', handle });
    },
    /** 推进假时间并按序触发到期定时器（一次 tick 触发后重新按新 at 排）。 */
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let earliest = null;
        for (const [handle, t] of timers) {
          if (t.at <= target && (earliest === null || t.at < earliest.t.at)) {
            earliest = { handle, t };
          }
        }
        if (!earliest) break;
        timers.delete(earliest.handle);
        now = earliest.t.at;
        earliest.t.fn();
      }
      now = target;
    },
    get pendingCount() {
      return timers.size;
    },
  };
}

/** 组装被测对象：注入假时钟 + 收集 ping 发送与事件。 */
function makeKeepalive({ pingIntervalMs, deadTimeoutMs } = {}) {
  const clock = makeFakeClock();
  const pings = [];
  const deadEvents = [];
  const sendFn = (payload) => pings.push({ payload, at: clock.now });
  const ka = new Keepalive({
    now: () => clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    send: sendFn,
    ...(pingIntervalMs !== undefined ? { pingIntervalMs } : {}),
    ...(deadTimeoutMs !== undefined ? { deadTimeoutMs } : {}),
  });
  ka.on('dead', (info) => deadEvents.push({ info, at: clock.now }));
  return { ka, clock, pings, deadEvents, sendFn };
}

describe('Keepalive · 任意入站帧刷新 lastInboundAt（touch）', () => {
  let env;
  beforeEach(() => {
    env = makeKeepalive();
  });

  test('touch() 刷新存活：ping 后收到 ack，推进 10 秒不再发第二个 ping', () => {
    const { ka, clock, pings } = env;
    const pingOnly = () => pings.filter((p) => p.payload.type === 'ping');
    ka.start();
    clock.advance(5_000); // 空闲满 5 秒 → ping#1
    assert.equal(pingOnly().length, 1);
    ka.touch(clock.now + 1); // 收到 ack 帧，续命（lastInboundAt=5001）
    clock.advance(9_999); // tick@10000：idle=4999 未满，不得发 ping
    assert.equal(pingOnly().length, 1, '入站续命后 10 秒内不得再发 ping');
    clock.advance(1); // tick@15000：idle=9999 已满 → 续命过期，应发 ping#2
    assert.equal(pingOnly().length, 2);
  });

  test('nack/业务帧同样续命：touch 后 30 秒内不判死', () => {
    const { ka, clock, deadEvents } = env;
    ka.start();
    ka.touch(clock.now); // 模拟刚收到 nack
    clock.advance(29_000);
    ka.touch(clock.now); // 又收到一帧业务消息
    clock.advance(29_000);
    assert.equal(deadEvents.length, 0, '两次入站间隔均 <30 秒，不得判死');
    assert.ok(clock.pendingCount > 0, 'tick 仍在运行');
  });

  test('touch 返回内部状态便于诊断（lastInboundAt 可读）', () => {
    const { ka, clock } = env;
    ka.start();
    const before = ka.lastInboundAt;
    clock.advance(100);
    ka.touch(clock.now);
    assert.equal(ka.lastInboundAt, clock.now);
    assert.ok(ka.lastInboundAt > before);
  });
});

describe('Keepalive · 5 秒 tick：ping / 判死', () => {
  let env;
  beforeEach(() => {
    env = makeKeepalive();
  });

  test('>5000 无入站 → 发 ping{type:"ping", seq 递增}', () => {
    const { ka, clock, pings } = env;
    ka.start();
    clock.advance(5_000); // 首个 tick：空闲满 5 秒 → 发 ping#1
    assert.equal(pings.length, 1);
    assert.equal(pings[0].payload.type, 'ping');
    assert.equal(pings[0].payload.seq, 1);
    clock.advance(5_000); // 空闲 10 秒 → ping#2
    assert.equal(pings.length, 2);
    assert.equal(pings[1].payload.seq, 2, 'seq 单调递增');
    assert.equal(pings[1].payload.type, 'ping');
  });

  test('>30000 无入站 → emit("dead",{reason:"keepalive-timeout"}) 并停止 tick', () => {
    const { ka, clock, pings, deadEvents } = env;
    ka.start();
    clock.advance(30_000);
    assert.equal(deadEvents.length, 1);
    assert.equal(deadEvents[0].info.reason, 'keepalive-timeout');
    assert.ok(deadEvents[0].info.idleMs >= 30_000);
    assert.equal(clock.pendingCount, 0, 'tick 定时器应停止');
    const pingsAtDeath = pings.length;
    clock.advance(60_000); // 死后再推进也不应有任何动作
    assert.equal(pings.length, pingsAtDeath);
    assert.equal(deadEvents.length, 1, 'dead 只 emit 一次');
  });

  test('空闲 5..25 秒只 ping 不判死；满 30 秒判死', () => {
    const { ka, clock, pings, deadEvents } = env;
    ka.start();
    clock.advance(10_000); // tick@5s/10s 各一发 ping
    assert.equal(pings.length, 2);
    assert.equal(deadEvents.length, 0, '10 秒空闲只 ping 不判死');
    clock.advance(15_000); // 累计空闲 25_000
    assert.equal(deadEvents.length, 0, '25 秒仍不判死');
    clock.advance(5_000); // 累计 30_000 → 判死
    assert.equal(deadEvents.length, 1);
    assert.ok(deadEvents[0].info.idleMs >= 30_000);
    assert.equal(clock.pendingCount, 0);
  });

  test('start 后立即有入站流量 → tick 全程不发 ping（省带宽）', () => {
    const { ka, clock, pings } = env;
    ka.start();
    // 每 4 秒来一帧业务流量，推 60 秒
    for (let i = 0; i < 15; i += 1) {
      clock.advance(4_000);
      ka.touch(clock.now);
    }
    assert.equal(pings.length, 0, '持续业务流量下不得发任何 ping');
  });
});

describe('Keepalive · ping 应答（收到 ping 立即回 pong）', () => {
  test('handleMessage({type:"ping",seq:7}) → 立即 send({type:"pong",seq:7})', () => {
    const { ka, clock, sendFn, pings } = makeKeepalive();
    const sent = [];
    // 替换 send 观察 pong：Keepalive 的 send 回调既用于发 ping 也用于回 pong
    ka.on('pong', (payload) => sent.push(payload));
    ka.start();
    clock.advance(1);
    ka.handleMessage({ type: 'ping', seq: 7 });
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0], { type: 'pong', seq: 7 });
    // send 回调既发 ping 也回 pong——pings 里此刻只有那条 pong 记录
    assert.equal(pings.filter((p) => p.payload.type === 'ping').length, 0, '收到 ping 不得触发主动 ping');
    assert.deepEqual(pings[0].payload, { type: 'pong', seq: 7 });
  });

  test('收到 pong 不做校验：seq 不匹配也刷新存活', () => {
    const { ka, clock, deadEvents } = makeKeepalive();
    ka.start();
    clock.advance(6_000); // 会发 ping#1
    ka.handleMessage({ type: 'pong', seq: 999 }); // 明显不匹配
    clock.advance(25_000);
    assert.equal(deadEvents.length, 0, 'pong 刷新存活，不校验 seq');
  });
});

describe('Keepalive · 定时器注入与假时钟（不许真实等待）', () => {
  test('全部通过注入 setTimer/clearTimer/now 驱动；stop 后 clearTimer 被调用', () => {
    const { ka, clock } = makeKeepalive();
    const clearsBefore = clock.fired.filter((f) => f.kind === 'clear').length;
    ka.start();
    assert.ok(clock.pendingCount > 0, 'start 后应有 tick 定时器挂起');
    ka.stop();
    const clearsAfter = clock.fired.filter((f) => f.kind === 'clear').length;
    assert.ok(clearsAfter > clearsBefore, 'stop 应 clearTimer');
    assert.equal(clock.pendingCount, 0);
  });

  test('测试自身不含真实 sleep/timeout：全套断言同步假时钟驱动', () => {
    // 该用例的存在本身就是约束——任何真实等待都会让总时长暴增，
    // 由外层 duration_ms 观察（必须远小于 1 秒）。
    const { ka, clock, deadEvents } = makeKeepalive();
    ka.start();
    clock.advance(100_000); // 一次推 100 秒也不需要真实时间
    assert.equal(deadEvents.length, 1);
  });
});

describe('Keepalive · stop() 幂等', () => {
  test('stop 后 tick 停止、不 emit、不 send；重复 stop 安全', () => {
    const { ka, clock, pings, deadEvents } = makeKeepalive();
    ka.start();
    ka.stop();
    ka.stop(); // 幂等
    clock.advance(120_000);
    assert.equal(pings.length, 0, 'stop 后不得发 ping');
    assert.equal(deadEvents.length, 0, 'stop 后不得 emit dead');
  });

  test('未 start 直接 stop 也安全', () => {
    const { ka } = makeKeepalive();
    assert.doesNotThrow(() => ka.stop());
  });
});

describe('T1 回归 · 只回 ack 不回 pong 时 60 秒内不得判死', () => {
  test('对端持续回 ack（touch 由 link 层在每帧入站时调），推 60 秒不 dead', () => {
    const { ka, clock, deadEvents, pings } = makeKeepalive();
    ka.start();
    // 场景：主机 5 秒发一次 ping，对端从不回 pong，但 ACK 流不断（每 4 秒一帧）
    for (let i = 0; i < 15; i += 1) {
      clock.advance(4_000);
      ka.touch(clock.now); // link.js 收到 ack 帧即调 touch
    }
    assert.equal(deadEvents.length, 0, 'T1：有 ack 入站就证明对端活着，60 秒不得判死');
    assert.equal(pings.length, 0, '且持续入站下连 ping 都不该发');
  });

  test('T1 对照组：完全没有入站（连 ack 都没有）时 30 秒判死', () => {
    const { ka, clock, deadEvents } = makeKeepalive();
    ka.start();
    clock.advance(30_000);
    assert.equal(deadEvents.length, 1, '完全无入站必须判死');
  });
});
