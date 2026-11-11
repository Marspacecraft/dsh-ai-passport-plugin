/**
 * 12 位消息号分配器（协议 §2.6）。
 *
 * 规则：
 * - 环形分配，跳过在途号
 * - 4096 个全在途 → 抛 `MSGID_EXHAUSTED`
 * - **所有释放路径必须闭合**：正常 ack、nack 放弃、发送失败、超时放弃
 *
 * 旧实现的泄漏点：收到 gap 时不释放，要等 3 次 ACK 超时（约 2.8 秒）才回收。
 * 本实现把释放交给调用方，但提供 `releaseAll()` 供断链时一次性清空。
 */

import { MSGID_SPACE } from './constants.js';
import { WireError, ERR } from './errors.js';

export class MsgIdAllocator {
  /**
   * @param {{space?: number}} [options] 仅测试需要改 space，生产固定 4096
   */
  constructor({ space = MSGID_SPACE } = {}) {
    if (!Number.isInteger(space) || space < 1 || space > MSGID_SPACE) {
      throw new WireError(ERR.BAD_PAYLOAD, `msgId 空间非法：${space}`);
    }
    this.space = space;
    this.inUse = new Set();
    this.cursor = 0;
  }

  /** 已占用的号数量。 */
  get size() {
    return this.inUse.size;
  }

  /** 剩余可用号数量。 */
  get available() {
    return this.space - this.inUse.size;
  }

  /**
   * 分配一个未占用的号。
   *
   * 从 cursor 起环形扫描，命中空位即占用并把 cursor 移到下一位，
   * 使连续分配尽量落在连续号上（便于抓包时肉眼对照）。
   */
  allocate() {
    if (this.inUse.size >= this.space) {
      throw new WireError(
        ERR.MSGID_EXHAUSTED,
        `消息号耗尽：${this.space} 个号全部在途，链路可能已异常`,
        { detail: { space: this.space } },
      );
    }
    for (let i = 0; i < this.space; i += 1) {
      const id = (this.cursor + i) % this.space;
      if (!this.inUse.has(id)) {
        this.inUse.add(id);
        this.cursor = (id + 1) % this.space;
        return id;
      }
    }
    // 理论上不可达：size < space 时必然存在空位
    throw new WireError(ERR.MSGID_EXHAUSTED, '消息号耗尽（扫描未命中空位）');
  }

  /**
   * 释放一个号。
   *
   * 释放未占用的号是**幂等**的（不抛错）—— 因为 ACK 与超时放弃可能
   * 同时发生，两者都调 release 是正常路径，不该因此报错。
   *
   * @returns {boolean} 是否真的释放了一个在途号
   */
  release(msgId) {
    return this.inUse.delete(msgId);
  }

  /** 是否在途。 */
  has(msgId) {
    return this.inUse.has(msgId);
  }

  /**
   * 一次性释放全部。
   *
   * 断链时必须调用（协议 §9.2「发送队列全部 reject」+ 号段清空），
   * 否则重连后号段仍被旧消息占着。
   */
  releaseAll() {
    const n = this.inUse.size;
    this.inUse.clear();
    this.cursor = 0;
    return n;
  }

  /** 快照，供诊断与测试断言。 */
  snapshot() {
    return {
      space: this.space,
      inUse: this.inUse.size,
      available: this.available,
      cursor: this.cursor,
    };
  }
}
