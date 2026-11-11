/**
 * 帧头编解码与分片。
 *
 * 帧头 4 字节（协议 §2.1）：
 *
 *   byte 0: 高 4 位 version | 低 4 位 flags
 *   byte 1: channel
 *   byte 2: msgId bit 11..4
 *   byte 3: 高 4 位 msgId bit 3..0 | 低 4 位 frag
 *
 * 本模块是纯函数，无状态、无 IO，可被同一组用例对撞（encode → decode 还原）。
 */

import {
  PROTOCOL_VERSION,
  FRAME_HEADER_BYTES,
  VERSION_SHIFT,
  VERSION_MASK,
  FLAGS_MASK,
  MSGID_MASK,
  FRAG_MASK,
  MAX_CHUNKS,
  FLAG_FIRST,
  FLAG_LAST,
  FLAG_ACK_REQ,
  CHANNEL_CONTROL,
} from './constants.js';
import { WireError, ERR } from './errors.js';

/**
 * 计算单条消息应拆成几片。
 *
 * 空载荷也产生 1 片（协议 §2.2：单帧消息同时置 FIRST|LAST）。
 */
export function chunkCount(byteLength, chunkPayload) {
  assertChunkPayload(chunkPayload);
  if (!Number.isInteger(byteLength) || byteLength < 0) {
    throw new WireError(ERR.BAD_PAYLOAD, `载荷长度非法：${byteLength}`);
  }
  return Math.max(1, Math.ceil(byteLength / chunkPayload));
}

/**
 * 编码一帧的 4 字节帧头。
 *
 * @param {{version?: number, flags: number, channel: number, msgId: number, frag: number}} head
 * @returns {Uint8Array} 长度恒为 4
 */
export function encodeHeader(head) {
  const {
    version = PROTOCOL_VERSION,
    flags,
    channel,
    msgId,
    frag,
  } = head;

  if (!Number.isInteger(version) || version < 0 || version > VERSION_MASK) {
    throw new WireError(ERR.PROTO_MISMATCH, `version 超出 4 位：${version}`);
  }
  if (!Number.isInteger(flags) || flags < 0 || flags > FLAGS_MASK) {
    throw new WireError(ERR.BAD_PAYLOAD, `flags 超出 4 位：${flags}`);
  }
  if (!Number.isInteger(channel) || channel < 0 || channel > 0xff) {
    throw new WireError(ERR.BAD_PAYLOAD, `channel 超出 1 字节：${channel}`);
  }
  if (!Number.isInteger(msgId) || msgId < 0 || msgId > MSGID_MASK) {
    throw new WireError(ERR.BAD_PAYLOAD, `msgId 超出 12 位：${msgId}`);
  }
  if (!Number.isInteger(frag) || frag < 0 || frag > FRAG_MASK) {
    throw new WireError(ERR.BAD_PAYLOAD, `frag 超出 4 位：${frag}`);
  }

  const out = new Uint8Array(FRAME_HEADER_BYTES);
  out[0] = ((version & VERSION_MASK) << VERSION_SHIFT) | (flags & FLAGS_MASK);
  out[1] = channel & 0xff;
  out[2] = (msgId >> 4) & 0xff;
  out[3] = ((msgId & 0x0f) << 4) | (frag & FRAG_MASK);
  return out;
}

/**
 * 解码 4 字节帧头。
 *
 * 只解析、不校验版本 —— 版本判断属于握手层（协议 §11），
 * 传输层遇到任何版本都要能读出 channel/msgId 才能回错误。
 */
export function decodeHeader(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < FRAME_HEADER_BYTES) {
    throw new WireError(
      ERR.BAD_PAYLOAD,
      `帧头至少需要 ${FRAME_HEADER_BYTES} 字节，实际 ${bytes?.length ?? 0}`,
    );
  }
  const b0 = bytes[0];
  const b1 = bytes[1];
  const b2 = bytes[2];
  const b3 = bytes[3];
  return {
    version: (b0 >> VERSION_SHIFT) & VERSION_MASK,
    flags: b0 & FLAGS_MASK,
    channel: b1,
    msgId: ((b2 & 0xff) << 4) | ((b3 >> 4) & 0x0f),
    frag: b3 & FRAG_MASK,
  };
}

/**
 * 把一条消息载荷拆成完整帧（帧头 + 数据）。
 *
 * 每个分片都带 `ACK_REQ`（若 `ackRequired` 为真），这样丢中间片时
 * 接收方能立刻察觉（协议 §2.5）。
 *
 * @param {object} options
 * @param {number} options.msgId 0..4095
 * @param {Uint8Array} options.payload 消息载荷，可为空
 * @param {number} options.chunkPayload 单片数据上限
 * @param {number} [options.channel=CHANNEL_CONTROL]
 * @param {boolean} [options.ackRequired=false]
 * @param {number} [options.version=PROTOCOL_VERSION]
 * @returns {Uint8Array[]} 每项 = 4 字节帧头 + 该片数据
 */
export function encodeFrames(options) {
  const {
    msgId,
    payload,
    chunkPayload,
    channel = CHANNEL_CONTROL,
    ackRequired = false,
    version = PROTOCOL_VERSION,
  } = options;

  assertChunkPayload(chunkPayload);
  if (!(payload instanceof Uint8Array)) {
    throw new WireError(ERR.BAD_PAYLOAD, 'payload 必须是 Uint8Array');
  }

  const total = chunkCount(payload.length, chunkPayload);
  if (total > MAX_CHUNKS) {
    throw new WireError(
      ERR.PAYLOAD_TOO_LARGE,
      `单条消息需要 ${total} 片，超过上限 ${MAX_CHUNKS}，请调大 chunkPayload 或缩小载荷`,
      { detail: { byteLength: payload.length, chunkPayload, total } },
    );
  }

  const frames = [];
  for (let frag = 0; frag < total; frag += 1) {
    let flags = 0;
    if (frag === 0) flags |= FLAG_FIRST;
    if (frag === total - 1) flags |= FLAG_LAST;
    if (ackRequired) flags |= FLAG_ACK_REQ;

    const start = frag * chunkPayload;
    const end = Math.min(start + chunkPayload, payload.length);
    const body = payload.subarray(start, end);

    const frame = new Uint8Array(FRAME_HEADER_BYTES + body.length);
    frame.set(
      encodeHeader({ version, flags, channel, msgId, frag }),
      0,
    );
    frame.set(body, FRAME_HEADER_BYTES);
    frames.push(frame);
  }
  return frames;
}

/**
 * 从完整帧里取出数据部分（去掉 4 字节帧头）。
 *
 * @returns {Uint8Array} **视图**，不复制。调用方若需长期持有须自行复制。
 */
export function frameBody(frame) {
  if (!(frame instanceof Uint8Array) || frame.length < FRAME_HEADER_BYTES) {
    throw new WireError(ERR.BAD_PAYLOAD, '帧短于 4 字节帧头');
  }
  return frame.subarray(FRAME_HEADER_BYTES);
}

/** 单片最大数据量（给定 MTU）。协议 §1.4 的权威公式。 */
export function chunkPayloadForMtu(mtu) {
  if (!Number.isInteger(mtu) || mtu < 0) {
    throw new WireError(ERR.BAD_PAYLOAD, `MTU 非法：${mtu}`);
  }
  // attPayload = max(20, mtu - 3)，再减 4 字节帧头
  const attPayload = Math.max(20, mtu - 3);
  return Math.max(16, attPayload - FRAME_HEADER_BYTES);
}

function assertChunkPayload(chunkPayload) {
  if (!Number.isInteger(chunkPayload) || chunkPayload < 1) {
    throw new WireError(ERR.BAD_PAYLOAD, `chunkPayload 非法：${chunkPayload}`);
  }
}
