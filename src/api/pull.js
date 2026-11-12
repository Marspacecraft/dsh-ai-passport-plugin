// Task 30 · api/pull.js
//
// 拉取族：设备主动发起，主机应答。
//
//   session.list.req → session.list  （内容与 session.state 的 sessions[] 完全一致）
//   timeline.req     → timeline      （最近 N 条，超限按 §5.1.2 拆片，不裁剪条目）
//   balance.req      → balance | notice
//
// 三条硬约束（都是前几轮的真实事故）：
//   · 未 ready 直接 return：不自增 ver、不调用 send。ver 一旦先加后失败，
//     设备侧会看到跳号（M4-F1）。
//   · ver 按消息类型独立计数，握手成功 / 断链归零。
//   · 发送失败只 log；断链后不再补发。调用方可能是 void，绝不能留下
//     unhandledRejection。
//
// balance 成功走注入的 balanceProvider（函数或 { getBalance() }），失败回
// notice{text}，绝不伪造 0；todayUsed 字段已从协议删除，禁止出现。

import { splitArrayParts } from '../wire/split-array.js';
import { buildSessions } from './snapshot.js';
import { MSG, MAX_MESSAGE_BYTES_CEILING } from '../wire/constants.js';

const NOOP_LOG = Object.freeze({
  debug() {},
  info() {},
  warn() {},
  error() {},
});

/** 协议字段一律是字符串；数字只做格式化，不改变值。 */
function asText(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

export class PullCapability {
  /** 恰为三个下行请求类型；顺序即分发表顺序。 */
  types = [MSG.SESSION_LIST_REQ, MSG.TIMELINE_REQ, MSG.BALANCE_REQ];

  #link;
  #log;
  #host;
  #timeline;
  #balanceProvider;
  #maxMessageBytesOption;

  /** 按消息类型独立计数；ready / disconnected 时整体清零。 */
  #vers = new Map();
  /** 连接代次：断链即作废在途应答，防止跨重连补发。 */
  #epoch = 0;
  #disposed = false;

  #stats = {
    requests: 0,
    sessionList: 0,
    timeline: 0,
    balance: 0,
    notices: 0,
    sendErrors: 0,
    dropped: 0,
  };

  constructor({
    link,
    log,
    host,
    timeline,
    balanceProvider,
    maxMessageBytes,
  } = {}) {
    if (!link || typeof link.send !== 'function') {
      throw new TypeError('PullCapability 需要一个可 send 的 link');
    }
    this.#link = link;
    this.#log = log ?? NOOP_LOG;
    this.#host = host ?? {};
    this.#timeline = timeline ?? null;
    this.#balanceProvider = balanceProvider ?? null;
    this.#maxMessageBytesOption =
      Number.isInteger(maxMessageBytes) && maxMessageBytes > 0 ? maxMessageBytes : null;
  }

  /**
   * 处理设备请求。返回 true 表示「类型归我管」；即使当前未 ready 也返回
   * true（请求已被接收，只是按协议丢弃，不应落到 unknown_type）。
   */
  handle(type, payload) {
    if (this.#disposed) return false;

    let respond;
    switch (type) {
      case MSG.SESSION_LIST_REQ:
        respond = () => this.#respondSessionList();
        break;
      case MSG.TIMELINE_REQ:
        respond = () => this.#respondTimeline(payload);
        break;
      case MSG.BALANCE_REQ:
        respond = () => this.#respondBalance();
        break;
      default:
        return false;
    }

    // 未 ready：不消耗 ver、不 send。请求本身算已处理。
    if (this.#link?.ready !== true) return true;

    this.#stats.requests += 1;
    respond();
    return true;
  }

  /** 握手成功：新连接从 ver=1 开始，旧连接的在途应答作废。 */
  onLinkReady() {
    this.#epoch += 1;
    this.#vers.clear();
  }

  /** 断链：ver 归零并作废在途应答；重连后不补发。 */
  onDisconnected() {
    this.#epoch += 1;
    this.#vers.clear();
  }

  dispose() {
    this.#disposed = true;
    this.#epoch += 1;
    this.#vers.clear();
  }

  get stats() {
    return { ...this.#stats };
  }

  // -------------------------------------------------------------------------
  // session.list
  // -------------------------------------------------------------------------

  #respondSessionList() {
    const epoch = this.#epoch;
    const ver = this.#nextVer(MSG.SESSION_LIST);
    const sessions = buildSessions(this.#host?.sessions?.snapshot?.());

    this.#stats.sessionList += 1;
    void this.#sendArray({
      type: MSG.SESSION_LIST,
      ver,
      header: {},
      key: 'sessions',
      items: sessions,
      epoch,
    });
  }

  // -------------------------------------------------------------------------
  // timeline
  // -------------------------------------------------------------------------

  #respondTimeline(payload) {
    const request = payload !== null && typeof payload === 'object' ? payload : {};
    const sessionId = typeof request.sessionId === 'string' ? request.sessionId : '';

    let recent = { entries: [], hasMore: false };
    try {
      // count 的归一化由 Timeline.recent 负责（非法值 → limit，不抛错）。
      recent = this.#timeline?.recent?.(sessionId, request.count) ?? recent;
    } catch (err) {
      this.#log.error('timeline 读取失败：%s', err?.stack ?? err);
    }

    const entries = Array.isArray(recent.entries) ? recent.entries : [];
    const epoch = this.#epoch;
    const ver = this.#nextVer(MSG.TIMELINE);

    this.#stats.timeline += 1;
    void this.#sendArray({
      type: MSG.TIMELINE,
      ver,
      // dropped 交给拆分器按真实丢弃数回填（逐片一致）。
      header: { sessionId, hasMore: recent.hasMore === true, dropped: 0 },
      key: 'entries',
      items: entries,
      epoch,
    });
  }

  // -------------------------------------------------------------------------
  // balance
  // -------------------------------------------------------------------------

  #respondBalance() {
    const epoch = this.#epoch;
    let result;
    try {
      result = this.#invokeBalanceProvider();
    } catch (err) {
      this.#sendBalanceFailure(err, epoch);
      return;
    }

    if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
      // 异步 provider：await 期间可能已断链/重连，落地前必须复核代次。
      result.then(
        (value) => this.#sendBalanceOk(value, epoch),
        (err) => this.#sendBalanceFailure(err, epoch),
      );
      return;
    }
    this.#sendBalanceOk(result, epoch);
  }

  #invokeBalanceProvider() {
    const provider = this.#balanceProvider;
    if (typeof provider === 'function') return provider();
    if (provider !== null && typeof provider === 'object' && typeof provider.getBalance === 'function') {
      return provider.getBalance();
    }
    throw new Error('余额服务未配置');
  }

  #sendBalanceOk(result, epoch) {
    if (epoch !== this.#epoch || this.#link?.ready !== true) return;

    if (result === null || typeof result !== 'object') {
      this.#sendBalanceFailure(new Error('余额服务返回空结果'), epoch);
      return;
    }

    // 协议要求三个金额字段都存在；缺任何一项都视为失败，不补 0。
    const totalBalance = asText(result.totalBalance);
    const recharge = asText(result.recharge);
    const bonus = asText(result.bonus);
    if (totalBalance === null || recharge === null || bonus === null) {
      this.#sendBalanceFailure(new Error('余额字段不完整'), epoch);
      return;
    }

    const currency =
      typeof result.currency === 'string' && result.currency.length > 0 ? result.currency : 'CNY';
    const payload = {
      type: MSG.BALANCE,
      currency,
      totalBalance,
      recharge,
      bonus,
    };

    this.#stats.balance += 1;
    void this.#sendOne(MSG.BALANCE, payload, epoch);
  }

  #sendBalanceFailure(err, epoch) {
    if (epoch !== this.#epoch || this.#link?.ready !== true) return;
    const reason =
      err instanceof Error && typeof err.message === 'string' && err.message.length > 0
        ? err.message
        : '未知错误';
    this.#log.warn('余额获取失败：%s', reason);
    this.#stats.notices += 1;
    void this.#sendOne(MSG.NOTICE, { type: MSG.NOTICE, text: `未获取到余额：${reason}` }, epoch);
  }

  // -------------------------------------------------------------------------
  // 发送
  // -------------------------------------------------------------------------

  #nextVer(type) {
    const next = (this.#vers.get(type) ?? 0) + 1;
    this.#vers.set(type, next);
    return next;
  }

  #maxBytes() {
    if (this.#maxMessageBytesOption !== null) return this.#maxMessageBytesOption;
    const declared = this.#link?.info?.maxPayload;
    if (Number.isInteger(declared) && declared > 0) {
      return Math.min(declared, MAX_MESSAGE_BYTES_CEILING);
    }
    return MAX_MESSAGE_BYTES_CEILING;
  }

  /**
   * 拆分并逐片发送。每片发出前复核代次——断链后剩余片直接丢弃，绝不
   * 在重连后补发。整个函数自行吞错，调用方可以安全地 void。
   */
  async #sendArray({ type, ver, header, key, items, epoch }) {
    let split;
    try {
      split = splitArrayParts({
        type,
        ver,
        header,
        key,
        items,
        maxBytes: this.#maxBytes(),
      });
    } catch (err) {
      // header 连最小信封都装不下（或拆分无法收敛）：这是配置/协商错误，
      // 必须可观测且不能把不合法片发出去，更不能变成 unhandledRejection。
      this.#stats.sendErrors += 1;
      this.#log.warn('%s 拆分失败（header 无法容纳）：%s', type, err?.message ?? err);
      return;
    }

    try {
      const { parts, dropped } = split;

      if (dropped > 0) {
        this.#stats.dropped += dropped;
        this.#log.warn('%s 有 %d 条自身超过 maxMessageBytes，已整条丢弃', type, dropped);
      }

      for (const part of parts) {
        if (epoch !== this.#epoch || this.#link?.ready !== true) return;
        await this.#sendOne(type, part, epoch);
      }
    } catch (err) {
      this.#log.error('%s 发送失败：%s', type, err?.stack ?? err);
    }
  }

  /** 单次发送：同步抛错和异步拒绝都只记日志，不产生 unhandledRejection。 */
  async #sendOne(type, payload, epoch) {
    try {
      const pending = this.#link.send(type, payload, { ack: true });
      await pending;
    } catch (err) {
      this.#stats.sendErrors += 1;
      this.#log.warn('%s 发送失败：%s', type, err?.message ?? err);
    }
  }
}
