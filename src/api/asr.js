// Task 35 · api/asr.js
//
// 无状态 ASR 服务（协议 docs/03 §7 / docs/04 Task 35）：
//
//   asr.begin → AUDIO 原始字节流 → asr.end → 转写 → asr.result → 忘掉一切
//
// 三条容易写错的协议规则：
//   · asr.begin 没有应答（不存在 asr.started）。但无法转写时必须**同帧**
//     回 asr.error：设备收到才会停止录音，不能拖到 30 秒后再报。
//   · AUDIO 通道是流，不是消息：按到达顺序追加，不重组、不去重、不看 frag。
//   · asr.cancel / 断链都**一条消息都不回**；绝不用 asr.error{ASR_CANCELLED}
//     表达取消（取消是设备发起的，见 §7.1a）。
//
// 本能力不绑定会话、不注入、不保留历史；音频只在 asr.end 时解码一次。

import { Buffer } from 'node:buffer';

import { decodeAdpcm } from '../wire/adpcm.js';
import { EnvelopeSender, MessageSplitError } from '../wire/message-split.js';
import {
  ASR_BLOCK_BYTES,
  ASR_BLOCK_HEADER_BYTES,
  ASR_BLOCK_DATA_BYTES,
  ASR_CHANNELS,
  ASR_CODEC,
  ASR_FALLBACK_RATE,
  ASR_MAX_SECONDS,
  ASR_MIN_SAMPLES,
  ASR_SAMPLE_RATE,
  ASR_SAMPLES_PER_BLOCK,
  ASR_TIMEOUT_MS,
  CAP_MIC,
  MSG,
} from '../wire/constants.js';

/**
 * 30 秒 @16k / ima-adpcm 的协议字节数（docs/03 §7.1）：
 * 476 个满块（476×508）+ 尾块（4 头 + 96 数据）= 241908。
 * 字节上限是硬限制；8kHz 时还要靠时长估算兜住 30 秒。
 */
const ASR_MAX_BYTES = 241_908;

const NOOP_LOG = Object.freeze({
  debug() {},
  info() {},
  warn() {},
  error() {},
});

function errorMessage(code, detail) {
  switch (code) {
    case 'ASR_NO_PROVIDER':
      return '未配置语音识别服务';
    case 'ASR_NOT_READY':
      return '语音识别服务未就绪';
    case 'ASR_TIMEOUT':
      return '语音识别超时';
    case 'ASR_TOO_SHORT':
      return '音频短于 0.5 秒';
    case 'ASR_TOO_LONG':
      return '音频超过 30 秒上限';
    case 'ASR_NO_MIC':
      return '设备未声明麦克风能力';
    default:
      return detail ?? '语音识别失败';
  }
}

/** 按码流估算样本数；尾部不足 4 字节的残尾不构成块。 */
function estimateSamples(bytes) {
  const full = Math.floor(bytes / ASR_BLOCK_BYTES);
  const rest = bytes % ASR_BLOCK_BYTES;
  return full * ASR_SAMPLES_PER_BLOCK +
    (rest >= ASR_BLOCK_HEADER_BYTES ? (rest - ASR_BLOCK_HEADER_BYTES) * 2 : 0);
}

/** 44 字节 WAV 头 + 16-bit 单声道 PCM。 */
function buildWav(samples, sampleRate) {
  const dataSize = samples.length * 2;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(ASR_CHANNELS, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * ASR_CHANNELS * 2, 28);
  wav.writeUInt16LE(ASR_CHANNELS * 2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples.length; i += 1) {
    wav.writeInt16LE(samples[i], 44 + i * 2);
  }
  return wav;
}

/**
 * EnvelopeSender 只内置 question.asked / approval.asked 两种拆分。asr.result
 * 的信封形状简单（一个可切分的 text 字段），这里继承它复用：
 *   · maxBytes / 逐片 await ack / 发送失败抛 MessageSplitError；
 *   · ver 按消息类型独立计数，断链后由 reset() 归零。
 * 仅覆盖 split()，不复制发送循环。
 */
class AsrResultSender extends EnvelopeSender {
  #resultVer = 0;

  split(type, payload = {}) {
    if (type !== MSG.ASR_RESULT) {
      throw new MessageSplitError(`AsrResultSender 只支持 ${MSG.ASR_RESULT}`, { type });
    }
    const max = this.maxBytes;
    const text = typeof payload.text === 'string' ? payload.text : '';
    const header = { requestId: payload.requestId, durationMs: payload.durationMs };
    const ver = this.#resultVer + 1;
    const make = (part, parts, chunk) => ({ type, ver, part, parts, ...header, text: chunk });
    const sizeOf = (part) => Buffer.byteLength(JSON.stringify(part), 'utf8');

    if (sizeOf(make(1, 1, '')) > max) {
      throw new MessageSplitError(
        `asr.result 的空信封已超过 maxPayload=${max}（requestId=${payload.requestId}）`,
        { type, ver, part: 1, parts: 1 },
      );
    }

    let partsCount = 1;
    let parts = [];
    for (let guard = 0; guard < 32; guard += 1) {
      parts = this.#pack(ver, header, text, partsCount, max, make, sizeOf);
      if (parts.length === partsCount) break;
      partsCount = parts.length;
    }
    if (parts.length !== partsCount) {
      throw new MessageSplitError(
        `asr.result 拆分无法收敛（期望 ${partsCount} 片，实得 ${parts.length} 片）`,
        { type, ver, part: 1, parts: partsCount },
      );
    }
    for (const part of parts) {
      if (sizeOf(part) > max) {
        throw new MessageSplitError(
          `asr.result 第 ${part.part}/${part.parts} 片超过 maxPayload=${max}`,
          { type, ver, part: part.part, parts: part.parts },
        );
      }
    }

    this.#resultVer = ver;
    return parts;
  }

  reset() {
    super.reset();
    this.#resultVer = 0;
  }

  #pack(ver, header, text, partsCount, max, make, sizeOf) {
    const points = Array.from(text);
    // 用该位宽下最大的 part 数字做保守信封：实际 part 只会更短。
    const label = Number('9'.repeat(String(partsCount).length));
    const makePart = (part, chunk) => make(part, partsCount, chunk);

    if (sizeOf(makePart(label, '')) > max) {
      throw new MessageSplitError(
        `asr.result 的 header 无法容纳（maxPayload=${max}，parts=${partsCount}）`,
        { type: MSG.ASR_RESULT, ver, part: 1, parts: partsCount },
      );
    }

    const chunks = [];
    let index = 0;
    while (index < points.length) {
      let low = 1;
      let high = points.length - index;
      let best = 0;
      while (low <= high) {
        const mid = (low + high) >> 1;
        const candidate = makePart(label, points.slice(index, index + mid).join(''));
        if (sizeOf(candidate) <= max) {
          best = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      if (best === 0) {
        throw new MessageSplitError(
          `asr.result 在 maxPayload=${max} 下连一个字符都放不下`,
          { type: MSG.ASR_RESULT, ver, part: chunks.length + 1, parts: partsCount },
        );
      }
      chunks.push(points.slice(index, index + best).join(''));
      index += best;
    }
    if (chunks.length === 0) chunks.push('');
    return chunks.map((chunk, i) => makePart(i + 1, chunk));
  }
}

export class AsrCapability {
  /** 只登记三条设备→主机控制消息；AUDIO 走 onAudio，不经过分发表。 */
  types = [MSG.ASR_BEGIN, MSG.ASR_END, MSG.ASR_CANCEL];

  #link;
  #log;
  #host;
  #setTimer;
  #clearTimer;
  #sender;
  #sessions = new Map();
  #started = false;
  #disposed = false;

  #stats = {
    begins: 0,
    results: 0,
    errors: 0,
    tooShort: 0,
    tooLong: 0,
    cancels: 0,
    timeouts: 0,
    sendErrors: 0,
  };

  #onAudioEvent = (frame) => this.onAudio(frame);

  constructor({ link, log, host, setTimer, clearTimer, maxMessageBytes } = {}) {
    this.#link = link;
    this.#log = log ?? NOOP_LOG;
    this.#host = host ?? {};
    this.#setTimer =
      setTimer ??
      ((fn, ms) => {
        const timer = setTimeout(fn, ms);
        if (typeof timer.unref === 'function') timer.unref();
        return timer;
      });
    this.#clearTimer = clearTimer ?? ((timer) => clearTimeout(timer));
    this.#sender = new AsrResultSender({ link, log: this.#log, maxMessageBytes });
  }

  get stats() {
    return { ...this.#stats, sessions: this.#sessions.size };
  }

  /** 可选：把 Link 的 AUDIO 事件直接接到本能力（Task 36 集成用）。 */
  start() {
    if (this.#disposed || this.#started) return;
    this.#started = true;
    this.#link?.on?.('audio', this.#onAudioEvent);
  }

  stop() {
    if (this.#started) {
      this.#started = false;
      this.#unbindAudio();
      this.#dropAllSessions();
    }
  }

  dispose() {
    if (this.#disposed) return;
    this.stop();
    this.#disposed = true;
    this.#sender.dispose();
  }

  async handle(type, payload = {}) {
    if (this.#disposed) return false;
    switch (type) {
      case MSG.ASR_BEGIN:
        await this.#begin(payload ?? {});
        return true;
      case MSG.ASR_END:
        await this.#end(payload ?? {});
        return true;
      case MSG.ASR_CANCEL:
        this.#cancel(payload ?? {});
        return true;
      default:
        return false;
    }
  }

  /**
   * AUDIO 通道原始字节入口。msgId 就是 requestId；找不到活动 session 时
   * 静默丢弃（取消后的在途帧、未知 requestId、begin 被拒绝后的音频）。
   */
  onAudio({ bytes, msgId } = {}) {
    if (this.#disposed || bytes == null) return;
    const key = String(msgId);
    const session = this.#sessions.get(key);
    if (!session || session.settled || session.closed) return;

    const chunk = Buffer.isBuffer(bytes) ? Buffer.from(bytes) : Buffer.from(bytes);
    if (chunk.length === 0) return;

    const projected = session.bytes + chunk.length;
    const estimateMs = (estimateSamples(projected) / session.sampleRate) * 1000;
    if (projected > ASR_MAX_BYTES || estimateMs > ASR_MAX_SECONDS * 1000) {
      void this.#failSession(session, 'ASR_TOO_LONG', '音频超过 30 秒上限');
      return;
    }

    // 只按到达顺序追加：不做重组、不去重、不校验 frag。
    session.chunks.push(chunk);
    session.bytes = projected;
  }

  onDisconnected() {
    this.#dropAllSessions();
    this.#sender.reset();
  }

  onLinkReady() {
    this.#sender.reset();
  }

  // -------------------------------------------------------------------------
  // begin
  // -------------------------------------------------------------------------

  async #begin(payload) {
    const requestId = payload.requestId;
    if (!Number.isInteger(requestId) || requestId < 0 || requestId >= 16) {
      await this.#sendError(requestId, 'ASR_FAILED', 'requestId 必须是 0..15 的整数');
      return;
    }

    if (!this.#hasMic()) {
      await this.#sendError(requestId, 'ASR_NO_MIC');
      return;
    }

    const provider = this.#host?.asr;
    if (!provider || typeof provider.transcribe !== 'function') {
      await this.#sendError(requestId, 'ASR_NO_PROVIDER');
      return;
    }
    if (provider.ready !== true) {
      await this.#sendError(requestId, 'ASR_NOT_READY');
      return;
    }

    const codec = payload.codec;
    if (codec !== ASR_CODEC) {
      await this.#sendError(requestId, 'ASR_FAILED', `不支持的 codec: ${String(codec)}`);
      return;
    }

    const sampleRate = payload.sampleRate ?? ASR_SAMPLE_RATE;
    if (sampleRate !== ASR_SAMPLE_RATE && sampleRate !== ASR_FALLBACK_RATE) {
      await this.#sendError(requestId, 'ASR_FAILED', `不支持的采样率: ${String(sampleRate)}`);
      return;
    }
    const channels = payload.channels ?? ASR_CHANNELS;
    if (channels !== ASR_CHANNELS) {
      await this.#sendError(requestId, 'ASR_FAILED', `不支持的声道数: ${String(channels)}`);
      return;
    }

    if (this.#sessions.size > 0) {
      await this.#sendError(requestId, 'ASR_FAILED', '已有转写请求在途，同一时刻只允许一个');
      return;
    }

    this.#sessions.set(String(requestId), {
      requestId,
      key: String(requestId),
      sampleRate,
      chunks: [],
      bytes: 0,
      settled: false,
      closed: false,
      timer: null,
    });
    this.#stats.begins += 1;
  }

  #hasMic() {
    const info = this.#link?.info;
    if (!info) return true; // 未注入设备信息的测试桩不拦
    const caps = info.capabilities;
    if (Array.isArray(caps)) {
      return caps.includes('MIC') || caps.includes(CAP_MIC);
    }
    if (typeof caps === 'number') return (caps & CAP_MIC) !== 0;
    return true;
  }

  // -------------------------------------------------------------------------
  // end / transcribe
  // -------------------------------------------------------------------------

  async #end(payload) {
    const session = this.#sessions.get(String(payload.requestId));
    if (!session || session.closed || session.settled) return;
    session.settled = true;

    if (session.bytes === 0) {
      await this.#failSession(session, 'ASR_TOO_SHORT', '没有音频数据');
      return;
    }

    let samples;
    try {
      samples = decodeAdpcm(Buffer.concat(session.chunks));
    } catch (err) {
      this.#log.error('ASR 解码失败：%s', err?.message ?? err);
      await this.#failSession(session, 'ASR_FAILED', '音频解码失败');
      return;
    }
    if (samples.length < ASR_MIN_SAMPLES) {
      await this.#failSession(session, 'ASR_TOO_SHORT');
      return;
    }

    const provider = this.#host?.asr;
    if (!provider || typeof provider.transcribe !== 'function') {
      await this.#failSession(session, 'ASR_NO_PROVIDER');
      return;
    }

    const wav = buildWav(samples, session.sampleRate);
    const durationMs = Math.round((samples.length / session.sampleRate) * 1000);

    let timeoutError = null;
    const timeout = new Promise((_, reject) => {
      session.timer = this.#setTimer(() => {
        timeoutError = Object.assign(new Error('语音识别超时'), { code: 'ASR_TIMEOUT' });
        reject(timeoutError);
      }, ASR_TIMEOUT_MS);
    });
    // cancel / 断链时让挂起的 #end 立即返回，而不是等 provider 自然结束。
    // 这条 Promise 只在 #end 期间存在，race 一定给它挂了处理器。
    const cancelled = new Promise((_, reject) => {
      session.cancelReject = () => {
        reject(Object.assign(new Error('转写已取消'), { code: 'ASR_CANCELLED' }));
      };
    });

    try {
      // Promise.resolve().then 同时兜住同步抛错与同步返回值。
      const outcome = await Promise.race([
        Promise.resolve().then(() => provider.transcribe(wav)),
        timeout,
        cancelled,
      ]);
      if (session.closed) return;

      const text = typeof outcome?.text === 'string' ? outcome.text : '';
      await this.#sender.send(MSG.ASR_RESULT, {
        requestId: session.requestId,
        text,
        durationMs,
      });
      this.#stats.results += 1;
    } catch (err) {
      if (session.closed) return;
      if (timeoutError || err?.code === 'ASR_TIMEOUT') {
        this.#stats.timeouts += 1;
        await this.#sendError(session.requestId, 'ASR_TIMEOUT');
      } else {
        this.#log.error('ASR 转写失败：%s', err?.stack ?? err?.message ?? err);
        this.#stats.errors += 1;
        await this.#sendError(session.requestId, 'ASR_FAILED', err?.message);
      }
    } finally {
      session.cancelReject = null;
      if (session.timer !== null) {
        this.#clearTimer(session.timer);
        session.timer = null;
      }
      session.closed = true;
      if (this.#sessions.get(session.key) === session) this.#sessions.delete(session.key);
    }
  }

  // -------------------------------------------------------------------------
  // cancel / 断链
  // -------------------------------------------------------------------------

  #cancel(payload) {
    const session = this.#sessions.get(String(payload.requestId));
    if (!session) return;
    this.#closeSession(session);
    this.#stats.cancels += 1;
    // 取消是设备发起的：一条消息都不回，也绝不用 ASR_CANCELLED。
  }

  #dropAllSessions() {
    for (const session of [...this.#sessions.values()]) this.#closeSession(session);
  }

  #closeSession(session) {
    session.closed = true;
    session.chunks = [];
    session.bytes = 0;
    if (session.cancelReject) {
      session.cancelReject();
      session.cancelReject = null;
    }
    if (session.timer !== null) {
      this.#clearTimer(session.timer);
      session.timer = null;
    }
    if (this.#sessions.get(session.key) === session) this.#sessions.delete(session.key);
  }

  // -------------------------------------------------------------------------
  // 发送
  // -------------------------------------------------------------------------

  async #failSession(session, code, detail) {
    if (session.closed) return;
    this.#closeSession(session);
    if (code === 'ASR_TOO_LONG') this.#stats.tooLong += 1;
    else if (code === 'ASR_TOO_SHORT') this.#stats.tooShort += 1;
    else this.#stats.errors += 1;
    await this.#sendError(session.requestId, code, detail);
  }

  async #sendError(requestId, code, detail) {
    const payload = {
      requestId,
      code,
      message: errorMessage(code, detail),
    };
    try {
      await this.#link.send(MSG.ASR_ERROR, payload, { ack: true });
    } catch (err) {
      this.#stats.sendErrors += 1;
      this.#log.warn('回 asr.error 失败（%s）：%s', code, err?.message ?? err);
    }
  }

  #unbindAudio() {
    if (this.#link?.off) this.#link.off('audio', this.#onAudioEvent);
    else this.#link?.removeListener?.('audio', this.#onAudioEvent);
  }
}
