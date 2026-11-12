/**
 * api/push.js — 状态推送能力（docs/02 §5.1 / docs/04 Task 20）
 *
 * 负责把 host.sessions 的状态变化变成协议推送：
 *
 *   sessions.emit('changed') → 取全量快照 → ① 内容签名去重 ② 500ms 尾沿节流
 *                            → link.send('session.state', {ver,part,parts,sessions})
 *
 * 关键语义（都是 v1 的真实事故）：
 *   · 尾沿节流：窗口内只保留一个计时器，到点推**当时最新**的快照；不排队堆积。
 *   · attention none→approval/question 立即推送，绕过节流——节流对「状态显示」
 *     无感，对「弹提醒」有感，晚 500ms 提醒就凉了。
 *   · session.result 一次性事件：不节流、不按内容去重、不重发（按
 *     sessionId+turnId 只发一次；sentResults 只存内存，断链**不清**，防止重连
 *     后把用户已经看过的结果再弹一遍）。超限只截断 + truncated=1，绝不拆分。
 *   · session.state 超 maxMessageBytes 时按 (ver,part,parts) 拆分，同一次快照
 *     所有 part 共用一个 ver（docs/03 §5.1.2）。
 *   · 断链：清计时器、ver 归零、清签名；重连 ready 后重推一次全量快照。
 *
 * 本能力没有上行消息（types=[]，handle 恒返回 false），只被 ApiServer 当作
 * 兜底能力放在链尾；未 ready 时 link.send 抛 NOT_CONNECTED 由本层吞掉并 warn。
 */

import { Buffer } from 'node:buffer';

import { WireError, ERR } from '../wire/errors.js';
import { buildSessions } from './snapshot.js';
import {
  MSG,
  ATTENTION,
  PUSH_MIN_INTERVAL_MS,
  MAX_MESSAGE_BYTES_CEILING,
} from '../wire/constants.js';

const NOOP_LOG = Object.freeze({
  debug() {},
  info() {},
  warn() {},
  error() {},
});

const ALERT_ATTENTIONS = new Set([ATTENTION.APPROVAL, ATTENTION.QUESTION]);

/** 稳定签名：对象键递归排序，数组保持顺序；只用于比较，不用于发送。 */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

function byteLength(text) {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * 按 code point 截断（不切坏多字节字符与代理对），并用真实序列化结果做边界
 * 校验——转义字符（引号、反斜杠）会膨胀，不能按原始字节数一刀切。
 */
function truncateToBudget(points, makeMessage, maxBytes) {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (byteLength(makeMessage(points.slice(0, mid).join(''))) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return points.slice(0, lo).join('');
}

export class PushCapability {
  /** 没有上行消息类型：ApiServer 只把它当兜底能力。 */
  types = [];

  #link;
  #log;
  #host;
  #now;
  #setTimer;
  #clearTimer;
  #maxMessageBytesOption;

  #stateVer = 0;
  #resultVer = 0;
  #lastSentAt = -Infinity;
  #lastSignature = null;
  #lastAttention = new Map();
  #timer = null;
  /** 断链后置位：重连 ready 时必须无条件重推全量（断链期间的变化也算）。 */
  #forceFullSync = false;
  /**
   * 有变化尚未成功推给设备。未 ready 期间的变化一律攒在这里：既不分配 ver、
   * 也不写签名/#lastSentAt——否则会在设备看不见的时候把「已推送」状态写脏，
   * 导致 ready 后签名相同被去重、首份全量快照丢失（t25/F1）。
   */
  #dirty = true;

  /** 不落盘、断链不清（docs/02 §6 清理矩阵）。 */
  #sentResults = new Set();

  #started = false;
  #onChanged = () => this.onSessionsChanged();
  #onResult = (result) => this.onSessionResult(result);

  constructor({
    link,
    log,
    host,
    now = Date.now,
    setTimer,
    clearTimer,
    maxMessageBytes,
  } = {}) {
    if (!link || typeof link.send !== 'function') {
      throw new WireError(ERR.BAD_PAYLOAD, 'PushCapability 需要一个可 send 的 link');
    }
    this.#link = link;
    this.#log = log ?? NOOP_LOG;
    this.#host = host ?? {};
    this.#now = now;
    this.#setTimer =
      setTimer ??
      ((fn, ms) => {
        const timer = setTimeout(fn, ms);
        timer.unref?.();
        return timer;
      });
    this.#clearTimer = clearTimer ?? clearTimeout;
    this.#maxMessageBytesOption =
      Number.isInteger(maxMessageBytes) && maxMessageBytes > 0 ? maxMessageBytes : null;
  }

  /** 订阅 host.sessions 的变化与结果事件（幂等）。 */
  start() {
    if (this.#started) return;
    this.#started = true;
    const sessions = this.#host?.sessions;
    if (sessions && typeof sessions.on === 'function') {
      sessions.on('changed', this.#onChanged);
      sessions.on('result', this.#onResult);
    }
  }

  /** 退订并清计时器；不清 sentResults（那是逻辑状态，不是资源）。 */
  stop() {
    if (!this.#started) return;
    this.#started = false;
    const sessions = this.#host?.sessions;
    if (sessions && typeof sessions.off === 'function') {
      sessions.off('changed', this.#onChanged);
      sessions.off('result', this.#onResult);
    } else if (sessions && typeof sessions.removeListener === 'function') {
      sessions.removeListener('changed', this.#onChanged);
      sessions.removeListener('result', this.#onResult);
    }
    this.#cancelTimer();
  }

  /** push 没有上行消息。 */
  handle() {
    return false;
  }

  // -------------------------------------------------------------------------
  // session.state
  // -------------------------------------------------------------------------

  /** sessions.emit('changed') 的入口。宿主事件回调里不能让异常冒泡。 */
  onSessionsChanged() {
    try {
      this.#handleSessionsChanged();
    } catch (err) {
      this.#log.error('session.state 推送失败：%s', err?.stack ?? err);
    }
  }

  #handleSessionsChanged() {
    // 未 ready 时不做任何协议状态推进：只记 dirty，等 onLinkReady 补推。
    if (this.#link?.ready !== true) {
      this.#cancelTimer();
      this.#dirty = true;
      return;
    }

    const sessions = this.#snapshot();

    if (this.#shouldAlert(sessions)) {
      // 弹提醒不能等节流：立即推，并作废尚未触发的尾沿计时器。
      this.#cancelTimer();
      this.#flushState(sessions);
      return;
    }

    const now = this.#now();
    const elapsed = now - this.#lastSentAt;
    if (elapsed >= PUSH_MIN_INTERVAL_MS) {
      this.#flushState(sessions);
      return;
    }

    if (this.#timer === null) {
      // 尾沿：到点重新取快照，只推最后一次状态，不排队。
      this.#timer = this.#setTimer(() => {
        this.#timer = null;
        try {
          this.#flushState(this.#snapshot());
        } catch (err) {
          this.#log.error('session.state 尾沿推送失败：%s', err?.stack ?? err);
        }
      }, PUSH_MIN_INTERVAL_MS - elapsed);
    }
  }

  #flushState(sessions) {
    // 双保险：尾沿计时器/onLinkReady 都可能走到这里，仍未 ready 就别发包。
    if (this.#link?.ready !== true) {
      this.#cancelTimer();
      this.#dirty = true;
      return;
    }

    const signature = JSON.stringify(canonicalize(sessions));
    if (signature === this.#lastSignature) {
      // 内容没变：不重发，但保持 attention 基线一致。
      this.#rememberAttention(sessions);
      this.#dirty = false;
      return;
    }

    this.#lastSignature = signature;
    this.#rememberAttention(sessions);
    this.#stateVer += 1;
    const ver = this.#stateVer;
    this.#lastSentAt = this.#now();
    this.#dirty = false;

    for (const part of this.#splitState(ver, sessions)) {
      this.#send(MSG.SESSION_STATE, part);
    }
  }

  /** 拆分：贪心装片，parts 标签增长导致块数变化时迭代到自洽。 */
  #splitState(ver, sessions) {
    const maxBytes = this.#maxBytes();
    let parts = 1;
    let chunks = this.#packState(ver, parts, sessions, maxBytes);
    for (let guard = 0; guard <= sessions.length + 1 && chunks.length !== parts; guard += 1) {
      parts = chunks.length;
      chunks = this.#packState(ver, parts, sessions, maxBytes);
    }
    if (chunks.length !== parts) {
      // 极端兜底：标签与实际块数不一致时按实际块数重新标注，保证协议自洽。
      chunks = chunks.map((chunk, index) => ({
        ...chunk,
        part: index + 1,
        parts: chunks.length,
      }));
    }
    for (const chunk of chunks) {
      if (byteLength(JSON.stringify(chunk)) > maxBytes) {
        this.#log.warn(
          'session.state part %d/%d 超过 maxMessageBytes=%d：单条会话本身过大，无法再拆',
          chunk.part,
          chunk.parts,
          maxBytes,
        );
      }
    }
    return chunks;
  }

  #packState(ver, parts, sessions, maxBytes) {
    const chunks = [];
    let current = [];
    const fits = (list) =>
      byteLength(
        JSON.stringify({
          type: MSG.SESSION_STATE,
          ver,
          part: parts,
          parts,
          sessions: list,
        }),
      ) <= maxBytes;

    for (const session of sessions) {
      const candidate = [...current, session];
      if (current.length > 0 && !fits(candidate)) {
        chunks.push(current);
        current = [session];
      } else {
        current = candidate;
      }
    }
    if (current.length > 0) chunks.push(current);
    if (chunks.length === 0) chunks.push([]);

    return chunks.map((list, index) => ({
      type: MSG.SESSION_STATE,
      ver,
      part: index + 1,
      parts,
      sessions: list,
    }));
  }

  #shouldAlert(sessions) {
    return sessions.some((session) => {
      const next = session?.attention ?? ATTENTION.NONE;
      if (!ALERT_ATTENTIONS.has(next)) return false;
      const previous = this.#lastAttention.get(session?.id) ?? ATTENTION.NONE;
      return previous === ATTENTION.NONE;
    });
  }

  #rememberAttention(sessions) {
    this.#lastAttention.clear();
    for (const session of sessions) {
      this.#lastAttention.set(session?.id, session?.attention ?? ATTENTION.NONE);
    }
  }

  // -------------------------------------------------------------------------
  // session.result
  // -------------------------------------------------------------------------

  /** 一次性结果：不去重内容、不节流，只按 (sessionId,turnId) 保证只发一次。 */
  onSessionResult(result) {
    try {
      return this.#handleSessionResult(result);
    } catch (err) {
      this.#log.error('session.result 推送失败：%s', err?.stack ?? err);
      return false;
    }
  }

  #handleSessionResult(result) {
    if (
      !result ||
      typeof result.sessionId !== 'string' ||
      typeof result.turnId !== 'string'
    ) {
      this.#log.warn('session.result 缺少 sessionId/turnId，已丢弃');
      return false;
    }

    const key = `${result.sessionId}:${result.turnId}`;
    if (this.#sentResults.has(key)) return false;

    const ver = this.#resultVer + 1;
    const payload = this.#buildResultPayload(result, ver);
    this.#sentResults.add(key);
    this.#resultVer = ver;
    this.#send(MSG.SESSION_RESULT, payload);
    return true;
  }

  #buildResultPayload(result, ver) {
    const maxBytes = this.#maxBytes();
    const state = typeof result.state === 'string' ? result.state : 'done';
    const hostEpochSec = Number.isInteger(result.hostEpochSec)
      ? result.hostEpochSec
      : Math.floor(this.#now() / 1000);

    const payload = {
      type: MSG.SESSION_RESULT,
      sessionId: result.sessionId,
      ver,
      part: 1,
      parts: 1, // session.result 永不拆分（docs/03 §5.7）
      turnId: result.turnId,
      state,
      text: '',
      truncated: 0,
      elapsedMs: undefined,
      hostEpochSec,
    };
    if (Number.isFinite(result.elapsedMs) && result.elapsedMs >= 0) {
      payload.elapsedMs = result.elapsedMs;
    }
    if (payload.elapsedMs === undefined) delete payload.elapsedMs;

    const text = typeof result.text === 'string' ? result.text : String(result.text ?? '');
    const make = (candidate, truncated) => {
      const message = { ...payload, text: candidate, truncated };
      return JSON.stringify(message);
    };

    if (byteLength(make(text, 0)) <= maxBytes) {
      payload.text = text;
      return payload;
    }

    payload.truncated = 1;
    payload.text = truncateToBudget(
      Array.from(text),
      (candidate) => make(candidate, 1),
      maxBytes,
    );
    return payload;
  }

  // -------------------------------------------------------------------------
  // 断链 / 重连
  // -------------------------------------------------------------------------

  /** 断链：清计时器、ver 归零、清签名与 attention 基线；sentResults 保留。 */
  onDisconnected() {
    this.#cancelTimer();
    this.#dirty = true;
    this.#stateVer = 0;
    this.#resultVer = 0;
    this.#lastSignature = null;
    this.#lastAttention.clear();
    this.#lastSentAt = -Infinity;
    this.#forceFullSync = true;
  }

  /**
   * 重连 ready：只有存在未推送的变化（#dirty）或断链后强制全量时才重推。
   * 清签名是为了让「断链期间/首连前」攒下的状态一定发出去，而不是被去重。
   */
  onLinkReady() {
    this.#cancelTimer();
    if (!this.#dirty && !this.#forceFullSync) return;
    this.#forceFullSync = false;
    this.#lastSignature = null;
    this.#flushState(this.#snapshot());
  }

  // -------------------------------------------------------------------------
  // 工具
  // -------------------------------------------------------------------------

  #snapshot() {
    // 与 pull 的 session.list 共用同一份实现：两条路径的 sessions[] 必须一致。
    return buildSessions(this.#host?.sessions?.snapshot?.());
  }

  #maxBytes() {
    if (this.#maxMessageBytesOption !== null) return this.#maxMessageBytesOption;
    const declared = this.#link?.info?.maxPayload;
    if (Number.isInteger(declared) && declared > 0) {
      return Math.min(declared, MAX_MESSAGE_BYTES_CEILING);
    }
    return MAX_MESSAGE_BYTES_CEILING;
  }

  #send(type, payload) {
    try {
      const pending = this.#link.send(type, payload, { ack: true });
      if (pending && typeof pending.catch === 'function') {
        pending.catch((err) => {
          // 未 ready 时 Link 抛 NOT_CONNECTED：业务消息本就不该在此时发，
          // 吞掉并留日志，绝不能变成 unhandledRejection（t16 缺陷①）。
          this.#log.warn('%s 发送失败：%s', type, err?.message ?? err);
        });
      }
    } catch (err) {
      this.#log.warn('%s 发送失败：%s', type, err?.message ?? err);
    }
  }

  #cancelTimer() {
    if (this.#timer === null) return;
    this.#clearTimer(this.#timer);
    this.#timer = null;
  }
}
