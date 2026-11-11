// Task 28 · host/race.js — 共享竞速 / 幂等结算原语
//
// 覆盖 docs/04 Task 23 验收项「提问与审批共用 race()/settle() 但不共用类」
// 所依赖的两个纯语义：
//   · race(sources)：先到者胜、忽略 falsy、空集合永不 settle；
//   · claim(entry, final)：首次占坑成功、二次失败且不改写已有结果。

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { claim, race } from '../../src/host/race.js';

const delay = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms));

describe('race(sources)', () => {
  test('取先到者', async () => {
    const winner = await race([delay(20, 'slow'), Promise.resolve('fast'), delay(5, 'middle')]);
    assert.equal(winner, 'fast');
  });

  test('忽略 falsy 分支，只让真分支参与竞速', async () => {
    const winner = await race([null, undefined, false, 0, '', Promise.resolve('only')]);
    assert.equal(winner, 'only');
  });

  test('空数组返回永不 settle 的 Promise：不抛错，也不抢答 fallback', async () => {
    let settled = false;
    const pending = race([]).then(() => {
      settled = true;
    });

    const winner = await Promise.race([pending.then(() => 'race'), delay(20, 'fallback')]);
    await Promise.resolve();

    assert.equal(winner, 'fallback', 'race([]) 不得在 fallback 之前 settle');
    assert.equal(settled, false, 'race([]) 必须永远 pending');
  });

  test('非数组输入按「没有分支」处理（永不 settle）', async () => {
    const winner = await Promise.race([
      race(undefined).then(() => 'race'),
      delay(20, 'fallback'),
    ]);
    assert.equal(winner, 'fallback');
  });
});

describe('claim(entry, final)', () => {
  test('首次返回 true，并写入 settled/final', () => {
    const entry = { settled: false, final: null };
    const final = { outcome: 'allowed-once', decidedBy: 'pc' };

    assert.equal(claim(entry, final), true);
    assert.equal(entry.settled, true);
    assert.deepEqual(entry.final, { outcome: 'allowed-once', decidedBy: 'pc' });
  });

  test('二次返回 false，且不改写已写入的 final', () => {
    const entry = { settled: false };
    assert.equal(claim(entry, { outcome: 'allowed-once' }), true);
    assert.equal(claim(entry, { outcome: 'rejected' }), false);
    assert.deepEqual(entry.final, { outcome: 'allowed-once' });
    assert.equal(entry.settled, true);
  });

  test('entry 为 null/undefined 时返回 false，且无副作用', () => {
    assert.equal(claim(null, { outcome: 'rejected' }), false);
    assert.equal(claim(undefined, { outcome: 'rejected' }), false);
  });

  test('entry 已被外部标记 settled 时返回 false，不覆盖其 final', () => {
    const entry = { settled: true, final: { outcome: 'cancelled' } };
    assert.equal(claim(entry, { outcome: 'allowed-once' }), false);
    assert.deepEqual(entry.final, { outcome: 'cancelled' });
  });
});

describe('零域依赖', () => {
  test('race.js 不 import approvals / questions / api 等域模块', () => {
    const source = readFileSync(new URL('../../src/host/race.js', import.meta.url), 'utf8');
    // 零依赖：没有 import / require，自然也不依赖 approvals/questions/api。
    assert.doesNotMatch(source, /^\s*import\s/m);
    assert.doesNotMatch(source, /\brequire\s*\(/);
  });
});
