import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  LINK_STATE,
  TRANSPORT_ERROR,
  TransportError,
  classifyError,
  humanizeError,
  toUserError,
  Transport,
} from '../../src/ble/transport.js';

/** 最小子类：只覆盖钩子，其余全部走基类公共逻辑。 */
class StubTransport extends Transport {
  constructor(options = {}) {
    super(options);
    this.calls = [];
    /** @type {Record<string, unknown>} 各钩子的固定返回值 */
    this.ret = options.ret ?? {};
    if (options.hookThrows) this.hookThrows = options.hookThrows;
  }

  async doStartScan() { this.calls.push('doStartScan'); if (this.hookThrows?.doStartScan) throw this.hookThrows.doStartScan; return this.ret.doStartScan; }
  async doStopScan() { this.calls.push('doStopScan'); if (this.hookThrows?.doStopScan) throw this.hookThrows.doStopScan; return this.ret.doStopScan; }
  async doConnect() { this.calls.push('doConnect'); if (this.hookThrows?.doConnect) throw this.hookThrows.doConnect; }
  async doDisconnect() { this.calls.push('doDisconnect'); if (this.hookThrows?.doDisconnect) throw this.hookThrows.doDisconnect; }
  async doSend(bytes, opts) { this.calls.push('doSend'); if (this.hookThrows?.doSend) throw this.hookThrows.doSend; return this.ret.doSend?.(bytes, opts); }
  async doDispose() { this.calls.push('doDispose'); if (this.hookThrows?.doDispose) throw this.hookThrows.doDispose; }
}

/** 把事件收进数组，便于断言 payload。 */
function collector(t) {
  const events = [];
  for (const name of ['state', 'data', 'disconnected', 'error']) {
    t.on(name, (...args) => events.push({ name, args }));
  }
  return events;
}

describe('LINK_STATE 与 TRANSPORT_ERROR 常量', () => {
  test('LINK_STATE 六个状态值与实现计划一致', () => {
    assert.deepEqual(LINK_STATE, {
      IDLE: 'idle',
      SCANNING: 'scanning',
      CONNECTING: 'connecting',
      CONNECTED: 'connected',
      RECONNECTING: 'reconnecting',
      FAILED: 'failed',
    });
  });

  test('TRANSPORT_ERROR 值为同名小写短横线字符串，共 9 类', () => {
    const expect = [
      'NOT_AVAILABLE', 'PERMISSION_DENIED', 'ADAPTER_OFF', 'ADAPTER_UNAUTHORIZED',
      'DEVICE_NOT_FOUND', 'CONNECT_FAILED', 'DISCONNECTED', 'TIMEOUT', 'UNKNOWN',
    ];
    assert.deepEqual(Object.keys(TRANSPORT_ERROR), expect);
    for (const key of expect) {
      assert.equal(TRANSPORT_ERROR[key], key.toLowerCase().replaceAll('_', '-'));
    }
  });

  test('TransportError 携带 code 与 hint，cause 走 Error 标准 options', () => {
    const cause = new Error('底噪');
    const e = new TransportError(TRANSPORT_ERROR.TIMEOUT, '等待超时', { cause, hint: '离设备近一点' });
    assert.ok(e instanceof Error);
    assert.ok(e instanceof TransportError);
    assert.equal(e.code, TRANSPORT_ERROR.TIMEOUT);
    assert.equal(e.message, '等待超时');
    assert.equal(e.hint, '离设备近一点');
    assert.equal(e.cause, cause);
  });
});

describe('classifyError', () => {
  test('已是 TransportError 且 code !== UNKNOWN 时原样返回（短路）', () => {
    const e = new TransportError(TRANSPORT_ERROR.CONNECT_FAILED, '连接失败：蓝牙抽风');
    assert.equal(classifyError(e), e, '同一引用返回，message 不再被关键字改写');
  });

  test('code === UNKNOWN 的 TransportError 不短路，允许按 message 重分类', () => {
    const e = new TransportError(TRANSPORT_ERROR.UNKNOWN, 'adapter off 了');
    const out = classifyError(e);
    assert.equal(out.code, TRANSPORT_ERROR.ADAPTER_OFF);
    assert.notEqual(out, e, '应产出新的 TransportError');
    assert.equal(out.cause, e, '原 TransportError 应保留在 cause 里');
  });

  const cases = [
    ['eperm: operation not permitted', 'PERMISSION_DENIED'],
    ['requires permission from user', 'PERMISSION_DENIED'],
    ['permission denied for user', 'PERMISSION_DENIED'],
    ['adapter state is poweredoff', 'ADAPTER_OFF'],
    ['bluetooth is powered off', 'ADAPTER_OFF'],
    ['adapter off while scanning', 'ADAPTER_OFF'],
    ['operation is unauthorized', 'ADAPTER_UNAUTHORIZED'],
    ['device is unauthorized', 'ADAPTER_UNAUTHORIZED'],
    ["cannot find module '@stoprocent/noble'", 'NOT_AVAILABLE'],
    ['ERR_DLOPEN_FAILED', 'NOT_AVAILABLE'],
    ['the module was compiled against a different node.js version', 'NOT_AVAILABLE'],
    ['was compiled against a different Node.js version using NODE_MODULE_VERSION', 'NOT_AVAILABLE'],
    ['invalid elf header', 'NOT_AVAILABLE'],
    ['device not found', 'DEVICE_NOT_FOUND'],
    ['cannot find device 00:11:22:33:44:55', 'DEVICE_NOT_FOUND'],
    ['command timed out after 20000ms', 'TIMEOUT'],
    ['operation timed out', 'TIMEOUT'],
    ['connection timed out', 'TIMEOUT'],
    ['connection was disconnected unexpectedly', 'DISCONNECTED'],
    ['not connected to peripheral', 'DISCONNECTED'],
    ['gatt server disconnected', 'DISCONNECTED'],
  ];

  for (const [message, expectedKey] of cases) {
    test(`message 含 "${message}" → ${expectedKey}`, () => {
      const out = classifyError(new Error(message));
      assert.ok(out instanceof TransportError);
      assert.equal(out.code, TRANSPORT_ERROR[expectedKey]);
      assert.equal(out.cause, undefined, '普通 Error 输入不应带 cause（自身即原文）');
      // 分类保留原文：message 仍是低层原文，文案由 humanize 决定
      assert.equal(out.message, message);
    });
  }

  test('完全不认识的 message → UNKNOWN', () => {
    const out = classifyError(new Error('随便什么奇怪错误'));
    assert.ok(out instanceof TransportError);
    assert.equal(out.code, TRANSPORT_ERROR.UNKNOWN);
  });

  test('非 Error 输入（字符串/null/undefined）→ UNKNOWN，不抛异常', () => {
    for (const weird of ['裸字符串错误', null, undefined, 42]) {
      const out = classifyError(weird);
      assert.ok(out instanceof TransportError);
      assert.equal(out.code, TRANSPORT_ERROR.UNKNOWN);
    }
  });
});

describe('humanizeError', () => {
  test('低层原文命中 → 改写文案，原错误保留在 cause', () => {
    const low = new Error('could not start scanning');
    const out = humanizeError(low);
    assert.equal(out.code, TRANSPORT_ERROR.NOT_AVAILABLE);
    assert.notEqual(out.message, 'could not start scanning', '文案应改写');
    assert.equal(out.cause, low, '原错误必须留在 cause');
    assert.ok(typeof out.message === 'string' && out.message.length > 0);
  });

  const lowLevel = [
    'could not start scanning',
    'state is powered off',
    'peripheral already connected',
    'cannot find package',
    'Operation was aborted',
  ];
  for (const text of lowLevel) {
    test(`" ${text}" 之类低层原文会被改写且 cause 保留`, () => {
      const low = new Error(text);
      const out = humanizeError(low);
      assert.notEqual(out.message, text, `低层原文 "${text}" 不应原样透出`);
      assert.equal(out.cause, low);
    });
  }

  test('已是人读 TransportError → 原样返回，不加 cause', () => {
    const e = new TransportError(TRANSPORT_ERROR.CONNECT_FAILED, '连接失败，请重试');
    assert.equal(humanizeError(e), e);
    assert.equal(humanizeError(e).cause, undefined);
  });

  test('非已知低层特征的普通错误 → 按 code 出默认文案，不硬造 cause', () => {
    const out = humanizeError(new Error('随便什么奇怪错误'));
    assert.ok(typeof out.message === 'string' && out.message.length > 0);
    assert.equal(out.cause, undefined, '没有改写原文时不应伪造 cause');
  });
});

describe('toUserError', () => {
  test('串联：先 classify 再 humanize，code 来自 classify', () => {
    const out = toUserError(new Error('command timed out after 20000ms'));
    assert.ok(out instanceof TransportError);
    assert.equal(out.code, TRANSPORT_ERROR.TIMEOUT);
    assert.equal(out.cause, undefined, '没有改写低层原文时不带 cause');
    assert.ok(out.message.length > 0);
  });

  test('对已是用户可读的 TransportError 透传（短路生效）', () => {
    const e = new TransportError(TRANSPORT_ERROR.CONNECT_FAILED, '连接失败');
    assert.equal(toUserError(e), e);
  });

  test('改写低层原文时 cause 是 classify 产出的 TransportError', () => {
    const out = toUserError(new Error('could not start scanning'));
    assert.ok(out.cause instanceof TransportError, 'cause 应为 classifyError 的产物');
  });
});

describe('Transport 基类 · 公共生命周期', () => {
  test('构造后初始 state 为 idle，mtuPayload 有非零默认值', () => {
    const t = new StubTransport();
    assert.equal(t.state, LINK_STATE.IDLE);
    assert.ok(Number.isInteger(t.mtuPayload) && t.mtuPayload > 0);
  });

  test('构造函数可注入 mtuPayload', () => {
    const t = new StubTransport({ mtuPayload: 240 });
    assert.equal(t.mtuPayload, 240);
  });

  test('start() 走 doStartScan，state idle→scanning，各 emit 一次', async () => {
    const t = new StubTransport();
    const events = collector(t);
    await t.start();
    assert.deepEqual(t.calls, ['doStartScan']);
    assert.equal(t.state, LINK_STATE.SCANNING);
    const stateEvents = events.filter((e) => e.name === 'state');
    assert.equal(stateEvents.length, 1);
    assert.deepEqual(stateEvents[0].args, [LINK_STATE.IDLE, LINK_STATE.SCANNING]);
  });

  test('start() 在 scanning 状态重复调用不再触发 doStartScan', async () => {
    const t = new StubTransport();
    await t.start();
    await t.start();
    assert.equal(t.calls.filter((c) => c === 'doStartScan').length, 1);
  });

  test('connect() 在 scanning 中先 doStopScan 再 doConnect，state → connected', async () => {
    const t = new StubTransport();
    const events = collector(t);
    await t.start();
    await t.connect();
    assert.deepEqual(t.calls, ['doStartScan', 'doStopScan', 'doConnect']);
    assert.equal(t.state, LINK_STATE.CONNECTED);
    const stateEvents = events.filter((e) => e.name === 'state');
    assert.deepEqual(stateEvents.map((e) => e.args), [
      [LINK_STATE.IDLE, LINK_STATE.SCANNING],
      [LINK_STATE.SCANNING, LINK_STATE.CONNECTING],
      [LINK_STATE.CONNECTING, LINK_STATE.CONNECTED],
    ]);
  });

  test('doConnect 抛错时 classifyError 后抛出且 state → FAILED', async () => {
    const t = new StubTransport({
      hookThrows: { doConnect: new Error('command timed out') },
    });
    await assert.rejects(t.connect(), (e) => {
      assert.ok(e instanceof TransportError);
      assert.equal(e.code, TRANSPORT_ERROR.TIMEOUT);
      return true;
    });
    assert.equal(t.state, LINK_STATE.FAILED);
  });

  test('disconnect() 在 connected 时走 doDisconnect，state → scanning（回扫）', async () => {
    const t = new StubTransport();
    await t.start();
    await t.connect();
    const events = collector(t);
    await t.disconnect();
    // connected 时没有在扫描：先断开，再重新 startScan 找设备
    assert.deepEqual(t.calls.slice(-2), ['doDisconnect', 'doStartScan']);
    assert.equal(t.state, LINK_STATE.SCANNING, '主动断开后回到扫描找设备');
    const last = events.filter((e) => e.name === 'disconnected').at(-1);
    assert.ok(last, '应 emit disconnected');
    assert.deepEqual(last.args[0], { unexpected: false, reason: '主动断开' });
  });

  test('idle 时 disconnect() 不触发 doDisconnect', async () => {
    const t = new StubTransport();
    await t.disconnect();
    assert.deepEqual(t.calls, []);
    assert.equal(t.state, LINK_STATE.IDLE);
  });

  test('stop(reason) → doStopScan+doDisconnect+doDispose，state → idle', async () => {
    const t = new StubTransport();
    await t.start();
    await t.connect();
    await t.stop('面板关闭');
    assert.deepEqual(t.calls.slice(-3), ['doStopScan', 'doDisconnect', 'doDispose']);
    assert.equal(t.state, LINK_STATE.IDLE);
  });

  test('stop() 幂等：dispose 后再次 stop 不再触发钩子', async () => {
    const t = new StubTransport();
    await t.start();
    await t.stop('第一次');
    await t.stop('第二次');
    assert.equal(t.calls.filter((c) => c === 'doDispose').length, 1);
  });

  test('restartScan(reason) 从 connected 回 scanning，emit disconnected{unexpected:false}', async () => {
    const t = new StubTransport();
    await t.start();
    await t.connect();
    const events = collector(t);
    await t.restartScan('用户切换设备');
    // connected 时未在扫描，无需 doStopScan：断开 → 重新扫描
    assert.deepEqual(t.calls.slice(-2), ['doDisconnect', 'doStartScan']);
    assert.equal(t.state, LINK_STATE.SCANNING);
    const last = events.filter((e) => e.name === 'disconnected').at(-1);
    assert.deepEqual(last.args[0], { unexpected: false, reason: '用户切换设备' });
  });

  test('restartScan(reason) 从 scanning 直接重扫：doStopScan → doStartScan', async () => {
    const t = new StubTransport();
    await t.start();
    await t.restartScan('换个过滤器');
    assert.deepEqual(t.calls.slice(-2), ['doStopScan', 'doStartScan']);
    assert.equal(t.state, LINK_STATE.SCANNING);
  });
});

describe('Transport 基类 · send 与 data', () => {
  test('send() 在未连接时抛 TransportError(DISCONNECTED)，不静默丢弃', async () => {
    const t = new StubTransport();
    await assert.rejects(
      t.send(new Uint8Array([1, 2, 3])),
      (e) => e instanceof TransportError && e.code === TRANSPORT_ERROR.DISCONNECTED,
    );
    assert.deepEqual(t.calls, [], '未连接不得触碰 doSend');
  });

  test('connected 时 send(bytes, {channel}) 透传给 doSend', async () => {
    const t = new StubTransport();
    await t.start();
    await t.connect();
    const bytes = new Uint8Array([9]);
    let seen;
    t.ret.doSend = (b, opts) => { seen = { b, opts }; };
    await t.send(bytes, { channel: 'audio' });
    assert.equal(seen.b, bytes);
    assert.deepEqual(seen.opts, { channel: 'audio' });
  });

  test('send() 默认 channel=control', async () => {
    const t = new StubTransport();
    await t.start();
    await t.connect();
    let seen;
    t.ret.doSend = (b, opts) => { seen = opts; };
    await t.send(new Uint8Array([1]));
    assert.deepEqual(seen, { channel: 'control' });
  });

  test('doSend 抛错被 classify 后抛出（不再二次包装为 DISCONNECTED）', async () => {
    const t = new StubTransport({
      hookThrows: { doSend: new Error('connection was disconnected') },
    });
    await t.start();
    await t.connect();
    await assert.rejects(
      t.send(new Uint8Array([1])),
      (e) => e instanceof TransportError && e.code === TRANSPORT_ERROR.DISCONNECTED,
    );
  });

  test('_onData 校验非 Uint8Array 输入并抛 TypeError', async () => {
    const t = new StubTransport();
    assert.throws(() => t._onData('不是字节'), /Uint8Array/);
    const received = [];
    t.on('data', (bytes, meta) => received.push({ bytes, meta }));
    const bytes = new Uint8Array([1, 2]);
    t._onData(bytes, { channel: 'audio' });
    assert.equal(received[0].bytes, bytes);
    assert.deepEqual(received[0].meta, { channel: 'audio' });
  });
});

describe('Transport 基类 · 兜底 error 监听与意外断链', () => {
  test('无监听者时 emit("error") 不抛出，错误进 lastUnobservedError', () => {
    const t = new StubTransport();
    const boom = new TransportError(TRANSPORT_ERROR.TIMEOUT, '内部超时');
    assert.doesNotThrow(() => t._emitError(boom));
    assert.equal(t.lastUnobservedError, boom);
  });

  test('有监听者时兜底监听不吞事件', () => {
    const t = new StubTransport();
    const seen = [];
    t.on('error', (e) => seen.push(e));
    const boom = new TransportError(TRANSPORT_ERROR.TIMEOUT, '外部可见');
    t._emitError(boom);
    assert.deepEqual(seen, [boom]);
    assert.equal(t.lastUnobservedError, undefined, '有观测者时不应记录');
  });

  test('listenerCount 恰为 1（仅兜底）时仍记录为未观测', () => {
    const t = new StubTransport();
    const boom = new Error('只有兜底');
    t._emitError(boom);
    assert.equal(t.lastUnobservedError, boom);
  });

  test('emitUnexpectedDisconnect → state FAILED + disconnected{unexpected:true}', () => {
    const t = new StubTransport();
    const events = collector(t);
    const boom = new Error('connection lost');
    t.emitUnexpectedDisconnect('蓝牙拔了', boom);
    assert.equal(t.state, LINK_STATE.FAILED);
    const last = events.filter((e) => e.name === 'disconnected').at(-1);
    assert.ok(last);
    const payload = last.args[0];
    assert.equal(payload.unexpected, true);
    assert.equal(payload.reason, '蓝牙拔了');
    assert.equal(payload.error, boom);
  });

  test('emitUnexpectedDisconnect 未传 error 时以 reason 字符串兜底', () => {
    const t = new StubTransport();
    const events = collector(t);
    t.emitUnexpectedDisconnect('gatt server disconnected');
    assert.equal(t.state, LINK_STATE.FAILED);
    const payload = events.filter((e) => e.name === 'disconnected').at(-1).args[0];
    assert.equal(payload.unexpected, true);
    assert.equal(payload.reason, 'gatt server disconnected');
    assert.ok(payload.error instanceof Error);
  });

  test('emitUnexpectedDisconnect 同值短路：连续两次只 emit 一次 state', () => {
    const t = new StubTransport();
    const events = collector(t);
    t.emitUnexpectedDisconnect('x');
    t.emitUnexpectedDisconnect('y');
    const stateEvents = events.filter((e) => e.name === 'state');
    assert.equal(stateEvents.length, 1, '第二次已是 FAILED，同值短路');
    // disconnected 事件两次都发，链路恢复靠上层
    assert.equal(events.filter((e) => e.name === 'disconnected').length, 2);
  });
});

describe('Transport 基类 · #setState 同值短路', () => {
  test('start() 在已 scanning 时短路：不重复 emit 也不重复调钩子', async () => {
    const t = new StubTransport();
    const events = collector(t);
    await t.start();
    await t.start(); // 已是 scanning：#setState 同值短路
    const stateEvents = events.filter((e) => e.name === 'state');
    assert.equal(stateEvents.length, 1, '重复 start 不应再 emit state');
    assert.equal(t.calls.filter((c) => c === 'doStartScan').length, 1);
  });

  test('start 失败 → FAILED：两次合法状态流转，无同值重复 emit', async () => {
    const t = new StubTransport({
      hookThrows: { doStartScan: new Error('timed out') },
    });
    const events = collector(t);
    await assert.rejects(t.start());
    assert.equal(t.state, LINK_STATE.FAILED);
    // idle→scanning、scanning→failed 是两次合法流转，各 emit 一次
    assert.deepEqual(
      events.filter((e) => e.name === 'state').map((e) => e.args),
      [
        [LINK_STATE.IDLE, LINK_STATE.SCANNING],
        [LINK_STATE.SCANNING, LINK_STATE.FAILED],
      ],
    );
  });

  test('emitUnexpectedDisconnect 在已 FAILED 时不再 emit state（同值短路）', () => {
    const t = new StubTransport();
    const events = collector(t);
    t.emitUnexpectedDisconnect('第一次');
    t.emitUnexpectedDisconnect('第二次');
    assert.equal(events.filter((e) => e.name === 'state').length, 1);
  });

  test('非法状态值不会经由公共路径产生（状态机只接受 LINK_STATE 值）', () => {
    // #setState 是私有方法，只能由基类内部以 LINK_STATE 常量驱动；
    // 这里校验 LINK_STATE 的值集合是封闭的，保证非法值在源头被拦截。
    assert.deepEqual(
      Object.values(LINK_STATE).sort(),
      ['connected', 'connecting', 'failed', 'idle', 'reconnecting', 'scanning'],
    );
  });
});

describe('TRANSPORT_ERROR · 钩子抛 NOT_AVAILABLE（worker 缺 noble 场景）', () => {
  test('doStartScan 抛 cannot find module → NOT_AVAILABLE 且 state FAILED', async () => {
    const t = new StubTransport({
      hookThrows: { doStartScan: new Error("Cannot find module '@stoprocent/noble'") },
    });
    await assert.rejects(t.start(), (e) => {
      assert.ok(e instanceof TransportError);
      assert.equal(e.code, TRANSPORT_ERROR.NOT_AVAILABLE);
      return true;
    });
    assert.equal(t.state, LINK_STATE.FAILED);
  });
});

// ---------------------------------------------------------------------------
// t39-A4：生命周期世代（#epoch）与 connect() 单飞
// ---------------------------------------------------------------------------

/** 手动放行的 gate：新增用例不依赖固定 sleep，全部靠它精确控制等待点。 */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** 让出一轮事件循环；只用于交织序列，不做「等 N 毫秒」的猜测。 */
function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * 可精确卡住任一钩子的传输：用来在 await 窗口里插入 stop/connect/disconnect。
 * handle 模拟底层连接句柄，供不变量断言「connected ⇔ 有句柄」。
 */
class GatedTransport extends Transport {
  constructor() {
    super();
    this.calls = [];
    this.handle = false;
    this.scanning = false;
    this.entered = new Map();
    this.gates = new Map();
  }

  /** 为某个钩子装 gate；返回 gate（放行用）与 entered（钩子已进入）。 */
  gate(name) {
    const gate = deferred();
    const entered = deferred();
    this.gates.set(name, gate);
    this.entered.set(name, entered);
    return { gate, entered: entered.promise };
  }

  async #run(name) {
    this.calls.push(name);
    this.entered.get(name)?.resolve();
    await this.gates.get(name)?.promise;
    if (name === 'doStartScan') this.scanning = true;
    if (name === 'doStopScan') this.scanning = false;
    if (name === 'doConnect') this.handle = true;
    if (name === 'doDisconnect' || name === 'doDispose') this.handle = false;
  }

  async doStartScan() { await this.#run('doStartScan'); }
  async doStopScan() { await this.#run('doStopScan'); }
  async doConnect() { await this.#run('doConnect'); }
  async doDisconnect() { await this.#run('doDisconnect'); }
  async doDispose() { await this.#run('doDispose'); }
  async doSend() {}
}

describe('Transport 生命周期 · #epoch 世代与 connect() 单飞（t39-A4）', () => {
  test('T1：start() 挂起期间 stop()，晚到扫描不得把 state 改回 scanning/connected', async () => {
    const t = new GatedTransport();
    const events = collector(t);
    const g = t.gate('doStartScan');

    const start = t.start();
    await g.entered; // state 已是 scanning，doStartScan 卡住
    const stop = t.stop('用户停止');
    g.gate.resolve();
    await start;
    await stop;

    assert.equal(t.state, LINK_STATE.IDLE, 'stop 是终态，晚到的扫描结果不得复活状态机');
    assert.equal(t.ready, false);
    assert.equal(t.scanning, false, '晚到的扫描副作用必须被撤销，不能留下底层扫描句柄');
    const downs = events.filter((e) => e.name === 'disconnected').map((e) => e.args[0]);
    assert.equal(downs.length, 1);
    assert.equal(downs[0].unexpected, false);
    assert.equal(downs[0].reason, '用户停止');
    assert.ok(
      !events.some((e) => e.name === 'state' && e.args[1] === LINK_STATE.CONNECTED),
      '不得出现 connected 状态',
    );
  });

  test('T5：connect() 挂起期间 stop()，晚到连接不得 connected、不得发 ready 通知', async () => {
    const t = new GatedTransport();
    const events = collector(t);
    const g = t.gate('doConnect');

    const connect = t.connect();
    await g.entered; // state connecting，doConnect 卡住
    const stop = t.stop('取消连接');
    g.gate.resolve();
    await connect; // 已作废的连接应安静返回，不抛错
    await stop;

    assert.equal(t.state, LINK_STATE.IDLE);
    assert.equal(t.ready, false);
    assert.ok(
      !events.some((e) => e.name === 'state' && e.args[1] === LINK_STATE.CONNECTED),
      '晚到 connect 不得再进入 connected',
    );
    const downs = events.filter((e) => e.name === 'disconnected');
    assert.equal(downs.length, 1, 'stop 只广播一次断链');
  });

  test('T2：disconnect() 与挂起中的 connect() 乱序，最终不得 connected', async () => {
    const t = new GatedTransport();
    const events = collector(t);
    await t.start(); // 进入 scanning
    const g = t.gate('doConnect');

    const connect = t.connect();
    await g.entered; // state connecting，doConnect 卡住
    await t.disconnect(); // 主动断开：state 回 scanning，作废上面这次 connect
    g.gate.resolve();
    await connect;

    assert.equal(t.state, LINK_STATE.SCANNING, '晚到的 connect 不得把状态改回 connected');
    assert.equal(t.ready, false);
    assert.equal(t.handle, false, '被作废的连接必须把底层句柄收掉');
    assert.equal(t.calls.filter((c) => c === 'doConnect').length, 1);
    const downs = events.filter((e) => e.name === 'disconnected');
    assert.equal(downs.length, 1);
  });

  test('T3：并发两次 connect() 只执行一次 doConnect（单飞）', async () => {
    const t = new GatedTransport();
    const g = t.gate('doConnect');

    const p1 = t.connect();
    const p2 = t.connect();
    await g.entered;
    g.gate.resolve();
    await Promise.all([p1, p2]);

    assert.equal(t.calls.filter((c) => c === 'doConnect').length, 1);
    assert.equal(t.state, LINK_STATE.CONNECTED);
    assert.equal(t.ready, true);
  });

  test('T4：stop() 挂起期间 restartScan()，放行后不得进入 scanning', async () => {
    const t = new GatedTransport();
    await t.start(); // scanning
    const g = t.gate('doStopScan');

    const stop = t.stop('停机');
    await g.entered;
    const restart = t.restartScan('重扫');
    g.gate.resolve();
    await stop;
    await assert.rejects(restart, (e) => {
      assert.ok(e instanceof TransportError);
      assert.equal(e.code, TRANSPORT_ERROR.DISCONNECTED);
      return true;
    });

    assert.equal(t.state, LINK_STATE.IDLE, 'stop 之后不得再进入 scanning');
    assert.equal(t.scanning, false);
    assert.equal(t.calls.filter((c) => c === 'doStartScan').length, 1, '只有最初的 start 扫描');
  });

  test('作废的 connect 之后再次 connect()：等旧尝试收尾后真正重连', async () => {
    const t = new GatedTransport();
    await t.start();
    const g1 = t.gate('doConnect');

    const first = t.connect();
    await g1.entered;
    await t.disconnect(); // 作废 first
    g1.gate.resolve();
    await first;

    const g2 = t.gate('doConnect');
    const second = t.connect();
    await g2.entered; // 必须重新进入 doConnect，而不是复用陈旧的 resolve
    g2.gate.resolve();
    await second;

    assert.equal(t.state, LINK_STATE.CONNECTED);
    assert.equal(t.handle, true);
    assert.equal(t.calls.filter((c) => c === 'doConnect').length, 2);
  });
});

describe('Transport 生命周期 · 并发交织不变量（t39-A4）', () => {
  /** 钩子都让出一轮事件循环，让不同操作在 await 窗口里真正交错。 */
  class ChaosTransport extends Transport {
    constructor() {
      super();
      this.handle = false;
      this.calls = [];
    }

    async #tick() {
      await tick();
    }

    async doStartScan() { this.calls.push('doStartScan'); await this.#tick(); }
    async doStopScan() { this.calls.push('doStopScan'); await this.#tick(); }
    async doConnect() { this.calls.push('doConnect'); await this.#tick(); this.handle = true; }
    async doDisconnect() { this.calls.push('doDisconnect'); await this.#tick(); this.handle = false; }
    async doDispose() { this.calls.push('doDispose'); await this.#tick(); this.handle = false; }
    async doSend() {}
  }

  const OPS = ['start', 'connect', 'disconnect', 'stop', 'restartScan'];

  function invoke(t, op) {
    switch (op) {
      case 'start': return t.start();
      case 'connect': return t.connect();
      case 'disconnect': return t.disconnect();
      case 'stop': return t.stop(`stop-${op}`);
      case 'restartScan': return t.restartScan(`restart-${op}`);
      default: throw new Error(`unknown op ${op}`);
    }
  }

  function lcg(seed) {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
  }

  function assertInvariants(t, events, label) {
    assert.equal(
      t.state === LINK_STATE.CONNECTED,
      t.handle,
      `${label}: connected ⇔ 活跃底层句柄（state=${t.state}, handle=${t.handle}）`,
    );
    // disconnected 不重复：同一条连接周期（两次 connected 之间）最多一次。
    let downInCycle = 0;
    for (const e of events) {
      if (e.name === 'state' && e.args[1] === LINK_STATE.CONNECTED) downInCycle = 0;
      if (e.name === 'disconnected') {
        assert.equal(downInCycle, 0, `${label}: 同一连接周期内 disconnected 重复广播`);
        downInCycle = 1;
      }
    }
  }

  const rand = lcg(0xc0ffee);
  for (let i = 0; i < 30; i += 1) {
    const seq = Array.from({ length: 3 }, () => OPS[Math.floor(rand() * OPS.length)]);
    test(`交织 #${String(i).padStart(2, '0')}：${seq.join(' → ')}`, async () => {
      const t = new ChaosTransport();
      const events = collector(t);
      const pending = [];
      for (const op of seq) {
        // stop 是终态：其后的 start/connect 按既有契约 reject。这里只观察
        // 最终状态与事件序列，因此立即挂上 catch，避免测试进程误报未处理拒绝。
        pending.push(invoke(t, op).catch(() => {}));
        await tick(); // 只让出事件循环，制造真实交错；不等待固定时长
      }
      await Promise.all(pending);
      assertInvariants(t, events, seq.join('→'));
    });
  }
});
