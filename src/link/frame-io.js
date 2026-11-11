/**
 * link/frame-io.js · 收发管线（docs/04 Task 10）。
 *
 * 把 `Transport` 的字节流与 `wire/` 的分片模块粘成「能发一条消息 / 能收一条
 * 消息」的最小管线。**不掺业务语义**：本层不识别任何 type 字符串——唯一的
 * 例外是链路层控制消息 ack / nack（协议 §3.1 白名单：它们与握手无关）。
 *
 * 出站：`sendMessage` 走 `encodeFrames` → 串行发送队列；`ack:true` 时登记
 * `PendingAcks`（协议 §2.5：超时 400/800/1600 整条重发，`nack.missing` 仅
 * 诊断，不做部分重传——docs/03 §2.5 定案）。
 *
 * 入站：帧头分流——AUDIO 通道（协议 §2.3：不重组、不去重、不排序）直接
 * `emit('audio')`，绝不到达 Reassembler（C6 结构性保证，分流发生在
 * `reassembler.push` 抛 `AUDIO 不得进入重组器` 之前）；其余通道进
 * Reassembler，完整消息 `emit('message')`，gap 发 nack，ack 驱动确认表。
 *
 * 断链契约：`transport` 的 `disconnected` 事件 → 发送队列全部 reject
 * （`WireError(NOT_CONNECTED)`）+ `emit('send-failed')`，不留悬挂 Promise。
 */

import { EventEmitter } from 'node:events';

import {
  encodeFrames,
  decodeHeader,
  frameBody,
} from '../wire/frame.js';
import { Reassembler } from '../wire/reassembler.js';
import { PendingAcks } from '../wire/acks.js';
import { MsgIdAllocator } from '../wire/msgid.js';
import { WireError, ERR } from '../wire/errors.js';
import {
  MSG,
  CHANNEL_CONTROL,
  CHANNEL_AUDIO,
  FLAG_ACK_REQ,
} from '../wire/constants.js';

/** 默认日志器：吞掉一切（logger 抛错不得拖垮链路层）。 */
const NULL_LOGGER = Object.fromEntries(
  ['debug', 'info', 'warn', 'error'].map((level) => [
    level,
    () => {},
  ]),
);

/** 空载荷的占位字节（encodeFrames 空数组也产生 1 片，这里保持一致语义）。 */

/**
 * 消息级收发管线。
 *
 * @fires message {type, payload, msgId, channel} 完整控制消息（含链路层白名单外的全部）
 * @fires audio {bytes, msgId, frag} 音频帧（不重组）
 * @fires gap {msgId, missing, channel} 重组缺口
 * @fires ack-timeout {msgId, reason} ACK 重传耗尽
 * @fires send-failed {count, reason} 断链清空发送队列
 * @fires error {error} 入站解析异常等
 */
export class FrameIO extends EventEmitter {
  /**
   * @param {object} options
   * @param {import('../ble/transport.js').Transport} options.transport 已连接的传输层
   * @param {number} options.chunkPayload 每片载荷字节数
   * @param {number} options.maxMessageBytes 单条消息上限（协商结果）
   * @param {{debug?, info?, warn?, error?}} [options.logger]
   * @param {MsgIdAllocator} [options.msgIds] 注入用（默认新建）
   * @param {PendingAcks} [options.acks] 注入用（默认新建）
   * @param {Reassembler} [options.reassembler] 注入用（默认新建）
   */
  constructor({
    transport,
    chunkPayload,
    maxMessageBytes,
    logger,
    msgIds,
    acks,
    reassembler,
  } = {}) {
    super();
    if (!transport || typeof transport.send !== 'function') {
      throw new WireError(ERR.BAD_PAYLOAD, 'FrameIO 需要一个可 send 的 transport');
    }
    if (!Number.isInteger(chunkPayload) || chunkPayload < 1) {
      throw new WireError(ERR.BAD_PAYLOAD, `chunkPayload 非法：${chunkPayload}`);
    }
    if (!Number.isInteger(maxMessageBytes) || maxMessageBytes < 1) {
      throw new WireError(ERR.BAD_PAYLOAD, `maxMessageBytes 非法：${maxMessageBytes}`);
    }

    this.#logger = { ...NULL_LOGGER, ...logger };
    this.#transport = transport;
    this.#chunkPayload = chunkPayload;
    this.#maxMessageBytes = maxMessageBytes;
    this.#msgIds = msgIds ?? new MsgIdAllocator();

    // 待确认表：重传回调原样整条重发（entry.frames 全量），nack 的 missing
    // 仅作诊断透传给 logger——协议 §2.5：部分重发没有 FIRST 必判 stale。
    this.#acks =
      acks ??
      new PendingAcks({
        send: (msgId, resent) => {
          void this.#sendFramesNow(resent, { retransmit: true, msgId });
        },
        onGiveUp: (msgId, info) => {
          this.#msgIds.release(msgId);
          if (info?.reason === 'ack-timeout') this.#stats.ackTimeouts += 1;
          this.emit('ack-timeout', { msgId, reason: info?.reason });
        },
      });
    if (acks) {
      // 注入的 acks 也要接上放行回调（测试注入场景）
      acks.onGiveUp = (msgId, info) => {
        this.#msgIds.release(msgId);
        if (info?.reason === 'ack-timeout') this.#stats.ackTimeouts += 1;
        this.emit('ack-timeout', { msgId, reason: info?.reason });
      };
    }

    this.#reassembler = reassembler ?? new Reassembler({ maxMessageBytes });

    // 发送队列：串行执行。断链/dispose 时统一 reject。
    /** @type {Array<{run: () => Promise<void>, reject: (e: Error) => void}>} */
    this.#sendQueue = [];

    this.#stats = {
      messagesIn: 0,
      messagesOut: 0,
      bytesIn: 0,
      bytesOut: 0,
      gaps: 0,
      stale: 0,
      ackTimeouts: 0,
      badPayload: 0,
    };

    this.#attachTransport();
  }

  /** @type {import('node:events')} */
  #logger;
  #transport;
  #chunkPayload;
  #maxMessageBytes;
  #msgIds;
  #acks;
  #reassembler;
  #sendQueue;
  #draining = false;
  #disposed = false;
  #stats;

  get stats() {
    return { ...this.#stats };
  }

  // ---------------------------------------------------------------------------
  // 出站
  // ---------------------------------------------------------------------------

  /**
   * 发送一条控制消息（JSON）。ack:true 时等待对端 ack 才 resolve。
   *
   * @param {string} type 消息类型（本层不识别其语义）
   * @param {Uint8Array|object} payload 字节或可 JSON 序列化对象
   * @param {{ack?: boolean, channel?: number}} [options]
   * @returns {Promise<{msgId: number}>}
   */
  async sendMessage(type, payload, { ack = true, channel = CHANNEL_CONTROL } = {}) {
    if (this.#disposed) {
      throw new WireError(ERR.NOT_CONNECTED, 'FrameIO 已销毁，无法发送');
    }
    if (typeof type !== 'string' || type.length === 0) {
      throw new WireError(ERR.BAD_PAYLOAD, `type 必须是非空字符串，收到：${typeof type}`);
    }
    let bytes;
    if (payload instanceof Uint8Array) {
      bytes = payload;
    } else {
      bytes = new TextEncoder().encode(JSON.stringify({ type, ...payload }));
    }
    if (bytes.length > this.#maxMessageBytes) {
      throw new WireError(
        ERR.PAYLOAD_TOO_LARGE,
        `载荷 ${bytes.length} 字节超过单条消息上限 ${this.#maxMessageBytes}，不静默截断`,
        { detail: { byteLength: bytes.length, maxMessageBytes: this.#maxMessageBytes } },
      );
    }

    const msgId = this.#msgIds.allocate();
    const frames = encodeFrames({
      msgId,
      payload: bytes,
      chunkPayload: this.#chunkPayload,
      channel,
      ackRequired: ack,
    });

    await this.#enqueue(() => this.#sendFramesNow(frames, { msgId }));

    if (!ack) {
      this.#msgIds.release(msgId);
      return { msgId };
    }
    this.#acks.track(msgId, frames, { channel });
    // 等 ack：ack 处理器 acknowledge 后 resolve
    await new Promise((resolve, reject) => {
      const onAck = (ackMsgId) => {
        if (ackMsgId !== msgId) return;
        cleanup();
        resolve({ msgId });
      };
      const onTimeout = (info) => {
        if (info.msgId !== msgId) return;
        cleanup();
        reject(new WireError(ERR.ACK_TIMEOUT, `消息 ${msgId} ack 超时放弃`));
      };
      const onSendFailed = () => {
        cleanup();
        reject(new WireError(ERR.NOT_CONNECTED, '链路断开，消息未被确认'));
      };
      const cleanup = () => {
        this.off('ack', onAck);
        this.off('ack-timeout', onTimeout);
        this.off('send-failed', onSendFailed);
      };
      this.on('ack', onAck);
      this.on('ack-timeout', onTimeout);
      this.on('send-failed', onSendFailed);
    });
    return { msgId };
  }

  /**
   * 发送原始字节（音频用）：不分配消息号、不登记 ACK。
   * 协议 §2.3：AUDIO 通道不重组、不去重、不排序，帧本身按到达顺序追加。
   *
   * @param {number} channel 通道号（音频固定 CHANNEL_AUDIO，由调用方保证）
   * @param {Uint8Array} bytes
   * @returns {Promise<void>}
   */
  async sendRaw(channel, bytes) {
    if (this.#disposed) {
      throw new WireError(ERR.NOT_CONNECTED, 'FrameIO 已销毁，无法发送');
    }
    if (!(bytes instanceof Uint8Array)) {
      throw new WireError(ERR.BAD_PAYLOAD, 'sendRaw 的 bytes 必须是 Uint8Array');
    }
    const frames = encodeFrames({
      msgId: 0,
      payload: bytes,
      chunkPayload: this.#chunkPayload,
      channel,
      ackRequired: false,
    });
    await this.#enqueue(() => this.#sendFramesNow(frames, { raw: true }));
  }

  // ---------------------------------------------------------------------------
  // 入站
  // ---------------------------------------------------------------------------

  #attachTransport() {
    this.#onData = (frame, meta = {}) => {
      this.#handleFrame(frame, meta);
    };
    this.#onDisconnected = (payload = {}) => {
      this.#failQueue(`transport 断链：${payload?.reason ?? 'unknown'}`);
    };
    this.#transport.on('data', this.#onData);
    this.#transport.on('disconnected', this.#onDisconnected);
  }

  #onData = null;
  #onDisconnected = null;

  #handleFrame(frame, meta) {
    let header;
    try {
      header = decodeHeader(frame);
    } catch (e) {
      this.#stats.badPayload += 1;
      this.#logger.warn('丢弃无法解析的帧：%s', e?.message ?? e);
      return;
    }
    this.#stats.bytesIn += frame.length;

    // C6 分流：音频帧绝不进 Reassembler（reassembler 对 AUDIO 会抛错）。
    if (header.channel === CHANNEL_AUDIO) {
      this.emit('audio', { bytes: frameBody(frame), msgId: header.msgId, frag: header.frag });
      return;
    }

    let result;
    try {
      result = this.#reassembler.push(frame);
    } catch (e) {
      this.#stats.badPayload += 1;
      this.#logger.error('重组异常：%s', e?.message ?? e);
      this.emit('error', e);
      return;
    }

    switch (result.kind) {
      case 'message':
        this.#stats.messagesIn += 1;
        this.#handleMessage(result.payload, result.msgId, result.channel);
        break;
      case 'stale':
        this.#stats.stale += 1;
        this.#logger.debug('stale 片丢弃：msgId=%d', result.msgId);
        break;
      case 'gap': {
        this.#stats.gaps += 1;
        this.emit('gap', { msgId: result.msgId, missing: result.missing, channel: result.channel });
        // 协议 §2.4：gap 即回 nack；missing 仅为诊断信息
        this.#sendControlNow({
          type: MSG.NACK,
          msgId: result.msgId,
          reason: 'REASSEMBLY_GAP',
          missing: result.missing,
        });
        break;
      }
      case 'overflow': {
        this.#stats.gaps += 1;
        this.emit('gap', { msgId: result.msgId, missing: [], channel: result.channel });
        this.#sendControlNow({
          type: MSG.NACK,
          msgId: result.msgId,
          reason: 'REASSEMBLY_OVERFLOW',
        });
        break;
      }
      case 'pending':
      default:
        break;
    }
  }

  /**
   * 完整消息落地：链路层只识别 ack / nack（协议 §3.1 白名单里与握手无关的
   * 两个），其余原样 emit('message')。
   */
  #handleMessage(payload, msgId, channel) {
    let obj;
    try {
      obj = JSON.parse(new TextDecoder().decode(payload));
    } catch {
      // 非 JSON 载荷（如 LOG 文本）：不解析，原样上抛由上层决定
      this.emit('message', { type: null, payload, msgId, channel });
      return;
    }

    if (obj?.type === MSG.ACK) {
      if (typeof obj.msgId === 'number' && this.#acks.acknowledge(obj.msgId)) {
        this.#msgIds.release(obj.msgId);
        this.emit('ack', obj.msgId);
      }
      return;
    }
    if (obj?.type === MSG.NACK) {
      // 协议 §2.5：missing 仅诊断，negativeAcknowledge 带上它也只是透传，
      // 队列回调 #acks.send 始终整条重发（entry.frames 全量）。
      this.#logger.debug(
        'nack：msgId=%d reason=%s missing=%j（仅诊断，整条重发）',
        obj.msgId,
        obj.reason,
        obj.missing,
      );
      this.#acks.negativeAcknowledge(obj.msgId, obj.missing);
      return;
    }

    if (typeof obj?.type !== 'string') {
      // 验收 2：type 非字符串不 emit，记 badPayload 并回 nack{BAD_PAYLOAD}
      this.#stats.badPayload += 1;
      this.#sendControlNow({ type: MSG.NACK, msgId, reason: 'BAD_PAYLOAD' });
      return;
    }

    this.emit('message', { type: obj.type, payload: obj, msgId, channel });
  }

  // ---------------------------------------------------------------------------
  // 发送队列
  // ---------------------------------------------------------------------------

  /** 立即直发（绕过队列），用于重传与 nack 应答。返回 Promise。 */
  async #sendFramesNow(frames, { retransmit = false, msgId = null, raw = false } = {}) {
    for (const frame of frames) {
      await this.#transport.send(frame, { channel: decodeHeader(frame).channel });
      this.#stats.bytesOut += frame.length;
      if (!retransmit && !raw) this.#stats.messagesOut += 0; // 按消息计数，见 #enqueue 成功回调
    }
    if (retransmit) {
      this.#logger.debug('整条重发 %d 片（msgId=%d）', frames.length, msgId);
    }
  }

  /** 串行队列：一条执行完才执行下一条。 */
  #enqueue(job) {
    if (this.#disposed) {
      return Promise.reject(new WireError(ERR.NOT_CONNECTED, 'FrameIO 已销毁'));
    }
    return new Promise((resolve, reject) => {
      this.#sendQueue.push({
        run: async () => {
          try {
            await job();
            resolve();
          } catch (e) {
            reject(e);
          }
        },
        reject,
      });
      void this.#drain();
    });
  }

  async #drain() {
    if (this.#draining) return;
    this.#draining = true;
    try {
      while (this.#sendQueue.length > 0) {
        const job = this.#sendQueue.shift();
        await job.run();
      }
    } finally {
      this.#draining = false;
    }
  }

  /**
   * 清空队列并 reject 全部待发项（断链 / dispose）。已经发出的帧不追回；
   * 已登记的待确认项由 PendingAcks.clear 逐条放弃。
   */
  #failQueue(reason) {
    const waiting = this.#sendQueue.splice(0);
    for (const job of waiting) {
      job.reject(new WireError(ERR.NOT_CONNECTED, reason));
    }
    if (waiting.length > 0) {
      this.emit('send-failed', { count: waiting.length, reason: 'disconnect' });
    }
    this.#acks.clear(reason);
  }

  /** 立即发送一条控制 JSON（单帧，flags 无 ACK_REQ；协议 §12：单帧即完整）。 */
  #sendControlNow(obj) {
    const frames = encodeFrames({
      msgId: this.#msgIds.allocate(),
      payload: new TextEncoder().encode(JSON.stringify(obj)),
      chunkPayload: this.#chunkPayload,
      channel: CHANNEL_CONTROL,
      ackRequired: false,
    });
    // 控制应答发完立即释放号（等对端对这条应答本身不要求 ack）
    void this.#sendFramesNow(frames, { raw: true }).finally(() => {
      this.#msgIds.release(frames[0] ? decodeHeader(frames[0]).msgId : null);
    });
  }

  // ---------------------------------------------------------------------------
  // 生命周期
  // ---------------------------------------------------------------------------

  /** 销毁：清空队列、放弃待确认项、摘除 transport 监听。幂等。 */
  async dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#failQueue('FrameIO 已销毁');
    this.#reassembler.clear();
    if (this.#onData) this.#transport.off('data', this.#onData);
    if (this.#onDisconnected) this.#transport.off('disconnected', this.#onDisconnected);
  }
}
