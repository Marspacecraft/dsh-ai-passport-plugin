// Task 38 · host/tools.js
//
// 4 个 DSH Agent 工具：passport_status / passport_notify / passport_ask /
// passport_balance（docs/01 FR-HOST-4，docs/04 Task 38）。
//
// 宿主 API 形状（审计 /tmp/m7-host-audit.md §5.1，已安装插件实测）：
//
//   defineTool({ name, description, parameters, output: { schema, render }, execute })
//
// 本模块**不**在顶层调用 defineTool，也不 import 宿主包：这样 node --test 在
// 没有宿主的仓库里也能直接构造并执行工具。返回的对象字段与 defineTool 的入参
// 完全一致，宿主插件在 apply() 里对每一项做 ctx.tools.register(defineTool(def))
// 即可（不要在顶层注册，否则 import 本模块就会产生副作用）。
//
// 语义约定：
//   · 链路未连接时四个工具都不抛错，返回一句可读文案；
//   · passport_ask 始终带有限超时（默认 120s，调用方传 0/负数也回落到默认值），
//     超时/断链/取消都回明确结论，不会永远挂着；
//   · passport_balance 复用 pull.js 的余额语义：三个金额字段缺一即失败，失败
//     只回 notice，绝不补 0；
//   · 业务逻辑全部通过 createTools({...}) 注入依赖，不读全局、不注册任何东西。

import { MSG } from '../wire/constants.js';

const DEFAULT_ASK_TIMEOUT_MS = 120_000;
const BALANCE_UNAVAILABLE_TEXT = '未配置余额服务，无法查询余额';

const NOOP_LOG = Object.freeze({
  debug() {},
  info() {},
  warn() {},
  error() {},
});

function isOnline(link) {
  // 只认 ready；link.state 仅用于文案，不作为判定依据（重连中的 ready 必为 false）。
  return link?.ready === true;
}

function linkStateText(link) {
  const state = typeof link?.state === 'string' && link.state.length > 0 ? link.state : 'unknown';
  return state;
}

function asText(value) {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function errorText(err) {
  if (err instanceof Error && typeof err.message === 'string' && err.message.length > 0) {
    return err.message;
  }
  if (typeof err === 'string' && err.length > 0) return err;
  return '未知错误';
}

function renderText(_args, value) {
  return [{ type: 'text', text: String(value?.text ?? '') }];
}

const OUTPUT_BASE = {
  text: { type: 'string', required: true },
};

/**
 * 构造 4 个工具定义。
 *
 * @param {object} deps
 * @param {object} [deps.link]       Link 实例（ready/state/info/send）
 * @param {object} [deps.sessions]   Sessions 实例（snapshot）
 * @param {object} [deps.questions]  Questions 实例（handle）
 * @param {Function|object} [deps.balance] 余额 provider（函数或 { getBalance() }）
 * @param {object} [deps.log]
 * @returns {Array<{name:string,description:string,parameters:object,output:{schema:object,render:Function},execute:Function}>}
 */
export function createTools({ link, sessions, questions, balance, log } = {}) {
  const logger = log ?? NOOP_LOG;
  let askSeq = 0;

  function offlineResult(label) {
    return {
      connected: false,
      text: `设备未连接（${linkStateText(link)}），${label}`,
    };
  }

  // -------------------------------------------------------------------------
  // passport_status
  // -------------------------------------------------------------------------

  const status = {
    name: 'passport_status',
    description:
      '查看 AI Passport 设备链路状态、设备信息与当前会话数。设备未连接时返回可读说明，不抛错。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          connected: { type: 'boolean', required: true },
          text: { ...OUTPUT_BASE.text },
          state: { type: 'string' },
          sessionCount: { type: 'number' },
          deviceName: { type: 'string' },
          firmware: { type: 'string' },
          deviceId: { type: 'string' },
        },
      },
      render: renderText,
    },
    async execute() {
      if (!isOnline(link)) {
        return { ...offlineResult('暂时无法获取链路状态'), sessionCount: 0 };
      }

      const info = link.info ?? {};
      const snapshot = sessions?.snapshot?.();
      const list = Array.isArray(snapshot)
        ? snapshot
        : Array.isArray(snapshot?.sessions)
          ? snapshot.sessions
          : [];

      const name = typeof info.name === 'string' && info.name.length > 0 ? info.name : '未知设备';
      const parts = [`设备已连接：${name}`];
      if (typeof info.firmware === 'string' && info.firmware.length > 0) {
        parts.push(`固件 ${info.firmware}`);
      }
      if (typeof info.deviceId === 'string' && info.deviceId.length > 0) {
        parts.push(`ID ${info.deviceId}`);
      }
      parts.push(`${list.length} 个会话`);

      const result = {
        connected: true,
        text: parts.join('，'),
        state: linkStateText(link),
        sessionCount: list.length,
      };
      if (typeof info.name === 'string') result.deviceName = info.name;
      if (typeof info.firmware === 'string') result.firmware = info.firmware;
      if (typeof info.deviceId === 'string') result.deviceId = info.deviceId;
      return result;
    },
  };

  // -------------------------------------------------------------------------
  // passport_notify
  // -------------------------------------------------------------------------

  const notify = {
    name: 'passport_notify',
    description:
      '让 AI Passport 设备提示用户（toast / 提示音 / 背光，取决于设备能力）。设备未连接时返回可读说明，不抛错。',
    parameters: {
      text: { type: 'string', required: true, description: '要显示在设备上的提示文本。' },
      urgent: { type: 'boolean', description: '是否以更醒目方式提示（设备自行决定）。' },
      sound: { type: 'boolean', description: '是否请求提示音（设备有扬声器时）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          delivered: { type: 'boolean', required: true },
          text: { ...OUTPUT_BASE.text },
        },
      },
      render: renderText,
    },
    async execute(args = {}) {
      const text = typeof args.text === 'string' ? args.text : '';
      if (text.trim().length === 0) {
        return { delivered: false, text: '提示内容不能为空' };
      }
      if (!isOnline(link)) {
        return { delivered: false, text: `设备未连接（${linkStateText(link)}），未发送提示` };
      }

      const payload = { text };
      if (typeof args.urgent === 'boolean') payload.urgent = args.urgent;
      if (typeof args.sound === 'boolean') payload.sound = args.sound;

      try {
        await link.send(MSG.NOTICE, payload, { ack: true });
        return { delivered: true, text: `已让设备提示：${text}` };
      } catch (err) {
        const reason = errorText(err);
        logger.warn?.('passport_notify 发送失败：%s', reason);
        return { delivered: false, text: `提示发送失败：${reason}` };
      }
    },
  };

  // -------------------------------------------------------------------------
  // passport_ask
  // -------------------------------------------------------------------------

  function normalizeTimeout(value) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return Math.round(number);
    // 0 / 负数 / NaN 一律回落默认值：工具不允许无限期等待。
    return DEFAULT_ASK_TIMEOUT_MS;
  }

  function formatAskResult(result, timeoutMs) {
    if (result && typeof result === 'object' && Array.isArray(result.answers)) {
      const pieces = result.answers.map((answer) => {
        const id = typeof answer?.id === 'string' && answer.id.length > 0 ? answer.id : '?';
        const selected = Array.isArray(answer?.selected)
          ? answer.selected.filter((item) => typeof item === 'string' && item.length > 0)
          : [];
        const custom = typeof answer?.custom === 'string' && answer.custom.trim().length > 0
          ? answer.custom.trim()
          : null;
        const value = selected.length > 0 ? selected.join('、') : custom ?? '（未选择）';
        return `${id}：${value}`;
      });
      return {
        answered: true,
        text: pieces.length > 0 ? `用户回答：${pieces.join('；')}` : '用户回答：（空）',
        answers: result.answers,
      };
    }

    const reason = typeof result?.reason === 'string' ? result.reason : 'unknown';
    if (reason === 'timeout') {
      return {
        answered: false,
        timedOut: true,
        cancelled: true,
        reason,
        text: `设备提问超时（${Math.round(timeoutMs / 1000)} 秒），未收到回答`,
      };
    }
    if (reason === 'disconnect') {
      return {
        answered: false,
        disconnected: true,
        cancelled: true,
        reason,
        text: '设备已断开，提问未完成',
      };
    }
    if (reason === 'cancel' || reason === 'reject') {
      return {
        answered: false,
        cancelled: true,
        reason,
        text: '用户取消了提问',
      };
    }
    return {
      answered: false,
      cancelled: true,
      reason,
      text: `提问未完成（${reason}）`,
    };
  }

  const ask = {
    name: 'passport_ask',
    description:
      '经 AI Passport 设备向用户提问。必须带有限超时；超时、断链或用户取消都会返回明确结论，不会无限等待。设备未连接时直接返回可读说明。',
    parameters: {
      question: { type: 'string', required: true, description: '要问用户的问题。' },
      options: {
        type: 'array',
        items: { type: 'string' },
        description: '可选选项文本；不传则只允许自定义回答。',
      },
      timeoutMs: {
        type: 'number',
        description: `等待用户回答的超时毫秒数，默认 ${DEFAULT_ASK_TIMEOUT_MS}；0 或负数按默认值处理。`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          answered: { type: 'boolean', required: true },
          text: { ...OUTPUT_BASE.text },
          timedOut: { type: 'boolean' },
          disconnected: { type: 'boolean' },
          cancelled: { type: 'boolean' },
          reason: { type: 'string' },
          answers: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                selected: { type: 'array', items: { type: 'string' } },
                custom: { oneOf: [{ type: 'string' }, { type: 'null' }] },
              },
            },
          },
        },
      },
      render: renderText,
    },
    async execute(args = {}) {
      const question = typeof args.question === 'string' ? args.question.trim() : '';
      if (question.length === 0) {
        return { answered: false, text: '问题内容不能为空' };
      }
      if (!isOnline(link)) {
        return { ...offlineResult('无法向设备提问'), answered: false };
      }
      if (!questions || typeof questions.handle !== 'function') {
        return { answered: false, text: '提问服务不可用，无法向设备提问' };
      }

      const timeoutMs = normalizeTimeout(args.timeoutMs);
      const options = Array.isArray(args.options)
        ? args.options.filter((item) => typeof item === 'string' && item.length > 0)
        : [];
      const request = {
        callId: `passport_ask_${++askSeq}`,
        kind: 'choice',
        deadlineMs: timeoutMs,
        questions: [
          {
            id: 'q1',
            question,
            options: options.map((label) => ({ label })),
          },
        ],
      };

      let result;
      try {
        result = await questions.handle(request);
      } catch (err) {
        const reason = errorText(err);
        logger.warn?.('passport_ask 提问失败：%s', reason);
        return { answered: false, text: `提问失败：${reason}` };
      }
      return formatAskResult(result, timeoutMs);
    },
  };

  // -------------------------------------------------------------------------
  // passport_balance
  // -------------------------------------------------------------------------

  async function readBalance() {
    if (typeof balance === 'function') return balance();
    if (balance && typeof balance.getBalance === 'function') return balance.getBalance();
    // 直接注入一份余额快照也允许（宿主可以把已缓存的账户信息原样交给工具）。
    if (balance && typeof balance === 'object') return balance;
    throw new Error(BALANCE_UNAVAILABLE_TEXT);
  }

  function balanceNotice(text) {
    return { ok: false, text, notice: { text } };
  }

  const balanceTool = {
    name: 'passport_balance',
    description:
      '查询 AI Passport 账户余额。失败时返回 notice 语义的可读说明，绝不伪造 0。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          text: { ...OUTPUT_BASE.text },
          currency: { type: 'string' },
          totalBalance: { type: 'string' },
          recharge: { type: 'string' },
          bonus: { type: 'string' },
          notice: {
            type: 'object',
            additionalProperties: false,
            properties: { text: { type: 'string', required: true } },
          },
        },
      },
      render: renderText,
    },
    async execute() {
      let value;
      try {
        value = await readBalance();
      } catch (err) {
        const reason = errorText(err);
        logger.warn?.('passport_balance 获取失败：%s', reason);
        const text = reason === BALANCE_UNAVAILABLE_TEXT
          ? BALANCE_UNAVAILABLE_TEXT
          : `未获取到余额：${reason}`;
        return balanceNotice(text);
      }

      if (value === null || typeof value !== 'object') {
        return balanceNotice('未获取到余额：余额服务返回空结果');
      }

      const totalBalance = asText(value.totalBalance);
      const recharge = asText(value.recharge);
      const bonus = asText(value.bonus);
      if (totalBalance === null || recharge === null || bonus === null) {
        return balanceNotice('未获取到余额：余额字段不完整');
      }

      const currency = typeof value.currency === 'string' && value.currency.length > 0
        ? value.currency
        : 'CNY';
      return {
        ok: true,
        currency,
        totalBalance,
        recharge,
        bonus,
        text: `余额 ${currency} ${totalBalance}（充值 ${recharge}，赠送 ${bonus}）`,
      };
    },
  };

  return [status, notify, ask, balanceTool];
}

export default createTools;
