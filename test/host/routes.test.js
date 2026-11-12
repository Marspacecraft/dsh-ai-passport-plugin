// Task 41 · 面板路由与宿主装配测试
//
// 全部用 fake ctx/req/res，不监听真实端口；import src/index.js 本身不得产生
// 副作用（单独起一个子进程 import，进程必须立即正常退出）。

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  registerPassportRoutes,
  checkOwner,
  PASSPORT_ACTIONS,
} from '../../src/host/routes.js';
import { apply, Config } from '../../src/index.js';

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(text) {
      this.body = text ?? '';
    },
  };
}

function makeReq({ method = 'GET', headers = {}, chunks = [] } = {}) {
  let reads = 0;
  const req = {
    method,
    headers,
    get reads() {
      return reads;
    },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        reads += 1;
        yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      }
    },
  };
  return req;
}

function jsonReq(actionBody, { method = 'POST', contentType = 'application/json' } = {}) {
  const text = typeof actionBody === 'string' ? actionBody : JSON.stringify(actionBody);
  return makeReq({
    method,
    headers: contentType === undefined ? {} : { 'content-type': contentType },
    chunks: [text],
  });
}

const owner = { peer: { principal: { kind: 'owner' } } };

function makeCtx({ connection, webServer, tools } = {}) {
  const effectiveConnection = connection === undefined ? { admit: async () => owner } : connection;
  const registered = [];
  const ws =
    webServer ??
    {
      register(route) {
        registered.push(route);
        return () => {
          const i = registered.indexOf(route);
          if (i >= 0) registered.splice(i, 1);
        };
      },
    };
  return {
    ctx: {
      get(key, fallback) {
        if (key === 'connection') return effectiveConnection;
        if (key === 'webServer') return ws ?? fallback;
        return fallback;
      },
      logger: { warn() {}, error() {}, info() {}, debug() {} },
      tools: tools ?? { register: () => () => {} },
    },
    registered: () => registered,
    webServer: ws,
  };
}

function makeLink({ ready = true, deviceId = 'dev-1' } = {}) {
  const calls = [];
  const link = {
    state: 'connected',
    ready,
    info: deviceId ? { deviceId, name: '护照', firmware: '2.0.0' } : null,
    calls,
    async start() {
      calls.push(['start']);
    },
    async stop(reason) {
      calls.push(['stop', reason]);
    },
    async restartScan(reason) {
      calls.push(['restartScan', reason]);
    },
    handshake: {
      pairs: [],
      resets: 0,
      async beginPairing(code) {
        this.pairs.push(code);
        calls.push(['pair', code]);
      },
      reset() {
        this.resets += 1;
      },
    },
  };
  return link;
}

const sessions = { snapshot: () => ({ sessions: [] }) };
const timeline = { stats: { entries: 0 } };
const asr = { ready: false, provider: null, stats: { sessions: 0 } };

function setupRoutes(overrides = {}) {
  const link = overrides.link ?? makeLink();
  const trust =
    overrides.trust ??
    {
      table: { 'dev-1': 'tok' },
      async load() {
        return { ...this.table };
      },
      async save(table) {
        this.table = table;
      },
    };
  const { ctx, registered } = makeCtx({ connection: overrides.connection });
  const routes = registerPassportRoutes({
    ctx,
    link,
    sessions,
    timeline,
    asr,
    trust,
    prefix: overrides.prefix ?? '/dsh-passport',
  });
  const byPath = new Map(registered().map((route) => [route.path, route]));
  return { link, trust, routes, byPath, registered };
}

async function call(handler, req) {
  const res = makeRes();
  await handler(req, res);
  return { res, body: res.body ? JSON.parse(res.body) : undefined };
}

describe('Task 41 · 路由鉴权 fail-closed', () => {
  test('无 connection 服务 → 503，且请求体未被读取', async () => {
    const { byPath } = setupRoutes({ connection: null });
    const req = jsonReq({ action: 'link.connect' });
    const { res } = await call(byPath.get('/dsh-passport/action').handler, req);
    assert.equal(res.statusCode, 503);
    assert.equal(req.reads, 0);
  });

  test('connection 没有 admit 方法 → 503', async () => {
    const { byPath } = setupRoutes({ connection: {} });
    const { res } = await call(byPath.get('/dsh-passport/state.json').handler, makeReq());
    assert.equal(res.statusCode, 503);
  });

  test('admit 抛错 → 403', async () => {
    const { byPath } = setupRoutes({
      connection: {
        admit() {
          throw new Error('bad origin');
        },
      },
    });
    const req = jsonReq({ action: 'link.connect' });
    const { res } = await call(byPath.get('/dsh-passport/action').handler, req);
    assert.equal(res.statusCode, 403);
    assert.equal(req.reads, 0);
  });

  test('admit 返回非对象 → 401', async () => {
    const { byPath } = setupRoutes({ connection: { admit: async () => null } });
    const { res } = await call(byPath.get('/dsh-passport/state.json').handler, makeReq());
    assert.equal(res.statusCode, 401);
  });

  test('admission.rejection → 透传状态码', async () => {
    const { byPath } = setupRoutes({
      connection: { admit: async () => ({ rejection: 429 }) },
    });
    const { res } = await call(byPath.get('/dsh-passport/state.json').handler, makeReq());
    assert.equal(res.statusCode, 429);
  });

  test('缺 peer → 401', async () => {
    const { byPath } = setupRoutes({ connection: { admit: async () => ({}) } });
    const { res } = await call(byPath.get('/dsh-passport/state.json').handler, makeReq());
    assert.equal(res.statusCode, 401);
  });

  test('非 owner → 403，且请求体未被读取', async () => {
    const { byPath } = setupRoutes({
      connection: { admit: async () => ({ peer: { principal: { kind: 'user' } } }) },
    });
    const req = jsonReq({ action: 'link.connect' });
    const { res } = await call(byPath.get('/dsh-passport/action').handler, req);
    assert.equal(res.statusCode, 403);
    assert.equal(req.reads, 0);
  });

  test('checkOwner 通过时返回 admission，不写响应', async () => {
    const { ctx } = makeCtx();
    const res = makeRes();
    const admission = await checkOwner(ctx, makeReq(), res);
    assert.equal(admission.peer.principal.kind, 'owner');
    assert.equal(res.body, '');
  });
});

describe('Task 41 · 两条路由', () => {
  test('GET state.json 返回 {state} 且含面板字段', async () => {
    const { byPath, link } = setupRoutes();
    const { res, body } = await call(byPath.get('/dsh-passport/state.json').handler, makeReq());
    assert.equal(res.statusCode, 200);
    assert.equal(body.state.linkState, link.state);
    assert.equal(body.state.linkReady, true);
    assert.equal(body.state.schemaVersion, 2);
  });

  test('POST action 非 application/json → 415，且不读 body', async () => {
    const { byPath } = setupRoutes();
    const req = makeReq({
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      chunks: ['{"action":"link.connect"}'],
    });
    const { res } = await call(byPath.get('/dsh-passport/action').handler, req);
    assert.equal(res.statusCode, 415);
    assert.equal(req.reads, 0);
  });

  test('坏 JSON / 缺 action / 未知动作 → 400，link 零调用', async () => {
    const { byPath, link } = setupRoutes();
    const handler = byPath.get('/dsh-passport/action').handler;
    for (const payload of ['{', '{}', JSON.stringify({ action: 'evil' })]) {
      const { res } = await call(handler, jsonReq(payload));
      assert.equal(res.statusCode, 400);
    }
    assert.deepEqual(link.calls, []);
  });

  test('action 白名单与客户端契约一致', () => {
    assert.deepEqual(PASSPORT_ACTIONS, [
      'link.connect',
      'link.disconnect',
      'link.restartScan',
      'pair.submit',
      'pair.unpair',
    ]);
  });

  test('link.connect / disconnect / restartScan 映射到 start/stop/restartScan', async () => {
    const { byPath, link } = setupRoutes();
    const handler = byPath.get('/dsh-passport/action').handler;

    let { res, body } = await call(handler, jsonReq({ action: 'link.connect' }));
    assert.equal(res.statusCode, 200);
    assert.equal(body.ok, true);
    assert.equal(body.state.linkState, 'connected');

    ({ res } = await call(handler, jsonReq({ action: 'link.disconnect' })));
    assert.equal(res.statusCode, 200);
    ({ res } = await call(handler, jsonReq({ action: 'link.restartScan' })));
    assert.equal(res.statusCode, 200);

    assert.deepEqual(link.calls, [
      ['start'],
      ['stop', '面板断开'],
      ['restartScan', '面板切换设备'],
    ]);
  });

  test('pair.submit 校验 6 位码并调用 beginPairing；未连接 → 409', async () => {
    const { byPath, link } = setupRoutes();
    const handler = byPath.get('/dsh-passport/action').handler;

    let { res } = await call(handler, jsonReq({ action: 'pair.submit', payload: { code: '12' } }));
    assert.equal(res.statusCode, 400);
    assert.deepEqual(link.calls, []);

    ({ res } = await call(handler, jsonReq({ action: 'pair.submit', payload: { code: '123456' } })));
    assert.equal(res.statusCode, 200);
    assert.deepEqual(link.handshake.pairs, ['123456']);

    const offline = setupRoutes({ link: makeLink({ ready: false }) });
    ({ res } = await call(
      offline.byPath.get('/dsh-passport/action').handler,
      jsonReq({ action: 'pair.submit', payload: { code: '123456' } }),
    ));
    assert.equal(res.statusCode, 409);
    assert.deepEqual(offline.link.calls, []);
  });

  test('pair.unpair 从信任表删除当前设备并 reset 握手', async () => {
    const { byPath, link, trust } = setupRoutes();
    const { res, body } = await call(
      byPath.get('/dsh-passport/action').handler,
      jsonReq({ action: 'pair.unpair' }),
    );
    assert.equal(res.statusCode, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(trust.table, {});
    assert.equal(link.handshake.resets, 1);
  });

  test('dispose 注销两条路由', async () => {
    const { routes, registered } = setupRoutes();
    assert.equal(registered().length, 2);
    routes.dispose();
    assert.equal(registered().length, 0);
  });

  test('没有 webServer 服务时不抛错，registered=false', () => {
    const { ctx } = makeCtx({ webServer: null });
    const routes = registerPassportRoutes({
      ctx: { get: () => undefined, logger: { warn() {} } },
      link: makeLink(),
      sessions,
      trust: { async load() {}, async save() {} },
    });
    assert.equal(routes.registered, false);
    assert.doesNotThrow(() => routes.dispose());
  });
});

describe('Task 41 · 宿主装配 src/index.js', () => {
  test('导出 Config + apply，import 本身无副作用（子进程立即退出）', async () => {
    assert.equal(typeof apply, 'function');
    assert.equal(Config.transport, 'bridge');
    const target = pathToFileURL(`${ROOT}src/index.js`).href;
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ['--input-type=module', '-e', `await import(${JSON.stringify(target)});`],
      { cwd: ROOT, timeout: 5000 },
    );
    assert.equal(stdout, '');
    assert.equal(stderr, '');
  });

  test('apply 装配链路、服务与四个工具，disposer 清理干净', async () => {
    const registeredTools = [];
    const disposedTools = [];
    const { ctx, registered } = makeCtx({
      tools: {
        register(def) {
          registeredTools.push(def);
          return () => disposedTools.push(def.name);
        },
      },
    });

    const dispose = apply(ctx, {
      transport: 'mock',
      autoStart: false,
      routePrefix: '/dsh-passport',
    });

    assert.deepEqual(
      registeredTools.map((def) => def.name).sort(),
      ['passport_ask', 'passport_balance', 'passport_notify', 'passport_status'],
    );
    assert.equal(registered().length, 2);
    for (const def of registeredTools) assert.equal(typeof def.execute, 'function');

    await dispose();
    assert.equal(registered().length, 0);
    assert.deepEqual(disposedTools.sort(), [
      'passport_ask',
      'passport_balance',
      'passport_notify',
      'passport_status',
    ]);
  });
});

// t70 补：原套件没有任何 405 用例——把方法判定改成 `if (false && ...)` 后 19 条全绿。
// HTTP 方法不是装饰：GET 能触发 action 就意味着任何一次误点链接/预取都可能连设备。
describe('Task 41 补充 · HTTP 方法必须严格', () => {
  test('GET /action → 405，且不读 body、不调用任何链路方法', async () => {
    const { byPath, link } = setupRoutes();
    const req = makeReq({ method: 'GET' });
    const { res, body } = await call(byPath.get('/dsh-passport/action').handler, req);
    assert.equal(res.statusCode, 405);
    assert.equal(req.reads, 0, '拒绝的请求不得消耗请求体');
    assert.deepEqual(link.calls, [], '方法不对时不得产生任何副作用');
    assert.equal(body?.ok, false);
  });

  test('POST /state.json → 405（状态只读，写方法一律拒绝）', async () => {
    const { byPath } = setupRoutes();
    const req = jsonReq({ action: 'link.connect' });
    const { res } = await call(byPath.get('/dsh-passport/state.json').handler, req);
    assert.equal(res.statusCode, 405);
    assert.equal(req.reads, 0);
  });
});
