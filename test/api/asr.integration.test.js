/**
 * M6 集成（mock 端到端）：30 秒真实尺寸的 ASR 音频。
 *
 * 真实链路：MockTransport（虚拟设备）→ Link（分帧 / 握手 / ACK）→ ApiServer
 * → AsrCapability。设备侧不直接调用主机方法：
 *   · 控制消息写成真实帧，经 MockTransport 的 data 事件进入 Link；
 *   · 音频按 chunkPayload 切片，写成 AUDIO 通道帧逐帧进入 Link（不重组）；
 *   · 主机发出的 asr.error / asr.result 用真实 Reassembler 还原，再按
 *     (type, ver) 把 part 拼回业务消息。
 *
 * 这样分片、AUDIO 分流、握手与 ACK 都是真实代码路径。测试不读私有字段，
 * 也不用固定 sleep 当同步手段：一律 await 可观察状态或 waitFor。
 */

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { describe, test } from 'node:test';

import { MockTransport } from '../../src/ble/mock-transport.js';
import { Link } from '../../src/link/link.js';
import { ApiServer } from '../../src/api/server.js';
import { AsrCapability } from '../../src/api/asr.js';
import { Reassembler } from '../../src/wire/reassembler.js';
import { decodeHeader, encodeFrames } from '../../src/wire/frame.js';
import {
  CHANNEL_AUDIO,
  CHANNEL_CONTROL,
  MAX_MESSAGE_BYTES_CEILING,
  MSG,
} from '../../src/wire/constants.js';

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

async function waitFor(fn, timeoutMs = 5000, stepMs = 2) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`waitFor 超时（${timeoutMs}ms）`);
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

function makeLog() {
  const entries = [];
  return {
    entries,
    debug() {},
    info() {},
    warn: (...args) => entries.push(['warn', ...args]),
    error: (...args) => entries.push(['error', ...args]),
  };
}

const memoryStore = () => ({ load: async () => ({}), save: async () => {} });

// 16k 下每个满块 1008 样本；30 秒 = 476 满块 + 尾块 96 数据字节。
const FULL_BLOCK_BYTES = 508;
const BLOCK_DATA_BYTES = 504;
const THIRTY_SECONDS_BYTES = 241_908;
const CHUNK_PAYLOAD = 510;

// ---------------------------------------------------------------------------
// 测试内 IMA ADPCM 编码器（不进 src/）
// ---------------------------------------------------------------------------

const IMA_INDEX = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];
const IMA_STEP = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
  50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230,
  253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
  1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327,
  3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442,
  11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
  32767,
];

function clamp16(value) {
  return Math.max(-32768, Math.min(32767, value));
}

function clampIndex(index) {
  return Math.max(0, Math.min(88, index));
}

/**
 * 把 440Hz 正弦编码成协议规定的块流。
 *
 * 块 = 4 字节头（predictor int16LE / stepIndex / 保留 0）+ 最多 504 字节数据。
 * 每个块头记录该块开始前的编码器状态；解码器每块都从块头重置，所以编码器
 * 可以跨块延续 predictor/stepIndex。
 *
 * @param {number} totalBytes 目标码流字节数
 * @returns {Buffer}
 */
function makeAdpcmStream(totalBytes) {
  const out = Buffer.alloc(totalBytes);
  let offset = 0;
  let sampleIndex = 0;
  let predictor = 0;
  let stepIndex = 0;

  while (offset < totalBytes) {
    const remaining = totalBytes - offset;
    // 至少要有块头；尾块允许只有头（这里不产生这种块）。
    if (remaining < 4) break;
    const dataLen = Math.min(BLOCK_DATA_BYTES, remaining - 4);
    if (dataLen <= 0) break;

    out.writeInt16LE(predictor, offset);
    out[offset + 2] = stepIndex;
    out[offset + 3] = 0;

    for (let n = 0; n < dataLen * 2; n += 1) {
      const sample = Math.round(
        8000 * Math.sin((2 * Math.PI * 440 * sampleIndex) / 16000),
      );
      sampleIndex += 1;

      const step = IMA_STEP[stepIndex];
      let diff = sample - predictor;
      let nibble = 0;
      if (diff < 0) {
        nibble = 8;
        diff = -diff;
      }
      let delta = step >> 3;
      if (diff >= step) {
        nibble |= 4;
        diff -= step;
        delta += step;
      }
      if (diff >= step >> 1) {
        nibble |= 2;
        diff -= step >> 1;
        delta += step >> 1;
      }
      if (diff >= step >> 2) {
        nibble |= 1;
        delta += step >> 2;
      }
      predictor = clamp16(predictor + (nibble & 8 ? -delta : delta));
      stepIndex = clampIndex(stepIndex + IMA_INDEX[nibble]);

      const byteIndex = offset + 4 + (n >> 1);
      if ((n & 1) === 0) out[byteIndex] = nibble;
      else out[byteIndex] |= nibble << 4;
    }

    offset += 4 + dataLen;
  }

  return out;
}

// ---------------------------------------------------------------------------
// 设备侧：真实 Reassembler 还原主机下行消息
// ---------------------------------------------------------------------------

class DeviceControl {
  raw = [];
  errors = [];

  accept(message) {
    if (message === null || typeof message !== 'object') return;
    this.raw.push(message);
  }

  ofType(type) {
    return this.raw.filter((message) => message.type === type);
  }

  /** @returns {null | {text: string, durationMs: number, parts: number, ver: number}} */
  result() {
    const list = this.ofType(MSG.ASR_RESULT);
    if (list.length === 0) return null;
    const ver = list[0].ver;
    const parts = list
      .filter((message) => message.ver === ver)
      .sort((a, b) => a.part - b.part);
    if (parts.length < parts[0].parts) return null;

    assert.equal(parts.length, parts[0].parts, 'asr.result 的 parts 应与实收片数一致');
    for (let i = 0; i < parts.length; i += 1) {
      assert.equal(parts[i].part, i + 1, 'asr.result 的 part 必须从 1 连续');
      assert.equal(parts[i].parts, parts.length, '同一结果的 parts 必须一致');
      assert.equal(parts[i].ver, ver, '同一结果的 ver 必须一致');
    }
    return {
      text: parts.map((part) => part.text).join(''),
      durationMs: parts[0].durationMs,
      parts: parts.length,
      ver,
    };
  }
}

function attachDevice(transport) {
  const device = new DeviceControl();
  const wire = new Reassembler({ maxMessageBytes: MAX_MESSAGE_BYTES_CEILING });
  const originalSend = transport.send.bind(transport);

  transport.send = async (frame, options) => {
    try {
      const head = decodeHeader(frame);
      if (head.channel === CHANNEL_CONTROL) {
        const result = wire.push(frame);
        if (result.kind === 'message') {
          device.accept(JSON.parse(Buffer.from(result.payload).toString('utf8')));
        }
      }
    } catch (err) {
      device.errors.push(err);
    }
    return originalSend(frame, options);
  };

  return device;
}

let deviceMsgId = 100;

/** 设备 → 主机：把一条控制消息写成真实帧注入 MockTransport。 */
function deviceSend(transport, message, { ackRequired = false } = {}) {
  const id = deviceMsgId;
  deviceMsgId = (deviceMsgId + 1) & 0x0fff;
  const payload = new TextEncoder().encode(JSON.stringify(message));
  const frames = encodeFrames({
    msgId: id,
    payload,
    chunkPayload: CHUNK_PAYLOAD,
    channel: CHANNEL_CONTROL,
    ackRequired,
  });
  for (const frame of frames) transport._onData(frame, { channel: 'control' });
}

/**
 * 设备 → 主机：把音频码流按 chunkPayload 切片，逐帧走 AUDIO 通道。
 * AUDIO 不重组：每帧 body 就是码流的一段，主机按到达顺序追加。
 */
function deviceAudio(transport, bytes, requestId) {
  for (let offset = 0; offset < bytes.length; offset += CHUNK_PAYLOAD) {
    const slice = bytes.subarray(offset, Math.min(offset + CHUNK_PAYLOAD, bytes.length));
    const frames = encodeFrames({
      msgId: requestId,
      payload: slice,
      chunkPayload: CHUNK_PAYLOAD,
      channel: CHANNEL_AUDIO,
      ackRequired: false,
    });
    assert.equal(frames.length, 1, '每片音频应当正好一帧');
    for (const frame of frames) transport._onData(frame, { channel: 'audio' });
  }
}

// ---------------------------------------------------------------------------
// 全栈
// ---------------------------------------------------------------------------

function makeStack({ provider, maxMessageBytes } = {}) {
  const transport = new MockTransport({ mtuPayload: CHUNK_PAYLOAD, autoRespond: true });
  const log = makeLog();
  const link = new Link({
    transport,
    chunkPayload: CHUNK_PAYLOAD,
    // 断链用例不希望测试中途自动重连，退避给足。
    backoffMs: [60_000],
    store: memoryStore(),
  });
  const host = provider ? { asr: provider } : {};
  const asr = new AsrCapability({ link, log, host, maxMessageBytes });
  const server = new ApiServer({ link, log, host, capabilities: [asr] });
  return { transport, log, link, asr, server };
}

async function setup(t, options = {}) {
  const stack = makeStack(options);
  const device = attachDevice(stack.transport);
  await stack.server.start();
  await stack.link.start();
  await waitFor(() => stack.link.ready === true, 5000);
  // 握手应答不是本文件关心的业务消息；清掉后 device.raw 只反映用例期间的下行。
  device.raw.length = 0;

  t.after(async () => {
    try {
      await stack.server.stop();
    } catch {
      // 清理失败不掩盖用例断言
    }
    try {
      await stack.link.stop('测试结束');
    } catch {
      // 同上
    }
    try {
      stack.asr.dispose();
    } catch {
      // 同上
    }
  });

  return { ...stack, device };
}

function parseWav(wav) {
  assert.ok(wav, 'provider 应收到 WAV');
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.toString('ascii', 36, 40), 'data');
  const dataLength = wav.readUInt32LE(40);
  assert.equal(wav.length, 44 + dataLength, 'WAV 长度应为 44 字节头 + data');
  return {
    sampleRate: wav.readUInt32LE(24),
    channels: wav.readUInt16LE(22),
    bitsPerSample: wav.readUInt16LE(34),
    dataLength,
    samples: dataLength / 2,
  };
}

function makeProvider(text = '真实尺寸转写') {
  return {
    ready: true,
    calls: 0,
    wav: null,
    async transcribe(wav) {
      this.calls += 1;
      this.wav = Buffer.from(wav);
      return { text };
    },
  };
}

function beginPayload(requestId = 3, extra = {}) {
  return {
    type: MSG.ASR_BEGIN,
    requestId,
    codec: 'ima-adpcm',
    sampleRate: 16000,
    channels: 1,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('M6 集成 · 30 秒真实尺寸音频端到端', () => {
  test('241908 字节码流分片上行 → 480000 样本 → asr.result durationMs=30000', async (t) => {
    const provider = makeProvider('真实尺寸转写');
    const { transport, device, asr } = await setup(t, { provider });

    const stream = makeAdpcmStream(THIRTY_SECONDS_BYTES);
    assert.equal(stream.length, THIRTY_SECONDS_BYTES);

    deviceSend(transport, beginPayload(3));
    await waitFor(() => asr.stats.sessions === 1);

    deviceAudio(transport, stream, 3);
    deviceSend(transport, { type: MSG.ASR_END, requestId: 3 });

    const result = await waitFor(() => device.result(), 5000);
    assert.equal(result.durationMs, 30000);
    assert.equal(result.text, '真实尺寸转写');
    assert.equal(result.parts, 1, '短文本应当一片发回');
    assert.equal(provider.calls, 1);

    const wav = parseWav(provider.wav);
    assert.equal(wav.sampleRate, 16000);
    assert.equal(wav.channels, 1);
    assert.equal(wav.bitsPerSample, 16);
    assert.equal(wav.samples, 480000, '241908 字节 @16k 应解码为 480000 样本');
    assert.equal(wav.dataLength, 960000);
    await waitFor(() => asr.stats.sessions === 0);
  });

  test('录音中途 asr.cancel → 之后音频静默丢弃，设备一条消息都收不到', async (t) => {
    const provider = makeProvider();
    const { transport, device, asr } = await setup(t, { provider });

    deviceSend(transport, beginPayload(3));
    await waitFor(() => asr.stats.sessions === 1);

    const stream = makeAdpcmStream(FULL_BLOCK_BYTES * 8);
    deviceAudio(transport, stream.subarray(0, 508 * 4), 3);
    deviceSend(transport, { type: MSG.ASR_CANCEL, requestId: 3 });
    await waitFor(() => asr.stats.sessions === 0);

    // 取消之后仍按原 requestId 到达的音频：必须静默丢弃。
    deviceAudio(transport, stream.subarray(508 * 4, 508 * 8), 3);
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(device.raw, [], '取消是设备发起的，主机不得回任何消息');
    assert.equal(asr.stats.cancels, 1);
    assert.equal(provider.calls, 0, '取消后不得调用 provider');
  });

  test('断链时录音在途 → 无消息、无 unhandledRejection、sessions 归零', async (t) => {
    const unhandled = [];
    const onUnhandled = (err) => unhandled.push(err);
    process.on('unhandledRejection', onUnhandled);
    t.after(() => process.off('unhandledRejection', onUnhandled));

    const provider = makeProvider();
    const { transport, device, asr, link } = await setup(t, { provider });

    deviceSend(transport, beginPayload(3));
    await waitFor(() => asr.stats.sessions === 1);

    const stream = makeAdpcmStream(FULL_BLOCK_BYTES * 8);
    deviceAudio(transport, stream.subarray(0, 508 * 4), 3);
    assert.ok(link.state === 'connected');

    transport.simulateDisconnect('录音中断链');
    await waitFor(() => asr.stats.sessions === 0);

    // 断链后的音频不得复活会话，也不得产生迟到结果。
    deviceAudio(transport, stream.subarray(508 * 4, 508 * 8), 3);
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(device.raw, [], '断链不得产生任何消息');
    assert.equal(asr.stats.sessions, 0);
    assert.deepEqual(unhandled, []);
  });

  test('超过 30 秒的码流 → ASR_TOO_LONG，之后音频不再累积', async (t) => {
    const provider = makeProvider();
    const { transport, device, asr } = await setup(t, { provider });

    deviceSend(transport, beginPayload(3));
    await waitFor(() => asr.stats.sessions === 1);

    const stream = makeAdpcmStream(THIRTY_SECONDS_BYTES + 1);
    deviceAudio(transport, stream, 3);

    const error = await waitFor(
      () => device.ofType(MSG.ASR_ERROR)[0],
      3000,
    );
    assert.equal(error.code, 'ASR_TOO_LONG');
    assert.equal(asr.stats.sessions, 0);
    assert.equal(asr.stats.tooLong, 1);

    // 之后到达的音频直接丢：不新增错误、不重建会话、不累积缓冲。
    deviceAudio(transport, makeAdpcmStream(FULL_BLOCK_BYTES), 3);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(device.ofType(MSG.ASR_ERROR).length, 1);
    assert.equal(asr.stats.tooLong, 1);
    assert.equal(asr.stats.sessions, 0);
    assert.equal(provider.calls, 0);
  });

  test('无 provider → asr.begin 同帧拿到 asr.error{ASR_NO_PROVIDER}，无需等 end', async (t) => {
    const { transport, device } = await setup(t);

    deviceSend(transport, beginPayload(3));

    const error = await waitFor(() => device.ofType(MSG.ASR_ERROR)[0], 3000);
    assert.equal(error.code, 'ASR_NO_PROVIDER');
    assert.equal(error.requestId, 3);
    assert.equal(device.raw.length, 1, 'begin 只回这一条错误；我们没有发送 asr.end');

    // 明确证明这是「同帧」路径：end 从未发出，主机仍已回错误。
    assert.equal(device.ofType(MSG.ASR_END).length, 0);
  });

  test('provider 超长文本按 part/parts 拆分，设备拼回逐字节相等', async (t) => {
    const text = '语音结果🙂'.repeat(400); // UTF-8 远超 maxMessageBytes
    const provider = makeProvider(text);
    const { transport, device, asr } = await setup(t, { provider, maxMessageBytes: 700 });

    deviceSend(transport, beginPayload(3));
    await waitFor(() => asr.stats.sessions === 1);
    deviceAudio(transport, makeAdpcmStream(FULL_BLOCK_BYTES * 8), 3);
    deviceSend(transport, { type: MSG.ASR_END, requestId: 3 });

    const result = await waitFor(() => device.result(), 5000);
    assert.ok(result.parts > 1, '长文本必须拆成多片');
    assert.equal(result.text, text, '拼回的文本必须与原文逐字符相等');
    assert.deepEqual(Buffer.from(result.text, 'utf8'), Buffer.from(text, 'utf8'));
    assert.equal(provider.calls, 1);
  });
});
