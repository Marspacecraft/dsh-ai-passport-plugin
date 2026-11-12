// Task 35 · api/asr.js — TDD
//
// 覆盖 docs/04 Task 35 的 13 条验收：无状态 ASR 能力。
// 音频不走 JSON 分发表，onAudio 独立入口；begin 成功零回执、失败同帧回
// asr.error；cancel/断链零回执；end 只在结束时解码一次并组 WAV。

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';

import { AsrCapability } from '../../src/api/asr.js';
import { decodeAdpcm } from '../../src/wire/adpcm.js';
import {
  ASR_BLOCK_BYTES,
  ASR_BLOCK_DATA_BYTES,
  ASR_BLOCK_HEADER_BYTES,
  ASR_MAX_SECONDS,
  ASR_SAMPLE_RATE,
  CAP_DISPLAY,
  CAP_MIC,
  MSG,
} from '../../src/wire/constants.js';

// ---------------------------------------------------------------------------
// 基建
// ---------------------------------------------------------------------------

class FakeLink extends EventEmitter {
  sent = [];
  info;

  constructor({ maxPayload = 4096, capabilities = CAP_MIC } = {}) {
    super();
    this.info = { maxPayload, capabilities, paired: true };
  }

  async send(type, payload, opts = {}) {
    this.sent.push({ type, payload, opts });
    return { msgId: this.sent.length };
  }

  ofType(type) {
    return this.sent.filter((m) => m.type === type);
  }
}

function makeLog() {
  const entries = [];
  const push = (level) => (...args) => entries.push({ level, text: args.map(String).join(' ') });
  return { entries, debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') };
}

function makeClock() {
  let now = 0;
  let timers = [];
  return {
    now: () => now,
    setTimer(fn, delay) {
      const timer = { at: now + delay, fn, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) {
      if (timer) timer.cleared = true;
    },
    advance(ms) {
      now += ms;
      const due = timers
        .filter((t) => !t.cleared && t.at <= now)
        .sort((a, b) => a.at - b.at);
      timers = timers.filter((t) => t.cleared || t.at > now);
      for (const timer of due) {
        timer.cleared = true;
        timer.fn();
      }
    },
  };
}

function makeProvider({ ready = true, text = 'hello', handler } = {}) {
  const calls = [];
  return {
    ready,
    calls,
    transcribe(wav) {
      calls.push(wav);
      if (handler) return handler(wav);
      return Promise.resolve({ text });
    },
  };
}

function makeCap({ link, provider, host, log, clock, maxMessageBytes } = {}) {
  const l = link ?? new FakeLink();
  const h = host ?? (provider === null ? {} : { asr: provider ?? makeProvider() });
  return {
    link: l,
    cap: new AsrCapability({
      link: l,
      log: log ?? makeLog(),
      host: h,
      setTimer: clock?.setTimer,
      clearTimer: clock?.clearTimer,
      maxMessageBytes,
    }),
  };
}

function adpcmBlock(predictor, stepIndex, data) {
  const block = Buffer.alloc(ASR_BLOCK_HEADER_BYTES + data.length);
  block.writeInt16LE(predictor, 0);
  block[2] = stepIndex;
  block[3] = 0;
  data.copy(block, ASR_BLOCK_HEADER_BYTES);
  return block;
}

/** 生成总长恰好 bytes 的合法码流：满块 + 尾块（不足 4 字节的残尾原样附加）。 */
function makeStream(bytes) {
  const chunks = [];
  let remaining = bytes;
  let index = 0;
  while (remaining >= ASR_BLOCK_BYTES) {
    const data = Buffer.alloc(ASR_BLOCK_DATA_BYTES);
    for (let j = 0; j < data.length; j += 1) data[j] = (index * 13 + j) & 0xff;
    chunks.push(adpcmBlock((index * 97) % 20000, index % 89, data));
    remaining -= ASR_BLOCK_BYTES;
    index += 1;
  }
  if (remaining >= ASR_BLOCK_HEADER_BYTES) {
    const data = Buffer.alloc(remaining - ASR_BLOCK_HEADER_BYTES, 0x5a);
    chunks.push(adpcmBlock(1234, 45, data));
    remaining = 0;
  }
  if (remaining > 0) chunks.push(Buffer.alloc(remaining, 0xaa));
  const stream = Buffer.concat(chunks);
  assert.equal(stream.length, bytes);
  return stream;
}

function framesOf(stream, size = 510) {
  const frames = [];
  for (let off = 0; off < stream.length; off += size) {
    frames.push(stream.subarray(off, Math.min(stream.length, off + size)));
  }
  return frames;
}

function parseWav(wav) {
  assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(wav.subarray(8, 12).toString('ascii'), 'WAVE');
  assert.equal(wav.subarray(12, 16).toString('ascii'), 'fmt ');
  assert.equal(wav.subarray(36, 40).toString('ascii'), 'data');
  return {
    riksSize: wav.readUInt32LE(4),
    fmtSize: wav.readUInt32LE(16),
    audioFormat: wav.readUInt16LE(20),
    channels: wav.readUInt16LE(22),
    sampleRate: wav.readUInt32LE(24),
    byteRate: wav.readUInt32LE(28),
    blockAlign: wav.readUInt16LE(32),
    bitsPerSample: wav.readUInt16LE(34),
    dataSize: wav.readUInt32LE(40),
    data: wav.subarray(44),
  };
}

function beginPayload(overrides = {}) {
  return { requestId: 3, codec: 'ima-adpcm', sampleRate: ASR_SAMPLE_RATE, channels: 1, ...overrides };
}

/** 30 秒 @16k 的协议字节数，也是 ASR_MAX_BYTES。 */
const THIRTY_SECONDS_BYTES = 241_908;

async function beginAndSend(cap, stream, { requestId = 3, ...rest } = {}) {
  await cap.handle(MSG.ASR_BEGIN, beginPayload({ requestId, ...rest }));
  for (const [i, bytes] of framesOf(stream).entries()) {
    cap.onAudio({ bytes, msgId: requestId, frag: i & 0x0f });
  }
}

// ---------------------------------------------------------------------------
// 1. 分发表与 begin
// ---------------------------------------------------------------------------

describe('AsrCapability · 类型与 begin 回执语义', () => {
  test("types 恰为 ['asr.begin','asr.end','asr.cancel']，音频有独立入口", () => {
    const { cap } = makeCap();
    assert.deepEqual(cap.types, [MSG.ASR_BEGIN, MSG.ASR_END, MSG.ASR_CANCEL]);
    assert.equal(cap.types.includes(MSG.ASR_RESULT), false);
    assert.equal(typeof cap.onAudio, 'function');
  });

  test('asr.begin 成功路径一条消息都不发（没有 asr.started）', async () => {
    const provider = makeProvider();
    const { cap, link } = makeCap({ provider });
    assert.equal(await cap.handle(MSG.ASR_BEGIN, beginPayload()), true);
    assert.equal(link.sent.length, 0);
    assert.equal(cap.stats.sessions, 1);
  });

  test('无 provider → 同帧回 ASR_NO_PROVIDER，不建 session', async () => {
    const { cap, link } = makeCap({ host: {} });
    await cap.handle(MSG.ASR_BEGIN, beginPayload());
    assert.equal(link.sent.length, 1);
    assert.equal(link.sent[0].type, MSG.ASR_ERROR);
    assert.equal(link.sent[0].payload.code, 'ASR_NO_PROVIDER');
    assert.equal(cap.stats.sessions, 0);
  });

  test('provider 未就绪 → ASR_NOT_READY', async () => {
    const { cap, link } = makeCap({ provider: makeProvider({ ready: false }) });
    await cap.handle(MSG.ASR_BEGIN, beginPayload());
    assert.equal(link.sent.length, 1);
    assert.equal(link.sent[0].payload.code, 'ASR_NOT_READY');
    assert.equal(cap.stats.sessions, 0);
  });

  test('codec 非 ima-adpcm（pcm16）→ ASR_FAILED 且不建 session、不降级', async () => {
    const provider = makeProvider();
    const { cap, link } = makeCap({ provider });
    await cap.handle(MSG.ASR_BEGIN, beginPayload({ codec: 'pcm16' }));
    assert.equal(link.sent.length, 1);
    assert.equal(link.sent[0].payload.code, 'ASR_FAILED');
    assert.match(link.sent[0].payload.message, /pcm16/);
    assert.equal(cap.stats.sessions, 0);
    assert.equal(provider.calls.length, 0);
  });

  test('同一 requestId 已有在途 → ASR_FAILED，原 session 保留', async () => {
    const { cap, link } = makeCap();
    await cap.handle(MSG.ASR_BEGIN, beginPayload());
    await cap.handle(MSG.ASR_BEGIN, beginPayload());
    assert.equal(link.sent.length, 1);
    assert.equal(link.sent[0].payload.code, 'ASR_FAILED');
    assert.equal(cap.stats.sessions, 1);
  });

  test('能力位未声明 MIC → ASR_NO_MIC（数值位图与数组都支持）', async () => {
    const a = makeCap({ link: new FakeLink({ capabilities: CAP_DISPLAY }) });
    await a.cap.handle(MSG.ASR_BEGIN, beginPayload());
    assert.equal(a.link.sent[0]?.payload.code, 'ASR_NO_MIC');

    const b = makeCap({ link: new FakeLink({ capabilities: ['DISPLAY'] }) });
    await b.cap.handle(MSG.ASR_BEGIN, beginPayload());
    assert.equal(b.link.sent[0]?.payload.code, 'ASR_NO_MIC');

    const ok = makeCap({ link: new FakeLink({ capabilities: ['MIC'] }) });
    await ok.cap.handle(MSG.ASR_BEGIN, beginPayload());
    assert.equal(ok.link.sent.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 2. 音频收流
// ---------------------------------------------------------------------------

describe('AsrCapability · onAudio 流语义', () => {
  test('未知 msgId / cancel 之后的音频帧静默丢弃', async () => {
    const { cap, link } = makeCap();
    cap.onAudio({ bytes: Buffer.alloc(64, 0x11), msgId: 9, frag: 0 });
    await cap.handle(MSG.ASR_BEGIN, beginPayload());
    await cap.handle(MSG.ASR_CANCEL, { requestId: 3 });
    cap.onAudio({ bytes: Buffer.alloc(64, 0x22), msgId: 3, frag: 1 });
    assert.equal(link.sent.length, 0);
    assert.equal(cap.stats.sessions, 0);
  });

  test('按到达顺序追加，不做重组/去重：end 时解码整段（与 decodeAdpcm 拼接一致）', async () => {
    // 至少 8000 样本（8 块 = 8064），否则会先撞 ASR_TOO_SHORT，测不到拼接。
    const stream = makeStream(ASR_BLOCK_BYTES * 8);
    const expected = decodeAdpcm(stream);
    const provider = makeProvider();
    const { cap, link } = makeCap({ provider });
    await cap.handle(MSG.ASR_BEGIN, beginPayload());

    // 故意按 100 字节小块无序 frag 值发送：frag 仅诊断，不参与排序。
    const parts = framesOf(stream, 97);
    for (const [i, bytes] of parts.entries()) cap.onAudio({ bytes, msgId: 3, frag: (7 - i) & 0x0f });

    await cap.handle(MSG.ASR_END, { requestId: 3 });
    assert.equal(provider.calls.length, 1);
    const wav = parseWav(provider.calls[0]);
    assert.equal(wav.data.length, expected.length * 2);
    assert.deepEqual([...wav.data], [...Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength)]);
    assert.equal(link.sent[0].payload.durationMs, expected.length / 16);
  });

  test('累计字节超过 241908 → ASR_TOO_LONG，丢缓冲，之后音频直接丢', async () => {
    const { cap, link } = makeCap();
    await cap.handle(MSG.ASR_BEGIN, beginPayload());
    cap.onAudio({ bytes: makeStream(THIRTY_SECONDS_BYTES + 1), msgId: 3, frag: 0 });

    assert.equal(link.sent.length, 1);
    assert.equal(link.sent[0].payload.code, 'ASR_TOO_LONG');
    assert.equal(cap.stats.sessions, 0);

    cap.onAudio({ bytes: makeStream(ASR_BLOCK_BYTES), msgId: 3, frag: 1 });
    assert.equal(link.sent.length, 1, '丢弃后的音频不得再触发任何消息');
  });

  test('8kHz 下字节未超限但时长超 30 秒 → ASR_TOO_LONG', async () => {
    const { cap, link } = makeCap();
    await cap.handle(MSG.ASR_BEGIN, beginPayload({ sampleRate: 8000 }));
    // 30 秒 @8k ≈ 120956 字节；多给 1 字节。
    cap.onAudio({ bytes: makeStream(120_957), msgId: 3, frag: 0 });
    assert.equal(link.sent.length, 1);
    assert.equal(link.sent[0].payload.code, 'ASR_TOO_LONG');
    assert.equal(cap.stats.sessions, 0);
  });
});

// ---------------------------------------------------------------------------
// 3. end / WAV / 错误
// ---------------------------------------------------------------------------

describe('AsrCapability · asr.end 与结果', () => {
  test('241908 字节 → 480000 样本 → WAV 44 字节头 → durationMs 30000', async () => {
    const provider = makeProvider({ text: '用 macOS 构建' });
    const { cap, link } = makeCap({ provider });
    await beginAndSend(cap, makeStream(THIRTY_SECONDS_BYTES));
    await cap.handle(MSG.ASR_END, { requestId: 3 });

    assert.equal(provider.calls.length, 1);
    const wav = parseWav(provider.calls[0]);
    assert.equal(wav.fmtSize, 16);
    assert.equal(wav.audioFormat, 1);
    assert.equal(wav.channels, 1);
    assert.equal(wav.sampleRate, 16000);
    assert.equal(wav.byteRate, 32000);
    assert.equal(wav.blockAlign, 2);
    assert.equal(wav.bitsPerSample, 16);
    assert.equal(wav.dataSize, 480_000 * 2);
    assert.equal(wav.data.length, 480_000 * 2);
    assert.equal(wav.riksSize, 36 + wav.dataSize);

    assert.equal(link.sent.length, 1);
    const result = link.sent[0];
    assert.equal(result.type, MSG.ASR_RESULT);
    assert.deepEqual(
      { requestId: result.payload.requestId, text: result.payload.text, durationMs: result.payload.durationMs },
      { requestId: 3, text: '用 macOS 构建', durationMs: 30_000 },
    );
    assert.deepEqual(
      { ver: result.payload.ver, part: result.payload.part, parts: result.payload.parts },
      { ver: 1, part: 1, parts: 1 },
    );
    assert.equal(cap.stats.sessions, 0);
  });

  test('样本数 < 8000 → ASR_TOO_SHORT 且 provider 未被调用', async () => {
    const provider = makeProvider();
    const { cap, link } = makeCap({ provider });
    await beginAndSend(cap, makeStream(ASR_BLOCK_BYTES));
    await cap.handle(MSG.ASR_END, { requestId: 3 });
    assert.equal(link.sent[0].payload.code, 'ASR_TOO_SHORT');
    assert.equal(provider.calls.length, 0);
    assert.equal(cap.stats.sessions, 0);
  });

  test("空文本照常回 asr.result{text:''}，不是错误", async () => {
    const provider = makeProvider({ text: '' });
    const { cap, link } = makeCap({ provider });
    await beginAndSend(cap, makeStream(ASR_BLOCK_BYTES * 8));
    await cap.handle(MSG.ASR_END, { requestId: 3 });
    assert.equal(link.sent.length, 1);
    assert.equal(link.sent[0].type, MSG.ASR_RESULT);
    assert.equal(link.sent[0].payload.text, '');
  });

  test('provider 抛错 → ASR_FAILED，且不产生 unhandledRejection', async () => {
    const unhandled = [];
    const onUnhandled = (err) => unhandled.push(err);
    process.on('unhandledRejection', onUnhandled);
    try {
      const provider = makeProvider({
        handler: async () => {
          throw new Error('模型炸了');
        },
      });
      const { cap, link } = makeCap({ provider });
      await beginAndSend(cap, makeStream(ASR_BLOCK_BYTES * 8));
      await cap.handle(MSG.ASR_END, { requestId: 3 });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(link.sent[0].payload.code, 'ASR_FAILED');
      assert.equal(cap.stats.sessions, 0);
      assert.deepEqual(unhandled, []);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test('转写超过 60 秒 → ASR_TIMEOUT，且无 unhandledRejection', async () => {
    const unhandled = [];
    const onUnhandled = (err) => unhandled.push(err);
    process.on('unhandledRejection', onUnhandled);
    try {
      const clock = makeClock();
      let neverResolve;
      const provider = makeProvider({
        handler: () => new Promise((resolve) => {
          neverResolve = resolve;
        }),
      });
      const { cap, link } = makeCap({ provider, clock });
      await beginAndSend(cap, makeStream(ASR_BLOCK_BYTES * 8));

      const pending = cap.handle(MSG.ASR_END, { requestId: 3 });
      clock.advance(60_000);
      await pending;
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(link.sent.length, 1);
      assert.equal(link.sent[0].payload.code, 'ASR_TIMEOUT');
      assert.equal(cap.stats.sessions, 0);
      assert.deepEqual(unhandled, []);

      // 超时之后 provider 才结束，也不得再发结果。
      neverResolve({ text: '迟到' });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(link.sent.length, 1);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. cancel / 断链 / 只结算一次
// ---------------------------------------------------------------------------

describe('AsrCapability · cancel、断链与幂等', () => {
  test('asr.cancel 丢弃缓冲、释放 session、一条消息都不回', async () => {
    const { cap, link } = makeCap();
    await cap.handle(MSG.ASR_BEGIN, beginPayload());
    cap.onAudio({ bytes: makeStream(ASR_BLOCK_BYTES), msgId: 3, frag: 0 });
    await cap.handle(MSG.ASR_CANCEL, { requestId: 3 });

    assert.deepEqual(link.sent, []);
    assert.equal(cap.stats.sessions, 0);
    assert.equal(cap.stats.cancels, 1);

    await cap.handle(MSG.ASR_END, { requestId: 3 });
    assert.deepEqual(link.sent, []);
  });

  test('断链丢弃全部在途 session、不发消息，stats.sessions 归 0', async () => {
    const { cap, link } = makeCap();
    await cap.handle(MSG.ASR_BEGIN, beginPayload());
    cap.onAudio({ bytes: makeStream(ASR_BLOCK_BYTES), msgId: 3, frag: 0 });
    cap.onDisconnected({ reason: '测试断链' });
    assert.deepEqual(link.sent, []);
    assert.equal(cap.stats.sessions, 0);
    await cap.handle(MSG.ASR_END, { requestId: 3 });
    assert.deepEqual(link.sent, []);
  });

  test('转写中再次 asr.end 忽略；迟到 cancel 不影响已发结果', async () => {
    let resolveTranscribe;
    const provider = makeProvider({
      handler: () => new Promise((resolve) => {
        resolveTranscribe = resolve;
      }),
    });
    const { cap, link } = makeCap({ provider });
    await beginAndSend(cap, makeStream(ASR_BLOCK_BYTES * 8));

    const first = cap.handle(MSG.ASR_END, { requestId: 3 });
    await cap.handle(MSG.ASR_END, { requestId: 3 }); // 转写中，忽略
    resolveTranscribe({ text: '只此一次' });
    await first;

    await cap.handle(MSG.ASR_CANCEL, { requestId: 3 }); // 迟到 cancel
    assert.equal(link.sent.length, 1);
    assert.equal(link.sent[0].payload.text, '只此一次');
    assert.equal(cap.stats.sessions, 0);
  });

  test('转写中 cancel 抑制迟到结果，不回任何消息', async () => {
    let resolveTranscribe;
    const provider = makeProvider({
      handler: () => new Promise((resolve) => {
        resolveTranscribe = resolve;
      }),
    });
    const { cap, link } = makeCap({ provider });
    await beginAndSend(cap, makeStream(ASR_BLOCK_BYTES * 8));

    const pending = cap.handle(MSG.ASR_END, { requestId: 3 });
    await cap.handle(MSG.ASR_CANCEL, { requestId: 3 });
    resolveTranscribe({ text: '不该出现' });
    await pending;
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(link.sent, []);
    assert.equal(cap.stats.sessions, 0);
  });
});

// ---------------------------------------------------------------------------
// 5. 结果拆分与分层
// ---------------------------------------------------------------------------

describe('AsrCapability · 结果拆分与分层', () => {
  test('asr.result 超 maxPayload 按 §5.1.2 拆分，文本不被截断', async () => {
    const text = '用 macOS 构建 🚀 '.repeat(120);
    const provider = makeProvider({ text });
    const { cap, link } = makeCap({
      provider,
      link: new FakeLink({ maxPayload: 160 }),
    });
    await beginAndSend(cap, makeStream(ASR_BLOCK_BYTES * 8));
    await cap.handle(MSG.ASR_END, { requestId: 3 });

    const results = link.ofType(MSG.ASR_RESULT);
    assert.ok(results.length > 1, `应拆多片，实际 ${results.length}`);
    const parts = results.map((m) => m.payload);
    assert.ok(parts.every((p) => Buffer.byteLength(JSON.stringify(p)) <= 160));
    assert.deepEqual([...new Set(parts.map((p) => p.ver))].length, 1);
    assert.deepEqual(parts.map((p) => p.part), Array.from({ length: parts.length }, (_, i) => i + 1));
    assert.ok(parts.every((p) => p.parts === parts.length));
    assert.ok(parts.every((p) => p.requestId === 3));

    const joined = parts.map((p) => p.text).join('');
    assert.equal(joined, text, '拆分不得截断或丢失文本');
  });

  test('只 import 允许的底层模块，不反向依赖 host/', () => {
    const source = readFileSync(new URL('../../src/api/asr.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /from\s+['"][^'"]*host\//, 'api 不得 import host/');
    const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    for (const spec of imports) {
      assert.ok(
        spec === 'node:buffer' || spec === './../wire/constants.js' || spec === '../wire/constants.js'
          || spec === '../wire/message-split.js' || spec === '../wire/adpcm.js',
        `不允许的 import：${spec}`,
      );
    }
  });
});
