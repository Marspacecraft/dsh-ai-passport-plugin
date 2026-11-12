// Task 30 · api/snapshot.js
//
// `session.state`（推送）与 `session.list`（拉取）必须给出**完全相同**的
// sessions[]。把「从 host.sessions.snapshot() 里取对外数组」收敛成一个纯函数，
// 两条路径都调用它，避免两边各自拼字段后慢慢漂移。
//
// Task 37：title 在这里截断到 200 code point。它是 push / pull 唯一共用出口，
// 一处生效两处一致；host 里的会话对象保持原文（桌面面板要显示完整标题）。
// 只截 title，其它字段逐字段原样——截断后单个会话对象恒能装进一条消息。

/** 与 docs/03 §5.1.1 一致：主机侧把 sessions[].title 截到 200 code point。 */
const TITLE_MAX_CODE_POINTS = 200;

/**
 * 返回会话数组：任一 title 超长时按 code point 截断，并返回新数组/新对象；
 * 没有任何截断时原样返回入参数组（保持既有的纯透传语义）。
 * 非对象条目、非字符串 title 原样透传，不抛错。
 */
function normalizeSessions(sessions) {
  let changed = false;
  const out = sessions.map((session) => {
    if (session === null || typeof session !== 'object' || Array.isArray(session)) {
      return session;
    }
    if (typeof session.title !== 'string') return session;

    const codePoints = Array.from(session.title);
    if (codePoints.length <= TITLE_MAX_CODE_POINTS) return session;

    changed = true;
    return { ...session, title: codePoints.slice(0, TITLE_MAX_CODE_POINTS).join('') };
  });
  return changed ? out : sessions;
}

/**
 * 从 host.sessions.snapshot() 的返回值里取出对外 `sessions[]`。
 *
 * 容忍两种调用方式：直接传 snapshot 结果 `{ sessions: [...] }`，或直接传
 * 数组。任何其它形态都退回空数组——上层不需要用可选链重复防御。
 *
 * 纯函数：不排序、不裁剪条目，字段与顺序原样透传；只有 title 超长时才复制
 * 数组/对象并截断，保证调用方（host）持有的对象不被修改。
 *
 * @param {{sessions?: unknown[]}|unknown[]|null|undefined} snapshot
 * @returns {unknown[]}
 */
export function buildSessions(snapshot) {
  if (Array.isArray(snapshot)) return normalizeSessions(snapshot);
  if (snapshot !== null && typeof snapshot === 'object' && Array.isArray(snapshot.sessions)) {
    return normalizeSessions(snapshot.sessions);
  }
  return [];
}
