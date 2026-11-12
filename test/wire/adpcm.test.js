// Task 34 · src/wire/adpcm.js
//
// 协议依据：docs/03 §7.1.1（IMA ADPCM 块格式，强制）。块 = 4 字节头 + 504 字节
// 数据；每字节 2 个 4 位样本，低 nibble 在前；状态由每个块的块头裁定（块头存
// 的是解码这一块之前的状态），不是跨块累积。

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { decodeAdpcm, decodeBlock } from '../../src/wire/adpcm.js';
import {
  ASR_BLOCK_BYTES,
  ASR_BLOCK_DATA_BYTES,
  ASR_BLOCK_HEADER_BYTES,
  ASR_SAMPLES_PER_BLOCK,
} from '../../src/wire/constants.js';

function makeBlock(predictor, stepIndex, data, reserved = 0) {
  const block = Buffer.alloc(ASR_BLOCK_HEADER_BYTES + data.length);
  block.writeInt16LE(predictor, 0);
  block[2] = stepIndex;
  block[3] = reserved;
  data.copy(block, ASR_BLOCK_HEADER_BYTES);
  return block;
}

describe('decodeAdpcm · 块边界与样本数', () => {
  test('空 Buffer → 0 样本，不抛异常，返回合法 Int16Array', () => {
    const out = decodeAdpcm(Buffer.alloc(0));
    assert.ok(out instanceof Int16Array);
    assert.equal(out.length, 0);
  });

  test('1~3 字节不足块头 → 丢弃且 0 样本；4 字节只有块头 → 0 样本', () => {
    for (let n = 1; n <= 3; n += 1) {
      assert.doesNotThrow(() => decodeAdpcm(Buffer.alloc(n, 0x11)));
      assert.equal(decodeAdpcm(Buffer.alloc(n, 0x11)).length, 0, `${n} 字节应被丢弃`);
    }
    // 只有块头：predictor=0、stepIndex=0、保留字节。
    const headerOnly = makeBlock(0, 0, Buffer.alloc(0));
    assert.equal(headerOnly.length, 4);
    assert.equal(decodeAdpcm(headerOnly).length, 0, '尾块允许只有块头');
  });

  test('块头 + 1 数据字节 → 恰好 2 样本；满块 508 字节 → 1008 样本', () => {
    const one = makeBlock(0, 0, Buffer.from([0x07]));
    const out = decodeAdpcm(one);
    assert.equal(out.length, 2);
    assert.deepEqual([...out], [11, 13]);

    const full = makeBlock(0, 0, Buffer.alloc(ASR_BLOCK_DATA_BYTES, 0x00));
    assert.equal(full.length, ASR_BLOCK_BYTES);
    assert.equal(decodeAdpcm(full).length, ASR_SAMPLES_PER_BLOCK);
    assert.equal(ASR_SAMPLES_PER_BLOCK, 1008);
  });

  test('476 满块 + 尾块（4 头 + 96 数据）= 241908 字节 → 恰好 480000 样本', () => {
    const fullBlocks = 476;
    const tailData = 96;
    const buf = Buffer.alloc(fullBlocks * ASR_BLOCK_BYTES + ASR_BLOCK_HEADER_BYTES + tailData);

    for (let i = 0; i < fullBlocks; i += 1) {
      const off = i * ASR_BLOCK_BYTES;
      buf.writeInt16LE(((i * 97) % 32000) - 16000, off);
      buf[off + 2] = i % 89;
      buf[off + 3] = 0;
      for (let j = 0; j < ASR_BLOCK_DATA_BYTES; j += 1) {
        buf[off + ASR_BLOCK_HEADER_BYTES + j] = (i * 13 + j) & 0xff;
      }
    }
    const tailOff = fullBlocks * ASR_BLOCK_BYTES;
    buf.writeInt16LE(1234, tailOff);
    buf[tailOff + 2] = 45;
    buf.fill(0x5a, tailOff + ASR_BLOCK_HEADER_BYTES);

    assert.equal(buf.length, 241_908, '输入必须正好是协议里的 30 秒字节数');
    const out = decodeAdpcm(buf);
    assert.equal(out.length, 480_000, '30 秒 @16kHz 必须是 480000 个样本');
    assert.equal(out.length, fullBlocks * ASR_SAMPLES_PER_BLOCK + tailData * 2);
  });

  test('decodeBlock 也支持普通数组作为 out，并返回写入样本数', () => {
    const full = makeBlock(0, 0, Buffer.alloc(ASR_BLOCK_DATA_BYTES, 0x00));
    const out = new Array(ASR_SAMPLES_PER_BLOCK);
    assert.equal(decodeBlock(full, 0, ASR_BLOCK_DATA_BYTES, out), ASR_SAMPLES_PER_BLOCK);
    assert.equal(out[0], 0);
    assert.equal(out[ASR_SAMPLES_PER_BLOCK - 1], 0);
  });
});

describe('decodeBlock · nibble 顺序与块头状态', () => {
  test('低 nibble 先：predictor=0 / stepIndex=0 / 0x07 → [11, 13]', () => {
    // 手算（docs/03 §7.1.1）：
    //   低 nibble=7：step=7，diff=7>>3=0；bit0→+1、bit1→+3、bit2→+7 ⇒ 11；
    //                index += IMA_INDEX_TABLE[7] (=8) ⇒ 8
    //   高 nibble=0：step=16，diff=16>>3=2 ⇒ 13；index += -1 ⇒ 7
    // 若按高 nibble 先，同样字节会得到 [0, 11]，永远对不上 [11, 13]。
    const out = new Int16Array(2);
    assert.equal(decodeBlock(makeBlock(0, 0, Buffer.from([0x07])), 0, 1, out), 2);
    assert.deepEqual([...out], [11, 13]);
  });

  test('状态由块头裁定：两块相同数据、第二块块头不同 → 输出不同，块 1 末值被覆盖', () => {
    const data = Buffer.from([0x00]);
    // 块 1：idx=10，step=17 → diff=2 → 1002, 1004。
    // 块 2：同样的数据，但块头 predictor=2000 / idx=0 → 必须从 2000 重新开始，
    // 而不是接着块 1 的 1004。
    const block1 = makeBlock(1000, 10, data);
    const block2 = makeBlock(2000, 0, data);
    const out1 = new Int16Array(2);
    const out2 = new Int16Array(2);
    assert.equal(decodeBlock(block1, 0, 1, out1), 2);
    assert.equal(decodeBlock(block2, 0, 1, out2), 2);
    assert.deepEqual([...out1], [1002, 1004]);
    assert.deepEqual([...out2], [2000, 2000]);

    // 整条码流里也必须是两个独立的满块：第二块从自己的块头 2000 起算。
    const full1 = makeBlock(1000, 10, Buffer.concat([data, Buffer.alloc(503, 0)]));
    const full2 = makeBlock(2000, 0, Buffer.concat([data, Buffer.alloc(503, 0)]));
    const stream = decodeAdpcm(Buffer.concat([full1, full2]));
    assert.equal(stream.length, 2016);
    assert.deepEqual([...stream.subarray(0, 2)], [1002, 1004]);
    assert.deepEqual([...stream.subarray(1008, 1010)], [2000, 2000]);
  });
});

describe('decodeBlock · dataLen 必须生效', () => {
  test('508 字节缓冲声明 dataLen=96 → 192 样本；第 97 字节后的 0xFF 不影响结果', () => {
    const data96 = Buffer.alloc(96, 0x00);
    const clean = makeBlock(0, 0, Buffer.concat([data96, Buffer.alloc(408, 0x00)]));
    const poison = makeBlock(0, 0, Buffer.concat([data96, Buffer.alloc(408, 0xff)]));

    const outClean = new Int16Array(ASR_SAMPLES_PER_BLOCK);
    const outPoison = new Int16Array(ASR_SAMPLES_PER_BLOCK);
    assert.equal(decodeBlock(clean, 0, 96, outClean), 192);
    assert.equal(decodeBlock(poison, 0, 96, outPoison), 192);

    assert.deepEqual([...outClean.subarray(0, 192)], [...outPoison.subarray(0, 192)]);
    assert.deepEqual([...outPoison.subarray(0, 192)], new Array(192).fill(0));
    // 若按 buf.length 兜底读到 504 字节，0xFF 会让后半段出现非零样本。
    assert.deepEqual([...outPoison.subarray(192)], new Array(816).fill(0));
  });

  test('dataLen=0（只有块头）→ 0 样本', () => {
    const out = new Int16Array(ASR_SAMPLES_PER_BLOCK);
    assert.equal(decodeBlock(makeBlock(0, 0, Buffer.alloc(0)), 0, 0, out), 0);
  });
});

describe('decodeBlock · stepIndex 与 predictor 的边界', () => {
  test('stepIndex 起始值 > 88 被 clamp 到 88', () => {
    // stepIndex=200，块头 clamp 到 88：step=32767。
    // 两个 0 nibble：diff=4095 → 4095；index→87，step=29794，diff=3724 → 7819。
    const out = new Int16Array(2);
    decodeBlock(makeBlock(0, 200, Buffer.from([0x00])), 0, 1, out);
    assert.deepEqual([...out], [4095, 7819]);
  });

  test('任意 nibble 序列后索引都留在 [0,88]：全 0 nibble 不会让索引变负', () => {
    // index=0 时 nibble 0 的增量是 -1；没有 clamp 就会读 STEP_TABLE[-1] 得到 NaN。
    const out = new Int16Array(200);
    decodeBlock(makeBlock(0, 0, Buffer.alloc(100, 0x00)), 0, 100, out);
    assert.equal(out.length, 200);
    for (const sample of out) assert.equal(sample, 0);
  });

  test('索引上界：stepIndex=88 连续最大正向 nibble 被 clamp，索引不越界', () => {
    const out = new Int16Array(2);
    decodeBlock(makeBlock(0, 88, Buffer.from([0x77])), 0, 1, out);
    assert.deepEqual([...out], [32767, 32767]);
  });

  test('任意 nibble 序列都不产生 NaN 或越界样本（索引始终被 clamp）', () => {
    const data = Buffer.alloc(ASR_BLOCK_DATA_BYTES);
    let seed = 0x12345678;
    for (let i = 0; i < data.length; i += 1) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      data[i] = seed & 0xff;
    }
    const out = new Int16Array(ASR_SAMPLES_PER_BLOCK);
    assert.equal(decodeBlock(makeBlock(1234, 88, data), 0, data.length, out), 1008);
    for (const sample of out) {
      assert.ok(Number.isInteger(sample), `出现非整数样本 ${sample}`);
      assert.ok(sample >= -32768 && sample <= 32767, `越界样本 ${sample}`);
    }
  });

  test('predictor 溢出 int16 时被 clamp 到 -32768/32767', () => {
    const positive = new Int16Array(2);
    decodeBlock(makeBlock(0, 88, Buffer.from([0x77])), 0, 1, positive);
    for (const sample of positive) {
      assert.ok(sample >= -32768 && sample <= 32767, `越界样本 ${sample}`);
      assert.equal(sample, 32767);
    }

    // 0xFF 的两个 nibble 都是 15：diff 最大且为负 → 必然向下溢出。
    const negative = new Int16Array(2);
    decodeBlock(makeBlock(0, 88, Buffer.from([0xff])), 0, 1, negative);
    for (const sample of negative) {
      assert.ok(sample >= -32768 && sample <= 32767, `越界样本 ${sample}`);
      assert.equal(sample, -32768);
    }
  });
});

describe('decodeAdpcm · 游标遍历', () => {
  test('满块后剩 1~2 字节丢弃；块头 + 3 数据字节是尾块，解出 6 样本', () => {
    const full = makeBlock(0, 0, Buffer.alloc(ASR_BLOCK_DATA_BYTES, 0x00));
    assert.equal(decodeAdpcm(Buffer.concat([full, Buffer.from([0xde, 0xad])])).length, 1008);
    assert.equal(decodeAdpcm(Buffer.concat([full, Buffer.from([0xbe])])).length, 1008);

    // 只有 3 个数据字节：dataLen 由剩余长度推断为 3，解出 6 个样本。
    const short = makeBlock(0, 0, Buffer.from([0x00, 0x00, 0x00]));
    assert.equal(decodeAdpcm(short).length, 6);
  });

  test('实现必须用 while (total - off >= 4) 游标，禁止用 (total - 4) % 508 判合法性', () => {
    const source = readFileSync(new URL('../../src/wire/adpcm.js', import.meta.url), 'utf8');
    assert.match(
      source,
      /while\s*\(\s*total\s*-\s*off\s*>=\s*4\s*\)/,
      '必须用块头游标遍历；合法码流几乎不可能被 508 整除',
    );
    assert.ok(
      !/\(total\s*-\s*4\)\s*%\s*508/.test(source),
      '禁止用 (total - 4) % 508 判合法性（对合法码流恒为 504）',
    );
    assert.doesNotMatch(source, /from\s+['"](?:\.\.\/|\.\/)(?!constants\.js)/, '不得 import 上层模块');
  });
});
