// Task 37 · api/snapshot.js
//
// buildSessions() 是 session.state（push）与 session.list（pull）唯一共用的出口：
// title 必须在这里截断，否则单个会话对象可能超过 maxMessageBytes——pull 只能
// 整条丢弃，push 只能发超限单片。同时它必须是纯函数：host 里那份会话对象的
// title 要保持原文（桌面面板显示完整标题）。

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { buildSessions } from '../../src/api/snapshot.js';
import { PushCapability } from '../../src/api/push.js';
import { PullCapability } from '../../src/api/pull.js';
import { splitArrayParts } from '../../src/wire/split-array.js';
import { MSG, MAX_MESSAGE_BYTES_CEILING } from '../../src/wire/constants.js';

const TITLE_LIMIT = 200;

function makeSession(title, extra = {}) {
  return {
    id: 'session-1',
    role: 'main',
    state: 'idle',
    title,
    ...extra,
  };
}

function makeHost(session) {
  return {
    sessions: {
      snapshot: () => ({ sessions: [session] }),
    },
  };
}

function makeLink(sent) {
  return {
    ready: true,
    info: { maxPayload: MAX_MESSAGE_BYTES_CEILING },
    async send(type, payload) {
      sent.push({ type, payload });
      return { ok: true };
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('buildSessions · title 截断到 200 code point', () => {
  test('超长 ASCII title 截到 200，未超限的原样返回', () => {
    const long = makeSession('x'.repeat(10_000));
    const [truncated] = buildSessions({ sessions: [long] });
    assert.equal(truncated.title.length, TITLE_LIMIT);

    const overBoundary = makeSession('y'.repeat(201));
    const [justOver] = buildSessions({ sessions: [overBoundary] });
    assert.equal(justOver.title, 'y'.repeat(TITLE_LIMIT), '201 个 code point 必须只留 200');

    const atLimit = makeSession('z'.repeat(TITLE_LIMIT));
    const [untouched] = buildSessions({ sessions: [atLimit] });
    assert.equal(untouched.title, 'z'.repeat(TITLE_LIMIT));

    const short = makeSession('短标题');
    const [unchanged] = buildSessions({ sessions: [short] });
    assert.equal(unchanged.title, '短标题');
  });

  test('按 code point 截断：不切开代理对/emoji', () => {
    // 300 个 emoji = 300 code point / 600 UTF-16 code unit。
    const title = '😀'.repeat(300);
    const [truncated] = buildSessions({ sessions: [makeSession(title)] });

    assert.equal(Array.from(truncated.title).length, TITLE_LIMIT);
    assert.equal(truncated.title, '😀'.repeat(TITLE_LIMIT));
    // 没有落单的代理项：每个 UTF-16 单元都成对。
    for (let i = 0; i < truncated.title.length; i += 1) {
      const code = truncated.title.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = truncated.title.charCodeAt(i + 1);
        assert.ok(next >= 0xdc00 && next <= 0xdfff, `代理对在 ${i} 处被切开`);
        i += 1;
      }
    }
  });

  test('纯函数：不改入参，host 里的标题仍是原文；其它字段逐字段原样', () => {
    const original = '长'.repeat(10_000);
    const session = makeSession(original, { model: 'deepseek', cwd: '/tmp/work' });
    const [truncated] = buildSessions({ sessions: [session] });

    assert.equal(session.title, original, '入参 title 被原地改写');
    assert.notEqual(truncated, session, '截断必须返回新对象');
    assert.equal(truncated.model, session.model);
    assert.equal(truncated.cwd, session.cwd);
    assert.equal(truncated.id, session.id);
    assert.equal(truncated.state, session.state);
  });

  test('非字符串 title 原样透传，不抛错、不改写', () => {
    for (const title of [123, null, undefined, { text: 'x' }]) {
      const session = makeSession(title);
      const [out] = buildSessions([session]);
      assert.equal(out.title, title);
    }

    const missing = { id: 's', state: 'idle' };
    const [out] = buildSessions([missing]);
    assert.equal(Object.hasOwn(out, 'title'), false, '缺失 title 不应被补成 undefined');
  });

  test('push 的 session.state 与 pull 的 session.list 吃到同一截断，sessions[] 完全一致', async () => {
    const session = makeSession('😀'.repeat(500), { model: 'deepseek' });
    const host = makeHost(session);

    const pushSent = [];
    const push = new PushCapability({ link: makeLink(pushSent), host });
    push.onLinkReady();
    const state = pushSent.find((entry) => entry.type === MSG.SESSION_STATE)?.payload;
    assert.ok(state, 'push 必须发出 session.state');

    const pullSent = [];
    const pull = new PullCapability({ link: makeLink(pullSent), host });
    assert.equal(pull.handle(MSG.SESSION_LIST_REQ, {}), true);
    await flush();
    const list = pullSent.find((entry) => entry.type === MSG.SESSION_LIST)?.payload;
    assert.ok(list, 'pull 必须发出 session.list');

    assert.equal(Array.from(state.sessions[0].title).length, TITLE_LIMIT);
    assert.deepEqual(state.sessions, list.sessions, '两条路径的 sessions[] 必须逐字段相等');
    assert.equal(session.title, '😀'.repeat(500), '两条路径都不得改写 host 标题');
  });

  test('极限：10000 字符 title 经 buildSessions 后，session.list 拆片 dropped=0 且每片 ≤ maxBytes', () => {
    const session = makeSession('x'.repeat(10_000));
    const before = Buffer.byteLength(JSON.stringify(session), 'utf8');
    assert.ok(before > MAX_MESSAGE_BYTES_CEILING, `用例前提不成立：${before}B 未超过单条上限`);

    const sessions = buildSessions({ sessions: [session] });
    const { parts, dropped } = splitArrayParts({
      type: MSG.SESSION_LIST,
      ver: 1,
      header: {},
      key: 'sessions',
      items: sessions,
      maxBytes: MAX_MESSAGE_BYTES_CEILING,
    });

    assert.equal(dropped, 0, '截断后不允许再整条丢弃会话');
    assert.ok(parts.length >= 1);
    for (const part of parts) {
      assert.ok(
        Buffer.byteLength(JSON.stringify(part), 'utf8') <= MAX_MESSAGE_BYTES_CEILING,
        `part ${part.part} 超过 maxBytes`,
      );
    }
  });
});
