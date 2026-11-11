/**
 * 待确认表与重传（协议 §2.5）。
 *
 * - 只有 CONTROL 通道消息可要求 ACK
 * - 接收方整条重组成功后回 `ack {msgId}`
 * - 发送方超时未收到 ack → 重传，超时序列 400 / 800 / 1600 ms（指数退避），共 3 次
 * - 3 次仍失败 → 释放消息号，向上层报 `ACK_TIMEOUT`
 * - `nack` 可携带 `missing:[frag…]`，发送方只重发这些分片（选择性重传）
 *
 * **旧实现的缺陷**是固定 400ms 不退避、且只会整条重发。v2 两条都改。
 *
 * 时钟与定时器通过构造参数注入，测试可用假时钟精确断言重传时刻。
 */

import { ACK_RETRY_DELAYS_MS, ACK_MAX_RETRIES } from './constants.js';
import { WireError, ERR } from './errors.js';

export class PendingAcks {
  /**
   * @param {object} [options]
   * @param {number[]} [options.retryDelays] 每轮重传的超时（毫秒）
   * @param {(msgId: number, resent: Uint8Array[], frags: number[]) => void} [options.send]
   *   重传回调。收到 nack 的选择性重传也走这里，`frags` 标明本次重发哪些片。
   * @param {(msgId: number, info: object) => void} [options.onGiveUp]
   * @param {() => number} [options.now]
   * @param {(fn: () => void, ms: number) => any} [options.setTimer]
   * @param {(handle: any) => void} [options.clearTimer]
   * @param {(handle: any) => void} [options.unref]
   */
  constructor(options = {}) {
    const {
      retryDelays = ACK_RETRY_DELAYS_MS,
      send = () => {},
      onGiveUp = () => {},
      now = () => Date.now(),
      setTimer = (fn, ms) => setTimeout(fn, ms),
      clearTimer = (h) => clearTimeout(h),
      unref = (h) => h?.unref?.(),
    } = options;

    if (!Array.isArray(retryDelays) || retryDelays.length === 0) {
      throw new WireError(ERR.BAD_PAYLOAD, 'retryDelays 必须是非空数组');
    }
    this.retryDelays = [...retryDelays];
    this.maxRetries = this.retryDelays.length;
    this.send = send;
    this.onGiveUp = onGiveUp;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.unref = unref;

    /** @type {Map<number, {frames: Uint8Array[], channel: number, retries: number, timer: any, startedAt: number, lastSentAt: number}>} */
    this.pending = new Map();
    this.stats = { tracked: 0, acked: 0, timeouts: 0, retransmits: 0, selective: 0 };
  }

  get size() {
    return this.pending.size;
  }

  /**
   * 登记一条待确认消息并启动定时器。
   *
   * @param {number} msgId
   * @param {Uint8Array[]} frames 该消息的全部分片（含帧头）
   * @param {object} [meta]
   * @param {number} [meta.channel]
   */
  track(msgId, frames, meta = {}) {
    if (!Array.isArray(frames) || frames.length === 0) {
      throw new WireError(ERR.BAD_PAYLOAD, 'track 需要至少一个分片');
    }
    if (this.pending.has(msgId)) {
      throw new WireError(ERR.BAD_PAYLOAD, `msgId ${msgId} 已在待确认表中`);
    }
    const entry = {
      frames: frames.map((f) => (f instanceof Uint8Array ? f : Uint8Array.from(f))),
      channel: meta.channel ?? -1,
      retries: 0,
      timer: null,
      startedAt: this.now(),
      lastSentAt: this.now(),
    };
    this.pending.set(msgId, entry);
    this.stats.tracked += 1;
    this.#arm(msgId, entry);
  }

  /**
   * 收到 ack，停止重传。
   *
   * @returns {boolean} 是否命中一条待确认消息
   */
  acknowledge(msgId) {
    const entry = this.pending.get(msgId);
    if (!entry) return false;
    this.clearTimer(entry.timer);
    this.pending.delete(msgId);
    this.stats.acked += 1;
    return true;
  }

  /**
   * 收到 nack，按 `missing` 选择性重传；无 `missing` 则整条重传。
   *
   * 选择**不重置** retries 计数 —— 丢片反复出现时不能无限拖下去。
   *
   * @param {number} msgId
   * @param {number[]} [missing] 缺失的分片号
   * @returns {boolean} 是否命中一条待确认消息
   */
  negativeAcknowledge(msgId, missing) {
    const entry = this.pending.get(msgId);
    if (!entry) return false;

    this.clearTimer(entry.timer);

    const frags = Array.isArray(missing) && missing.length > 0
      ? [...new Set(missing)].filter((f) => Number.isInteger(f) && f >= 0 && f < entry.frames.length)
      : entry.frames.map((_, i) => i);

    if (frags.length === 0) {
      // missing 全是非法片号：按整条重传兜底（一次 send 带全部分片，不是逐片 send）
      const all = entry.frames.map((_, i) => i);
      this.send(msgId, [...entry.frames], all);
      this.stats.retransmits += entry.frames.length;
    } else {
      if (frags.length < entry.frames.length) this.stats.selective += 1;
      const resent = frags.map((i) => entry.frames[i]);
      this.send(msgId, resent, frags);
      this.stats.retransmits += resent.length;
    }

    entry.lastSentAt = this.now();
    this.#arm(msgId, entry);
    return true;
  }

  /**
   * 主动放弃一条（发送失败、断链等）。
   *
   * @param {'send-failed'|'disconnect'|'manual'} reason
   * @returns {boolean}
   */
  abandon(msgId, reason = 'manual') {
    const entry = this.pending.get(msgId);
    if (!entry) return false;
    this.clearTimer(entry.timer);
    this.pending.delete(msgId);
    this.onGiveUp(msgId, {
      reason,
      retries: entry.retries,
      elapsedMs: this.now() - entry.startedAt,
    });
    return true;
  }

  /** 断链时清空全部，逐个回调 onGiveUp。返回被清掉的数量。 */
  clear(reason = 'disconnect') {
    const ids = [...this.pending.keys()];
    for (const id of ids) this.abandon(id, reason);
    return ids.length;
  }

  /** 某号当前的已重试次数。 */
  retriesOf(msgId) {
    return this.pending.get(msgId)?.retries ?? null;
  }

  snapshot() {
    return { pending: this.pending.size, maxRetries: this.maxRetries, ...this.stats };
  }

  #arm(msgId, entry) {
    const delay = this.retryDelays[Math.min(entry.retries, this.retryDelays.length - 1)];
    entry.timer = this.setTimer(() => {
      // 定时器回调可能晚于 acknowledge 触发，二次确认
      if (!this.pending.has(msgId)) return;

      if (entry.retries >= this.maxRetries) {
        this.stats.timeouts += 1;
        this.pending.delete(msgId);
        this.onGiveUp(msgId, {
          reason: 'ack-timeout',
          retries: entry.retries,
          elapsedMs: this.now() - entry.startedAt,
        });
        return;
      }

      entry.retries += 1;
      this.send(msgId, entry.frames, entry.frames.map((_, i) => i));
      this.stats.retransmits += entry.frames.length;
      entry.lastSentAt = this.now();
      this.#arm(msgId, entry);
    }, delay);
    this.unref(entry.timer);
  }
}

export { ACK_MAX_RETRIES };
