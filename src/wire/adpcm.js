// Task 34 · wire/adpcm.js
//
// IMA ADPCM 块解码（协议 docs/03 §7.1.1）。
//
// 块 = 4 字节头（predictor int16LE + stepIndex uint8 + 保留）+ 504 字节数据。
// 每字节 2 个样本，低 nibble 在前。块头存的是「解码该块之前」的状态，所以
// 每个块开始时都由自己的块头重置 predictor/stepIndex，块与块之间不累积。
//
// 码流按块头游标遍历：剩 1~3 字节不足一个块头时直接丢弃。不能用「总长减 4
// 后能否被 508 整除」判合法性——对合法码流它恒等于一个数据块长度，等于没判。

import {
  ASR_BLOCK_DATA_BYTES,
  ASR_BLOCK_HEADER_BYTES,
  ASR_STEP_INDEX_MAX,
} from './constants.js';

const IMA_INDEX_TABLE = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];

const IMA_STEP_TABLE = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
  50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230,
  253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
  1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327,
  3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442,
  11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
  32767,
];

const INT16_MIN = -32768;
const INT16_MAX = 32767;

/**
 * 解码一个块。状态只来自该块的块头（4 字节），不读块外状态。
 *
 * @param {Buffer|Uint8Array} buf 码流
 * @param {number} offset 块头起点
 * @param {number} dataLen 本块数据字节数（0..504）；必须真的生效
 * @param {Int16Array|number[]} out 写入目标，从下标 0 开始
 * @returns {number} 写入的样本数
 */
export function decodeBlock(buf, offset, dataLen, out) {
  if (!buf || dataLen <= 0) return 0;

  // 手动读 int16LE，避免依赖 Buffer 专有方法（decodeAdpcm 也接受 Uint8Array）。
  const lo = buf[offset];
  const hi = buf[offset + 1];
  let predictor = ((lo | (hi << 8)) << 16) >> 16;
  let stepIndex = Math.max(
    0,
    Math.min(ASR_STEP_INDEX_MAX, buf[offset + 2] ?? 0),
  );

  const end = offset + ASR_BLOCK_HEADER_BYTES + Math.min(dataLen, ASR_BLOCK_DATA_BYTES);
  let written = 0;

  for (let i = offset + ASR_BLOCK_HEADER_BYTES; i < end; i += 1) {
    const byte = buf[i];
    // 低 nibble 先，再高 nibble——顺序写反会让手算向量 [11, 13] 对不上。
    for (const nibble of [byte & 0x0f, (byte >> 4) & 0x0f]) {
      const step = IMA_STEP_TABLE[stepIndex];
      let diff = step >> 3;
      if (nibble & 1) diff += step >> 2;
      if (nibble & 2) diff += step >> 1;
      if (nibble & 4) diff += step;

      predictor += nibble & 8 ? -diff : diff;
      predictor = Math.max(INT16_MIN, Math.min(INT16_MAX, predictor));
      stepIndex = Math.max(
        0,
        Math.min(ASR_STEP_INDEX_MAX, stepIndex + IMA_INDEX_TABLE[nibble]),
      );

      out[written] = predictor;
      written += 1;
    }
  }

  return written;
}

/**
 * 解码整个音频流（唯一对外入口）。
 *
 * @param {Buffer|Uint8Array} buf 码流
 * @returns {Int16Array} 16-bit 单声道 PCM 样本
 */
export function decodeAdpcm(buf) {
  const total = buf?.length ?? 0;
  if (total < ASR_BLOCK_HEADER_BYTES) return new Int16Array(0);

  // 第一遍只数样本，避免边解边扩容。
  let off = 0;
  let sampleCount = 0;
  while (total - off >= 4) {
    const dataLen = Math.min(ASR_BLOCK_DATA_BYTES, total - off - ASR_BLOCK_HEADER_BYTES);
    sampleCount += dataLen * 2;
    off += ASR_BLOCK_HEADER_BYTES + dataLen;
  }

  const out = new Int16Array(sampleCount);
  off = 0;
  let written = 0;
  while (total - off >= 4) {
    const dataLen = Math.min(ASR_BLOCK_DATA_BYTES, total - off - ASR_BLOCK_HEADER_BYTES);
    const blockOut = out.subarray(written, written + dataLen * 2);
    decodeBlock(buf, off, dataLen, blockOut);
    written += dataLen * 2;
    off += ASR_BLOCK_HEADER_BYTES + dataLen;
  }

  return out;
}
