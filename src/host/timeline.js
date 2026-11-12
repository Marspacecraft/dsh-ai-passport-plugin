// Task 29 · host/timeline.js
//
// 每会话一个内存环形缓冲，保存最近 TIMELINE_LIMIT 条思考 / 工具调用，
// 供设备端 `timeline.req` 拉取（docs/03 §6.2）。纯内存：无定时器、无 I/O，
// 只依赖 wire 层常量，不 import 任何上层模块。
//
// 归一化在写入时完成：缓冲里存的即是设备可见形态（reasoning 带 text；
// tool 带 name 与可选 field/value），`recent()` 直接切片返回，不再二次加工。

import { TIMELINE_LIMIT } from '../wire/constants.js';

/**
 * 工具名 → 「一个关键字段」的映射表（docs/02 §4、docs/03 §5.2.1）。
 * 查不到就只发工具名，**永不 fallback 到发全部参数**。
 */
export const TOOL_FIELD = Object.freeze({
  bash: 'command',
  write: 'path',
  edit: 'path',
  read: 'path',
  glob: 'pattern',
  grep: 'pattern',
});

/** 单字段值允许的最大字符数（唯一允许的截断点，docs/04 Task 29 验收 3）。 */
const VALUE_MAX_CHARS = 200;
const ELLIPSIS = '…';

const NOOP_LOG = Object.freeze({
  debug() {},
  warn() {},
});

/**
 * 把字段值转成字符串：对象走 JSON.stringify，其余走 String(v)。
 * 循环引用等无法序列化的对象退回 String(v)，至少不抛出。
 */
function stringifyValue(value) {
  if (typeof value === 'string') return value;
  if (value !== null && typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/** 只截断单个字段值，按 code point 计数，避免切开代理对。 */
function truncateValue(text) {
  const chars = Array.from(text);
  if (chars.length <= VALUE_MAX_CHARS) return text;
  return chars.slice(0, VALUE_MAX_CHARS).join('') + ELLIPSIS;
}

/**
 * 按 TOOL_FIELD 映射出一条 tool 条目。
 *
 * - 命中映射且 args 里确实有该字段（值为 null/undefined 视为没有）→ 带 field/value；
 * - 未命中映射、args 不是对象、或参数里没有该字段 → 只带 name。
 *
 * 返回值不含 args，调用方不需要也不允许把全部参数发出去。
 */
export function toolEntry(name, args) {
  if (!Object.hasOwn(TOOL_FIELD, name)) return { kind: 'tool', name };
  if (args === null || typeof args !== 'object') return { kind: 'tool', name };

  const field = TOOL_FIELD[name];
  if (!Object.hasOwn(args, field)) return { kind: 'tool', name };

  const raw = args[field];
  if (raw === undefined || raw === null) return { kind: 'tool', name };

  return { kind: 'tool', name, field, value: truncateValue(stringifyValue(raw)) };
}

/**
 * 每会话环形缓冲。
 *
 * `seq` 在会话内独立递增，`clear()` 之后从 1 重新开始；缓冲满了丢弃最旧
 * 一条，但序号不回退（设备据此去重 / 判断本次拉取范围）。
 */
export class Timeline {
  #limit;
  #log;
  #sessions = new Map();

  constructor({ limit = TIMELINE_LIMIT, log } = {}) {
    const parsed = Number(limit);
    this.#limit = Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : TIMELINE_LIMIT;
    this.#log = log == null ? NOOP_LOG : { ...NOOP_LOG, ...log };
  }

  /**
   * 归一化并写入一条时间线。返回 false 表示该条被拒绝（不会写入半条，
   * 也不消耗 seq）。
   */
  append(sessionId, entry) {
    const normalized = this.#normalize(sessionId, entry);
    if (normalized === null) return false;

    let state = this.#sessions.get(sessionId);
    if (state === undefined) {
      state = { entries: [], nextSeq: 1 };
      this.#sessions.set(sessionId, state);
    }

    state.entries.push({ seq: state.nextSeq, ...normalized });
    state.nextSeq += 1;
    if (state.entries.length > this.#limit) state.entries.shift();
    return true;
  }

  /**
   * 最近 `count` 条（按 seq 升序）。
   *
   * count 归一到 [1, limit]：非法值（负数、0、NaN、undefined、非数字）取 limit。
   * `hasMore` 只表示「本次被 count 截断了」，不是「还能继续往前翻」。
   */
  recent(sessionId, count) {
    const state = this.#sessions.get(sessionId);
    if (state === undefined) return { entries: [], hasMore: false };

    const wanted = this.#normalizeCount(count);
    const entries = state.entries.slice(-wanted);
    return { entries, hasMore: state.entries.length > entries.length };
  }

  /** 会话结束 / 被移除：丢弃该会话的全部条目，seq 下次从 1 开始。 */
  clear(sessionId) {
    this.#sessions.delete(sessionId);
  }

  /** 清空全部会话（插件卸载）。 */
  dispose() {
    this.#sessions.clear();
  }

  get stats() {
    let entries = 0;
    for (const state of this.#sessions.values()) entries += state.entries.length;
    return { sessions: this.#sessions.size, entries };
  }

  #normalizeCount(count) {
    const parsed = Number(count);
    if (!Number.isFinite(parsed) || parsed < 1) return this.#limit;
    return Math.min(Math.floor(parsed), this.#limit);
  }

  #normalize(sessionId, entry) {
    if (entry === null || typeof entry !== 'object') {
      this.#log.debug('timeline：拒绝非对象条目（sessionId=%s）', sessionId);
      return null;
    }

    if (entry.kind === 'reasoning') {
      if (typeof entry.text !== 'string') {
        this.#log.debug(
          'timeline：拒绝 reasoning 条目（sessionId=%s，text 类型=%s）',
          sessionId,
          typeof entry.text,
        );
        return null;
      }
      return { kind: 'reasoning', text: entry.text };
    }

    if (entry.kind === 'tool') {
      if (typeof entry.name !== 'string' || entry.name.length === 0) {
        this.#log.debug('timeline：拒绝 tool 条目（sessionId=%s，name 无效）', sessionId);
        return null;
      }
      return toolEntry(entry.name, entry.args);
    }

    this.#log.debug('timeline：拒绝未知 kind 条目（sessionId=%s，kind=%s）', sessionId, entry.kind);
    return null;
  }
}
