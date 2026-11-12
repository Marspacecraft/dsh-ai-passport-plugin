// Task 41 · 宿主 Web 面板路由（fail-closed 鉴权）
//
// 宿主 `ctx.webServer.register({kind:'exact', ...})` **不做任何鉴权**（t56 审计：
// dsh-host-webserver 明确不提供服务器级认证/来源策略）。所以两条路由自己加栅栏：
//
//   · 用软取 `ctx.get('connection', false)`，不写进 inject —— 本插件可能被装在
//     没有 Web 载体的组合里，缺服务时不能炸掉整个插件；
//   · connection 缺失 / 没有 admit → 503（fail-closed，绝不裸奔）；
//   · admit 抛错 → 403；返回非对象 → 401；返回 {rejection} → 透传状态码；
//   · admission.peer 缺失 → 401；peer.principal.kind !== 'owner' → 403；
//   · 鉴权必须在读 body 之前：被拒绝的请求不消耗请求体；
//   · POST 只收 application/json（去掉参数后比较，防跨站简单请求 CSRF 面）。
//
// 两条路由（前缀由客户端 lib/client.js 决定，默认 /dsh-passport）：
//   GET  <prefix>/state.json  → {state: panelSnapshot(...)}
//   POST <prefix>/action      → {ok:true, state} / {ok:false, error}
//
// 动作白名单与 lib/client.js:72 的 POST 契约一致；未知名返回 400 且零副作用。

import { panelSnapshot } from './panel-data.js';

const DEFAULT_PREFIX = '/dsh-passport';
const MAX_BODY_BYTES = 64 * 1024;

const ACTIONS = Object.freeze([
  'link.connect',
  'link.disconnect',
  'link.restartScan',
  'pair.submit',
  'pair.unpair',
]);

const NOOP_LOG = Object.freeze({
  debug() {},
  info() {},
  warn() {},
  error() {},
});

function sendJson(res, status, body) {
  if (!res || typeof res !== 'object') return;
  try {
    res.statusCode = status;
    if (typeof res.setHeader === 'function') res.setHeader('content-type', 'application/json; charset=utf-8');
    else if (res.headers && typeof res.headers === 'object') res.headers['content-type'] = 'application/json; charset=utf-8';
  } catch {
    // 某些 fake res 是只读对象；状态码写不进去也不影响下面 end()。
  }
  const text = JSON.stringify(body);
  if (typeof res.end === 'function') res.end(text);
}

function fail(res, status, error) {
  sendJson(res, status, { ok: false, error });
}

/**
 * owner-only 栅栏。通过返回 admission 对象；拒绝时已写响应并返回 null。
 *
 * 该函数单独导出便于测试直接覆盖每条语义（503/403/401/透传）。
 */
export async function checkOwner(ctx, req, res) {
  let connection;
  try {
    connection = typeof ctx?.get === 'function' ? ctx.get('connection', false) : undefined;
  } catch {
    connection = undefined;
  }
  if (!connection || typeof connection.admit !== 'function') {
    fail(res, 503, 'Web 连接服务不可用');
    return null;
  }

  let admission;
  try {
    admission = await connection.admit(req);
  } catch {
    fail(res, 403, '请求来源被拒绝');
    return null;
  }
  if (!admission || typeof admission !== 'object' || Array.isArray(admission)) {
    fail(res, 401, '未通过身份验证');
    return null;
  }
  if (Object.prototype.hasOwnProperty.call(admission, 'rejection')) {
    const status = Number.isInteger(admission.rejection) ? admission.rejection : 401;
    fail(res, status, '请求被拒绝');
    return null;
  }
  const peer = admission.peer;
  if (!peer || typeof peer !== 'object') {
    fail(res, 401, '未通过身份验证');
    return null;
  }
  if (peer.principal?.kind !== 'owner') {
    fail(res, 403, '仅允许本机所有者访问');
    return null;
  }
  return admission;
}

function isJsonContentType(value) {
  if (typeof value !== 'string') return false;
  return value.split(';', 1)[0].trim().toLowerCase() === 'application/json';
}

async function readJsonBody(req, res) {
  if (!isJsonContentType(req?.headers?.['content-type'])) {
    fail(res, 415, '仅支持 application/json');
    return undefined;
  }

  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > MAX_BODY_BYTES) {
        fail(res, 413, '请求体过大');
        return undefined;
      }
      chunks.push(buf);
    }
  } catch {
    fail(res, 400, '无法读取请求体');
    return undefined;
  }

  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') {
    fail(res, 400, '缺少 action');
    return undefined;
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      fail(res, 400, '请求体必须是 JSON 对象');
      return undefined;
    }
    return parsed;
  } catch {
    fail(res, 400, 'JSON 格式错误');
    return undefined;
  }
}

/**
 * 注册面板两条路由。返回 {dispose, registered, stateSnapshot}。
 *
 * @param {object} opts
 * @param {object} opts.ctx              Cordis 上下文（读取 webServer / connection）
 * @param {object} opts.link             Link（state/ready/info/start/stop/restartScan/handshake）
 * @param {object} opts.sessions         Sessions
 * @param {object} [opts.timeline]       Timeline
 * @param {object} [opts.asr]            AsrCapability
 * @param {object} [opts.trust]          信任表 {load,save}
 * @param {object} [opts.log]            日志
 * @param {string} [opts.prefix]         路由前缀，默认 '/dsh-passport'
 */
export function registerPassportRoutes({
  ctx,
  link,
  sessions,
  timeline,
  asr,
  trust,
  log,
  prefix = DEFAULT_PREFIX,
} = {}) {
  const logger = log ?? NOOP_LOG;

  let webServer;
  try {
    webServer =
      (typeof ctx?.get === 'function' ? ctx.get('webServer', false) : undefined) ??
      ctx?.webServer;
  } catch {
    webServer = undefined;
  }

  if (!webServer || typeof webServer.register !== 'function') {
    logger.warn?.('面板路由未注册：宿主没有 webServer 服务');
    return { dispose() {}, registered: false, disposeRoutes: [] };
  }

  const stateSnapshot = () =>
    panelSnapshot({ link, sessions, timeline, asr, trust, now: Date.now() });

  const handleState = async (req, res) => {
    // 先鉴权：即使方法不对，也不能在无 Web 身份服务时裸奔。
    if ((await checkOwner(ctx, req, res)) === null) return;
    if (req?.method && req.method !== 'GET') {
      fail(res, 405, '仅支持 GET');
      return;
    }
    try {
      sendJson(res, 200, { state: stateSnapshot() });
    } catch (err) {
      logger.error?.('生成面板快照失败：%s', err?.message ?? err);
      fail(res, 500, '生成面板快照失败');
    }
  };

  const handleAction = async (req, res) => {
    // ① 先鉴权，再碰 body：被拒绝的请求不消耗请求体。
    if ((await checkOwner(ctx, req, res)) === null) return;
    if (req?.method && req.method !== 'POST') {
      fail(res, 405, '仅支持 POST');
      return;
    }

    // ② 内容类型（同样在读取 body 之前）。
    const body = await readJsonBody(req, res);
    if (body === undefined) return;

    const { action } = body;
    if (typeof action !== 'string' || action.length === 0) {
      fail(res, 400, '缺少 action');
      return;
    }
    if (!ACTIONS.includes(action)) {
      fail(res, 400, `未知动作：${action}`);
      return;
    }

    try {
      switch (action) {
        case 'link.connect':
          await link.start();
          break;
        case 'link.disconnect':
          await link.stop('面板断开');
          break;
        case 'link.restartScan':
          await link.restartScan('面板切换设备');
          break;
        case 'pair.submit': {
          const code = body?.payload?.code;
          if (typeof code !== 'string' || !/^\d{6}$/.test(code)) {
            fail(res, 400, '配对码必须是 6 位数字');
            return;
          }
          if (link.ready !== true) {
            fail(res, 409, '设备未连接，无法配对');
            return;
          }
          const handshake = link.handshake;
          if (!handshake || typeof handshake.beginPairing !== 'function') {
            fail(res, 409, '握手未就绪，无法配对');
            return;
          }
          await handshake.beginPairing(code);
          break;
        }
        case 'pair.unpair': {
          const deviceId = link.info?.deviceId;
          if (typeof deviceId !== 'string' || deviceId.length === 0) {
            fail(res, 409, '当前没有已配对设备');
            return;
          }
          if (!trust || typeof trust.load !== 'function' || typeof trust.save !== 'function') {
            fail(res, 503, '信任表不可用');
            return;
          }
          const table = (await trust.load()) ?? {};
          if (!Object.prototype.hasOwnProperty.call(table, deviceId)) {
            fail(res, 409, '当前设备不在信任表中');
            return;
          }
          delete table[deviceId];
          await trust.save(table);
          // 让本连接立即回到「未配对」：设备下一次 hello 会重新走配对。
          link.handshake?.reset?.();
          break;
        }
        default:
          // 白名单已挡住；这里是防御性兜底，保持零副作用。
          fail(res, 400, `未知动作：${action}`);
          return;
      }
    } catch (err) {
      logger.error?.('面板动作 %s 失败：%s', action, err?.message ?? err);
      fail(res, 500, `动作执行失败：${err?.message ?? err}`);
      return;
    }

    sendJson(res, 200, { ok: true, state: stateSnapshot() });
  };

  const disposers = [];
  const remember = (handle) => {
    if (typeof handle === 'function') disposers.push(handle);
    else if (handle && typeof handle.dispose === 'function') disposers.push(() => handle.dispose());
    else if (handle && typeof handle.unregister === 'function') disposers.push(() => handle.unregister());
  };

  remember(
    webServer.register({
      kind: 'exact',
      path: `${prefix}/state.json`,
      handler: handleState,
    }),
  );
  remember(
    webServer.register({
      kind: 'exact',
      path: `${prefix}/action`,
      handler: handleAction,
    }),
  );

  return {
    registered: true,
    disposeRoutes: disposers,
    dispose() {
      for (const fn of disposers.splice(0)) {
        try {
          fn();
        } catch (err) {
          logger.warn?.('注销面板路由失败：%s', err?.message ?? err);
        }
      }
    },
  };
}

export { ACTIONS as PASSPORT_ACTIONS, DEFAULT_PREFIX as PASSPORT_ROUTE_PREFIX };
