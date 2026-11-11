// Task 28 · host/race.js
//
// 「一次竞速 + 幂等结算」的共享原语（docs/04 Task 23 验收项：
// 提问与审批共用 race()/settle()，但不共用类）。
//
// 本模块刻意保持零域依赖：不 import approvals/questions/api，也不出现
// 审批、提问、attention、done 等域概念。域侧通过 entry 字段与 onSettled
// 回调扩展自己的副作用。

/**
 * 多个来源中先到者胜；falsy 分支（null/undefined/false）不参与竞速。
 *
 * 没有任何分支时返回一个**永不 settle** 的 Promise——语义是「没有分支
 * 参与竞速」，而不是「先到 undefined」。调用方不会被同步抛错打断。
 */
export function race(sources) {
  const list = Array.isArray(sources) ? sources.filter(Boolean) : [];
  if (list.length === 0) return new Promise(() => {});
  return Promise.race(list);
}

/**
 * 幂等占坑：entry 已结算（或 entry 为空）时返回 false，且不改写已有结果。
 * 成功时写入 `entry.settled = true` 与 `entry.final = final`，返回 true。
 */
export function claim(entry, final) {
  if (!entry || entry.settled) return false;
  entry.settled = true;
  entry.final = final;
  return true;
}
