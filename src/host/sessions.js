// 会话集合（docs/02 §4.5 / docs/04 Task 21）
//
// 职责：维护会话集合与主从关系，产出 session.state 全量快照的数据源。
//
// 三条 v1 事故对应的不变量：
//   1. role 由 parentSessionId 显式判定：有父 → sub，无父 → main。绝不按
//      「第一个跑起来的会话」猜主会话（多会话并发时那种推测必错）。
//   2. elapsedMs 的起点必须可靠；起点不可靠时整个字段省略，绝不填 0
//      （协议 §5.1：填 0 会让设备显示「已运行 0 秒」，而真实语义是「不知道」）。
//   3. emit('changed', { reason }) 区分 'content' 与 'elapsed'：push 层对
//      「只是秒数变了」和「内容真变了」的节流策略不同（docs/02 §5.1）。
//
// 计时器全部可注入（now / setTimer / clearTimer），测试用假时钟推进。
// done 保持 8 秒后自动转 idle 是协议 §5.1 的规定。

import { EventEmitter } from 'node:events';

const STATES = new Set(['idle', 'running', 'waiting', 'done', 'error']);
const ATTENTIONS = new Set(['none', 'approval', 'question']);
const ATTENTION_KINDS = new Set(['approval', 'question']);

/** 协议 §5.1：done 保持 8 秒后转 idle。 */
const DONE_HOLD_MS = 8_000;
/** elapsedMs 走秒的刷新周期；push 层还有 500ms 尾沿节流兜底。 */
const ELAPSED_TICK_MS = 1_000;

const NULL_LOGGER = { debug() {}, info() {}, warn() {}, error() {} };

/** 直接 setAttention 时使用的占位 token；与 begin/endAttention 的 token 共存。 */
const MANUAL_TOKEN = Symbol('manual-attention');

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

export class Sessions extends EventEmitter {
  #log;
  #now;
  #setTimer;
  #clearTimer;
  #doneHoldMs;
  #elapsedTickMs;

  /** id -> 内部会话记录（时间戳等不上线字段都在这里）。 */
  #sessions = new Map();
  /** id -> { approvals: Set, questions: Set }，用于 attention 挂起计数。 */
  #pending = new Map();
  /** id -> done→idle 计时器句柄。 */
  #doneTimers = new Map();
  /** elapsedMs 走秒计时器（全局一个，只在需要时存在）。 */
  #elapsedTimer = null;
  #disposed = false;

  constructor({
    log,
    now,
    setTimer,
    clearTimer,
    doneHoldMs = DONE_HOLD_MS,
    elapsedTickMs = ELAPSED_TICK_MS,
  } = {}) {
    super();
    this.#log = { ...NULL_LOGGER, ...(log ?? {}) };
    this.#now = typeof now === 'function' ? now : () => Date.now();
    this.#setTimer =
      typeof setTimer === 'function'
        ? setTimer
        : (fn, ms) => {
            const handle = setTimeout(fn, ms);
            handle.unref?.();
            return handle;
          };
    this.#clearTimer = typeof clearTimer === 'function' ? clearTimer : (id) => clearTimeout(id);
    this.#doneHoldMs = doneHoldMs;
    this.#elapsedTickMs = elapsedTickMs;
  }

  // -- 查询 ------------------------------------------------------------------

  get size() {
    return this.#sessions.size;
  }

  has(id) {
    return this.#sessions.has(id);
  }

  /** 单条会话的线上投影（副本）。未知 id 返回 undefined。 */
  get(id) {
    const session = this.#sessions.get(id);
    return session ? this.#toWire(session) : undefined;
  }

  /** session.state 的全量快照。每次构造新对象，调用方改不到内部。 */
  snapshot() {
    return { sessions: [...this.#sessions.values()].map((session) => this.#toWire(session)) };
  }

  // -- 写入 ------------------------------------------------------------------

  /**
   * 更新或新增会话。
   *
   * patch 支持的字段：parentSessionId（null/undefined 表示主会话）、state、
   * title、model、cwd、startedAt（毫秒时间戳；null 显式表示起点不可靠）。
   * 不认识的字段忽略（DSH 事件里字段很多，宿主层只取自己需要的）。
   */
  upsert(id, patch = {}) {
    this.#assertAlive();
    this.#assertId(id);
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new TypeError(`upsert(${id}) 的 patch 必须是对象`);
    }

    const existed = this.#sessions.has(id);
    let session = this.#sessions.get(id);
    if (!session) {
      session = {
        id,
        role: 'main',
        parentId: undefined,
        state: 'idle',
        title: '',
        model: undefined,
        cwd: undefined,
        startedAt: null,
        finishedAt: null,
        attention: 'none',
      };
      this.#sessions.set(id, session);
      this.#pending.set(id, { approvals: new Set(), questions: new Set() });
    }

    // 新会话一定会广播 content（before 用 null 哨兵表示「此前不存在」）。
    const before = existed ? this.#signature(session) : null;

    if (hasOwn(patch, 'parentSessionId')) {
      this.#applyParent(session, patch.parentSessionId);
    }
    if (hasOwn(patch, 'state')) {
      this.#assertState(patch.state);
      if (patch.state !== session.state) {
        const previous = session.state;
        session.state = patch.state;
        this.#onStateChanged(session, previous, { wasNew: !existed });
      }
    }
    if (hasOwn(patch, 'startedAt')) {
      this.#applyStartedAt(session, patch.startedAt);
    }
    if (hasOwn(patch, 'title')) {
      if (typeof patch.title !== 'string') throw new TypeError('title 必须是字符串');
      session.title = patch.title;
    }
    if (hasOwn(patch, 'model')) {
      session.model = this.#optionalString(patch.model, 'model');
    }
    if (hasOwn(patch, 'cwd')) {
      session.cwd = this.#optionalString(patch.cwd, 'cwd');
    }

    if (this.#signature(session) !== before) {
      this.#emitChanged('content');
    }
    this.#syncElapsedTicker();
    return this.#toWire(session);
  }

  /** 删除会话。存在返回 true 并广播 content；未知 id 返回 false。 */
  remove(id) {
    this.#assertAlive();
    this.#assertId(id);
    if (!this.#sessions.has(id)) return false;
    this.#clearDoneTimer(id);
    this.#sessions.delete(id);
    this.#pending.delete(id);
    this.#syncElapsedTicker();
    this.#emitChanged('content');
    return true;
  }

  /**
   * 直接设置 attention。'none' 会清空该会话的全部挂起项（审批/提问），
   * 非 none 会清空后只留一个 manual token。返回值：会话是否存在。
   */
  setAttention(id, value) {
    this.#assertAlive();
    this.#assertId(id);
    this.#assertAttention(value);
    const session = this.#sessions.get(id);
    if (!session) {
      this.#log.warn('setAttention：会话不存在 %s', id);
      return false;
    }
    const pending = this.#pending.get(id);
    pending.approvals.clear();
    pending.questions.clear();
    if (value !== 'none') {
      const bucket = value === 'approval' ? pending.approvals : pending.questions;
      bucket.add(MANUAL_TOKEN);
    }
    this.#applyAttention(session);
    return true;
  }

  /**
   * 登记一个在途审批/提问。token 由调用方生成（如 requestId），同一 token
   * 重复登记幂等。多个挂起项并存时 question 优先于 approval：提问要用户
   * 整批作答，审批可能被电脑端抢先答掉，先保住 device 上的提问提醒。
   */
  beginAttention(id, kind, token = kind) {
    this.#assertAlive();
    this.#assertId(id);
    this.#assertKind(kind);
    const session = this.#sessions.get(id);
    if (!session) {
      this.#log.warn('beginAttention：会话不存在 %s', id);
      return false;
    }
    const bucket = kind === 'approval'
      ? this.#pending.get(id).approvals
      : this.#pending.get(id).questions;
    bucket.add(token);
    this.#applyAttention(session);
    return true;
  }

  /** 结算一个在途审批/提问；token 不存在时幂等无副作用。 */
  endAttention(id, kind, token = kind) {
    this.#assertAlive();
    this.#assertId(id);
    this.#assertKind(kind);
    const session = this.#sessions.get(id);
    if (!session) {
      this.#log.warn('endAttention：会话不存在 %s', id);
      return false;
    }
    const bucket = kind === 'approval'
      ? this.#pending.get(id).approvals
      : this.#pending.get(id).questions;
    bucket.delete(token);
    this.#applyAttention(session);
    return true;
  }

  /** 清理全部计时器与监听器；dispose 之后计时回调不再触发。 */
  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const id of [...this.#doneTimers.keys()]) this.#clearDoneTimer(id);
    if (this.#elapsedTimer !== null) {
      this.#clearTimer(this.#elapsedTimer);
      this.#elapsedTimer = null;
    }
    this.removeAllListeners();
  }

  // -- 内部：字段 ------------------------------------------------------------

  #applyParent(session, parentSessionId) {
    if (parentSessionId === null || parentSessionId === undefined) {
      session.parentId = undefined;
      session.role = 'main';
      return;
    }
    if (typeof parentSessionId !== 'string' || parentSessionId.length === 0) {
      throw new TypeError('parentSessionId 必须是非空字符串或 null');
    }
    if (parentSessionId === session.id) {
      throw new TypeError('parentSessionId 不能指向自己');
    }
    session.parentId = parentSessionId;
    session.role = 'sub';
  }

  #applyStartedAt(session, startedAt) {
    if (startedAt === null) {
      session.startedAt = null;
      session.finishedAt = null;
      return;
    }
    if (!Number.isFinite(startedAt)) {
      throw new TypeError('startedAt 必须是有限数字或 null');
    }
    session.startedAt = startedAt;
    if (session.state === 'running' || session.state === 'waiting') {
      session.finishedAt = null;
    }
  }

  #optionalString(value, field) {
    if (value === null || value === undefined || value === '') return undefined;
    if (typeof value !== 'string') throw new TypeError(`${field} 必须是字符串或省略`);
    return value;
  }

  // -- 内部：状态流转 --------------------------------------------------------

  #onStateChanged(session, previous, { wasNew = false } = {}) {
    switch (session.state) {
      case 'running': {
        if (wasNew) {
          // 首次见到会话就已经在跑：起点不可靠，保持 null（elapsedMs 省略）。
          session.startedAt = null;
        } else if (previous === 'done' || previous === 'error' || previous === 'idle') {
          // done/error/idle 之后重新跑起来 = 新一轮，从此刻重新计时。
          session.startedAt = this.#now();
        }
        // running → running / waiting → running：同一轮，保留已有起点
        // （若起点本来未知则继续保持 null，不凭空造一个）。
        session.finishedAt = null;
        this.#clearDoneTimer(session.id);
        break;
      }
      case 'waiting': {
        // waiting 仍是同一轮在跑：保留已有时长；从非运行态进来则起点未知。
        if (previous !== 'running' && previous !== 'waiting') {
          session.startedAt = null;
          session.finishedAt = null;
        }
        this.#clearDoneTimer(session.id);
        break;
      }
      case 'done': {
        session.finishedAt = session.startedAt == null ? null : this.#now();
        this.#scheduleDoneTimer(session);
        break;
      }
      case 'error': {
        session.finishedAt = session.startedAt == null ? null : this.#now();
        this.#clearDoneTimer(session.id);
        break;
      }
      case 'idle':
      default: {
        session.startedAt = null;
        session.finishedAt = null;
        this.#clearDoneTimer(session.id);
        break;
      }
    }
  }

  #scheduleDoneTimer(session) {
    this.#clearDoneTimer(session.id);
    const id = session.id;
    const handle = this.#setTimer(() => {
      this.#doneTimers.delete(id);
      if (this.#disposed) return;
      const current = this.#sessions.get(id);
      if (!current || current.state !== 'done') return;
      current.state = 'idle';
      current.startedAt = null;
      current.finishedAt = null;
      this.#syncElapsedTicker();
      this.#emitChanged('content');
    }, this.#doneHoldMs);
    this.#doneTimers.set(id, handle);
  }

  #clearDoneTimer(id) {
    const handle = this.#doneTimers.get(id);
    if (handle === undefined) return;
    this.#doneTimers.delete(id);
    this.#clearTimer(handle);
  }

  // -- 内部：attention -------------------------------------------------------

  #applyAttention(session) {
    const pending = this.#pending.get(session.id);
    const next = pending.questions.size > 0
      ? 'question'
      : pending.approvals.size > 0
        ? 'approval'
        : 'none';
    if (next === session.attention) return;
    session.attention = next;
    this.#emitChanged('content');
  }

  // -- 内部：elapsedMs -------------------------------------------------------

  #elapsedOf(session) {
    if (session.startedAt == null) return undefined;
    const end = session.finishedAt ?? this.#now();
    return Math.max(0, Math.floor(end - session.startedAt));
  }

  #needsElapsedTicker() {
    for (const session of this.#sessions.values()) {
      if (session.startedAt == null) continue;
      if (session.state === 'running' || session.state === 'waiting') return true;
    }
    return false;
  }

  #syncElapsedTicker() {
    if (this.#disposed) return;
    if (!this.#needsElapsedTicker()) {
      if (this.#elapsedTimer !== null) {
        this.#clearTimer(this.#elapsedTimer);
        this.#elapsedTimer = null;
      }
      return;
    }
    if (this.#elapsedTimer === null) this.#scheduleElapsedTick();
  }

  #scheduleElapsedTick() {
    this.#elapsedTimer = this.#setTimer(() => {
      this.#elapsedTimer = null;
      if (this.#disposed) return;
      if (!this.#needsElapsedTicker()) return;
      // 只走秒：内容字段没有任何变化，push 层据此走普通节流。
      this.#emitChanged('elapsed');
      this.#scheduleElapsedTick();
    }, this.#elapsedTickMs);
  }

  // -- 内部：投影与广播 ------------------------------------------------------

  #toWire(session) {
    const wire = { id: session.id, role: session.role };
    if (session.parentId !== undefined) wire.parentId = session.parentId;
    wire.state = session.state;
    wire.title = session.title;
    if (session.model !== undefined) wire.model = session.model;
    if (session.cwd !== undefined) wire.cwd = session.cwd;
    const elapsedMs = this.#elapsedOf(session);
    if (elapsedMs !== undefined) wire.elapsedMs = elapsedMs;
    wire.attention = session.attention;
    return wire;
  }

  /** 内容签名：只覆盖对外字段与计时起点，不覆盖会随时间自然变化的 elapsedMs。 */
  #signature(session) {
    return JSON.stringify([
      session.id,
      session.role,
      session.parentId ?? null,
      session.state,
      session.title,
      session.model ?? null,
      session.cwd ?? null,
      session.startedAt,
      session.finishedAt,
      session.attention,
    ]);
  }

  #emitChanged(reason) {
    this.emit('changed', { reason });
  }

  // -- 内部：校验 ------------------------------------------------------------

  #assertId(id) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new TypeError('会话 id 必须是非空字符串');
    }
  }

  #assertState(state) {
    if (!STATES.has(state)) {
      throw new TypeError(`非法会话状态：${String(state)}`);
    }
  }

  #assertAttention(value) {
    if (!ATTENTIONS.has(value)) {
      throw new TypeError(`非法 attention：${String(value)}`);
    }
  }

  #assertKind(kind) {
    if (!ATTENTION_KINDS.has(kind)) {
      throw new TypeError(`非法 attention 类型：${String(kind)}`);
    }
  }

  #assertAlive() {
    if (this.#disposed) throw new Error('Sessions 已 dispose');
  }
}
