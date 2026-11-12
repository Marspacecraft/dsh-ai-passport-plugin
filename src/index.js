// Task 41 · 宿主半区装配（Cordis 插件）
//
// 现代码本来就没有 src/index.js，package.json 的 main 指向一个不存在的文件，
// 插件根本装不起来。本文件把 M2–M7 的模块装配成一个 Cordis 插件：
//
//   transport(bridge | mock) → Link → Sessions/Timeline → Approvals/Questions
//   → ApiServer(push/pull/control/asr) → 面板路由 → 四个 Agent 工具
//
// 两条硬约束：
//   1. **import 本文件不得有副作用**：不在顶层 new Link、不 spawn、不开定时器。
//      所有构造都发生在 apply() 里。
//   2. disposer 必须能停干净：注销工具与路由、停 link、停 server、dispose
//      sessions/timeline/asr，确保卸载插件后事件循环没有残留句柄。
//
// Config 用「等价 schema」：本包没有 dependencies，不能硬 import
// @deepseek-ai/schemastery；导出一个字段与默认值都明确的只读对象，宿主侧
// 可以原样作为配置默认值使用。apply() 会逐项校验，非法值直接抛清晰错误。

import { BridgeClient } from './ble/bridge-client.js';
import { MockTransport } from './ble/mock-transport.js';
import { Link, createTrustStore } from './link/index.js';
import { Sessions } from './host/sessions.js';
import { Timeline } from './host/timeline.js';
import { Approvals } from './host/approvals.js';
import { Questions } from './host/questions.js';
import { createTools } from './host/tools.js';
import { registerPassportRoutes } from './host/routes.js';
import { ApiServer } from './api/server.js';
import { PushCapability } from './api/push.js';
import { PullCapability } from './api/pull.js';
import { ControlCapability } from './api/control.js';
import { AsrCapability } from './api/asr.js';

export const name = 'dsh-ai-passport';

/**
 * 配置默认值（schemastery 等价物）。
 *
 * transport: 'bridge' 走父子进程蓝牙桥；'mock' 走内存虚拟设备（开发/测试）。
 * autoStart: apply 后是否立刻开始扫描/连接。import 不产生任何副作用，只有
 *            apply + autoStart 才会碰蓝牙。
 */
export const Config = Object.freeze({
  transport: 'bridge',
  autoStart: true,
  chunkPayload: 510,
  mtuPayload: 512,
  trustDir: undefined,
  routePrefix: '/dsh-passport',
  transportOptions: Object.freeze({}),
  mock: Object.freeze({}),
  balance: null,
  asr: null,
  cancelSession: null,
  sessionInput: null,
});

const NOOP_LOG = Object.freeze({
  debug() {},
  info() {},
  warn() {},
  error() {},
});

function normalizeConfig(raw) {
  const cfg = { ...Config, ...(raw && typeof raw === 'object' ? raw : {}) };
  if (cfg.transport !== 'bridge' && cfg.transport !== 'mock') {
    throw new TypeError(`transport 只能是 'bridge' 或 'mock'，收到 ${JSON.stringify(cfg.transport)}`);
  }
  for (const key of ['chunkPayload', 'mtuPayload']) {
    if (!Number.isInteger(cfg[key]) || cfg[key] <= 0) {
      throw new TypeError(`${key} 必须是正整数，收到 ${JSON.stringify(cfg[key])}`);
    }
  }
  if (typeof cfg.routePrefix !== 'string' || !cfg.routePrefix.startsWith('/')) {
    throw new TypeError(`routePrefix 必须以 / 开头，收到 ${JSON.stringify(cfg.routePrefix)}`);
  }
  return cfg;
}

function makeTransport(cfg) {
  const options = { mtuPayload: cfg.mtuPayload, ...(cfg.transportOptions ?? {}) };
  if (cfg.transport === 'mock') {
    const mockOptions = { ...(cfg.mock ?? {}), ...(cfg.transportOptions ?? {}) };
    mockOptions.mtuPayload = cfg.mtuPayload;
    return new MockTransport(mockOptions);
  }
  return new BridgeClient(options);
}

function makeLog(ctx) {
  const logger = ctx?.logger;
  if (!logger) return NOOP_LOG;
  return {
    debug: (...args) => logger.debug?.(...args),
    info: (...args) => logger.info?.(...args),
    warn: (...args) => logger.warn?.(...args),
    error: (...args) => logger.error?.(...args),
  };
}

/**
 * Cordis 插件入口。
 *
 * @param {object} ctx Cordis 上下文（tools / logger / get）
 * @param {object} [rawConfig] 见 {@link Config}
 * @returns {() => Promise<void>} disposer
 */
export function apply(ctx, rawConfig = {}) {
  const cfg = normalizeConfig(rawConfig);
  const log = makeLog(ctx);

  const trust = createTrustStore(cfg.trustDir ? { dir: cfg.trustDir } : undefined);
  const transport = makeTransport(cfg);
  const link = new Link({
    transport,
    store: trust,
    chunkPayload: cfg.chunkPayload,
    logger: log,
  });

  const sessions = new Sessions({ log });
  const timeline = new Timeline({ log });
  const approvals = new Approvals({ link, log, sessions, config: cfg });
  const questions = new Questions({ link, log, sessions });

  const host = {
    sessions,
    approvals,
    questions,
    asr: cfg.asr,
    cancelSession: cfg.cancelSession,
    input: cfg.sessionInput,
  };

  const push = new PushCapability({ link, log, host });
  const pull = new PullCapability({ link, log, host, timeline, balanceProvider: cfg.balance });
  const control = new ControlCapability({ link, log, host });
  const asr = new AsrCapability({ link, log, host });
  const server = new ApiServer({ link, log, host, capabilities: [push, pull, control, asr] });

  const routes = registerPassportRoutes({
    ctx,
    link,
    sessions,
    timeline,
    asr,
    trust,
    log,
    prefix: cfg.routePrefix,
  });

  // 工具定义已经是 defineTool 入参的完整形状（host/tools.js 顶部有审计依据）。
  // 宿主若在 ctx 上暴露了 defineTool 就用它；否则恒等函数——绝不能为了一个
  // 可选包装去 import 宿主包，否则无宿主环境下 import 本文件就会失败。
  const defineTool = typeof ctx?.defineTool === 'function' ? ctx.defineTool : (definition) => definition;
  const toolDisposers = [];
  const tools = createTools({ link, sessions, questions, balance: cfg.balance, log });
  if (ctx?.tools && typeof ctx.tools.register === 'function') {
    for (const definition of tools) {
      const handle = ctx.tools.register(defineTool(definition));
      if (typeof handle === 'function') toolDisposers.push(handle);
      else if (handle && typeof handle.dispose === 'function') toolDisposers.push(() => handle.dispose());
    }
  }

  const serverStarted = server.start();
  Promise.resolve(serverStarted).catch((err) => {
    log.error?.('ApiServer 启动失败：%s', err?.message ?? err);
  });

  if (cfg.autoStart) {
    // 不阻塞 apply：真实 BLE 扫描可能很久；失败由 link 自己按退避重连。
    Promise.resolve()
      .then(() => link.start())
      .catch((err) => log.warn?.('Link 自动启动失败：%s', err?.message ?? err));
  }

  let disposed = false;
  return async () => {
    if (disposed) return;
    disposed = true;

    for (const fn of toolDisposers.splice(0)) {
      try {
        await fn();
      } catch (err) {
        log.warn?.('注销工具失败：%s', err?.message ?? err);
      }
    }
    try {
      routes.dispose();
    } catch (err) {
      log.warn?.('注销面板路由失败：%s', err?.message ?? err);
    }
    try {
      // 先结算在飞的审批/提问，避免它们的超时计时器拖住进程退出。
      approvals.onDisconnect?.();
      questions.onDisconnect?.();
    } catch (err) {
      log.warn?.('结算在飞请求失败：%s', err?.message ?? err);
    }
    try {
      await server.stop();
    } catch (err) {
      log.warn?.('停止 ApiServer 失败：%s', err?.message ?? err);
    }
    try {
      pull.dispose();
    } catch (err) {
      log.warn?.('释放 Pull 失败：%s', err?.message ?? err);
    }
    try {
      await link.stop('插件卸载');
    } catch (err) {
      log.warn?.('停止 Link 失败：%s', err?.message ?? err);
    }
    try {
      asr.dispose();
    } catch (err) {
      log.warn?.('释放 ASR 失败：%s', err?.message ?? err);
    }
    try {
      sessions.dispose();
    } catch (err) {
      log.warn?.('释放 Sessions 失败：%s', err?.message ?? err);
    }
    try {
      timeline.dispose();
    } catch (err) {
      log.warn?.('释放 Timeline 失败：%s', err?.message ?? err);
    }
  };
}
