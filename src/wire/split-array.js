// Task 30 · wire/split-array.js
//
// 把一个数组字段（如 timeline 的 entries[]）按 §5.1.2 的拆分信封装进多个
// part。与 api/push.js 的 session.state 拆分同构，但抽成 wire 层纯函数：
//
//   { ...header, type, ver, part, parts, [key]: items }
//
// 规则：
//   · 贪心填片；每片完整 JSON（UTF-8）≤ maxBytes；
//   · 单片也显式写 part=1 / parts=1；
//   · 某一条自身就装不下时整条丢弃并计入 dropped——绝不截断条目内容（C1）；
//   · items 原序保持。
//
// 关键不变量（t54-F1）：fit 判定必须使用「最终信封」——part/parts 的实际
// 数字位宽、以及 header 里 dropped 的最终值。若只在 part=1/parts=1 下判定，
// 片数进入两位数（10 片）时标签会多 1 字节、dropped 从 9 变 10 也会多 1
// 字节，输出片就会超过 maxBytes。
//
// 做法：按标签位宽 w 分别打包，取「丢弃最少、片数最少」的方案；因为同一
// 位宽下任意数字的 JSON 字节数相同，用该位宽的最大值（9/99/999）预判等价
// 于用最终标签判定。若某片复核仍超限，则移除该片最后一条、计入 dropped 并
// 用新的 dropped/parts 重排。header 本身无法容纳（含 dropped 预留）时抛
// 可诊断的 RangeError，而不是产出超限的空片。
//
// 若 header 显式带 `dropped` 字段，本函数把它当作「预留字段」：先按最终
// dropped 数预留字节再装片，并把每片的 dropped 改写成真实值。
//
// 零依赖（只允许 node:buffer）。

import { Buffer } from 'node:buffer';

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

const MAX_PARTS_BY_WIDTH = (width) => 10 ** width - 1;

/**
 * @param {object} options
 * @param {string} options.type 消息类型（写入每片）
 * @param {number} options.ver 本次应答的版本号（同批各片共用）
 * @param {object} [options.header] 每片都携带的固定字段
 * @param {string} options.key 数组字段名（如 'entries'）
 * @param {unknown[]} options.items 待拆分条目
 * @param {number} options.maxBytes 单片序列化后的字节上限
 * @returns {{parts: object[], dropped: number}}
 */
export function splitArrayParts({ type, ver, header = {}, key, items, maxBytes } = {}) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new TypeError('splitArrayParts: key 必须是非空字符串');
  }
  if (!Array.isArray(items)) {
    throw new TypeError('splitArrayParts: items 必须是数组');
  }
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError('splitArrayParts: maxBytes 必须是正整数');
  }

  const baseHeader = header !== null && typeof header === 'object' ? header : {};
  const reservesDropped = Object.hasOwn(baseHeader, 'dropped');
  const headerFor = (dropped) => (reservesDropped ? { ...baseHeader, dropped } : baseHeader);

  const envelopeBytes = (effectiveHeader, part, parts, list) =>
    byteLength({ ...effectiveHeader, type, ver, part, parts, [key]: list });

  const headerError = (dropped, actual) =>
    new RangeError(
      `splitArrayParts: header 无法容纳（type=${type}, key=${key}, maxBytes=${maxBytes}, ` +
        `dropped=${dropped}, 最小信封=${actual}B）`,
    );

  // header 连「一条都不装」的最小信封都放不下：任何拆分都不可能合法。
  const minimal = envelopeBytes(headerFor(0), 1, 1, []);
  if (minimal > maxBytes) throw headerError(0, minimal);

  /**
   * 在给定标签位宽下贪心装片。
   * 返回超限/无槽位的条目（由外层移除并计入 dropped），而不是静默收下。
   */
  const packWidth = (kept, dropped, width) => {
    const cap = MAX_PARTS_BY_WIDTH(width);
    const effectiveHeader = headerFor(dropped);
    const fits = (list) => envelopeBytes(effectiveHeader, cap, cap, list) <= maxBytes;
    const chunks = [];
    let current = [];
    const overflow = [];

    for (const entry of kept) {
      const candidate = [...current.map((held) => held.item), entry.item];
      if (fits(candidate)) {
        current.push(entry);
        continue;
      }
      if (current.length === 0) {
        // 单条自身就装不下：换更宽的标签只会更大，这一条只能丢弃。
        overflow.push(entry);
        continue;
      }
      if (chunks.length === cap) {
        // 片数已到该位宽上限，再开新片会让 parts 进入更宽位（正是要避免的）。
        overflow.push(entry);
        continue;
      }
      chunks.push(current);
      current = [entry];
    }

    if (current.length > 0) {
      if (chunks.length < cap) chunks.push(current);
      else overflow.push(...current);
    }
    if (chunks.length === 0) chunks.push([]);
    return { chunks, overflow, width };
  };

  let kept = items.map((item, index) => ({ item, index }));
  let dropped = 0;

  for (let guard = 0; guard <= items.length + 16; guard += 1) {
    const maxWidth = Math.max(1, String(Math.max(1, kept.length)).length);
    let best = null;
    for (let width = 1; width <= maxWidth; width += 1) {
      const candidate = packWidth(kept, dropped, width);
      if (
        best === null ||
        candidate.overflow.length < best.overflow.length ||
        (candidate.overflow.length === best.overflow.length &&
          candidate.chunks.length < best.chunks.length)
      ) {
        best = candidate;
      }
    }

    if (best.overflow.length > 0) {
      const droppedIndexes = new Set();
      for (const entry of best.overflow) {
        if (entry) droppedIndexes.add(entry.index);
      }
      dropped += droppedIndexes.size;
      kept = kept.filter((entry) => !droppedIndexes.has(entry.index));
      // dropped 位数可能变宽，header 随之变大：下一轮按新值重新判定。
      continue;
    }

    const partsCount = best.chunks.length;
    const effectiveHeader = headerFor(dropped);

    // 逐片复核：用最终 part/parts 数字位宽再算一次字节数。
    const overIndex = best.chunks.findIndex(
      (list, index) =>
        envelopeBytes(
          effectiveHeader,
          index + 1,
          partsCount,
          list.map((entry) => entry.item),
        ) > maxBytes,
    );
    if (overIndex !== -1) {
      const list = best.chunks[overIndex];
      if (list.length === 0) {
        throw headerError(dropped, envelopeBytes(effectiveHeader, 1, partsCount, []));
      }
      const victim = list[list.length - 1];
      dropped += 1;
      kept = kept.filter((entry) => entry.index !== victim.index);
      continue;
    }

    return {
      parts: best.chunks.map((list, index) => ({
        ...effectiveHeader,
        type,
        ver,
        part: index + 1,
        parts: partsCount,
        [key]: list.map((entry) => entry.item),
      })),
      dropped,
    };
  }

  throw new RangeError(
    `splitArrayParts: 拆分无法收敛（type=${type}, key=${key}, items=${items.length}, maxBytes=${maxBytes}）`,
  );
}
