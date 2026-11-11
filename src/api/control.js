// Task 23 · api/control.js
//
// 设备 → 主机的控制动作分发（docs/02 §4.4 / docs/04 Task 23）：
//
//   session.cancel   → 通知宿主停止会话 → 回 session.cancel.ack{reqId, ok}
//   session.input    → **唯一**需要设备→主机分片组装的路径（协议 §5.1.2）
//   approval.decide  → 交给 host.approvals（幂等 settle；迟到/未知静默忽略）
//   question.answer  → 交给 host.questions（同上）
//
// 两条容易写错的协议细节：
//   · session.input 的 ack **只在收齐 part === parts 后发一次**，中间片不回；
//     组装超时（10 秒）丢弃半成品且**不回 ack**——设备靠收不到 ack 判断要重发，
//     且重发必须换新 reqId。
//   · sessionId 必填，主机绝不猜（C2）；不存在的会话回 INPUT_NO_SUCH_SESSION，
//     让设备重新拉 session.list，而不是回退到"最近/当前"会话。

import { MSG } from '../wire/constants.js';

const DEFAULT_ASSEMBLY_TIMEOUT_MS = 10_000;

/**
 * 已投递结果的缓存上限（与 #expiredReqIds 的 64 条同量级）。
 * 设备只有在没收到 ack 时才会重传，正常重传窗口是秒级；64 条足以覆盖
 * 「刚投递完的若干 reqId 的 ack 丢失重传」，又不让内存随运行时间增长。
 */
const INPUT_RESULT_CACHE_LIMIT = 64;

const NOOP_LOG = Object.freeze({
  debug() {},
  info() {},
  warn() {},
  error() {},
});

function pickFunction(...candidates) {
  return candidates.find((candidate) => typeof candidate === 'function') ?? null;
}

function toPositiveInt(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) {
    const parsed = Number(value);
    return parsed > 0 ? parsed : null;
  }
  return null;
}

export class ControlCapability {
  /** ApiServer 依据该列表把四条上行消息路由到 handle()。 */
  types = [
    MSG.SESSION_CANCEL,
    MSG.SESSION_INPUT,
    MSG.APPROVAL_DECIDE,
    MSG.QUESTION_ANSWER,
  ];

  #link;
  #log;
  #host;
  #setTimer;
  #clearTimer;
  #assemblyTimeoutMs;

  /** @type {Map<string, object>} reqId → 设备→主机分片半成品 */
  #assemblies = new Map();

  /**
   * 已收齐、正在 await #deliverInput 的 reqId。「收齐」必须在 await 之前落地：
   * 投递可能挂起数百毫秒，期间设备因未收到 ack 会重传同一批分片；若此时
   * 重新开批就会二次投递（t39-A3）。命中该集合的片不重开批、不投递，
   * ack 由挂起中的投递完成后统一发一次。
   */
  #deliveringReqIds = new Set();

  /**
   * 已投递完成的 reqId → ack 结果（有界）。设备重传说明 ack 丢了，
   * 命中后原样重发同一条 ack，不能静默丢弃（否则设备重传到 10 秒超时）。
   * 容量见 INPUT_RESULT_CACHE_LIMIT 注释。
   */
  #deliveredInputs = new Map();
  #deliveredOrder = [];

  /**
   * 超时丢弃过的 reqId。设备重发必须换新 reqId；若复用旧 reqId，后续片直接丢弃，
   * 避免"超时后的残留片"与新批次混在一起（验收项 3）。
   */
  #expiredReqIds = new Set();
  #expiredOrder = [];

  #stats = {
    cancels: 0,
    inputs: 0,
    approvalDecides: 0,
    questionAnswers: 0,
    timeouts: 0,
    sendErrors: 0,
  };

  constructor({
    link,
    log,
    host,
    setTimer,
    clearTimer,
    assemblyTimeoutMs = DEFAULT_ASSEMBLY_TIMEOUT_MS,
  } = {}) {
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
    this.#assemblyTimeoutMs = assemblyTimeoutMs;
  }

  get stats() {
    return { ...this.#stats, pendingAssemblies: this.#assemblies.size };
  }

  get pendingAssemblies() {
    return this.#assemblies.size;
  }

  /**
   * ApiServer 的派发入口。返回 true 表示已处理（不会再落到 UNKNOWN_TYPE）。
   * 迟到/未知的 approval.decide / question.answer 也返回 true：主机的立场是
   * "静默忽略"，而不是给设备回一个错误包。
   */
  async handle(type, payload = {}) {
    switch (type) {
      case MSG.SESSION_CANCEL:
        await this.#handleCancel(payload ?? {});
        return true;
      case MSG.SESSION_INPUT:
        await this.#handleInput(payload ?? {});
        return true;
      case MSG.APPROVAL_DECIDE:
        this.#handleApprovalDecide(payload ?? {});
        return true;
      case MSG.QUESTION_ANSWER:
        this.#handleQuestionAnswer(payload ?? {});
        return true;
      default:
        return false;
    }
  }

  // -------------------------------------------------------------------------
  // session.cancel
  // -------------------------------------------------------------------------

  async #handleCancel(payload) {
    const reqId = typeof payload.reqId === 'string' ? payload.reqId : null;
    const sessionId = payload.sessionId;
    const sessions = this.#host?.sessions;

    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      await this.#ack(MSG.SESSION_CANCEL_ACK, {
        reqId,
        ok: false,
        code: 'CANCEL_NOT_FOUND',
        message: 'session.cancel 缺少 sessionId',
      });
      return;
    }

    if (sessions && typeof sessions.has === 'function' && !sessions.has(sessionId)) {
      await this.#ack(MSG.SESSION_CANCEL_ACK, {
        reqId,
        ok: false,
        code: 'CANCEL_NOT_FOUND',
        message: `会话不存在：${sessionId}`,
      });
      return;
    }

    const cancelFn = pickFunction(
      sessions?.cancel,
      sessions?.stop,
      this.#host?.cancelSession,
      this.#host?.cancel,
    );
    if (!cancelFn) {
      await this.#ack(MSG.SESSION_CANCEL_ACK, {
        reqId,
        ok: false,
        code: 'CANCEL_FAILED',
        message: '宿主没有提供取消会话的能力',
      });
      return;
    }

    try {
      const result = await cancelFn.call(sessions ?? this.#host, sessionId);
      if (result === false) {
        await this.#ack(MSG.SESSION_CANCEL_ACK, {
          reqId,
          ok: false,
          code: 'CANCEL_NOT_RUNNING',
          message: '该会话当前没有在执行',
        });
        return;
      }
      if (result && typeof result === 'object' && result.ok === false) {
        await this.#ack(MSG.SESSION_CANCEL_ACK, {
          reqId,
          ok: false,
          code: result.code ?? 'CANCEL_FAILED',
          message: result.message ?? '宿主拒绝取消会话',
        });
        return;
      }
      this.#stats.cancels += 1;
      await this.#ack(MSG.SESSION_CANCEL_ACK, { reqId, ok: true });
    } catch (err) {
      await this.#ack(MSG.SESSION_CANCEL_ACK, {
        reqId,
        ok: false,
        code: 'CANCEL_FAILED',
        message: err?.message ?? '取消会话失败',
      });
    }
  }

  // -------------------------------------------------------------------------
  // session.input（设备→主机唯一分片路径）
  // -------------------------------------------------------------------------

  async #handleInput(payload) {
    const reqId = payload.reqId;
    if (typeof reqId !== 'string' || reqId.length === 0) {
      await this.#ack(MSG.SESSION_INPUT_ACK, {
        reqId: null,
        ok: false,
        code: 'INPUT_FAILED',
        message: 'session.input 缺少 reqId',
      });
      return;
    }

    // 协议 §5.1.2：parts/part 必须显式下发（即使 parts=1 也要写全），接收方
    // 不替发送方补默认值——缺字段一律按非法分片拒绝，避免「单条消息少写 parts
    // 被当成 1 片」这种静默兼容在设备固件里生根。
    if (payload.parts === undefined || payload.part === undefined) {
      this.#warn(
        'session.input 缺少 part/parts（reqId=%s），按非法分片拒绝',
        reqId,
      );
      await this.#ack(MSG.SESSION_INPUT_ACK, {
        reqId,
        ok: false,
        code: 'INPUT_FAILED',
        message: '分片字段必须显式提供（part/parts）',
      });
      return;
    }

    const parts = toPositiveInt(payload.parts);
    const part = toPositiveInt(payload.part);
    if (!parts || !part || part > parts) {
      await this.#ack(MSG.SESSION_INPUT_ACK, {
        reqId,
        ok: false,
        code: 'INPUT_FAILED',
        message: '分片字段非法（part/parts）',
      });
      return;
    }

    let batch = this.#assemblies.get(reqId);

    // 超时过（或已被丢弃）的 reqId 一律不再接收：设备重发必须换新 reqId。
    if (this.#expiredReqIds.has(reqId)) {
      this.#warn('session.input 的 reqId 已超时作废（reqId=%s），丢弃该片', reqId);
      return;
    }

    // 已收齐、投递仍在进行：重传片只可能来自「设备还没收到 ack」。
    // 不得重新开批或二次投递；ack 由挂起中的投递完成后发一次。
    if (this.#deliveringReqIds.has(reqId)) return;

    // 已投递完成：重传说明 ack 丢了，原样重发同一条 ack（不投递）。
    // 只让**末片**触发重发：既有语义仍是「收齐后只回一次 ack」，设备重传
    // 整批时由最后一片拿回结果，中间片继续保持静默（集成用例 7 的约束）。
    const deliveredAck = this.#deliveredInputs.get(reqId);
    if (deliveredAck) {
      if (part === parts) await this.#ack(MSG.SESSION_INPUT_ACK, { reqId, ...deliveredAck });
      return;
    }

    // 没有批次时**任何 part** 都可以开批：验收要求"乱序到达仍能正确拼装"，
    // 因此 part=2 先到也要先存起来，等 part=1 补齐（不能像设备侧那样丢弃）。
    if (!batch) {
      batch = {
        reqId,
        sessionId: payload.sessionId,
        parts,
        texts: new Map(),
        timer: null,
      };
      this.#assemblies.set(reqId, batch);
      if (parts > 1) {
        batch.timer = this.#setTimer(() => this.#expireBatch(reqId), this.#assemblyTimeoutMs);
      }
    }

    if (batch.parts !== parts) {
      this.#warn('session.input 分片 parts 不一致（reqId=%s），丢弃该片', reqId);
      return;
    }
    if (typeof payload.sessionId === 'string' && batch.sessionId !== payload.sessionId) {
      this.#warn('session.input 分片 sessionId 不一致（reqId=%s），以首片为准', reqId);
    }
    if (batch.texts.has(part)) return; // 重复片：只保留一份
    batch.texts.set(part, typeof payload.text === 'string' ? payload.text : '');

    if (batch.texts.size < parts) return; // 中间片：**不回 ack**

    // 收齐：按 part 序号拼接。先删除批次并登记「投递中」，再 await 投递——
    // 这个顺序是 t39-A3 的修复点：收齐事实必须在挂起窗口之前落地。
    this.#assemblies.delete(reqId);
    this.#clearBatchTimer(batch);
    const text = Array.from({ length: parts }, (_, index) => batch.texts.get(index + 1) ?? '').join('');
    this.#deliveringReqIds.add(reqId);
    try {
      const result = await this.#deliverInput(batch.sessionId, text, reqId);
      // 先缓存结果再发 ack：ack 发送期间/之后到达的重传都能拿到同一结果。
      this.#rememberDeliveredInput(reqId, result);
      await this.#ack(MSG.SESSION_INPUT_ACK, { reqId, ...result });
    } finally {
      this.#deliveringReqIds.delete(reqId);
    }
  }

  #rememberDeliveredInput(reqId, result) {
    if (this.#deliveredInputs.has(reqId)) return;
    this.#deliveredInputs.set(reqId, result);
    this.#deliveredOrder.push(reqId);
    while (this.#deliveredOrder.length > INPUT_RESULT_CACHE_LIMIT) {
      this.#deliveredInputs.delete(this.#deliveredOrder.shift());
    }
  }

  #expireBatch(reqId) {
    const batch = this.#assemblies.get(reqId);
    if (!batch) return;
    this.#assemblies.delete(reqId);
    batch.timer = null;
    this.#stats.timeouts += 1;
    this.#expiredReqIds.add(reqId);
    this.#expiredOrder.push(reqId);
    while (this.#expiredOrder.length > 64) {
      this.#expiredReqIds.delete(this.#expiredOrder.shift());
    }
    // 关键：**不回 ack**。设备靠超时收不到 ack 判断需要换新 reqId 重发。
    this.#warn(
      'session.input 组装超时（reqId=%s，已收 %s/%s 片），丢弃半成品且不回 ack',
      reqId,
      batch.texts.size,
      batch.parts,
    );
  }

  async #deliverInput(sessionId, text, reqId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return {
        ok: false,
        code: 'INPUT_NO_SUCH_SESSION',
        message: 'session.input 缺少 sessionId',
      };
    }
    if (text.length === 0) {
      return { ok: false, code: 'INPUT_EMPTY_TEXT', message: 'text 为空串' };
    }

    const sessions = this.#host?.sessions;
    if (sessions && typeof sessions.has === 'function' && !sessions.has(sessionId)) {
      return {
        ok: false,
        code: 'INPUT_NO_SUCH_SESSION',
        message: `会话不存在：${sessionId}`,
      };
    }

    const deliverFn = pickFunction(
      sessions?.input,
      sessions?.appendInput,
      sessions?.deliverInput,
      this.#host?.input,
      this.#host?.sessionInput,
    );
    if (!deliverFn) {
      return {
        ok: false,
        code: 'INPUT_FAILED',
        message: '宿主没有提供向会话投递消息的能力',
      };
    }

    try {
      const result = await deliverFn.call(sessions ?? this.#host, { sessionId, text });
      if (result === false) {
        return { ok: false, code: 'INPUT_REJECTED', message: '宿主拒绝投递该消息' };
      }
      if (result && typeof result === 'object' && result.ok === false) {
        return {
          ok: false,
          code: result.code ?? 'INPUT_REJECTED',
          message: result.message ?? '宿主拒绝投递该消息',
        };
      }
      this.#stats.inputs += 1;
      return { ok: true };
    } catch (err) {
      return { ok: false, code: 'INPUT_FAILED', message: err?.message ?? '投递消息失败' };
    }
  }

  // -------------------------------------------------------------------------
  // approval.decide / question.answer
  // -------------------------------------------------------------------------

  #handleApprovalDecide(payload) {
    this.#stats.approvalDecides += 1;
    try {
      // 迟到/未知由 approvals 的幂等 settle 处理；这里不回报错、不回包。
      this.#host?.approvals?.onDeviceDecide?.(payload);
    } catch (err) {
      this.#warn('approval.decide 处理失败（已忽略）：%s', err?.message ?? err);
    }
  }

  #handleQuestionAnswer(payload) {
    this.#stats.questionAnswers += 1;
    try {
      this.#host?.questions?.onDeviceAnswer?.(payload);
    } catch (err) {
      this.#warn('question.answer 处理失败（已忽略）：%s', err?.message ?? err);
    }
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  async #ack(type, payload) {
    try {
      await this.#link.send(type, { type, ...payload }, { ack: false });
    } catch (err) {
      this.#stats.sendErrors += 1;
      this.#warn('%s 发送失败：%s', type, err?.message ?? err);
    }
  }

  #clearBatchTimer(batch) {
    if (!batch?.timer) return;
    try {
      this.#clearTimer(batch.timer);
    } catch {
      // 计时器清理失败不影响组装结果。
    }
    batch.timer = null;
  }


  #warn(...args) {
    this.#log?.warn?.(...args);
  }
}

export default ControlCapability;
