/**
 * wire/message-split.js — §5.1.2 通用拆分信封的发送器
 *
 * 协议里所有"可能超过 maxPayload"的推送都必须带 `ver/part/parts`，并按 part
 * 顺序可被设备拼回同一条业务消息。push.js 的 session.state 已有自己的拆分；
 * 这里给 host 侧的 question.asked / approval.asked 提供同一套机制：
 *
 *   · ver 按消息 type 独立计数，握手/断链后归零（docs/03 §5.1.1）；
 *   · parts 不拆分也**显式写 1**，part 从 1 开始；
 *   · 每条 part 的完整 JSON（含信封字段）不超过 maxPayload；
 *   · 同一 ver 的 parts 按 part 顺序「拼接业务字段」：
 *       - questions[] 按数组顺序合并；
 *       - 同一个 question id 在多个 part 出现时，detail 按 part 顺序拼接
 *         （计划正文可能长于一条消息，这是 §5.4.1 的要求）；
 *       - approval.asked 的 detail 为字符串时按 part 顺序拼接；为对象时按
 *         同一路径的字符串叶子拼接、其余字段合并（对象内数组不做切分）。
 *
 * 发送失败会带 type/ver/part 记 error 并抛 MessageSplitError，调用方必须把
 * 它变成可诊断的失败（不能静默悬挂）。本模块只依赖 wire/，不 import host/api。
 */

import { Buffer } from 'node:buffer';

import { MSG, MAX_MESSAGE_BYTES_CEILING } from './constants.js';

const NOOP_LOG = Object.freeze({
  debug() {},
  info() {},
  warn() {},
  error() {},
});

const SUPPORTED = new Set([MSG.QUESTION_ASKED, MSG.APPROVAL_ASKED]);

function bytesOf(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function envelope(type, ver, part, parts, body) {
  return { type, ver, part, parts, ...body };
}

/** 拆分失败：带足够诊断信息，调用方可以直接 log.error 或转成 ack code。 */
export class MessageSplitError extends Error {
  constructor(message, { type, ver, part, parts, cause } = {}) {
    super(message);
    this.name = 'MessageSplitError';
    this.code = 'SPLIT_FAILED';
    this.type = type;
    this.ver = ver;
    this.part = part;
    this.parts = parts;
    if (cause !== undefined) this.cause = cause;
  }
}

export class EnvelopeSender {
  #link;
  #log;
  #maxMessageBytesOption;
  #vers = new Map();
  #onDisconnected = () => this.reset();

  constructor({ link, log, maxMessageBytes } = {}) {
    if (!link || typeof link.send !== 'function') {
      throw new TypeError('EnvelopeSender 需要一个可 send 的 link');
    }
    this.#link = link;
    this.#log = log ?? NOOP_LOG;
    this.#maxMessageBytesOption =
      Number.isInteger(maxMessageBytes) && maxMessageBytes > 0 ? maxMessageBytes : null;
    if (typeof link.on === 'function') link.on('disconnected', this.#onDisconnected);
  }

  /** 当前连接可用的单条消息上限。 */
  get maxBytes() {
    if (this.#maxMessageBytesOption !== null) return this.#maxMessageBytesOption;
    const declared = this.#link?.info?.maxPayload;
    if (Number.isInteger(declared) && declared > 0) {
      return Math.min(declared, MAX_MESSAGE_BYTES_CEILING);
    }
    return MAX_MESSAGE_BYTES_CEILING;
  }

  /** 握手/断链后所有 type 的 ver 归零（docs/03 §5.1.1）。 */
  reset() {
    this.#vers.clear();
  }

  dispose() {
    if (typeof this.#link.off === 'function') this.#link.off('disconnected', this.#onDisconnected);
  }

  /**
   * 发送一条逻辑消息（自动拆片并按顺序等待每片 link ack）。
   * @returns {Promise<{ver:number, parts:number}>}
   */
  async send(type, payload, { ack = true } = {}) {
    const parts = this.split(type, payload);
    for (const part of parts) {
      try {
        await this.#link.send(type, part, { ack });
      } catch (err) {
        this.#log.error(
          '%s 拆分发送失败（ver=%s，part=%s/%s）：%s',
          type,
          part.ver,
          part.part,
          part.parts,
          err?.message ?? err,
        );
        throw new MessageSplitError(
          `${type} 第 ${part.part}/${part.parts} 片发送失败：${err?.message ?? err}`,
          { type, ver: part.ver, part: part.part, parts: part.parts, cause: err },
        );
      }
    }
    return { ver: parts[0].ver, parts: parts.length };
  }

  /** 只拆不发（测试/诊断用）。ver 在这里递增。 */
  split(type, payload = {}) {
    if (!SUPPORTED.has(type)) {
      throw new MessageSplitError(`不支持拆分信封的消息类型：${type}`, { type });
    }
    const ver = (this.#vers.get(type) ?? 0) + 1;
    this.#vers.set(type, ver);
    const parts =
      type === MSG.QUESTION_ASKED
        ? this.#splitQuestionAsked(ver, payload)
        : this.#splitApprovalAsked(ver, payload);
    this.#assertFits(type, ver, parts);
    return parts;
  }

  // -- question.asked -------------------------------------------------------

  #splitQuestionAsked(ver, payload) {
    const questions = Array.isArray(payload.questions) ? payload.questions : [];
    const header = {
      callId: payload.callId,
      kind: payload.kind,
      deadlineMs: payload.deadlineMs,
    };

    let partsCount = 1;
    let parts = [];
    for (let guard = 0; guard < 8; guard += 1) {
      parts = this.#packQuestions(ver, header, questions, partsCount);
      if (parts.length === partsCount) break;
      partsCount = parts.length;
    }
    return parts;
  }

  #packQuestions(ver, header, questions, partsCount) {
    const max = this.maxBytes;
    const fragments = [];
    const makeOne = (question) =>
      envelope(MSG.QUESTION_ASKED, ver, partsCount, partsCount, {
        ...header,
        questions: [question],
      });

    for (const question of questions) {
      if (bytesOf(makeOne(question)) <= max) {
        fragments.push(question);
        continue;
      }
      if (typeof question?.detail !== 'string') {
        throw new MessageSplitError(
          `question.asked 的单条问题超过 maxPayload=${max}，且 detail 不是字符串，无法按 §5.1.2 拆分`,
          { type: MSG.QUESTION_ASKED, ver, part: 1, parts: partsCount },
        );
      }
      for (const chunk of this.#chunkString(
        question.detail,
        (detail) => makeOne({ ...question, detail }),
        MSG.QUESTION_ASKED,
        ver,
      )) {
        fragments.push({ ...question, detail: chunk });
      }
    }

    const groups = [];
    let current = [];
    const makeGroup = (list) =>
      envelope(MSG.QUESTION_ASKED, ver, partsCount, partsCount, {
        ...header,
        questions: list,
      });

    for (const fragment of fragments) {
      const candidate = [...current, fragment];
      if (current.length > 0 && bytesOf(makeGroup(candidate)) > max) {
        groups.push(current);
        current = [fragment];
      } else {
        current = candidate;
      }
    }
    if (current.length > 0) groups.push(current);
    if (groups.length === 0) groups.push([]);

    return groups.map((list, index) =>
      envelope(MSG.QUESTION_ASKED, ver, index + 1, groups.length, {
        ...header,
        questions: list,
      }),
    );
  }

  // -- approval.asked -------------------------------------------------------

  #splitApprovalAsked(ver, payload) {
    const { detail, ...header } = payload;
    let partsCount = 1;
    let parts = [];
    for (let guard = 0; guard < 8; guard += 1) {
      parts = this.#packApproval(ver, header, detail, partsCount);
      if (parts.length === partsCount) break;
      partsCount = parts.length;
    }
    return parts;
  }

  #packApproval(ver, header, detail, partsCount) {
    const max = this.maxBytes;
    const make = (body) =>
      envelope(MSG.APPROVAL_ASKED, ver, partsCount, partsCount, body);

    const whole = envelope(MSG.APPROVAL_ASKED, ver, 1, 1, { ...header, ...(detail === undefined ? {} : { detail }) });
    if (bytesOf(whole) <= max) return [whole];

    if (detail === undefined) {
      throw new MessageSplitError(
        `approval.asked 超过 maxPayload=${max} 且没有可拆分的 detail`,
        { type: MSG.APPROVAL_ASKED, ver, part: 1, parts: 1 },
      );
    }

    if (typeof detail === 'string') {
      const chunks = this.#chunkString(
        detail,
        (chunk) => make({ ...header, detail: chunk }),
        MSG.APPROVAL_ASKED,
        ver,
      );
      return chunks.map((chunk, index) =>
        envelope(MSG.APPROVAL_ASKED, ver, index + 1, chunks.length, {
          ...header,
          detail: chunk,
        }),
      );
    }

    if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
      const fragments = this.#fragmentObject(detail, (partial) =>
        make({ ...header, detail: partial }),
      );
      return fragments.map((partial, index) =>
        envelope(MSG.APPROVAL_ASKED, ver, index + 1, fragments.length, {
          ...header,
          detail: partial,
        }),
      );
    }

    throw new MessageSplitError(
      `approval.asked 的 detail 形态（${Array.isArray(detail) ? 'array' : typeof detail}）超过 maxPayload=${max} 时无法拆分`,
      { type: MSG.APPROVAL_ASKED, ver, part: 1, parts: 1 },
    );
  }

  /**
   * 把对象里的字符串叶子切块；每片只保留一个叶子的一个片段（其余非字符串
   * 叶子放进第一片）。设备按路径合并、同路径字符串按 part 顺序拼接。
   */
  #fragmentObject(detail, make) {
    const strings = [];
    const others = [];
    const walk = (value, path) => {
      if (typeof value === 'string') {
        strings.push({ path, value });
        return;
      }
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [key, child] of Object.entries(value)) walk(child, [...path, key]);
        return;
      }
      others.push({ path, value });
    };
    walk(detail, []);

    if (strings.length === 0) {
      throw new MessageSplitError(
        'approval.asked 的 detail 对象没有可切分的字符串字段',
        { type: MSG.APPROVAL_ASKED },
      );
    }

    const fragments = [];
    strings.forEach((leaf, leafIndex) => {
      const chunks = this.#chunkString(leaf.value, (chunk) => {
        const partial = {};
        if (leafIndex === 0) for (const other of others) setPath(partial, other.path, other.value);
        setPath(partial, leaf.path, chunk);
        return make(partial);
      }, MSG.APPROVAL_ASKED, this.#vers.get(MSG.APPROVAL_ASKED));
      for (const chunk of chunks) {
        const partial = {};
        if (leafIndex === 0) for (const other of others) setPath(partial, other.path, other.value);
        setPath(partial, leaf.path, chunk);
        fragments.push(partial);
      }
    });

    if (fragments.length === 0) {
      throw new MessageSplitError('approval.asked 的 detail 无法切开', {
        type: MSG.APPROVAL_ASKED,
      });
    }
    return fragments;
  }

  // -- 工具 -----------------------------------------------------------------

  /** 按 code point 二分切块；每块都能塞进 make(chunk) 且不超 maxBytes。 */
  #chunkString(text, make, type, ver) {
    const points = Array.from(text);
    const max = this.maxBytes;
    const chunks = [];
    let offset = 0;
    while (offset < points.length) {
      const rest = points.slice(offset);
      const probe = make(rest.join(''));
      if (bytesOf(probe) <= max) {
        chunks.push(rest.join(''));
        break;
      }
      let lo = 1;
      let hi = rest.length;
      if (bytesOf(make(rest[0])) > max) {
        throw new MessageSplitError(
          `拆分后单片仍超过 maxPayload=${max}（信封/头部本身过大）`,
          { type, ver, part: chunks.length + 1, parts: 1 },
        );
      }
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (bytesOf(make(rest.slice(0, mid).join(''))) <= max) lo = mid;
        else hi = mid - 1;
      }
      chunks.push(rest.slice(0, lo).join(''));
      offset += lo;
    }
    return chunks;
  }

  #assertFits(type, ver, parts) {
    const max = this.maxBytes;
    for (const part of parts) {
      if (bytesOf(part) > max) {
        throw new MessageSplitError(
          `${type} 拆分后 part ${part.part}/${part.parts} 仍超过 maxPayload=${max}`,
          { type, ver, part: part.part, parts: part.parts },
        );
      }
    }
    if (parts.length === 0) {
      throw new MessageSplitError(`${type} 拆分结果为空`, { type, ver, part: 1, parts: 1 });
    }
  }
}

function setPath(target, path, value) {
  let node = target;
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = path[i];
    if (!node[key] || typeof node[key] !== 'object') node[key] = {};
    node = node[key];
  }
  node[path[path.length - 1]] = value;
}
