// Task 22 · host/approvals.js
//
// 审批双端竞速（docs/02 §5.2 / docs/04 Task 22）。
//
// 三条不可动摇的规则（v1 真实事故换来的）：
//   1. 电脑分支**无条件**启动。设备是否在线只决定要不要多通知一个设备，
//      绝不能反过来抑制电脑侧卡片——否则设备不在身边时审批永久悬挂。
//   2. 落败方必须收到 approval.done，否则设备上会留一张永远点不动的死卡片。
//   3. 主机不设审批超时。timeoutMs 只是给设备的展示建议，0 表示一直显示。
//
// 竞速的另一半语义：设备先答 → abort 电脑卡片；电脑先答 → done 让设备收起。
// 断链只结算设备侧（cancelled / decidedBy:'disconnect'），**不 abort 电脑分支**：
// 用户仍然可以在电脑上完成这次审批。

import { MSG, APPROVAL_OUTCOME, DECIDED_BY } from '../wire/constants.js';
import { EnvelopeSender } from '../wire/message-split.js';
import { claim } from './race.js';

const OUTCOMES = new Set(Object.values(APPROVAL_OUTCOME));
const SCOPES = new Set(['all', 'write-only', 'none']);

const ALWAYS_ALLOW_WARN =
  '设备请求「总是允许」，但 DSH 的 ApprovalOutcome 只有 allowed-once；' +
  '本次落 allowed-once，不创建持久授权（grants apply only to the requested action）';

/**
 * 把一个值转成 `{ promise, resolve }`——resolve 只生效一次，重复调用返回 false。
 */
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

/** 兼容 `{ outcome }` / `{ decision }` / `{ approved }` 等宿主返回形状。 */
function normalizeOutcome(value) {
  if (typeof value === 'string') {
    if (value === APPROVAL_OUTCOME.TIMEOUT || value === 'abort') {
      return APPROVAL_OUTCOME.CANCELLED;
    }
    if (value === 'always' || value === 'always-allow' || value === 'alwaysAllow') {
      return APPROVAL_OUTCOME.ALLOWED_ONCE;
    }
    return OUTCOMES.has(value) ? value : APPROVAL_OUTCOME.UNAVAILABLE;
  }
  if (value && typeof value === 'object') {
    if (typeof value.outcome === 'string') return normalizeOutcome(value.outcome);
    if (value.approved === true) return APPROVAL_OUTCOME.ALLOWED_ONCE;
    if (value.approved === false) return APPROVAL_OUTCOME.REJECTED;
    if (value.decision === 'allow' || value.decision === 'allowed' || value.decision === 'approve') {
      return APPROVAL_OUTCOME.ALLOWED_ONCE;
    }
    if (value.decision === 'deny' || value.decision === 'denied' || value.decision === 'reject') {
      return APPROVAL_OUTCOME.REJECTED;
    }
  }
  return APPROVAL_OUTCOME.UNAVAILABLE;
}

/** 设备 decision 字符串 → 主机 outcome；always-allow 只落一次授权。 */
function decisionOutcome(decision) {
  if (typeof decision !== 'string') return null;
  switch (decision) {
    case 'allow':
    case 'allowed':
    case 'approve':
    case 'allowed-once':
      return { outcome: APPROVAL_OUTCOME.ALLOWED_ONCE, warn: false };
    case 'deny':
    case 'denied':
    case 'reject':
    case 'rejected':
      return { outcome: APPROVAL_OUTCOME.REJECTED, warn: false };
    case 'always':
    case 'always-allow':
    case 'alwaysAllow':
      return { outcome: APPROVAL_OUTCOME.ALLOWED_ONCE, warn: true };
    case 'cancel':
    case 'cancelled':
      return { outcome: APPROVAL_OUTCOME.CANCELLED, warn: false };
    default:
      return null;
  }
}

export class Approvals {
  #link;
  #log;
  #config;
  #sessions;

  #seq = 0;
  /** @type {Map<string, object>} 在途审批 */
  #pending = new Map();

  #stats = {
    asked: 0,
    allowed: 0,
    rejected: 0,
    cancelled: 0,
    unavailable: 0,
    deviceWins: 0,
    pcWins: 0,
    lateDecisions: 0,
    sendErrors: 0,
  };

  #scopeWarned = false;
  #pcMissingWarned = false;
  #sender;

  constructor({ link, log, config = {}, sessions, maxMessageBytes } = {}) {
    this.#link = link;
    this.#log = log;
    this.#config = config ?? {};
    this.#sessions = sessions;
    this.#sender = new EnvelopeSender({ link, log, maxMessageBytes });
  }

  get stats() {
    return { ...this.#stats, inFlight: this.#pending.size };
  }

  get pendingCount() {
    return this.#pending.size;
  }

  // -------------------------------------------------------------------------
  // DSH 侧入口
  // -------------------------------------------------------------------------

  /**
   * 拦截一次 DSH approval/request。
   *
   * @param {object} request DSH 的审批请求（toolName/reason/readOnly/timeoutMs/...）
   * @param {Function} [runPc] 电脑分支执行器；也可以在 config.pcBranch / request.pc 里注入。
   *   调用形状 `runPc(request, { signal, approvalId })`；signal abort 表示设备已先答，
   *   电脑卡片应收起。
   * @returns {Promise<'allowed-once'|'rejected'|'cancelled'|'unavailable'>}
   */
  async handle(request = {}, runPc) {
    const req = request ?? {};
    const entry = this.#createEntry(req);
    this.#pending.set(entry.id, entry);

    // 宿主主动中止（req.signal）：审批结算 cancelled，并让设备收起卡片。
    // 审批的生死由 DSH 宿主决定，主机自己不设超时。
    this.#watchAbort(entry);

    // ① 电脑分支无条件启动：先把 promise 挂上，不看设备是否在线。
    //    没有注入 runPc 时不能立刻落 unavailable——那会抢在设备作答之前结算
    //    （设备明明在线却永远没机会）。这时明确退化为「仅设备可答」：
    //    设备合格就等设备/断链/abort；设备也不合格才无可等待，立即 unavailable。
    const pcRunner = this.#resolvePcRunner(req, runPc);
    const deviceEligible = this.#deviceEligible(entry);
    if (!pcRunner && !this.#pcMissingWarned) {
      this.#pcMissingWarned = true;
      this.#warn(
        '审批未提供电脑分支 runPc：降级为「仅设备可答」；设备不可用时将直接返回 unavailable',
      );
    }
    const pcRace = pcRunner
      ? Promise.resolve()
          .then(() => pcRunner(req, { signal: entry.abort.signal, approvalId: entry.id }))
          .then(
            (value) => ({ source: 'pc', outcome: normalizeOutcome(value) }),
            (err) => {
              this.#warn('电脑分支审批失败，按 unavailable 处理（id=%s）：%s', entry.id, err?.message ?? err);
              return { source: 'pc', outcome: APPROVAL_OUTCOME.UNAVAILABLE };
            },
          )
      : deviceEligible
        ? new Promise(() => {})
        : Promise.resolve({ source: 'pc', outcome: APPROVAL_OUTCOME.UNAVAILABLE });

    // ② 设备合格才通知；deviceEligible 只决定"要不要问设备"，不影响上面的 PC 分支。
    //    已经中止的审批不必再打扰设备。
    const deviceRace =
      !entry.abortGate.settled && deviceEligible ? this.#askDevice(entry) : null;

    // ③ 竞速。设备分支因断链被 resolve 时不作为最终结果，继续等电脑分支；
    //    宿主 abort 则立即以 cancelled 结算。没有电脑分支时断链本身就是终局
    //    （设备已收到 cancelled），不能傻等一个永远不会 resolve 的 pcRace。
    let winner = await Promise.race([pcRace, deviceRace ?? new Promise(() => {}), entry.abortGate.promise]);
    if (winner.source === 'device' && winner.disconnect && pcRunner) {
      winner = await pcRace;
    }

    const decidedBy =
      winner.source === 'device'
        ? DECIDED_BY.DEVICE
        : winner.source === 'abort'
          ? DECIDED_BY.ABORT
          : DECIDED_BY.PC;
    await this.#settle(entry, winner.outcome, decidedBy);
    return winner.outcome;
  }

  /** server 分发表收到 approval.decide 时调用。返回是否被接受（迟到/未知 → false）。 */
  onDeviceDecide(input = {}) {
    const id = input?.id ?? input?.approvalId;
    if (typeof id !== 'string' || id.length === 0) {
      this.#stats.lateDecisions += 1;
      return false;
    }

    const entry = this.#pending.get(id);
    if (!entry || entry.settled || entry.deviceSettled || !entry.deviceResolve) {
      this.#stats.lateDecisions += 1;
      return false;
    }

    const mapped = decisionOutcome(input.decision);
    if (!mapped) {
      this.#stats.lateDecisions += 1;
      this.#warn('设备裁决无法识别（id=%s, decision=%s），已忽略', id, String(input.decision));
      return false;
    }
    if (mapped.warn) this.#warn(ALWAYS_ALLOW_WARN);

    entry.deviceResolve.resolve({ source: 'device', outcome: mapped.outcome });
    entry.deviceResolve = null;
    return true;
  }

  /**
   * 断链清理：只结算设备侧。
   * 电脑分支继续跑——用户仍可在电脑上完成这次审批。
   */
  onDisconnect() {
    for (const entry of [...this.#pending.values()]) {
      if (entry.settled) continue;

      // 标记为"设备侧已放弃"，此后迟到的 approval.decide 一律忽略。
      entry.deviceSettled = true;

      if (entry.notified && !entry.doneSent) {
        entry.doneSent = true;
        // 断链时 link 可能已经不可用；sendDone 内部吞掉错误并记 warn。
        void this.#sendDone(entry, APPROVAL_OUTCOME.CANCELLED, DECIDED_BY.DISCONNECT);
        entry.notified = false;
      }
      this.#clearAttention(entry);

      if (entry.deviceResolve) {
        entry.deviceResolve.resolve({
          source: 'device',
          outcome: APPROVAL_OUTCOME.CANCELLED,
          disconnect: true,
        });
        entry.deviceResolve = null;
      }
    }
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  #createEntry(req) {
    const toolName =
      req.toolName ?? req.tool?.name ?? (typeof req.tool === 'string' ? req.tool : undefined) ?? req.name ?? 'unknown';
    const sessionId =
      req.sessionId ?? req.session_id ?? req.session?.id ?? req.session?.sessionId ?? null;
    const readOnly = this.#isReadOnly(req);
    const reason = req.displayReason ?? req.reason ?? req.description;
    const detail = req.detail ?? req.arguments ?? req.args;

    return {
      id: `ap_${++this.#seq}`,
      toolName: typeof toolName === 'string' ? toolName : 'unknown',
      sessionId: typeof sessionId === 'string' ? sessionId : null,
      risk: readOnly ? 'low' : 'high',
      timeoutMs: this.#timeoutMs(req),
      callId: req.callId,
      reason: typeof reason === 'string' ? reason : undefined,
      detail: detail === undefined || detail === null ? undefined : detail,
      request: req,
      abort: new AbortController(),
      abortGate: deferred(),
      signal: req.signal,
      detachAbort: null,
      settled: false,
      deviceSettled: false,
      notified: false,
      doneSent: false,
      deviceResolve: null,
      final: null,
    };
  }

  /**
   * 监听宿主 `req.signal` 的中止。中止意味着宿主已经不再需要这次裁决：
   * 结算 cancelled，abort 电脑卡片，并通知设备收起。
   */
  #watchAbort(entry) {
    const signal = entry.signal;
    if (!signal || typeof signal.addEventListener !== 'function') return;

    const fire = () => {
      entry.abortGate.resolve({ source: 'abort', outcome: APPROVAL_OUTCOME.CANCELLED });
    };

    if (signal.aborted) {
      fire();
      return;
    }
    signal.addEventListener('abort', fire, { once: true });
    entry.detachAbort = () => signal.removeEventListener('abort', fire);
  }

  #askedPayload(entry) {
    const payload = {
      type: MSG.APPROVAL_ASKED,
      id: entry.id,
      toolName: entry.toolName,
      risk: entry.risk,
      timeoutMs: entry.timeoutMs,
    };
    if (entry.reason !== undefined) {
      payload.reason = entry.reason;
      payload.displayReason = entry.reason;
    }
    if (entry.detail !== undefined) payload.detail = entry.detail;
    if (entry.callId !== undefined) payload.callId = entry.callId;
    return payload;
  }

  /**
   * 通知设备并返回一个只在设备裁决时才会 resolve 的 promise。
   * 发送失败时此 promise 永远 pending —— 电脑分支照样能完成审批。
   */
  #askDevice(entry) {
    const gate = deferred();
    entry.deviceResolve = gate;

    void (async () => {
      try {
        await this.#sender.send(MSG.APPROVAL_ASKED, this.#askedPayload(entry), { ack: true });
      } catch (err) {
        entry.notified = false;
        entry.sendFailed = true;
        this.#stats.sendErrors += 1;
        this.#log.error(
          'approval.asked 拆分/发送失败（id=%s，code=%s）：%s',
          entry.id,
          err?.code ?? 'SEND_FAILED',
          err?.message ?? err,
        );
        // 设备没收到完整卡片，不可能再作答；让竞速退回电脑分支（若有），
        // 否则按 cancelled 结算，不能挂着一个永远等不到的 gate。
        gate.resolve({
          source: 'device',
          outcome: APPROVAL_OUTCOME.CANCELLED,
          disconnect: true,
          sendFailed: true,
        });
        return;
      }

      entry.notified = true;
      this.#stats.asked += 1;
      this.#markAttention(entry, true);

      // 卡片刚送达时审批可能已经被电脑抢先答完，或设备中途断链：
      // 必须补一条 done，否则设备上会留下点不动的死卡片。
      if (entry.settled) {
        if (!entry.doneSent && entry.final) {
          entry.doneSent = true;
          await this.#sendDone(entry, entry.final.outcome, entry.final.decidedBy);
        }
      } else if (entry.deviceSettled && !entry.doneSent) {
        entry.doneSent = true;
        await this.#sendDone(entry, APPROVAL_OUTCOME.CANCELLED, DECIDED_BY.DISCONNECT);
      }
    })();

    return gate.promise;
  }

  /** 幂等结算；返回 false 表示这次结算无效（已经被人抢先了）。 */
  async #settle(entry, outcome, decidedBy) {
    if (!claim(entry, { outcome, decidedBy })) return false;
    this.#pending.delete(entry.id);
    try {
      entry.detachAbort?.();
    } catch {
      // 清理监听器失败不影响结算。
    }
    entry.detachAbort = null;

    if (decidedBy === DECIDED_BY.DEVICE || decidedBy === DECIDED_BY.ABORT) {
      // 设备先答 / 宿主中止，让电脑卡片收起。
      try {
        entry.abort.abort();
      } catch {
        // AbortController.abort 不会抛；保留防御。
      }
    }

    this.#clearAttention(entry);
    this.#countOutcome(outcome, decidedBy);

    if (entry.notified && !entry.doneSent) {
      entry.doneSent = true;
      await this.#sendDone(entry, outcome, decidedBy);
    }
    return true;
  }

  async #sendDone(entry, outcome, decidedBy) {
    try {
      await this.#link.send(
        MSG.APPROVAL_DONE,
        { type: MSG.APPROVAL_DONE, id: entry.id, outcome, decidedBy },
        { ack: true },
      );
    } catch (err) {
      this.#stats.sendErrors += 1;
      this.#warn('approval.done 发送失败（id=%s）：%s', entry.id, err?.message ?? err);
    }
  }

  #countOutcome(outcome, decidedBy) {
    if (outcome === APPROVAL_OUTCOME.ALLOWED_ONCE) this.#stats.allowed += 1;
    else if (outcome === APPROVAL_OUTCOME.REJECTED) this.#stats.rejected += 1;
    else if (outcome === APPROVAL_OUTCOME.CANCELLED) this.#stats.cancelled += 1;
    else this.#stats.unavailable += 1;

    if (decidedBy === DECIDED_BY.DEVICE) this.#stats.deviceWins += 1;
    else if (decidedBy === DECIDED_BY.PC) this.#stats.pcWins += 1;
  }

  #resolvePcRunner(req, runPc) {
    const approvalConfig = this.#approvalConfig();
    const candidates = [
      runPc,
      req.pcBranch,
      req.pc,
      req.next,
      req.runPc,
      this.#config.pcBranch,
      this.#config.pcApproval,
      this.#config.pc,
      approvalConfig.pcBranch,
      approvalConfig.pc,
      approvalConfig.pcApproval,
    ];
    return candidates.find((candidate) => typeof candidate === 'function') ?? null;
  }

  #deviceEligible(entry) {
    const scope = this.#scope();
    if (scope === 'none') return false;
    if (scope === 'write-only' && entry.risk === 'low') return false;

    const ready = this.#link?.ready;
    if (ready !== true) return false;

    const paired = this.#link?.info?.paired;
    return paired === true || paired === 1;
  }

  #approvalConfig() {
    if (this.#config && typeof this.#config === 'object' && this.#config.approval) {
      return this.#config.approval;
    }
    return this.#config ?? {};
  }

  #scope() {
    const raw = this.#approvalConfig().deviceToolScope ?? this.#config?.deviceToolScope ?? 'all';
    if (typeof raw === 'string' && SCOPES.has(raw)) return raw;

    if (typeof raw === 'boolean') {
      if (!this.#scopeWarned) {
        this.#scopeWarned = true;
        this.#warn('approval.deviceToolScope 应该是 "all"/"write-only"/"none"，收到布尔值 %s；按 %s 处理', raw, raw ? 'all' : 'none');
      }
      return raw ? 'all' : 'none';
    }

    if (!this.#scopeWarned) {
      this.#scopeWarned = true;
      this.#warn('approval.deviceToolScope 取值非法（%s），按 "all" 处理', String(raw));
    }
    return 'all';
  }

  #timeoutMs(req) {
    if (Number.isFinite(req.timeoutMs)) return req.timeoutMs;
    const configured = this.#approvalConfig().timeoutMs ?? this.#config?.timeoutMs;
    return Number.isFinite(configured) ? configured : 0;
  }

  #isReadOnly(req) {
    if (typeof req.readOnly === 'boolean') return req.readOnly;
    if (typeof req.read_only === 'boolean') return req.read_only;
    if (typeof req.tool?.readOnly === 'boolean') return req.tool.readOnly;
    if (typeof req.tool?.read_only === 'boolean') return req.tool.read_only;
    if (typeof req.annotations?.readOnly === 'boolean') return req.annotations.readOnly;
    if (typeof req.metadata?.readOnly === 'boolean') return req.metadata.readOnly;
    return false;
  }

  #markAttention(entry, on) {
    const sessions = this.#sessions;
    if (!sessions || !entry.sessionId) return;
    try {
      if (on) {
        if (typeof sessions.beginAttention === 'function') {
          sessions.beginAttention(entry.sessionId, 'approval', entry.id);
        } else if (typeof sessions.setAttention === 'function') {
          sessions.setAttention(entry.sessionId, 'approval');
        }
      } else {
        if (typeof sessions.endAttention === 'function') {
          sessions.endAttention(entry.sessionId, 'approval', entry.id);
        } else if (typeof sessions.setAttention === 'function') {
          sessions.setAttention(entry.sessionId, 'none');
        }
      }
    } catch (err) {
      this.#warn('更新会话 attention 失败（%s）：%s', entry.sessionId, err?.message ?? err);
    }
  }

  #clearAttention(entry) {
    this.#markAttention(entry, false);
  }

  #warn(...args) {
    this.#log?.warn?.(...args);
  }
}

export default Approvals;
