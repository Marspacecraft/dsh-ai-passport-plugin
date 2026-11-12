/**
 * Task 20 · api/server.js 分发表 — 单元测试（TDD）
 *
 * 覆盖 docs/04 Task 20 中 server 负责的部分：
 *   1. type → handler 表：命中的类型派发到注册它的能力，payload 原样透传。
 *   2. 未命中的类型必须回 nack{reason/code=UNKNOWN_TYPE} 并计入 stats.unknownType
 *      —— v1 的 emit('unhandled') 没有监听者，设备发了什么主机永远不知道。
 *   3. handler 返回 false 视为未处理，继续问兜底能力，最后仍回 UNKNOWN_TYPE。
 *   4. handler 抛错隔离：记 stats.errors、发诊断事件，不影响后续消息。
 *   5. start()/stop() 幂等且可重复，disconnected / ready 转发给能力层。
 *   6. stats 返回副本；nack 发送失败被吞掉（不产生 unhandledRejection）。
 *
 * 全部用假 link（EventEmitter）+ 假能力，不依赖真实链路。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { ApiServer } from '../../src/api/server.js';
import { MSG } from '../../src/wire/constants.js';
import { WireError, ERR } from '../../src/wire/errors.js';

// ---------------------------------------------------------------------------
// 测试基建
// ---------------------------------------------------------------------------

/** 记录全部日志调用，断言 warn/error 内容。 */
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
  constructor({ sendImpl } = {}) {
    super();
    this.sent = [];
    this.info = { maxPayload: 8160 };
    this.sendImpl = sendImpl ?? null;
  }

  async send(type, payload, options = {}) {
    this.sent.push({ type, payload, options });
    if (this.sendImpl) return this.sendImpl(type, payload, options);
    return undefined;
  }
}

class FakeCapability {
  constructor({ types, handle } = {}) {
    this.types = types;
    this.calls = [];
    this.disconnected = [];
    this.ready = [];
    this.started = 0;
    this.stopped = 0;
    this.#handleImpl = handle ?? (() => true);
  }

  #handleImpl;

  async handle(type, payload) {
    this.calls.push({ type, payload });
    return this.#handleImpl(type, payload);
  }

  async start() {
    this.started += 1;
  }

  async stop() {
    this.stopped += 1;
  }

  onDisconnected(info) {
    this.disconnected.push(info);
  }

  onLinkReady(info) {
    this.ready.push(info);
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

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
 * start() 挂起的能力：用来把「start 已绑定但尚未完成」的窗口钉住。
 * running 只在 start 真正完成后置 true，stop 会同步改回 false。
 */
class GatedStartCapability extends FakeCapability {
  constructor(options = {}) {
    super(options);
    this.running = false;
    this.gate = deferred();
  }

  async start() {
    this.started += 1;
    await this.gate.promise;
    this.running = true;
  }

  async stop() {
    this.stopped += 1;
    this.running = false;
  }

  release() {
    this.gate.resolve();
  }
}

/** stop() 挂起的能力：用来把「stop 已开始但尚未完成」的窗口钉住。 */
class GatedStopCapability extends FakeCapability {
  constructor(options = {}) {
    super(options);
    this.gate = deferred();
  }

  async start() {
    this.started += 1;
  }

  async stop() {
    this.stopped += 1;
    await this.gate.promise;
  }

  release() {
    this.gate.resolve();
  }
}

function makeMessage(type, { payload, msgId = 1, channel = 0 } = {}) {
  const body = payload ?? { type };
  return { type, payload: body, msgId, channel };
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('ApiServer · 分发表', () => {
  test('注册类型派发到对应能力，payload 原样透传并计入 dispatched', async () => {
    const link = new FakeLink();
    const log = makeLog();
    const cap = new FakeCapability({ types: [MSG.SESSION_CANCEL] });
    const server = new ApiServer({ link, log, capabilities: [cap] });
    await server.start();

    const msg = makeMessage(MSG.SESSION_CANCEL, {
      payload: { type: MSG.SESSION_CANCEL, sessionId: 's1' },
      msgId: 7,
    });
    link.emit('message', msg);
    await flush();

    assert.equal(cap.calls.length, 1);
    assert.equal(cap.calls[0].type, MSG.SESSION_CANCEL);
    assert.deepEqual(cap.calls[0].payload, msg.payload);
    assert.equal(server.stats.dispatched, 1);
    assert.equal(server.stats.unknownType, 0);
    assert.equal(server.stats.errors, 0);
    // 命中类型不应回任何 nack
    assert.equal(link.sent.length, 0);
  });

  test('未命中类型回 nack{UNKNOWN_TYPE}，计入 stats.unknownType 且日志可诊断', async () => {
    const link = new FakeLink();
    const log = makeLog();
    const cap = new FakeCapability({ types: ['session.cancel'] });
    const server = new ApiServer({ link, log, capabilities: [cap] });
    const unknownEvents = [];
    server.on('unknown-type', (evt) => unknownEvents.push(evt));
    await server.start();

    link.emit('message', makeMessage('session.wat', { msgId: 42 }));
    await flush();

    // 不是黑洞：必须回一条错误消息
    assert.equal(link.sent.length, 1);
    const nack = link.sent[0];
    assert.equal(nack.type, MSG.NACK);
    assert.equal(nack.payload.msgId, 42);
    assert.equal(nack.payload.reason, 'UNKNOWN_TYPE');
    assert.equal(nack.payload.code, 'UNKNOWN_TYPE');
    assert.equal(nack.options.ack, false);
    // 统计与诊断
    assert.equal(server.stats.unknownType, 1);
    assert.equal(server.stats.dispatched, 0);
    assert.equal(unknownEvents.length, 1);
    assert.equal(unknownEvents[0].type, 'session.wat');
    assert.equal(unknownEvents[0].msgId, 42);
    // 日志里必须能看见具体 type，否则排障时仍然是黑洞
    assert.ok(
      log.entries.some((e) => e.level === 'warn' && logText(e).includes('session.wat')),
      'warn 日志应包含未知 type',
    );
  });

  test('handler 返回 false 视为未处理：继续问兜底能力，最终仍回 UNKNOWN_TYPE', async () => {
    const link = new FakeLink();
    const log = makeLog();
    const mapped = new FakeCapability({ types: ['session.input'], handle: () => false });
    const fallback = new FakeCapability({ handle: () => false });
    const server = new ApiServer({ link, log, capabilities: [mapped, fallback] });
    await server.start();

    link.emit('message', makeMessage('session.input', { msgId: 3 }));
    await flush();

    assert.equal(mapped.calls.length, 1);
    assert.equal(fallback.calls.length, 1);
    assert.equal(server.stats.unknownType, 1);
    assert.equal(link.sent[0].payload.reason, 'UNKNOWN_TYPE');
  });

  test('兜底能力可以处理没有声明 types 的消息', async () => {
    const link = new FakeLink();
    const log = makeLog();
    const fallback = new FakeCapability({
      handle: (type) => type === 'vendor.custom',
    });
    const server = new ApiServer({ link, log, capabilities: [fallback] });
    await server.start();

    link.emit('message', makeMessage('vendor.custom', { msgId: 9 }));
    await flush();

    assert.equal(server.stats.dispatched, 1);
    assert.equal(server.stats.unknownType, 0);
    assert.equal(link.sent.length, 0);
  });

  test('handler 抛错被隔离：计 errors、发诊断事件，后续消息仍可派发', async () => {
    const link = new FakeLink();
    const log = makeLog();
    const cap = new FakeCapability({
      types: ['session.cancel'],
      handle: () => {
        throw new Error('boom');
      },
    });
    const server = new ApiServer({ link, log, capabilities: [cap] });
    const errors = [];
    server.on('dispatch-error', (evt) => errors.push(evt));
    await server.start();

    link.emit('message', makeMessage('session.cancel', { msgId: 1 }));
    await flush();

    assert.equal(server.stats.errors, 1);
    assert.equal(server.stats.unknownType, 0, '抛错不应被误报成未知类型');
    assert.equal(errors.length, 1);
    assert.ok(log.entries.some((e) => e.level === 'error'));

    // 下一条消息不受影响
    const ok = new FakeCapability({ types: ['session.input'] });
    server.register(ok);
    link.emit('message', makeMessage('session.input', { msgId: 2 }));
    await flush();
    assert.equal(ok.calls.length, 1);
    assert.equal(server.stats.dispatched, 1);
  });

  test('start 幂等；stop 解绑；可以再次 start', async () => {
    const link = new FakeLink();
    const log = makeLog();
    const cap = new FakeCapability({ types: ['session.cancel'] });
    const server = new ApiServer({ link, log, capabilities: [cap] });

    await server.start();
    await server.start();
    assert.equal(cap.started, 1);

    link.emit('message', makeMessage('session.cancel', { msgId: 1 }));
    await flush();
    assert.equal(cap.calls.length, 1, '重复 start 不应重复派发');

    await server.stop();
    link.emit('message', makeMessage('session.cancel', { msgId: 2 }));
    await flush();
    assert.equal(cap.calls.length, 1, 'stop 之后不应再派发');

    await server.start();
    link.emit('message', makeMessage('session.cancel', { msgId: 3 }));
    await flush();
    assert.equal(cap.calls.length, 2);
  });

  test('disconnected / ready 转发给能力层', async () => {
    const link = new FakeLink();
    const log = makeLog();
    const cap = new FakeCapability({ types: [] });
    const server = new ApiServer({ link, log, capabilities: [cap] });
    await server.start();

    link.emit('disconnected', { unexpected: true, reason: 'keepalive-timeout' });
    link.emit('ready', { proto: 1, maxPayload: 8160 });

    assert.deepEqual(cap.disconnected, [{ unexpected: true, reason: 'keepalive-timeout' }]);
    assert.deepEqual(cap.ready, [{ proto: 1, maxPayload: 8160 }]);
  });

  test('stats 返回副本，外部修改不影响内部计数', async () => {
    const link = new FakeLink();
    const log = makeLog();
    const server = new ApiServer({ link, log, capabilities: [] });
    await server.start();

    link.emit('message', makeMessage('nope', { msgId: 1 }));
    await flush();

    const snapshot = server.stats;
    assert.deepEqual(snapshot, { dispatched: 0, unknownType: 1, errors: 0 });
    snapshot.unknownType = 99;
    assert.equal(server.stats.unknownType, 1);
  });

  test('nack 发送失败被吞掉：计入 errors 并 warn，不抛 unhandledRejection', async () => {
    let unhandled = 0;
    const onUnhandled = () => {
      unhandled += 1;
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const link = new FakeLink({
        sendImpl: () => Promise.reject(new WireError(ERR.NOT_CONNECTED, '链路已断开')),
      });
      const log = makeLog();
      const server = new ApiServer({ link, log, capabilities: [] });
      await server.start();

      link.emit('message', makeMessage('nope', { msgId: 5 }));
      await flush();
      await flush();

      assert.equal(server.stats.unknownType, 1);
      assert.equal(server.stats.errors, 1);
      assert.equal(unhandled, 0);
      assert.ok(
        log.entries.some((e) => e.level === 'warn' && logText(e).includes('UNKNOWN_TYPE')),
        'nack 失败应有 warn 日志',
      );
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test('无 type 的载荷（如非 JSON 日志帧）只留痕，不回 nack', async () => {
    const link = new FakeLink();
    const log = makeLog();
    const server = new ApiServer({ link, log, capabilities: [] });
    await server.start();

    link.emit('message', { type: null, payload: new Uint8Array([1, 2]), msgId: 8, channel: 0 });
    await flush();

    assert.equal(server.stats.unknownType, 1);
    assert.equal(link.sent.length, 0, '非协议消息不应回 nack');
    assert.ok(log.entries.some((e) => e.level === 'warn'));
  });

  test('运行期注册（start 之后）的能力也会被启动', async () => {
    const link = new FakeLink();
    const log = makeLog();
    const server = new ApiServer({ link, log, capabilities: [] });
    await server.start();

    const late = new FakeCapability({ types: ['late.type'] });
    server.register(late);
    await flush();
    assert.equal(late.started, 1);

    link.emit('message', makeMessage('late.type', { msgId: 1 }));
    await flush();
    assert.equal(late.calls.length, 1);
    assert.equal(server.stats.dispatched, 1);
  });

  test('运行期注册的能力必须进入生命周期：stop 之后也要被 stop 掉', async () => {
    // t69 补：原用例只断言 late.started === 1，够不着「stop 追不到」这个泄漏。
    // src/api/server.js 的 register() 注释写着「不能直接 void cap.start()，那样它
    // 不在生命周期内，stop 追不到（A5 同类泄漏）」——但没有任何用例能证伪这句话：
    // 换成 void cap.start() 且不登记进 #capabilities，127 条全绿。
    const link = new FakeLink();
    const log = makeLog();
    const server = new ApiServer({ link, log, capabilities: [] });
    await server.start();

    const late = new FakeCapability({ types: ['late.stop.type'] });
    server.register(late);
    await flush();
    assert.equal(late.started, 1, '前置：运行期注册的能力应被启动');
    assert.equal(server.activeCount, 1, '前置：运行期注册的能力应进入运行期注册表');

    await server.stop();
    assert.equal(late.stopped, 1, '运行期注册的能力必须被 stop 追上（否则与 A5 同类泄漏）');
    assert.equal(server.activeCount, 0, 'stop 之后运行期注册表必须为空');
  });

  test('重复注册同一 type 直接报配置错误，避免静默覆盖', () => {
    const link = new FakeLink();
    const log = makeLog();
    const server = new ApiServer({ link, log, capabilities: [] });
    server.register(new FakeCapability({ types: ['session.cancel'] }));
    assert.throws(
      () => server.register(new FakeCapability({ types: ['session.cancel'] })),
      (err) => err instanceof WireError && err.code === ERR.BAD_PAYLOAD,
    );
  });
});

describe('ApiServer · 生命周期并发（t39-A5）', () => {
  test('start 挂起时 stop：stop 返回后不得留下仍在运行的能力', async () => {
    const link = new FakeLink();
    const cap = new GatedStartCapability({ types: ['session.cancel'] });
    const server = new ApiServer({ link, log: makeLog(), capabilities: [cap] });

    const startPromise = server.start();
    await flush();
    assert.equal(cap.started, 1, 'start 应已进入能力层并挂起');

    const stopPromise = server.stop();
    cap.release();
    await stopPromise;
    await flush();

    // 旧实现：stop 先返回，晚到的 start 完成后把能力留在 running 状态，
    // 而 stop 已经结束，没有人再 stop 它（t39-A5）。
    assert.equal(cap.running, false, 'stop 返回后不得残留 running 的能力');
    assert.equal(cap.stopped, 1, '能力应恰好被 stop 一次');
    assert.equal(link.listenerCount('message'), 0);
    assert.equal(link.listenerCount('disconnected'), 0);
    assert.equal(link.listenerCount('ready'), 0);

    await startPromise;
  });

  test('stop 之后晚到的 start 不得继续启动后续能力', async () => {
    const link = new FakeLink();
    const first = new GatedStartCapability({ types: ['a.type'] });
    const second = new FakeCapability({ types: ['b.type'] });
    const server = new ApiServer({
      link,
      log: makeLog(),
      capabilities: [first, second],
    });

    const startPromise = server.start();
    await flush();
    assert.equal(first.started, 1);

    const stopPromise = server.stop();
    first.release();
    await stopPromise;
    await startPromise;
    await flush();

    assert.equal(first.running, false);
    assert.equal(second.started, 0, 'stop 之后 start 循环必须停止，不能启动第二个能力');
    assert.equal(server.activeCount, 0);
  });

  test('重复 start 复用同一在飞 promise；重复 stop 同理', async () => {
    const link = new FakeLink();
    const startCap = new GatedStartCapability({ types: ['a.type'] });
    const server = new ApiServer({
      link,
      log: makeLog(),
      capabilities: [startCap],
    });

    const p1 = server.start();
    const p2 = server.start();
    assert.strictEqual(p2, p1, '重复 start 必须复用同一在飞 promise');
    startCap.release();
    await p1;
    assert.equal(startCap.started, 1, '不得产生第二套注册');
    assert.equal(link.listenerCount('message'), 1);

    await server.stop();
    assert.equal(startCap.stopped, 1);

    const stopCap = new GatedStopCapability({ types: ['a.type'] });
    const server2 = new ApiServer({
      link: new FakeLink(),
      log: makeLog(),
      capabilities: [stopCap],
    });
    await server2.start();

    const s1 = server2.stop();
    const s2 = server2.stop();
    assert.strictEqual(s2, s1, '重复 stop 必须复用同一在飞 promise');
    stopCap.release();
    await s1;
    assert.equal(stopCap.stopped, 1, '不得产生第二套 stop');
  });

  test('stop 返回后注册表与 Link 监听器归零，再次 start 能完整重新注册', async () => {
    const link = new FakeLink();
    const cap = new FakeCapability({ types: ['session.cancel'] });
    const server = new ApiServer({ link, log: makeLog(), capabilities: [cap] });

    await server.start();
    assert.equal(server.activeCount, 1);
    assert.equal(link.listenerCount('message'), 1);
    assert.equal(link.listenerCount('disconnected'), 1);
    assert.equal(link.listenerCount('ready'), 1);

    await server.stop();
    assert.equal(server.activeCount, 0, 'stop 后不得残留已注册能力');
    assert.equal(link.listenerCount('message'), 0);
    assert.equal(link.listenerCount('disconnected'), 0);
    assert.equal(link.listenerCount('ready'), 0);

    await server.start();
    assert.equal(server.activeCount, 1, '再次 start 必须完整重新注册');
    assert.equal(cap.started, 2, '能力应被重新启动，而不是被旧注册表挡住');
    assert.equal(link.listenerCount('message'), 1);

    link.emit('message', makeMessage('session.cancel', { msgId: 1 }));
    await flush();
    assert.equal(cap.calls.length, 1, '重新 start 后必须还能派发');

    await server.stop();
    assert.equal(server.activeCount, 0);
  });

  test('stop 挂起时 start：start 等 stop 完成后再启动，不产生两套监听', async () => {
    const link = new FakeLink();
    const cap = new GatedStopCapability({ types: ['session.cancel'] });
    const server = new ApiServer({ link, log: makeLog(), capabilities: [cap] });

    await server.start();
    const stopPromise = server.stop();
    assert.equal(link.listenerCount('message'), 0, 'stop 入口应立即解绑');

    const startPromise = server.start();
    cap.release();
    await stopPromise;
    assert.equal(server.activeCount, 0, 'stop 必须在 start 重新注册前完成清理');
    assert.equal(link.listenerCount('message'), 0);

    await startPromise;
    assert.equal(server.activeCount, 1);
    assert.equal(cap.started, 2);
    assert.equal(link.listenerCount('message'), 1);

    await server.stop();
  });
});
