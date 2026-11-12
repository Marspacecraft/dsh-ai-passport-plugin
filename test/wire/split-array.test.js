/**
 * Task 30 · wire/split-array.js 单元测试（TDD）
 *
 * 覆盖 docs/04 Task 30 对拆分原语的要求：
 *   · 恰好装进一片时 part=1 / parts=1；
 *   · 边界差 1 字节必须多片，且每片 JSON ≤ maxBytes；
 *   · 单条自身超 maxBytes → 整条丢弃并计入 dropped（不截断内容）；
 *   · items 原序保持；
 *   · header 字段逐片携带，key 可配置；
 *   · 除 node:buffer 外零 import。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';

import { splitArrayParts } from '../../src/wire/split-array.js';

const bytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');

describe('splitArrayParts · 单片的显式信封', () => {
  test('恰好一片：part=1、parts=1，header 与 key 都在', () => {
    const { parts, dropped } = splitArrayParts({
      type: 'timeline',
      ver: 7,
      header: { sessionId: 's1', hasMore: false, dropped: 0 },
      key: 'entries',
      items: [{ seq: 1 }, { seq: 2 }, { seq: 3 }],
      maxBytes: 8160,
    });

    assert.equal(dropped, 0);
    assert.equal(parts.length, 1);
    assert.deepEqual(parts[0], {
      sessionId: 's1',
      hasMore: false,
      dropped: 0,
      type: 'timeline',
      ver: 7,
      part: 1,
      parts: 1,
      entries: [{ seq: 1 }, { seq: 2 }, { seq: 3 }],
    });
  });

  test('空数组也产出一片（显式 part=1/parts=1）', () => {
    const { parts, dropped } = splitArrayParts({
      type: 'timeline',
      ver: 3,
      header: { sessionId: 's1', hasMore: false },
      key: 'entries',
      items: [],
      maxBytes: 256,
    });
    assert.equal(dropped, 0);
    assert.equal(parts.length, 1);
    assert.deepEqual(parts[0].entries, []);
    assert.equal(parts[0].part, 1);
    assert.equal(parts[0].parts, 1);
  });
});

describe('splitArrayParts · 边界', () => {
  test('maxBytes 恰好等于整片字节数 → 仍是一片', () => {
    const args = {
      type: 'timeline',
      ver: 1,
      header: { sessionId: 's' },
      key: 'entries',
      items: [{ seq: 1, kind: 'reasoning', text: 'a'.repeat(20) }, { seq: 2 }],
    };
    const full = { type: 'timeline', ver: 1, sessionId: 's', part: 1, parts: 1, entries: args.items };
    const exact = bytes(full);

    const { parts, dropped } = splitArrayParts({ ...args, maxBytes: exact });
    assert.equal(dropped, 0);
    assert.equal(parts.length, 1);
    assert.ok(bytes(parts[0]) <= exact);
  });

  test('边界差 1 字节 → 必须拆成多片，每片都 ≤ maxBytes', () => {
    const args = {
      type: 'timeline',
      ver: 1,
      header: { sessionId: 's' },
      key: 'entries',
      items: [{ seq: 1, text: 'a'.repeat(20) }, { seq: 2 }],
    };
    const full = { type: 'timeline', ver: 1, sessionId: 's', part: 1, parts: 1, entries: args.items };
    const maxBytes = bytes(full) - 1;

    const { parts, dropped } = splitArrayParts({ ...args, maxBytes });
    assert.equal(dropped, 0);
    assert.ok(parts.length > 1);
    for (const part of parts) assert.ok(bytes(part) <= maxBytes, `part ${part.part} 超限`);
    assert.deepEqual(
      parts.flatMap((part) => part.entries),
      args.items,
    );
  });
});

describe('splitArrayParts · 丢弃与顺序', () => {
  test('单条自身超 maxBytes → 整条丢弃，计入 dropped，内容不截断', () => {
    const huge = { seq: 2, kind: 'reasoning', text: 'x'.repeat(500) };
    const items = [{ seq: 1 }, huge, { seq: 3 }];
    const { parts, dropped } = splitArrayParts({
      type: 'timeline',
      ver: 1,
      header: { sessionId: 's', dropped: 0 },
      key: 'entries',
      items,
      maxBytes: 200,
    });

    assert.equal(dropped, 1);
    const delivered = parts.flatMap((part) => part.entries);
    assert.deepEqual(delivered, [{ seq: 1 }, { seq: 3 }]);
    assert.equal(delivered.includes(huge), false);
    // 每片的 dropped 都是真实值（逐片一致），且不含半条。
    for (const part of parts) assert.equal(part.dropped, 1);
  });

  test('乱序 items 保持原序，dropped 计数准确', () => {
    const items = [7, 3, 9, 1, 5];
    const { parts, dropped } = splitArrayParts({
      type: 'x',
      ver: 1,
      header: {},
      key: 'items',
      items,
      maxBytes: 90,
    });
    assert.equal(dropped, 0);
    assert.deepEqual(parts.flatMap((part) => part.items), items);
  });

  test('多条超限分别计数', () => {
    const { parts, dropped } = splitArrayParts({
      type: 'x',
      ver: 1,
      header: {},
      key: 'items',
      items: ['y'.repeat(500), 'ok', 'z'.repeat(500), 'ok2'],
      maxBytes: 150,
    });
    assert.equal(dropped, 2);
    assert.deepEqual(parts.flatMap((part) => part.items), ['ok', 'ok2']);
  });

  test('header 不携带 dropped 时，输出也不凭空添加该字段', () => {
    const { parts } = splitArrayParts({
      type: 'x',
      ver: 1,
      header: { sessionId: 's' },
      key: 'items',
      items: [1],
      maxBytes: 512,
    });
    assert.equal(Object.hasOwn(parts[0], 'dropped'), false);
  });

  test('参数非法时抛 TypeError（不静默产出坏信封）', () => {
    assert.throws(() => splitArrayParts({ type: 'x', ver: 1, key: '', items: [], maxBytes: 10 }), TypeError);
    assert.throws(() => splitArrayParts({ type: 'x', ver: 1, key: 'items', items: null, maxBytes: 10 }), TypeError);
    assert.throws(() => splitArrayParts({ type: 'x', ver: 1, key: 'items', items: [], maxBytes: 0 }), TypeError);
  });
});

describe('splitArrayParts · 最终信封的位宽（t54-F1）', () => {
  const envelope = (header, entries, part = 1, parts = 1) => ({
    ...header,
    type: 'timeline',
    ver: 1,
    part,
    parts,
    entries,
  });

  /** 二分出「在给定 header + part=1/parts=1 下恰好占满 maxBytes」的条目。 */
  const itemExactly = (header, maxBytes, template) => {
    let low = 0;
    let high = 8192;
    let best = 0;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const candidate = { ...template, text: 'x'.repeat(mid) };
      if (bytes(envelope(header, [candidate])) <= maxBytes) {
        best = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return { ...template, text: 'x'.repeat(best) };
  };

  test('parts 位数跃迁：1 / 2 / 9 / 10 / 11 / 100 都逐片 ≤ 恰好装下一条的 maxBytes', () => {
    const item = 'a';
    for (const count of [1, 2, 9, 10, 11, 100]) {
      const maxBytes = bytes({
        type: 'x',
        ver: 1,
        part: count,
        parts: count,
        items: [item],
      });
      const { parts, dropped } = splitArrayParts({
        type: 'x',
        ver: 1,
        header: {},
        key: 'items',
        items: Array.from({ length: count }, () => item),
        maxBytes,
      });

      assert.equal(dropped, 0, `parts=${count} 不应丢弃`);
      assert.equal(parts.length, count, `parts=${count} 期望恰好 ${count} 片`);
      assert.deepEqual(
        parts.map((part) => part.part),
        Array.from({ length: count }, (_, index) => index + 1),
      );
      for (const part of parts) {
        assert.equal(part.parts, count);
        assert.ok(
          bytes(part) <= maxBytes,
          `parts=${count} 的 part ${part.part} 超限：${bytes(part)}B > ${maxBytes}B`,
        );
      }
    }
  });

  test('10 条恰好 448B 的条目：parts 进入两位数后每片仍 ≤ maxBytes，超出的整条丢弃', () => {
    const header = { sessionId: 's', hasMore: false };
    // t54-F1 第一条复现：355 个字符的条目在 1/1 信封下恰好 448B。
    const item = 'x'.repeat(355);
    assert.equal(bytes(envelope(header, [item])), 448, '前提：单条在 1/1 信封下恰好 448B');

    const items = Array.from({ length: 10 }, () => item);
    const { parts, dropped } = splitArrayParts({
      type: 'timeline',
      ver: 1,
      header,
      key: 'entries',
      items,
      maxBytes: 448,
    });

    // 9 片 × 1 条 = 448B；第 10 条若再开一片，parts 会是两位数、多 1 字节。
    assert.equal(parts.length, 9);
    assert.equal(dropped, 1);
    for (const part of parts) {
      assert.ok(bytes(part) <= 448, `part ${part.part} 超限：${bytes(part)}B`);
      assert.equal(part.parts, 9);
    }
    assert.deepEqual(parts.flatMap((part) => part.entries), items.slice(0, 9));
  });

  test('header 预留 dropped 时，parts=10 的两位数信封仍在 maxBytes 内', () => {
    const header = { sessionId: 's', hasMore: false, dropped: 0 };
    const item = itemExactly(header, 448, { seq: 1, kind: 'assistant' });
    const items = Array.from({ length: 10 }, () => item);

    const { parts, dropped } = splitArrayParts({
      type: 'timeline',
      ver: 1,
      header,
      key: 'entries',
      items,
      maxBytes: 450,
    });

    assert.equal(dropped, 0);
    assert.equal(parts.length, 10);
    for (const part of parts) {
      assert.ok(bytes(part) <= 450, `part ${part.part} 超限：${bytes(part)}B`);
      assert.equal(part.parts, 10);
      assert.equal(part.dropped, 0);
    }
    // part=10 比 part=1..9 多一位数字，正好是 F1 里最容易漏掉的 1 字节。
    assert.equal(bytes(parts[9]), 450);
    assert.deepEqual(parts.flatMap((part) => part.entries), items);
  });

  test('10+ 片：part/parts 两位数且连续升序，每片 ≤ maxBytes，原序不丢', () => {
    const header = { sessionId: 's', hasMore: true };
    const items = Array.from({ length: 50 }, (_, index) => ({
      seq: index + 1,
      kind: 'assistant',
      text: 'x'.repeat(100),
    }));

    const { parts, dropped } = splitArrayParts({
      type: 'timeline',
      ver: 1,
      header,
      key: 'entries',
      items,
      maxBytes: 500,
    });

    assert.equal(dropped, 0);
    assert.ok(parts.length > 10, `期望 10+ 片，实际 ${parts.length}`);
    assert.deepEqual(
      parts.map((part) => part.part),
      Array.from({ length: parts.length }, (_, index) => index + 1),
    );
    for (const part of parts) {
      assert.equal(part.parts, parts.length);
      assert.ok(bytes(part) <= 500, `part ${part.part} 超限：${bytes(part)}B`);
    }
    assert.deepEqual(parts.flatMap((part) => part.entries), items);
  });

  test('dropped 恰好进入两位（10）：header 的 1 字节增长被算进片大小', () => {
    const header = { sessionId: 's', hasMore: true, dropped: 0 };
    const oversized = Array.from({ length: 10 }, (_, index) => ({
      seq: index + 1,
      kind: 'assistant',
      text: 'x'.repeat(400),
    }));
    const small = { seq: 99, kind: 'assistant', text: 'ok' };

    const { parts, dropped } = splitArrayParts({
      type: 'timeline',
      ver: 1,
      header,
      key: 'entries',
      items: [...oversized, small],
      maxBytes: 300,
    });

    assert.equal(dropped, 10);
    assert.equal(parts.length, 1);
    assert.equal(parts[0].dropped, 10);
    assert.deepEqual(parts[0].entries, [small]);
    assert.ok(bytes(parts[0]) <= 300, `片超限：${bytes(parts[0])}B`);
  });

  test('dropped 从一位进入两位（12）：header 变大后逐片复核，仍不超限', () => {
    const header = { sessionId: 's', hasMore: true, dropped: 0 };
    const oversized = Array.from({ length: 12 }, (_, index) => ({
      seq: index + 1,
      kind: 'assistant',
      text: 'x'.repeat(400),
    }));
    const small = { seq: 99, kind: 'assistant', text: 'ok' };

    const { parts, dropped } = splitArrayParts({
      type: 'timeline',
      ver: 1,
      header,
      key: 'entries',
      items: [...oversized, small],
      maxBytes: 300,
    });

    assert.equal(dropped, 12);
    assert.equal(parts.length, 1);
    assert.equal(parts[0].dropped, 12);
    assert.deepEqual(parts[0].entries, [small]);
    assert.ok(bytes(parts[0]) <= 300, `片超限：${bytes(parts[0])}B`);
  });

  test('dropped 从两位进入三位（99 → 100）：99 的空片头也按真实值回填', () => {
    const header = { sessionId: 's', hasMore: true, dropped: 0 };
    const makeOversized = (count) =>
      Array.from({ length: count }, (_, index) => ({
        seq: index + 1,
        kind: 'assistant',
        text: 'x'.repeat(400),
      }));

    const at99 = splitArrayParts({
      type: 'timeline',
      ver: 1,
      header,
      key: 'entries',
      items: makeOversized(99),
      maxBytes: 300,
    });
    assert.equal(at99.dropped, 99);
    assert.equal(at99.parts[0].dropped, 99);
    assert.ok(bytes(at99.parts[0]) <= 300, `99 的空片超限：${bytes(at99.parts[0])}B`);

    const at100 = splitArrayParts({
      type: 'timeline',
      ver: 1,
      header,
      key: 'entries',
      items: makeOversized(100),
      maxBytes: 300,
    });
    assert.equal(at100.dropped, 100);
    assert.equal(at100.parts[0].dropped, 100);
    assert.ok(bytes(at100.parts[0]) <= 300, `100 的空片超限：${bytes(at100.parts[0])}B`);
  });

  test('dropped 进入三位（100）：不重复累计，空片头的 dropped 也是真实值', () => {
    const header = { sessionId: 's', hasMore: true, dropped: 0 };
    const oversized = Array.from({ length: 100 }, (_, index) => ({
      seq: index + 1,
      kind: 'assistant',
      text: 'x'.repeat(400),
    }));

    const { parts, dropped } = splitArrayParts({
      type: 'timeline',
      ver: 1,
      header,
      key: 'entries',
      items: oversized,
      maxBytes: 300,
    });

    assert.equal(dropped, 100);
    assert.equal(parts.length, 1);
    assert.deepEqual(parts[0].entries, []);
    assert.equal(parts[0].dropped, 100);
    assert.ok(bytes(parts[0]) <= 300, `空片超限：${bytes(parts[0])}B`);
  });

  test('header 自身无法容纳时抛可诊断的 RangeError（不是超限空片）', () => {
    // t54-F1 第二条复现：旧实现会产出 474B 的空片（maxBytes=300）。
    assert.throws(
      () =>
        splitArrayParts({
          type: 'timeline',
          ver: 1,
          header: { sessionId: 's'.repeat(400) },
          key: 'entries',
          items: [],
          maxBytes: 300,
        }),
      (error) => {
        assert.ok(error instanceof RangeError);
        assert.match(error.message, /header 无法容纳/);
        assert.match(error.message, /maxBytes=300/);
        assert.match(error.message, /最小信封=474B/);
        return true;
      },
    );
  });

  test('header 无法容纳（通用形态）时抛错并带上诊断字段', () => {
    assert.throws(
      () =>
        splitArrayParts({
          type: 'timeline',
          ver: 1,
          header: { sessionId: 's'.repeat(200) },
          key: 'entries',
          items: [],
          maxBytes: 100,
        }),
      (error) => {
        assert.ok(error instanceof RangeError);
        assert.match(error.message, /header 无法容纳/);
        assert.match(error.message, /maxBytes=100/);
        return true;
      },
    );
  });

  test('dropped 位宽增长到三位导致空信封超限时，也抛 header 无法容纳', () => {
    const header = { sessionId: 's'.repeat(20), dropped: 0 };
    const minimal = bytes(envelope(header, []));
    const maxBytes = minimal + 1;
    const oversized = Array.from({ length: 100 }, (_, index) => ({
      seq: index + 1,
      text: 'x'.repeat(400),
    }));

    assert.throws(
      () =>
        splitArrayParts({
          type: 'timeline',
          ver: 1,
          header,
          key: 'entries',
          items: oversized,
          maxBytes,
        }),
      (error) => {
        assert.ok(error instanceof RangeError);
        assert.match(error.message, /header 无法容纳/);
        assert.match(error.message, /dropped=100/);
        return true;
      },
    );
  });
});

describe('splitArrayParts · 依赖边界', () => {
  test('源码除 node:buffer 外零 import', () => {
    const source = readFileSync(new URL('../../src/wire/split-array.js', import.meta.url), 'utf8');
    const specifiers = [...source.matchAll(/^import\s+.*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    assert.deepEqual(specifiers, ['node:buffer']);
  });
});
