// 只读状态视图（docs/04 Task 21 验收 7）
//
// 给上层（IPC、调试面板、api 能力）看的窗口：只能读到此刻的 session.state
// 快照，读不到也不持有任何业务状态。所有数据每次现取自 Sessions，避免出现
// 「视图里一份、集合里一份」的双源不一致。

/**
 * 递归冻结一个对象图（只冻结普通对象与数组，跳过 undefined/原始值）。
 * 遇到环引用时依赖 seen 去重，不会死循环。
 */
export function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const key of Object.keys(value)) deepFreeze(value[key], seen);
  return Object.freeze(value);
}

export class StateView {
  #sessions;

  /**
   * @param {{ sessions: { snapshot: () => { sessions: object[] } } }} deps
   *   必须传入 Sessions 实例（或同形状对象）；视图不复制、不缓存它的状态。
   */
  constructor({ sessions } = {}) {
    if (
      sessions === null ||
      typeof sessions !== 'object' ||
      typeof sessions.snapshot !== 'function'
    ) {
      throw new TypeError('StateView 需要一个提供 snapshot() 的 sessions 对象');
    }
    this.#sessions = sessions;
  }

  /** 只读快照：每次调用都向 Sessions 现取，并深冻结。 */
  snapshot() {
    return deepFreeze(this.#sessions.snapshot());
  }

  /** 等价于 snapshot().sessions（新的冻结数组）。 */
  get sessions() {
    return this.snapshot().sessions;
  }

  /** 会话数量；实时读取，不缓存。 */
  get count() {
    return this.#sessions.snapshot().sessions.length;
  }

  /** JSON.stringify(view) 得到与 snapshot() 一致的冻结视图。 */
  toJSON() {
    return this.snapshot();
  }

  static create(deps) {
    return new StateView(deps);
  }
}

export function createStateView(deps) {
  return new StateView(deps);
}
