/**
 * 传输层抽象基类与错误分类。
 *
 * 设计（docs/02 §4.2、§10，docs/04 Task 1）：
 *
 * - `Transport` 给所有传输实现（bridge / mock / 将来的真机驱动）提供共同的
 *   状态机、事件约定与「发送一串字节」的入口；子类只覆盖 `do*` 钩子。
 * - 钩子**刻意不用 `#private`**：`#` 方法词法绑定，子类同名方法不会覆盖
 *   基类方法，钩子会静默失效——v1 实测踩过。
 * - 错误分两件事：`classifyError()` 定类别（权威），`humanizeError()` 定
 *   文案（可重推）。`toUserError = humanize(classify(x))` 是唯一出口。
 * - EventEmitter 在无监听者时 `emit('error')` 会抛到调用栈并把宿主带崩，
 *   基类构造时装一个兜底监听，把没人观测的错误记到 `lastUnobservedError`。
 */

import { EventEmitter } from 'node:events';

/** 链路状态机。 */
export const LINK_STATE = {
  IDLE: 'idle',
  SCANNING: 'scanning',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting',
  FAILED: 'failed',
};

/** 传输层错误类别（值为同名小写短横线字符串）。 */
export const TRANSPORT_ERROR = {
  NOT_AVAILABLE: 'not-available',
  PERMISSION_DENIED: 'permission-denied',
  ADAPTER_OFF: 'adapter-off',
  ADAPTER_UNAUTHORIZED: 'adapter-unauthorized',
  DEVICE_NOT_FOUND: 'device-not-found',
  CONNECT_FAILED: 'connect-failed',
  DISCONNECTED: 'disconnected',
  TIMEOUT: 'timeout',
  UNKNOWN: 'unknown',
};

/**
 * 传输层错误。
 *
 * @param {string} code 类别，见 TRANSPORT_ERROR
 * @param {string} message 人读原因
 * @param {{cause?: unknown, hint?: string}} [options]
 *   - `cause`：底层原错误（Error 标准字段，`error.cause` 可读）
 *   - `hint`：给用户的补救建议，与 message 分开，UI 可选择性展示
 */
export class TransportError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'TransportError';
    this.code = code;
    if (options.hint !== undefined) this.hint = options.hint;
  }
}

/** classifyError 按关键字兜底分类的规则表：`正则 → TRANSPORT_ERROR 键`。 */
const CLASSIFY_RULES = [
  [/permission|eperm/i, 'PERMISSION_DENIED'],
  [/poweredoff|powered off|adapter off/i, 'ADAPTER_OFF'],
  [/unauthoriz/i, 'ADAPTER_UNAUTHORIZED'],
  [/cannot find module|err_dlopen_failed|different node\.js version|invalid elf header/i, 'NOT_AVAILABLE'],
  [/not found|cannot find device/i, 'DEVICE_NOT_FOUND'],
  [/timeout|timed out/i, 'TIMEOUT'],
  [/disconnect|not connected/i, 'DISCONNECTED'],
];

/**
 * 任意错误 → TransportError，只定类别不改文案。
 *
 * 对「已是 TransportError 且 code !== UNKNOWN」的输入原样返回（短路）：
 * 上层构造的中文错误若被 message 关键字二次分类会被改写错类别。
 *
 * @param {unknown} error
 * @returns {TransportError}
 */
export function classifyError(error) {
  if (error instanceof TransportError && error.code !== TRANSPORT_ERROR.UNKNOWN) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error ?? '');
  for (const [pattern, key] of CLASSIFY_RULES) {
    if (pattern.test(message)) {
      // UNKNOWN 的 TransportError 重分类时，把原错误挂在 cause 上保留
      const cause = error instanceof TransportError ? error : undefined;
      return new TransportError(TRANSPORT_ERROR[key], message, { cause });
    }
  }
  if (error instanceof TransportError) return error;
  return new TransportError(TRANSPORT_ERROR.UNKNOWN, message);
}

/**
 * 低层原文 → 人读文案。只在命中「低层原文特征」时才换文案；
 * 改写后原错误留在 `cause`。分类仍以 `classifyError` 为准。
 *
 * @param {unknown} error
 * @returns {TransportError}
 */
export function humanizeError(error) {
  const classified = classifyError(error);
  const message = classified instanceof Error ? classified.message : String(classified ?? '');

  // 逐条「低层原文特征 → (类别, 中文文案)」；命中即改写并把原错误留在 cause。
  // 类别以 classifyError 的分类为基础，个别低层原文可以指向更精确的类别。
  const LOW_LEVEL_RULES = [
    [/could not start scanning/i, TRANSPORT_ERROR.NOT_AVAILABLE, '无法启动蓝牙扫描，请确认系统蓝牙已开启后重试'],
    [/state is powered off/i, TRANSPORT_ERROR.ADAPTER_OFF, '系统蓝牙已关闭，请在系统设置中打开蓝牙'],
    [/peripheral already connected/i, TRANSPORT_ERROR.CONNECT_FAILED, '设备已被占用（可能被其他应用连接），请先断开后重试'],
    [/cannot find package/i, TRANSPORT_ERROR.NOT_AVAILABLE, '蓝牙驱动未安装，请重新安装本插件'],
    [/Operation was aborted/i, TRANSPORT_ERROR.TIMEOUT, '操作被中止（连接超时），请重试'],
  ];
  for (const [pattern, code, text] of LOW_LEVEL_RULES) {
    if (pattern.test(message)) {
      return new TransportError(code, text, { cause: error });
    }
  }

  // 未命中低层特征：文案即 message（本身已人读），原样返回不另造包装。
  return classified;
}

/**
 * 唯一出口：先定类别再定文案。
 *
 * @param {unknown} error
 * @returns {TransportError}
 */
export function toUserError(error) {
  return humanizeError(classifyError(error));
}

/**
 * 传输抽象基类。
 *
 * 事件（docs/02 §4.2）：
 * - `state(prev, next)`：链路状态变化
 * - `data(bytes, {channel})`：收到一串字节
 * - `disconnected({unexpected, reason, error?})`：断链（主动与意外共用）
 * - `error(err)`：异步错误（构造时装有兜底监听，无监听者不崩宿主）
 */
export class Transport extends EventEmitter {
  /** @type {string} 当前链路状态 */
  #state;
  /** @type {number} 单帧有效载荷 */
  #mtuPayload;
  /** @type {boolean} stop() 后不再接受 start()/connect() */
  #disposed;

  /**
   * 生命周期世代（t39-A4，与 Link 的 #epoch 同构）。
   *
   * 语义边界：start/stop/restartScan/connect/disconnect 入口各自 `#epoch += 1`
   * 并捕获当次世代；这些方法里**每个 await 之后**都复核 `epoch !== this.#epoch`，
   * 一旦发现已被更新的一次生命周期操作接管，立刻 return——不得再 setState、
   * emit 事件或写入底层句柄。世代只保护「谁有权写状态机」，不负责串行化；
   * connect() 的并发单飞由 #connectPromise 负责，stop() 的终态优先级由
   * #stopPromise 负责。
   */
  #epoch = 0;

  /** connect() 单飞：并发的第二次 connect 复用同一个 in-flight promise。 */
  #connectPromise = null;

  /**
   * 当前 in-flight connect 创建时的世代。若它已被后续生命周期操作作废
   * （#connectEpoch !== #epoch），新的 connect() 不能复用旧 promise 的结果，
   * 而要等旧尝试收尾后重新发起一次真正的连接。
   */
  #connectEpoch = 0;

  /** 进行中的 stop()。stop 是终态，其它生命周期操作必须排在它之后。 */
  #stopPromise = null;

  /**
   * 当前连接周期内是否已广播过「主动断链」。同一段连接只广播一次；
   * 新建连接（state → connected）时复位。意外断链（emitUnexpectedDisconnect）
   * 不走此去重，保持「每次上报都 emit」的既有契约。
   */
  #downNotified = false;

  /**
   * @param {{mtuPayload?: number}} [options]
   */
  constructor(options = {}) {
    super();
    this.#state = LINK_STATE.IDLE;
    this.#mtuPayload = options.mtuPayload ?? 240; // docs/03 §1.4：MTU 247 兜底值的分片载荷
    this.#disposed = false;
    // 兜底 error 监听：EventEmitter 无监听者时 emit('error') 抛异常，
    // 会把宿主带崩。这里垫一个最低优先监听把错误记录下来。
    this.on('error', (error) => {
      if (this.listenerCount('error') > 1) return; // 有真监听者，不吞事件
      this.lastUnobservedError = error;
    });
  }

  /**
   * 无监听者兜底的错误入口：基类内部在异步路径上出错时用它 emit，
   * 即使上层没挂 error 监听也不会把宿主带崩。
   * @param {unknown} error
   */
  _emitError(error) {
    this.emit('error', error);
  }

  /** @type {string} */
  get state() { return this.#state; }

  /** @type {number} 单帧有效载荷（attPayload − 4 字节帧头） */
  get mtuPayload() { return this.#mtuPayload; }

  /** 连接就绪：send() 可用。 */
  get ready() { return this.#state === LINK_STATE.CONNECTED; }

  // ------------------------------------------------------------------
  // 公共生命周期
  // ------------------------------------------------------------------

  /** 开始扫描并等待设备广播。幂等：已在 scanning 时不重复触发钩子。 */
  async start() {
    // stop 是终态：排在它后面，结束后 disposed 保护会把本次 start 拒掉。
    if (this.#stopPromise) {
      await this.#stopPromise;
      this.#ensureNotDisposed();
      return;
    }
    const epoch = ++this.#epoch;
    this.#ensureNotDisposed();
    if (this.#state === LINK_STATE.SCANNING) return;
    await this._transition(LINK_STATE.SCANNING, () => this.doStartScan(), epoch);
    if (epoch !== this.#epoch) {
      // 扫描钩子晚到：stop/restartScan 已经接管，撤掉可能已启动的扫描。
      await this.#abandonHook(() => this.doStopScan());
    }
  }

  /** 停止扫描、断开连接并释放底层资源。幂等。 */
  async stop(reason = '手动停止') {
    if (this.#stopPromise) return this.#stopPromise;
    const epoch = ++this.#epoch;
    const tracked = this.#stopRun(epoch, reason).finally(() => {
      if (this.#stopPromise === tracked) this.#stopPromise = null;
    });
    this.#stopPromise = tracked;
    return tracked;
  }

  async #stopRun(epoch, reason) {
    if (this.#state === LINK_STATE.IDLE && this.#disposed) return;
    if (this.#state !== LINK_STATE.IDLE && this.#state !== LINK_STATE.FAILED) {
      this.#emitLifecycleDisconnection({ unexpected: false, reason });
      await this.doStopScan();
      if (epoch !== this.#epoch) return;
      await this.doDisconnect();
      if (epoch !== this.#epoch) return;
    }
    await this.doDispose();
    if (epoch !== this.#epoch) return;
    this.#setState(LINK_STATE.IDLE);
    this.#disposed = true;
  }

  /** 重启扫描（例如用户切换目标设备或扫描卡住后重试）。 */
  async restartScan(reason = '重启扫描') {
    if (this.#stopPromise) {
      await this.#stopPromise;
      this.#ensureNotDisposed();
      return;
    }
    const epoch = ++this.#epoch;
    this.#ensureNotDisposed();
    if (this.#state === LINK_STATE.CONNECTED || this.#state === LINK_STATE.CONNECTING) {
      this.#emitLifecycleDisconnection({ unexpected: false, reason });
      await this.doDisconnect();
      if (epoch !== this.#epoch) return;
    }
    if (this.#state === LINK_STATE.SCANNING) {
      await this.doStopScan();
      if (epoch !== this.#epoch) return;
    }
    // scanning → scanning 是同值短路，不重复 emit state
    await this._transition(LINK_STATE.SCANNING, () => this.doStartScan(), epoch);
    if (epoch !== this.#epoch) {
      await this.#abandonHook(() => this.doStopScan());
    }
  }

  /**
   * 连接当前目标设备。先停扫描再连接。
   *
   * 钩子抛错时统一 classifyError 后抛出，state → FAILED。
   */
  async connect() {
    // 已被更新操作作废的 in-flight connect：等它收尾（含它自己的反向清理），
    // 再按当前状态重新尝试；不能把陈旧的 resolve 当成「已经连上了」。
    while (this.#connectPromise && this.#connectEpoch !== this.#epoch) {
      try {
        await this.#connectPromise;
      } catch {
        // 旧尝试的失败不归新调用方承担
      }
    }
    // 单飞：同一世代的并发 connect 复用同一个 in-flight promise，
    // 绝不并发跑两次 doConnect。
    if (this.#connectPromise) return this.#connectPromise;
    if (this.#stopPromise) {
      await this.#stopPromise;
      this.#ensureNotDisposed();
      return;
    }
    this.#ensureNotDisposed();
    if (this.#state === LINK_STATE.CONNECTED) return;
    const epoch = ++this.#epoch;
    const tracked = this.#connectRun(epoch).finally(() => {
      if (this.#connectPromise === tracked) this.#connectPromise = null;
    });
    this.#connectPromise = tracked;
    this.#connectEpoch = epoch;
    return tracked;
  }

  async #connectRun(epoch) {
    if (this.#state === LINK_STATE.SCANNING) {
      await this.doStopScan();
      if (epoch !== this.#epoch) {
        await this.#abandonHook(() => this.doDisconnect());
        return;
      }
    }
    await this._transition(LINK_STATE.CONNECTING, () => this.doConnect(), epoch);
    if (epoch !== this.#epoch) {
      // 已被更新的操作作废：本次 doConnect 可能已在底层建好连接，主动拆掉。
      await this.#abandonHook(() => this.doDisconnect());
      return;
    }
    this.#downNotified = false;
    this.#setState(LINK_STATE.CONNECTED);
  }

  /** 主动断开。回扫描态继续找设备。 */
  async disconnect() {
    if (this.#stopPromise) {
      await this.#stopPromise;
      return;
    }
    if (this.#state === LINK_STATE.IDLE || this.#state === LINK_STATE.FAILED) return;
    const epoch = ++this.#epoch;
    this.#emitLifecycleDisconnection({ unexpected: false, reason: '主动断开' });
    await this.doDisconnect();
    if (epoch !== this.#epoch) return;
    await this._transition(LINK_STATE.SCANNING, () => this.doStartScan(), epoch);
    if (epoch !== this.#epoch) {
      await this.#abandonHook(() => this.doStopScan());
    }
  }

  /**
   * 发送一串字节。未连接时抛 TransportError(DISCONNECTED)——不做静默丢弃。
   *
   * @param {Uint8Array} bytes
   * @param {{channel?: string}} [options] channel 默认 'control'
   */
  async send(bytes, { channel = 'control' } = {}) {
    if (!this.ready) {
      throw new TransportError(
        TRANSPORT_ERROR.DISCONNECTED,
        `未连接，无法发送（当前状态 ${this.#state}）`,
      );
    }
    return this.doSend(bytes, { channel }).catch((e) => {
      // doSend 抛的错（例如写队列里底层已断开）统一 classify 后透传，
      // 不再二次包装成 DISCONNECTED 掩盖真实原因。
      throw classifyError(e);
    });
  }

  /**
   * 上报意外断链（基类公共入口，供子类在收到底层断开事件时调用）。
   *
   * 置 FAILED 并 emit `disconnected`，payload 带 `{unexpected: true, …}`。
   * FAILED 期间重复调用只发 disconnected 事件，不再重复 state 变化。
   *
   * @param {string} reason
   * @param {unknown} [error] 底层错误
   */
  emitUnexpectedDisconnect(reason, error) {
    if (!this.#disposed && this.#state !== LINK_STATE.FAILED) {
      this.#setState(LINK_STATE.FAILED);
    }
    this._emitDisconnection({
      unexpected: true,
      reason,
      error: error ?? new TransportError(TRANSPORT_ERROR.DISCONNECTED, reason ?? '意外断链'),
    });
  }

  // ------------------------------------------------------------------
  // 子类钩子（下划线命名，刻意不用 #private——子类必须能覆盖）
  // ------------------------------------------------------------------

  /** @abstract 开始扫描 */
  async doStartScan() {
    throw new TransportError(TRANSPORT_ERROR.NOT_AVAILABLE, 'doStartScan 未实现');
  }

  /** @abstract 停止扫描 */
  async doStopScan() {
    throw new TransportError(TRANSPORT_ERROR.NOT_AVAILABLE, 'doStopScan 未实现');
  }

  /** @abstract 连接设备 */
  async doConnect() {
    throw new TransportError(TRANSPORT_ERROR.NOT_AVAILABLE, 'doConnect 未实现');
  }

  /** @abstract 断开连接 */
  async doDisconnect() {
    throw new TransportError(TRANSPORT_ERROR.NOT_AVAILABLE, 'doDisconnect 未实现');
  }

  /** @abstract 发送字节 */
  async doSend(_bytes, _options) {
    throw new TransportError(TRANSPORT_ERROR.NOT_AVAILABLE, 'doSend 未实现');
  }

  /** @abstract 释放底层资源 */
  async doDispose() {
    throw new TransportError(TRANSPORT_ERROR.NOT_AVAILABLE, 'doDispose 未实现');
  }

  // ------------------------------------------------------------------
  // 子类内部工具（单下划线，可被子类使用；非事件、不对外）
  // ------------------------------------------------------------------

  /**
   * 子类收到一串字节时调用。
   *
   * @param {Uint8Array} bytes
   * @param {{channel?: string}} [meta]
   */
  _onData(bytes, meta = {}) {
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError(`_onData 需要 Uint8Array，收到 ${typeof bytes}`);
    }
    this.emit('data', bytes, meta);
  }

  /** @param {number} payload 连接后按协商 MTU 调整（docs/03 §1.4 公式） */
  _setMtuPayload(payload) {
    if (!Number.isInteger(payload) || payload < 16) {
      throw new RangeError(`mtuPayload 非法：${payload}（最小 16，MTU 23 的分片载荷）`);
    }
    this.#mtuPayload = payload;
  }

  /**
   * 状态流转：先 setState 再执行钩子，钩子抛错时 state → FAILED 并透传
   * classify 后的错误。
   *
   * @param {string} next 目标状态
   * @param {() => Promise<void>} hook 钩子函数
   * @param {number|null} [epoch] 调用方捕获的世代；传入后 await 结束会复核，
   *   已被更新操作接管时不再改状态/抛错
   */
  async _transition(next, hook, epoch = null) {
    this.#setState(next);
    try {
      await hook();
    } catch (e) {
      const classified = classifyError(e);
      if (epoch !== null && epoch !== this.#epoch) return;
      this.#setState(LINK_STATE.FAILED);
      throw classified;
    }
    if (epoch !== null && epoch !== this.#epoch) return;
  }

  /** 生命周期断链去重：同一连接周期最多广播一次。 */
  #emitLifecycleDisconnection(payload) {
    if (this.#downNotified) return;
    this.#downNotified = true;
    this._emitDisconnection(payload);
  }

  /**
   * 被作废的异步钩子可能已在底层产生副作用（扫描已启动 / 连接已建立）。
   * 尽力撤掉；失败只记录，不影响本次调用已经返回的语义。
   */
  async #abandonHook(hook) {
    try {
      await hook();
    } catch (e) {
      this.lastUnobservedError = e;
    }
  }

  /**
   * emit disconnected 事件。
   * @param {{unexpected: boolean, reason: string, error?: unknown}} payload
   */
  _emitDisconnection(payload) {
    this.emit('disconnected', payload);
  }

  /**
   * 状态变更：同值短路，不重复 emit。
   * @param {string} next
   */
  #setState(next) {
    if (!Object.values(LINK_STATE).includes(next)) {
      throw new RangeError(`非法链路状态：${next}`);
    }
    if (this.#state === next) return;
    const prev = this.#state;
    this.#state = next;
    this.emit('state', prev, next);
  }

  #ensureNotDisposed() {
    if (this.#disposed) {
      throw new TransportError(TRANSPORT_ERROR.DISCONNECTED, '传输已 dispose，不能再使用');
    }
  }
}
