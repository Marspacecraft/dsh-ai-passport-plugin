/**
 * 消息重组（协议 §2.4）。
 *
 * 以 `key = "{channel}:{msgId}"` 维护缓冲，四条规则：
 *
 * | 情况 | 处理 |
 * |---|---|
 * | 收到 FIRST | 丢弃同名残留，新建缓冲 |
 * | 无 FIRST 就来片 | 丢弃，计入 stale |
 * | frag 重复 | 忽略该片 |
 * | frag ≠ 上次+1 | 丢弃整条，报 gap |
 * | 累积超上限 | 丢弃整条，报 overflow |
 * | 见过 LAST + 0..lastFrag 连续 + 字节数一致 | 完成 |
 *
 * **无定时器、无 IO**：清理超时缓冲由上层按 `REASSEMBLY_TIMEOUT_MS` 调 `sweep()`。
 * 这样本模块可以被纯同步用例完全覆盖。
 */

import {
  PROTOCOL_VERSION,
  FRAME_HEADER_BYTES,
  FLAG_FIRST,
  FLAG_LAST,
  MAX_CHUNKS,
  CHANNEL_AUDIO,
} from './constants.js';
import { WireError, ERR } from './errors.js';

const keyOf = (channel, msgId) => `${channel}:${msgId}`;

export class Reassembler {
  /**
   * @param {object} [options]
   * @param {number} [options.maxMessageBytes] 单条消息字节上限；超了报 overflow
   * @param {number} [options.now] 注入时钟，测试用
   */
  constructor({ maxMessageBytes = Infinity, now = () => Date.now() } = {}) {
    if (!(maxMessageBytes > 0)) {
      throw new WireError(ERR.BAD_PAYLOAD, `maxMessageBytes 非法：${maxMessageBytes}`);
    }
    this.maxMessageBytes = maxMessageBytes;
    this.now = now;
    /** @type {Map<string, {channel:number, msgId:number, parts: Uint8Array[], seen: Set<number>, lastFrag: number, sawLast: boolean, lastAt: number}>} */
    this.pending = new Map();
    this.stats = { messages: 0, stale: 0, gaps: 0, overflow: 0, duplicates: 0 };
  }

  get size() {
    return this.pending.size;
  }

  /**
   * 喂入一片完整帧（含 4 字节帧头）。
   *
   * @param {Uint8Array} frame
   * @returns {{kind:'message', channel:number, msgId:number, payload:Uint8Array}
   *          |{kind:'stale', channel:number, msgId:number}
   *          |{kind:'gap', channel:number, msgId:number, expectedFrag:number, gotFrag:number, missing:number[]}
   *          |{kind:'overflow', channel:number, msgId:number, bytes:number}
   *          |{kind:'pending'}}
   */
  push(frame) {
    if (!(frame instanceof Uint8Array) || frame.length < FRAME_HEADER_BYTES) {
      throw new WireError(ERR.BAD_PAYLOAD, '帧短于 4 字节帧头');
    }

    const b0 = frame[0];
    const channel = frame[1];
    const msgId = ((frame[2] & 0xff) << 4) | ((frame[3] >> 4) & 0x0f);
    const frag = frame[3] & 0x0f;
    const flags = b0 & 0x0f;
    const version = (b0 >> 4) & 0x0f;

    // 音频通道不重组（协议 §2.3，C6 的结构性保证）。
    // 正常路径上 link 层在分派前就分流，这里再挡一次，防止误用。
    if (channel === CHANNEL_AUDIO) {
      throw new WireError(ERR.BAD_PAYLOAD, 'AUDIO 通道不得进入重组器');
    }
    if (version !== PROTOCOL_VERSION) {
      throw new WireError(
        ERR.PROTO_MISMATCH,
        `帧版本 ${version} 与协议版本 ${PROTOCOL_VERSION} 不符`,
      );
    }

    const body = frame.subarray(FRAME_HEADER_BYTES);
    const key = keyOf(channel, msgId);
    const isFirst = (flags & FLAG_FIRST) !== 0;
    const isLast = (flags & FLAG_LAST) !== 0;

    // --- FIRST：丢弃同名残留，新建缓冲 -------------------------------------
    if (isFirst) {
      this.pending.set(key, {
        channel,
        msgId,
        parts: [],
        seen: new Set(),
        lastFrag: -1,
        sawLast: false,
        lastAt: this.now(),
      });
    }

    const entry = this.pending.get(key);
    if (!entry) {
      // 没有 FIRST 就来了中间片/末片
      this.stats.stale += 1;
      return { kind: 'stale', channel, msgId };
    }

    // --- 重复片：忽略 ------------------------------------------------------
    if (entry.seen.has(frag)) {
      this.stats.duplicates += 1;
      entry.lastAt = this.now();
      return { kind: 'pending' };
    }

    // --- 片号不连续：整条丢弃 -------------------------------------------------
    if (frag !== entry.lastFrag + 1) {
      this.stats.gaps += 1;
      this.pending.delete(key);
      const missing = [];
      for (let i = entry.lastFrag + 1; i < frag; i += 1) missing.push(i);
      return {
        kind: 'gap',
        channel,
        msgId,
        expectedFrag: entry.lastFrag + 1,
        gotFrag: frag,
        missing,
      };
    }

    // --- 超上限：整条丢弃 -----------------------------------------------------
    const bytes = entry.parts.reduce((n, p) => n + p.length, 0) + body.length;
    if (bytes > this.maxMessageBytes) {
      this.stats.overflow += 1;
      this.pending.delete(key);
      return { kind: 'overflow', channel, msgId, bytes };
    }

    // --- 收下这一片 -----------------------------------------------------------
    // 必须复制：调用方可能复用底层缓冲（noble 的 data 事件就是复用的）
    entry.parts.push(body.slice());
    entry.seen.add(frag);
    entry.lastFrag = frag;
    entry.lastAt = this.now();
    if (isLast) entry.sawLast = true;

    if (entry.sawLast && entry.seen.size === entry.lastFrag + 1) {
      const total = entry.parts.reduce((n, p) => n + p.length, 0);
      const payload = new Uint8Array(total);
      let offset = 0;
      for (const p of entry.parts) {
        payload.set(p, offset);
        offset += p.length;
      }
      this.pending.delete(key);
      this.stats.messages += 1;
      return { kind: 'message', channel, msgId, payload };
    }

    return { kind: 'pending' };
  }

  /**
   * 清理超时未完成的缓冲。
   *
   * @param {number} timeoutMs 默认 `REASSEMBLY_TIMEOUT_MS`
   * @returns {Array<{channel:number, msgId:number, bytes:number}>} 被清掉的条目
   */
  sweep(timeoutMs) {
    const deadline = this.now() - timeoutMs;
    const dropped = [];
    for (const [key, entry] of this.pending) {
      if (entry.lastAt <= deadline) {
        dropped.push({
          channel: entry.channel,
          msgId: entry.msgId,
          bytes: entry.parts.reduce((n, p) => n + p.length, 0),
        });
        this.pending.delete(key);
      }
    }
    return dropped;
  }

  /** 断链时清空全部缓冲。 */
  clear() {
    const n = this.pending.size;
    this.pending.clear();
    return n;
  }

  snapshot() {
    return {
      pending: this.pending.size,
      maxMessageBytes: this.maxMessageBytes,
      maxChunks: MAX_CHUNKS,
      ...this.stats,
    };
  }
}
