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
  #capabilities = [];
  #started = false;
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
    this.#capabilities.push(capability);
    // 支持运行期注册：server 已启动时新能力也要接上 host 订阅。
    if (this.#started) void this.#startCapability(capability);
    return this;
  }

  /** 幂等启动：绑定 Link 事件并启动各能力（能力可自行订阅 host 状态）。 */
  async start() {
    if (this.#started) return;
    this.#started = true;
    this.#link.on('message', this.#onMessage);
    this.#link.on('disconnected', this.#onDisconnected);
    this.#link.on('ready', this.#onReady);
    for (const cap of this.#capabilities) {
      await this.#startCapability(cap);
    }
  }

  /** 幂等停止：解绑 Link 事件并停止各能力（含清计时器）。 */
  async stop() {
    if (!this.#started) return;
    this.#started = false;
    this.#unbind('message', this.#onMessage);
    this.#unbind('disconnected', this.#onDisconnected);
    this.#unbind('ready', this.#onReady);
    for (const cap of this.#capabilities) {
      try {
        await cap.stop?.();
      } catch (err) {
        this.#recordError(`stop(${cap.constructor?.name ?? 'cap'})`, err);
      }
    }
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
