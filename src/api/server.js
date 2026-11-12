/**
 * api/server.js — API 分发（docs/02 §4.4 / docs/04 Task 20）
 *
 * 职责：把 Link 的事件翻译成能力层调用，并把能力层的应答写回链路。
 * 本层**不实现任何业务**（docs/02 §4.4）：业务都在 api/* 能力里。
 *
 *   type → handler 表
 *     · register(cap)：cap.types 里的每个 type 映射到 cap.handle
 *     · 没有声明 types 的能力是兜底能力（例如 push 只下行、没有上行 type），
 *       表里查不到或 handler 返回 false 时依次询问
 *     · 全都处理不了 → 回 nack{reason/code=UNKNOWN_TYPE} 并计入
 *       stats.unknownType。**绝不静默丢弃**：v1 用 emit('unhandled') 且没有
 *       监听者，设备发了什么主机永远不知道，等于黑洞（docs/04 验收 1）。
 *
 *   未 ready 的业务消息不会到达本层：Link 的 Handshake 在 ready=false 时
 *   直接丢弃（src/link/handshake.js:178-179），server 不需要重复判 ready。
 *
 * 事件（供宿主观测）：
 *   'unknown-type'    { type, msgId, channel }  收到无法处理的上行消息
 *   'dispatch-error'  { context, error }        能力层处理抛错（不冒泡）
 */

import { EventEmitter } from 'node:events';

import { WireError, ERR } from '../wire/errors.js';
import { MSG } from '../wire/constants.js';

const NOOP_LOG = Object.freeze({
  debug() {},
  info() {},
  warn() {},
  error() {},
});

export class ApiServer extends EventEmitter {
  #link;
  #log;
  #host;
  #handlers = new Map();
  #fallbacks = [];
  /** 构造/运行期注册的全部能力（配置期名单，stop 不清）。 */
  #roster = [];
  /** 当前真正已 start、尚未 stop 的能力（运行期注册表，stop 必须清空）。 */
  #capabilities = new Set();
  #bound = false;
  #running = false;
  /** 生命周期世代：start/stop 入口自增，异步步骤每步复核。 */
  #epoch = 0;
  #startPromise = null;
  #stopPromise = null;
  /** stop 在飞时到达的 start：等 stop 完成后合并成一次 start。 */
  #startAfterStop = null;
  #stats = { dispatched: 0, unknownType: 0, errors: 0 };

  /** 绑定一次，off 时用同一引用。 */
  #onMessage = (msg) => {
    void this.#dispatch(msg);
  };

  #onDisconnected = (info) => {
    for (const cap of this.#capabilities) {
      try {
        cap.onDisconnected?.(info);
      } catch (err) {
        this.#recordError(`onDisconnected(${cap.constructor?.name ?? 'cap'})`, err);
      }
    }
  };

  #onReady = (info) => {
    for (const cap of this.#capabilities) {
      try {
        cap.onLinkReady?.(info);
      } catch (err) {
        this.#recordError(`onLinkReady(${cap.constructor?.name ?? 'cap'})`, err);
      }
    }
  };

  constructor({ link, log, host, capabilities = [] } = {}) {
    super();
    if (!link || typeof link.send !== 'function' || typeof link.on !== 'function') {
      throw new WireError(ERR.BAD_PAYLOAD, 'ApiServer 需要一个可 send/on 的 link');
    }
    this.#link = link;
    this.#log = log ?? NOOP_LOG;
    this.#host = host ?? {};
    for (const cap of capabilities) this.register(cap);
  }

  /** 注册能力：cap.types 为数组则逐 type 映射；否则作为兜底能力。 */
  register(capability) {
    if (!capability || typeof capability.handle !== 'function') {
      throw new WireError(ERR.BAD_PAYLOAD, '能力必须实现 handle(type, payload)');
    }
    const types = Array.isArray(capability.types)
      ? capability.types
      : typeof capability.type === 'string'
        ? [capability.type]
        : [];

    if (types.length === 0) {
      this.#fallbacks.push(capability);
    } else {
      for (const type of types) {
        if (typeof type !== 'string' || type.length === 0) {
          throw new WireError(ERR.BAD_PAYLOAD, `能力声明了非法 type：${String(type)}`);
        }
        if (this.#handlers.has(type)) {
          // 静默覆盖会让后注册的能力永远收不到消息，属于配置错误，直接炸。
          throw new WireError(ERR.BAD_PAYLOAD, `重复注册消息类型：${type}`);
        }
        this.#handlers.set(type, capability);
      }
    }
    this.#roster.push(capability);
    // 支持运行期注册：server 已启动时新能力也要接上 host 订阅。
    // 不能直接 void cap.start()：那样它不在生命周期内，stop 追不到（A5 同类泄漏）。
    // 统一走一次 start 收敛；若当前 start 在飞，则等它结束后补一轮。
    if (this.#running) {
      const current = this.#startPromise;
      if (current) current.then(() => this.#kickStart(), () => this.#kickStart());
      else this.#kickStart();
    }
    return this;
  }

  /**
   * 启动：绑定 Link 事件并启动各能力。
   *
   * 并发模型（t39-A5）：
   *   · 重复 start 复用同一个在飞 promise；
   *   · stop 在飞时的 start 不抢跑，等 stop 完成后合并成一次 start；
   *   · start 的异步步骤每步复核 #epoch，stop 一旦开始就回滚本 run 已做的注册；
   *   · stop 先解绑、再等 start 收尾，最后把 #capabilities 逐个 stop 到空集，
   *     所以 stop 的 promise 返回时不可能残留「已注册但无人 stop」的能力。
   */
  start() {
    if (this.#stopPromise) {
      if (!this.#startAfterStop) {
        const after = this.#stopPromise.then(
          () => {
            this.#startAfterStop = null;
            return this.start();
          },
          () => {
            this.#startAfterStop = null;
            return this.start();
          },
        );
        this.#startAfterStop = after;
      }
      return this.#startAfterStop;
    }
    if (this.#startPromise) return this.#startPromise;

    // 调用瞬间的世代：如果 stop 在本 run 真正开始前就发生，ticket 失配直接放弃，
    // 避免「stop 先解绑、start 微任务后绑定」的竞态。
    const ticket = this.#epoch;
    const run = Promise.resolve()
      .then(() => this.#runStart(ticket))
      .finally(() => {
        if (this.#startPromise === run) this.#startPromise = null;
      });
    this.#startPromise = run;
    return run;
  }

  /** 停止：解绑 Link 事件并把所有已注册能力 stop 到空集。 */
  stop() {
    if (this.#stopPromise) return this.#stopPromise;
    // 入口同步落定意图：stop 一开始就不再收帧，正在排队的 start 也会看到世代失配。
    ++this.#epoch;
    this.#running = false;
    this.#unbindAll();
    const run = Promise.resolve()
      .then(() => this.#runStop())
      .finally(() => {
        if (this.#stopPromise === run) this.#stopPromise = null;
      });
    this.#stopPromise = run;
    return run;
  }

  /** 当前已注册（已 start、未 stop）的能力数量；stop 后必须为 0。 */
  get activeCount() {
    return this.#capabilities.size;
  }

  /** 统计快照（副本）：{ dispatched, unknownType, errors }。 */
  get stats() {
    return { ...this.#stats };
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  #unbind(event, listener) {
    if (typeof this.#link.off === 'function') this.#link.off(event, listener);
    else this.#link.removeListener?.(event, listener);
  }

  #bind() {
    if (this.#bound) return;
    this.#link.on('message', this.#onMessage);
    this.#link.on('disconnected', this.#onDisconnected);
    this.#link.on('ready', this.#onReady);
    this.#bound = true;
  }

  #unbindAll() {
    if (!this.#bound) return;
    this.#unbind('message', this.#onMessage);
    this.#unbind('disconnected', this.#onDisconnected);
    this.#unbind('ready', this.#onReady);
    this.#bound = false;
  }

  async #runStart(ticket) {
    // 调用后、真正执行前已有 stop：这一轮 start 已作废。
    if (ticket !== this.#epoch) return;

    const epoch = ++this.#epoch;
    this.#running = true;
    this.#bind();
    if (epoch !== this.#epoch) return;

    const startedByThisRun = [];
    for (const cap of [...this.#roster]) {
      if (epoch !== this.#epoch) {
        await this.#rollback(startedByThisRun);
        return;
      }
      if (this.#capabilities.has(cap)) continue;

      // 先登记再 await：stop 只要开始，就一定能看到这个能力并 stop 它。
      this.#capabilities.add(cap);
      startedByThisRun.push(cap);
      await this.#startCapability(cap);

      if (epoch !== this.#epoch) {
        // stop 已经发生：把本 run 刚启动的能力撤掉，绝不继续启动后续能力。
        await this.#rollback(startedByThisRun);
        return;
      }
    }
  }

  async #runStop() {
    // stop() 入口已同步推进世代、解绑；这里再解一次是防御（start 可能刚绑定）。
    this.#unbindAll();

    // 等 start 回滚完（它可能正挂在某个 cap.start 上），再统一清理。
    const starting = this.#startPromise;
    if (starting) {
      try {
        await starting;
      } catch {
        // start 内部已按能力记录错误；stop 不应被单点失败挡住。
      }
    }
    this.#unbindAll();

    // 逐个 stop 到空集。start 已回滚，注册表此时不会再增长。
    while (this.#capabilities.size > 0) {
      const batch = [...this.#capabilities];
      for (const cap of batch) {
        await this.#stopCapability(cap);
        this.#capabilities.delete(cap);
      }
      // 防御性再解绑：极端情况下（外部同步触发）也不允许 stop 返回后留有监听。
      this.#unbindAll();
    }

    if (this.#capabilities.size !== 0) {
      // 走到这里说明清理逻辑被破坏；显式留痕，避免静默 A5 回归。
      this.#log.error('ApiServer.stop 后仍有 %d 个能力未注销', this.#capabilities.size);
    }
  }

  async #rollback(caps) {
    for (let i = caps.length - 1; i >= 0; i -= 1) {
      const cap = caps[i];
      if (!this.#capabilities.has(cap)) continue;
      await this.#stopCapability(cap);
      this.#capabilities.delete(cap);
    }
  }

  #kickStart() {
    if (!this.#running || this.#stopPromise) return;
    this.start().catch((err) => this.#recordError('start(运行期注册能力)', err));
  }

  async #stopCapability(cap) {
    try {
      await cap.stop?.();
    } catch (err) {
      this.#recordError(`stop(${cap.constructor?.name ?? 'cap'})`, err);
    }
  }

  async #startCapability(cap) {
    try {
      await cap.start?.();
    } catch (err) {
      this.#recordError(`start(${cap.constructor?.name ?? 'cap'})`, err);
    }
  }

  async #dispatch(msg) {
    const type = msg?.type;
    const mapped = typeof type === 'string' ? this.#handlers.get(type) : undefined;

    if (mapped) {
      const outcome = await this.#invoke(mapped, type, msg?.payload);
      if (outcome === 'handled') {
        this.#stats.dispatched += 1;
        return;
      }
      if (outcome === 'error') return; // 已记 errors；不要再误报成 unknown
    }

    for (const fallback of this.#fallbacks) {
      if (fallback === mapped) continue;
      const outcome = await this.#invoke(fallback, type, msg?.payload);
      if (outcome === 'handled') {
        this.#stats.dispatched += 1;
        return;
      }
      if (outcome === 'error') return;
    }

    await this.#answerUnknown(msg);
  }

  /** 返回 'handled' | 'unhandled' | 'error'。抛错不冒泡，避免打断 Link 事件循环。 */
  async #invoke(capability, type, payload) {
    try {
      const result = await capability.handle(type, payload);
      return result === true ? 'handled' : 'unhandled';
    } catch (err) {
      this.#recordError(`handle(${String(type)})`, err);
      return 'error';
    }
  }

  /**
   * 未命中：回 nack 并留痕。协议层错误用 nack{msgId, reason}（docs/03 §10.3），
   * docs/04 又要求 code=UNKNOWN_TYPE，两者都带上；message 给人类排障用。
   */
  async #answerUnknown(msg) {
    const type = msg?.type;
    this.#stats.unknownType += 1;
    if (typeof type !== 'string') {
      // FrameIO 对非 JSON 载荷 emit type=null（例如日志文本）：不是协议消息，
      // 没有可回的 nack 语义，只留痕，避免对每个 LOG 帧刷 nack。
      this.#log.warn('收到无 type 的载荷（msgId=%s），已忽略', String(msg?.msgId));
      this.#emitSafe('unknown-type', { type, msgId: msg?.msgId, channel: msg?.channel });
      return;
    }
    this.#log.warn(
      '未知消息类型 %s（msgId=%s），回 nack{UNKNOWN_TYPE}',
      type,
      String(msg?.msgId),
    );
    this.#emitSafe('unknown-type', { type, msgId: msg?.msgId, channel: msg?.channel });

    const payload = {
      msgId: msg?.msgId,
      reason: 'UNKNOWN_TYPE',
      code: 'UNKNOWN_TYPE',
      message: `未知消息类型：${type}`,
    };

    try {
      await this.#link.send(MSG.NACK, payload, { ack: false });
    } catch (err) {
      this.#stats.errors += 1;
      this.#log.warn('回 UNKNOWN_TYPE nack 失败：%s', err?.message ?? err);
    }
  }

  /** 监听器抛错不能让 dispatch 变成 unhandledRejection（t16 教训）。 */
  #emitSafe(event, payload) {
    try {
      this.emit(event, payload);
    } catch (err) {
      this.#log.warn('事件 %s 的监听器抛错：%s', event, err?.message ?? err);
    }
  }

  #recordError(context, err) {
    this.#stats.errors += 1;
    this.#log.error('%s 处理失败：%s', context, err?.stack ?? err?.message ?? err);
    this.#emitSafe('dispatch-error', { context, error: err });
  }
}
