// Task 23 · host/questions.js
//
// 提问双端竞速（docs/02 §4.5 / docs/04 Task 23）。
//
// 与 approvals.js 的相同点：都是"先答者胜、落败方收 done"，共用 race()/settle()
// 两个辅助函数；不同点是审批是一次性裁决，提问是**整批作答 + 途中导航**：
//   · question.ask 整批一次下发（questions[] 在一条消息里），不逐题；
//   · question.nav / question.pick 只是设备 UI 交互，不结算；
//   · 只有 question.answer 才结算。
// 合并两个类会得到一个两边用例都不舒服的抽象，所以这里保持独立类。
//
// deadlineMs 的语义按协议：0 = 不超时（计划评审），> 0 到点结算 timeout。
// 断链时在途提问结算 cancelled、by:'disconnect'（验收项 9）。

import { MSG } from '../wire/constants.js';
import { EnvelopeSender } from '../wire/message-split.js';
import { claim, race } from './race.js';

// 竞速函数来自共享模块；继续对外导出，保持可注入签名不变。
export { race };

/**
 * 通用幂等结算：entry.settled 之后再次调用返回 false，不产生副作用。
 * 占坑本身交给共享的 claim()；本包装只负责域侧回调与 resolve。
 * `onSettled(final, entry)` 由具体域（审批/提问）提供，负责清计时器、发 done 等。
 */
export function settle(entry, final, onSettled) {
  if (!claim(entry, final)) return false;
  if (typeof onSettled === 'function') onSettled(final, entry);
  if (typeof entry.resolve === 'function') entry.resolve(final);
  return true;
}

function deferred() {
  let settled = false;
  let resolvePromise;
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    get settled() {
      return settled;
    },
    resolve(value) {
      if (settled) return false;
      settled = true;
      resolvePromise(value);
      return true;
    },
  };
}

const NOOP_LOG = Object.freeze({
  debug() {},
  info() {},
  warn() {},
  error() {},
});

/**
 * @param {object} deps
 * @param {object} deps.link       Link 实例（send/on）
 * @param {object} [deps.log]
 * @param {object} [deps.sessions] Sessions 实例（beginAttention/endAttention）
 * @param {Function} [deps.race]   竞速辅助函数（默认本模块的 race）
 * @param {Function} [deps.settle] 幂等结算辅助函数（默认本模块的 settle）
 * @param {Function} [deps.now]    时钟（测试注入）
 * @param {Function} [deps.setTimer]
 * @param {Function} [deps.clearTimer]
 */
export class Questions {
  #link;
  #log;
  #sessions;
  #race;
  #settle;
  #setTimer;
  #clearTimer;
  #sender;

  #seq = 0;
  /** @type {Map<string, object>} callId → 在途提问 */
  #pending = new Map();

  #stats = {
    asked: 0,
    answered: 0,
    cancelled: 0,
    timedOut: 0,
    lateAnswers: 0,
    uiEvents: 0,
    sendErrors: 0,
  };

  constructor({
    link,
    log,
    sessions,
    race: raceFn = race,
    settle: settleFn = settle,
    setTimer,
    clearTimer,
    maxMessageBytes,
  } = {}) {
    this.#link = link;
    this.#log = log ?? NOOP_LOG;
    this.#sessions = sessions;
    this.#sender = new EnvelopeSender({ link, log: this.#log, maxMessageBytes });
    this.#race = raceFn;
    this.#settle = settleFn;
    this.#setTimer =
      setTimer ??
      ((fn, ms) => {
        const timer = setTimeout(fn, ms);
        if (typeof timer.unref === 'function') timer.unref();
        return timer;
      });
    this.#clearTimer = clearTimer ?? ((timer) => clearTimeout(timer));
  }

  get stats() {
    return { ...this.#stats, inFlight: this.#pending.size };
  }

  get pendingCount() {
    return this.#pending.size;
  }

  /**
   * 拦截一次 DSH `user-questions/request`。
   *
   * 返回：
   *   · submit → `{ answers: [{ id, selected, custom }] }`
   *   · cancel / reject → `{ cancelled: true, reason: 'cancel'|'reject' }`
   *   · deadline 到点 → `{ cancelled: true, reason: 'timeout' }`
   *   · 断链 → `{ cancelled: true, reason: 'disconnect' }`
   *
   * 设备不在线时仍然挂起（由宿主自己的 deadline 或断链收尾）——本类不替
   * 宿主决定"没人可答"；是否向设备展示由上层注入决定。
   */
  async handle(request = {}) {
    const req = request ?? {};
    const callId =
      typeof req.callId === 'string' && req.callId.length > 0
        ? req.callId
        : `q_${++this.#seq}`;
    const sessionId =
      (typeof req.sessionId === 'string' && req.sessionId) ||
      (typeof req.session?.id === 'string' && req.session.id) ||
      null;
    const kind = req.kind === 'plan' ? 'plan' : 'choice';
    const deadlineMs = Number.isFinite(req.deadlineMs) ? Math.max(0, req.deadlineMs) : 0;

    const entry = {
      callId,
      sessionId,
      kind,
      deadlineMs,
      questions: this.#normalizeQuestions(req.questions ?? req.items ?? []),
      notified: false,
      doneSent: false,
      settled: false,
      deviceSettled: false,
      final: null,
      timer: null,
      resolve: null,
      deviceGate: deferred(),
      timeoutGate: deferred(),
      disconnectGate: deferred(),
    };
    this.#pending.set(callId, entry);

    // 先发问、再竞速；发送失败只告警，不阻止等待（断链/宿主 deadline 会收尾）。
    void this.#sendAsked(entry);
    if (deadlineMs > 0) {
      entry.timer = this.#setTimer(() => {
        entry.timeoutGate.resolve({
          outcome: 'timeout',
          by: 'timeout',
          result: { cancelled: true, reason: 'timeout' },
        });
      }, deadlineMs);
    }

    const winner = await this.#race([
      entry.deviceGate.promise,
      entry.timeoutGate.promise,
      entry.disconnectGate.promise,
    ]);
    return this.#finish(entry, winner);
  }

  /** server 分发表收到 question.answer 时调用。返回是否被接受（迟到 → false）。 */
  onDeviceAnswer(input = {}) {
    const callId = input?.callId;
    if (typeof callId !== 'string' || callId.length === 0) {
      this.#stats.lateAnswers += 1;
      return false;
    }

    const entry = this.#pending.get(callId);
    if (!entry || entry.settled || entry.deviceSettled) {
      this.#stats.lateAnswers += 1;
      return false;
    }

    const action = input.action ?? 'submit';
    if (action === 'cancel' || action === 'reject') {
      entry.deviceSettled = true;
      entry.deviceGate.resolve({
        outcome: 'cancelled',
        by: 'device',
        result: { cancelled: true, reason: action },
      });
      return true;
    }
    if (action !== 'submit') {
      this.#stats.lateAnswers += 1;
      this.#warn('无法识别的 question.answer action（callId=%s, action=%s），已忽略', callId, String(action));
      return false;
    }

    const answers = this.#normalizeAnswers(input.answers);
    entry.deviceSettled = true;
    entry.deviceGate.resolve({
      outcome: 'answered',
      by: 'device',
      result: { answers },
    });
    return true;
  }

  /**
   * question.nav / question.pick 只是设备侧导航交互，**不结算**。
   * 保留入口是为了让上层能显式喂入并断言"没有副作用"；返回 false 表示未结算。
   */
  onDeviceNav(nav = {}) {
    if (!this.#pending.has(nav.callId)) return false;
    this.#stats.uiEvents += 1;
    return false;
  }

  onDevicePick(pick = {}) {
    if (!this.#pending.has(pick.callId)) return false;
    this.#stats.uiEvents += 1;
    return false;
  }

  /** 断链：所有在途提问结算 cancelled / by:'disconnect'，并清 attention。 */
  onDisconnect() {
    for (const entry of [...this.#pending.values()]) {
      if (entry.settled || entry.deviceSettled) continue;
      entry.deviceSettled = true;
      entry.disconnectGate.resolve({
        outcome: 'cancelled',
        by: 'disconnect',
        result: { cancelled: true, reason: 'disconnect' },
      });
    }
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  async #sendAsked(entry) {
    try {
      await this.#sender.send(
        MSG.QUESTION_ASKED,
        {
          callId: entry.callId,
          kind: entry.kind,
          deadlineMs: entry.deadlineMs,
          questions: entry.questions,
        },
        { ack: true },
      );
    } catch (err) {
      this.#stats.sendErrors += 1;
      this.#log.error(
        'question.asked 拆分/发送失败（callId=%s，code=%s）：%s',
        entry.callId,
        err?.code ?? 'SEND_FAILED',
        err?.message ?? err,
      );
      // 设备看不到完整题目就不能让 handle 静默悬挂：按不可答结算，
      // 返回结果里带 reason='send-failed' 供宿主诊断（设备侧若收到过半片，
      // 会因收不齐在 10s 后自行丢弃，不会留下可点的卡片）。
      if (!entry.settled && !entry.deviceSettled) {
        entry.deviceSettled = true;
        entry.disconnectGate.resolve({
          outcome: 'cancelled',
          by: 'disconnect',
          result: { cancelled: true, reason: 'send-failed' },
        });
      }
      return;
    }

    entry.notified = true;
    this.#stats.asked += 1;
    this.#markAttention(entry, true);

    // 发送完成前可能已经被 timeout/断链结算：补一条 done，避免设备留死卡片。
    if (entry.settled && !entry.doneSent && entry.final) {
      entry.doneSent = true;
      await this.#sendDone(entry, entry.final.outcome, entry.final.by);
    }
  }

  #finish(entry, final) {
    const applied = this.#settle(entry, final, () => {
      this.#pending.delete(entry.callId);
      if (entry.timer) {
        this.#clearTimer(entry.timer);
        entry.timer = null;
      }
      if (final.outcome === 'answered') this.#stats.answered += 1;
      else if (final.outcome === 'timeout') this.#stats.timedOut += 1;
      else this.#stats.cancelled += 1;
      this.#markAttention(entry, false);
    });

    if (applied && entry.notified && !entry.doneSent) {
      entry.doneSent = true;
      void this.#sendDone(entry, final.outcome, final.by);
    }
    return final.result;
  }

  async #sendDone(entry, outcome, by) {
    try {
      await this.#link.send(
        MSG.QUESTION_DONE,
        { type: MSG.QUESTION_DONE, callId: entry.callId, outcome, by },
        { ack: true },
      );
    } catch (err) {
      this.#stats.sendErrors += 1;
      this.#warn('question.done 发送失败（callId=%s）：%s', entry.callId, err?.message ?? err);
    }
  }

  #normalizeQuestions(list) {
    if (!Array.isArray(list)) return [];
    return list
      .filter((item) => item && typeof item === 'object')
      .map((item, index) => {
        const out = {
          id: typeof item.id === 'string' && item.id ? item.id : `q${index + 1}`,
          question: typeof item.question === 'string'
            ? item.question
            : typeof item.text === 'string'
              ? item.text
              : '',
          multiSelect: item.multiSelect === true,
          custom: item.custom === true,
        };
        if (typeof item.detail === 'string') out.detail = item.detail;
        out.options = this.#normalizeOptions(item.options);
        return out;
      });
  }

  #normalizeOptions(options) {
    if (!Array.isArray(options)) return [];
    return options
      .map((option) => {
        if (typeof option === 'string') return { label: option };
        if (option && typeof option === 'object' && typeof option.label === 'string') {
          const out = { label: option.label };
          if (typeof option.description === 'string') out.description = option.description;
          return out;
        }
        return null;
      })
      .filter(Boolean);
  }

  #normalizeAnswers(answers) {
    if (!Array.isArray(answers)) return [];
    return answers
      .filter((answer) => answer && typeof answer === 'object' && typeof answer.id === 'string')
      .map((answer) => {
        const selected = Array.isArray(answer.selected)
          ? answer.selected.filter((value) => typeof value === 'string')
          : typeof answer.selected === 'string'
            ? [answer.selected]
            : [];
        return {
          id: answer.id,
          selected,
          custom: typeof answer.custom === 'string' ? answer.custom : null,
        };
      });
  }

  #markAttention(entry, on) {
    const sessions = this.#sessions;
    if (!sessions || !entry.sessionId) return;
    try {
      if (on) {
        if (typeof sessions.beginAttention === 'function') {
          sessions.beginAttention(entry.sessionId, 'question', entry.callId);
        } else if (typeof sessions.setAttention === 'function') {
          sessions.setAttention(entry.sessionId, 'question');
        }
      } else if (typeof sessions.endAttention === 'function') {
        sessions.endAttention(entry.sessionId, 'question', entry.callId);
      } else if (typeof sessions.setAttention === 'function') {
        sessions.setAttention(entry.sessionId, 'none');
      }
    } catch (err) {
      this.#warn('更新会话 attention 失败（%s）：%s', entry.sessionId, err?.message ?? err);
    }
  }


  #warn(...args) {
    this.#log?.warn?.(...args);
  }
}

export default Questions;
