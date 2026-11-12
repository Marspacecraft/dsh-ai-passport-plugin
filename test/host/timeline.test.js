// Task 29 · host/timeline.js — 每会话环形缓冲 + 工具关键字段映射
//
// 覆盖 docs/04 Task 29 的 7 条验收：
//   1. append 分配会话内 seq；缓冲满丢最旧、seq 不回退；
//   2. reasoning 缺 text / 非字符串 → 拒绝且不写半条；
//   3. toolEntry 按 TOOL_FIELD 映射；未命中只发 name，绝不发全部参数；
//   4. recent(count) 归一、升序、hasMore；未知会话不抛错；
//   5. 1000 条后 stats.entries === limit；
//   6. clear 后清空且 seq 从 1 重来；dispose 清空所有会话；
//   7. 条目整条保留，唯一截断点是 tool value 单字段的 200 字符。

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { Timeline, TOOL_FIELD, toolEntry } from '../../src/host/timeline.js';
import { TIMELINE_LIMIT } from '../../src/wire/constants.js';

function makeLogger() {
  const entries = [];
  const push = (level) => (...args) => entries.push({ level, text: args.map(String).join(' ') });
  return {
    entries,
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
  };
}

const reasoning = (text) => ({ kind: 'reasoning', text });
const tool = (name, args) => ({ kind: 'tool', name, args });

describe('TOOL_FIELD 映射表', () => {
  test('是一张冻结的数据表，包含 docs 约定的六个工具', () => {
    assert.equal(Object.isFrozen(TOOL_FIELD), true);
    assert.deepEqual(TOOL_FIELD, {
      bash: 'command',
      write: 'path',
      edit: 'path',
      read: 'path',
      glob: 'pattern',
      grep: 'pattern',
    });
    assert.throws(() => {
      TOOL_FIELD.bash = 'other';
    }, TypeError);
  });
});

describe('toolEntry(name, args)', () => {
  test('六个映射命中且带对应字段时产出 field/value', () => {
    const cases = [
      ['bash', { command: 'npm test' }, 'command', 'npm test'],
      ['write', { path: 'a.txt', content: 'x' }, 'path', 'a.txt'],
      ['edit', { path: 'src/a.js', old: 'a' }, 'path', 'src/a.js'],
      ['read', { path: 'README.md' }, 'path', 'README.md'],
      ['glob', { pattern: '**/*.js' }, 'pattern', '**/*.js'],
      ['grep', { pattern: 'TODO' }, 'pattern', 'TODO'],
    ];
    for (const [name, args, field, value] of cases) {
      assert.deepEqual(toolEntry(name, args), { kind: 'tool', name, field, value });
    }
  });

  test('未命中映射：只带 name，绝不 fallback 到发全部参数', () => {
    const entry = toolEntry('webfetch', { url: 'https://example.com', token: 'secret' });
    assert.deepEqual(entry, { kind: 'tool', name: 'webfetch' });
    assert.equal('field' in entry, false);
    assert.equal('value' in entry, false);
    assert.equal(JSON.stringify(entry).includes('secret'), false);
    assert.equal(JSON.stringify(entry).includes('example.com'), false);
  });

  test('命中映射但参数里没有该字段：只带 name', () => {
    assert.deepEqual(toolEntry('bash', { other: 'x' }), { kind: 'tool', name: 'bash' });
    assert.deepEqual(toolEntry('bash', {}), { kind: 'tool', name: 'bash' });
    assert.deepEqual(toolEntry('bash', null), { kind: 'tool', name: 'bash' });
    assert.deepEqual(toolEntry('bash', 'not-an-object'), { kind: 'tool', name: 'bash' });
  });

  test('字段值为 null/undefined 视作没有值：只带 name', () => {
    assert.deepEqual(toolEntry('bash', { command: null }), { kind: 'tool', name: 'bash' });
    assert.deepEqual(toolEntry('bash', { command: undefined }), { kind: 'tool', name: 'bash' });
  });

  test('非字符串值走 String(v)，对象走 JSON.stringify', () => {
    assert.deepEqual(toolEntry('bash', { command: 42 }), {
      kind: 'tool', name: 'bash', field: 'command', value: '42',
    });
    assert.deepEqual(toolEntry('bash', { command: false }), {
      kind: 'tool', name: 'bash', field: 'command', value: 'false',
    });
    assert.deepEqual(toolEntry('bash', { command: { script: 'npm test', env: { CI: 1 } } }), {
      kind: 'tool',
      name: 'bash',
      field: 'command',
      value: '{"script":"npm test","env":{"CI":1}}',
    });
  });

  test('value 超过 200 字符：截断到 200 字符 + 省略号（含 Unicode 安全）', () => {
    const exactly = 'a'.repeat(200);
    assert.equal(toolEntry('bash', { command: exactly }).value, exactly);

    const over = 'b'.repeat(201);
    const truncated = toolEntry('bash', { command: over }).value;
    assert.equal(truncated, 'b'.repeat(200) + '…');
    assert.equal(Array.from(truncated).length, 201);

    // 按 code point 截断，不得切出半个代理对。
    const emoji = '😀'.repeat(300);
    const emojiValue = toolEntry('bash', { command: emoji }).value;
    assert.equal(Array.from(emojiValue).length, 201);
    assert.equal(emojiValue.endsWith('…'), true);
    assert.equal(emojiValue.includes('\uFFFD'), false);
    assert.equal(emojiValue.slice(0, -1), '😀'.repeat(200));

    // 截断只作用于单个字段值，不作用于条目。
    const longJson = toolEntry('bash', { command: { script: 'x'.repeat(400) } }).value;
    assert.equal(longJson.length, 201);
    assert.equal(longJson.endsWith('…'), true);
  });
});

describe('Timeline.append：seq 与拒绝', () => {
  test('每会话 seq 独立、从 1 递增', () => {
    const timeline = new Timeline();
    assert.equal(timeline.append('s1', reasoning('a')), true);
    assert.equal(timeline.append('s1', reasoning('b')), true);
    assert.equal(timeline.append('s2', reasoning('c')), true);

    assert.deepEqual(timeline.recent('s1').entries.map((e) => e.seq), [1, 2]);
    assert.deepEqual(timeline.recent('s2').entries.map((e) => e.seq), [1]);
    assert.equal(timeline.stats.sessions, 2);
    assert.equal(timeline.stats.entries, 3);
  });

  test('reasoning 缺 text / text 非字符串 → false + debug，不写半条也不消耗 seq', () => {
    const log = makeLogger();
    const timeline = new Timeline({ log });

    for (const bad of [
      { kind: 'reasoning' },
      { kind: 'reasoning', text: 42 },
      { kind: 'reasoning', text: null },
      { kind: 'reasoning', text: { a: 1 } },
    ]) {
      assert.equal(timeline.append('s1', bad), false);
    }
    assert.equal(timeline.stats.entries, 0);
    assert.deepEqual(timeline.recent('s1'), { entries: [], hasMore: false });
    assert.equal(log.entries.filter((e) => e.level === 'debug').length, 4);

    // 被拒绝的条目不占用序号：下一条合法条目仍是 seq 1。
    assert.equal(timeline.append('s1', reasoning('ok')), true);
    assert.deepEqual(timeline.recent('s1').entries, [{ seq: 1, kind: 'reasoning', text: 'ok' }]);
  });

  test('非法条目（非对象 / 未知 kind / tool 缺 name）被拒绝且不写入', () => {
    const log = makeLogger();
    const timeline = new Timeline({ log });
    assert.equal(timeline.append('s1', null), false);
    assert.equal(timeline.append('s1', 'text'), false);
    assert.equal(timeline.append('s1', { kind: 'other' }), false);
    assert.equal(timeline.append('s1', { kind: 'tool' }), false);
    assert.equal(timeline.append('s1', { kind: 'tool', name: '' }), false);
    assert.equal(timeline.stats.entries, 0);
    assert.equal(log.entries.length, 5);
  });

  test('tool 条目写入时即完成映射（缓冲里不保留 args）', () => {
    const timeline = new Timeline();
    timeline.append('s1', tool('bash', { command: 'npm test', cwd: '/tmp', token: 'secret' }));
    const [entry] = timeline.recent('s1').entries;
    assert.deepEqual(entry, {
      seq: 1,
      kind: 'tool',
      name: 'bash',
      field: 'command',
      value: 'npm test',
    });
    assert.equal(JSON.stringify(entry).includes('/tmp'), false);
    assert.equal(JSON.stringify(entry).includes('secret'), false);
    assert.equal(JSON.stringify(entry).includes('args'), false);
  });
});

describe('Timeline 环形缓冲：上限与 seq 不回退', () => {
  test('自定义 limit：第 limit+1 条丢最旧，seq 继续递增', () => {
    const timeline = new Timeline({ limit: 3 });
    for (let i = 1; i <= 5; i += 1) timeline.append('s1', reasoning(`r${i}`));

    const { entries, hasMore } = timeline.recent('s1');
    assert.deepEqual(entries.map((e) => e.seq), [3, 4, 5]);
    assert.deepEqual(entries.map((e) => e.text), ['r3', 'r4', 'r5']);
    assert.equal(hasMore, false, 'count 取满 limit 时 hasMore 必须为 false');
    assert.equal(timeline.stats.entries, 3);
  });

  test('默认 limit：第 21 条进来丢第 1 条，recent(20) 返回 seq 2..21', () => {
    const timeline = new Timeline();
    for (let i = 1; i <= 21; i += 1) timeline.append('s1', reasoning(`r${i}`));

    const { entries, hasMore } = timeline.recent('s1', 20);
    assert.equal(entries.length, TIMELINE_LIMIT);
    assert.deepEqual(entries.map((e) => e.seq), Array.from({ length: 20 }, (_, i) => i + 2));
    assert.equal(entries[entries.length - 1].text, 'r21');
    assert.equal(hasMore, false);
  });

  test('连续 append 1000 条后 stats.entries === limit（内存不无限增长）', () => {
    const timeline = new Timeline();
    for (let i = 1; i <= 1000; i += 1) {
      timeline.append('s1', i % 2 === 0 ? reasoning(`r${i}`) : tool('bash', { command: `c${i}` }));
    }
    assert.equal(timeline.stats.sessions, 1);
    assert.equal(timeline.stats.entries, TIMELINE_LIMIT);

    const { entries, hasMore } = timeline.recent('s1', 20);
    assert.deepEqual(entries.map((e) => e.seq), Array.from({ length: 20 }, (_, i) => i + 981));
    assert.equal(hasMore, false);
  });
});

describe('Timeline.recent：count 归一与 hasMore', () => {
  function seeded() {
    const timeline = new Timeline();
    for (let i = 1; i <= 5; i += 1) timeline.append('s1', reasoning(`r${i}`));
    return timeline;
  }

  test('按 seq 升序返回最近 count 条', () => {
    const timeline = seeded();
    const { entries, hasMore } = timeline.recent('s1', 2);
    assert.deepEqual(entries.map((e) => e.seq), [4, 5]);
    assert.equal(hasMore, true, '缓冲 5 条只给 2 条 → hasMore');
  });

  test('count 非法（负数/0/NaN/undefined）→ limit', () => {
    const timeline = seeded();
    for (const count of [undefined, -1, 0, Number.NaN, 'abc']) {
      const { entries, hasMore } = timeline.recent('s1', count);
      assert.equal(entries.length, 5, `count=${String(count)} 应取 limit 内全部`);
      assert.equal(hasMore, false);
    }
  });

  test('count 超过 limit 或小数 → 夹到 [1, limit]', () => {
    const timeline = seeded();
    assert.equal(timeline.recent('s1', 999).entries.length, 5);
    assert.equal(timeline.recent('s1', 999).hasMore, false);
    assert.deepEqual(timeline.recent('s1', 2.9).entries.map((e) => e.seq), [4, 5]);
  });

  test('未知 sessionId 返回空结果、不抛错', () => {
    const timeline = seeded();
    assert.deepEqual(timeline.recent('nope', 10), { entries: [], hasMore: false });
    assert.deepEqual(timeline.recent(undefined), { entries: [], hasMore: false });
  });
});

describe('Timeline.clear / dispose', () => {
  test('clear(sessionId) 后 recent 为空、seq 从 1 重新开始', () => {
    const timeline = new Timeline();
    timeline.append('s1', reasoning('a'));
    timeline.append('s1', reasoning('b'));
    timeline.append('s2', reasoning('c'));

    timeline.clear('s1');
    assert.deepEqual(timeline.recent('s1'), { entries: [], hasMore: false });
    assert.equal(timeline.stats.sessions, 1, 'clear 只影响目标会话');

    assert.equal(timeline.append('s1', reasoning('after-clear')), true);
    assert.deepEqual(timeline.recent('s1').entries, [
      { seq: 1, kind: 'reasoning', text: 'after-clear' },
    ]);
  });

  test('dispose 清空所有会话', () => {
    const timeline = new Timeline();
    timeline.append('s1', reasoning('a'));
    timeline.append('s2', reasoning('b'));
    assert.deepEqual(timeline.stats, { sessions: 2, entries: 2 });

    timeline.dispose();
    assert.deepEqual(timeline.stats, { sessions: 0, entries: 0 });
    assert.deepEqual(timeline.recent('s1'), { entries: [], hasMore: false });
    assert.deepEqual(timeline.recent('s2'), { entries: [], hasMore: false });
  });
});

describe('Timeline：条目整条保留', () => {
  test('长 reasoning 文本不被裁剪，recent 原样返回', () => {
    const timeline = new Timeline();
    const text = '思考'.repeat(5000) + '\n末尾标记';
    timeline.append('s1', reasoning(text));
    const [entry] = timeline.recent('s1').entries;
    assert.equal(entry.text, text);
    assert.equal(entry.text.length, text.length);
    assert.equal(entry.text.endsWith('末尾标记'), true);
  });

  test('长 reasoning 与多个 tool 混排时只有 tool value 单字段被截断', () => {
    const timeline = new Timeline({ limit: 10 });
    const text = 'x'.repeat(10_000);
    timeline.append('s1', reasoning(text));
    timeline.append('s1', tool('bash', { command: 'y'.repeat(500) }));
    timeline.append('s1', reasoning(text));

    const { entries } = timeline.recent('s1');
    assert.equal(entries[0].text, text);
    assert.equal(entries[2].text, text);
    assert.equal(entries[1].value, 'y'.repeat(200) + '…');
  });
});
