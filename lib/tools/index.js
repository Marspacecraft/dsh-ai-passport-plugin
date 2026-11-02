/**
 * Agent 工具：让 DSH 自己也能操作设备。
 *
 * 这一层把"设备"变成 Agent 可调用的能力，于是双向都通了：
 *   - 用户 → 设备 → 任务（设备上发起）
 *   - Agent → 设备 → 用户（Agent 在设备上提问/提醒，拿回用户的回答）
 *
 * 每个工具都遵守两条约定：
 *   1. **失败要说清楚为什么**，包括"设备没连上"这种最常见的情况，
 *      而不是抛一个空栈的异常让模型去猜；
 *   2. **不在设备上做危险的事**（审批放行、删除任务）——那些只由用户在设备上主动按键触发。
 *
 * 关于 `output`：DSH 0.2.1 起，`tools.register()` 强制要求每个工具声明
 * `output: { schema, render }`（缺了会直接抛 TypeError，整批工具都注册不上）。
 * 这里每个工具都声明返回值 schema，并用 `textBlock()` 把结果渲染成一个文本块。
 * schema 里刻意只用宿主支持的子集（type / oneOf / properties / items / enum / const），
 * 可空字段一律写成 `oneOf: [..., { type: 'null' }]`——宿主的校验器不支持 type 数组。
 */

import { MSG } from '../protocol/constants.js'

/**
 * 注册全部工具。
 *
 * @param {object} ctx 宿主上下文（已确保 tools 服务存在）
 * @param {object} runtime createRuntime 产出的运行时
 * @param {(level:string, message:string)=>void} logger
 * @returns {Array<() => void>} 注销函数
 */
export function registerTools(ctx, runtime, logger) {
  const tools = ctx.tools ?? (typeof ctx.get === 'function' ? ctx.get('tools') : null)
  if (!tools?.register) {
    logger('debug', '[tools] 宿主没有 tools 服务，跳过工具注册')
    return []
  }

  const disposers = []
  const define = (definition) => {
    // 单个工具注册失败不应该带走其它工具：逐个 try/catch，失败只记日志。
    try {
      disposers.push(tools.register(definition))
    } catch (error) {
      logger('warn', `[tools] 工具 ${definition.name} 注册失败：${error?.message ?? error}`)
    }
  }

  define({
    name: 'ap_device_status',
    description:
      '读取 AI Passport 掌上设备的连接状态：链路是否连通、固件与协议版本、电量、信号强度、链路统计。在需要确认"设备是否可用"或排查连接问题时先调用它。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: {
          connected: { type: 'boolean', description: '链路是否已连通' },
          state: { type: 'string', description: '链路状态机的当前状态' },
          transport: { type: 'string', description: '当前传输方式：bridge / noble / mock' },
          handshakeComplete: { type: 'boolean', description: '协议握手是否完成' },
          device: {
            description: '已连接的设备；未连接时为 null',
            oneOf: [
              {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  name: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                  rssi: { oneOf: [{ type: 'number' }, { type: 'null' }] },
                },
                additionalProperties: true,
              },
              { type: 'null' },
            ],
          },
          firmware: { description: '设备固件版本', oneOf: [{ type: 'string' }, { type: 'null' }] },
          protocolVersion: { description: '设备上报的协议版本', oneOf: [{ type: 'number' }, { type: 'null' }] },
          batteryPercent: { description: '设备电量百分比', oneOf: [{ type: 'number' }, { type: 'null' }] },
          stats: { type: 'object', description: '链路统计（收发、重连、队列、ACK）' },
          lastError: {
            description: '最近一次链路错误；没有则为 null',
            oneOf: [
              {
                type: 'object',
                properties: {
                  code: { type: 'string' },
                  message: { type: 'string' },
                  hint: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                },
                additionalProperties: true,
              },
              { type: 'null' },
            ],
          },
          hint: { description: '给模型的下一步提示', oneOf: [{ type: 'string' }, { type: 'null' }] },
        },
        additionalProperties: true,
      },
      render: (_args, value) => textBlock(renderStatus(value)),
    },
    async execute() {
      const snapshot = runtime.snapshot()
      const link = snapshot.link
      return {
        connected: link.state === 'connected',
        state: String(link.state ?? 'unknown'),
        transport: String(snapshot.transport ?? 'unknown'),
        handshakeComplete: Boolean(link.handshakeComplete),
        device: link.device
          ? {
              id: String(link.device.id ?? ''),
              name: link.device.name == null ? null : String(link.device.name),
              rssi: Number.isFinite(link.device.rssi) ? link.device.rssi : null,
            }
          : null,
        firmware: link.deviceInfo?.firmware == null ? null : String(link.deviceInfo.firmware),
        protocolVersion: finiteOrNull(link.deviceInfo?.protocolVersion),
        batteryPercent: finiteOrNull(link.deviceInfo?.batteryPercent),
        stats: sanitizeStats(link.stats),
        lastError: link.lastError
          ? {
              code: String(link.lastError.code ?? ''),
              message: String(link.lastError.message ?? ''),
              hint: link.lastError.hint == null ? null : String(link.lastError.hint),
            }
          : null,
        hint: link.state === 'connected' ? null : '设备未连接时无法下发任何指令；可在控制面板 /dsh-passport 点「扫描并连接」。',
      }
    },
  })

  define({
    name: 'ap_device_notify',
    description:
      '在 AI Passport 设备屏幕上显示一条提示，并让设备响提示音。适合"任务做完了""需要你过来看一下"这类需要触达用户本人的场合——用户可能不在电脑前。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要显示的文本，建议不超过 40 个字' },
        urgent: { type: 'boolean', description: '是否使用更醒目的提醒（不同提示音 + 背光闪烁）' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          delivered: { type: 'boolean', description: '是否已下发到设备' },
          text: { type: 'string', description: '实际下发的文本（过长会被截断）' },
        },
        required: ['delivered', 'text'],
        additionalProperties: false,
      },
      render: (_args, value) => textBlock(`已在设备上显示：${value.text}`),
    },
    async execute(input) {
      requireConnection(runtime)
      const text = String(input.text ?? '').trim()
      if (!text) throw new Error('提示文本不能为空')
      const displayed = text.slice(0, 120)
      await runtime.link.send(MSG.TOAST, { text: displayed, urgent: Boolean(input.urgent) })
      return { delivered: true, text: displayed }
    },
  })

  define({
    name: 'ap_device_ask',
    description:
      '在 AI Passport 设备上向用户提问，并等待用户在设备上按键作答。当需要用户立刻确认一个选择、而用户可能不在电脑前时使用。设备只有三个按键，因此问题应当是"是/否"或少量选项。',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '问题文本，建议不超过 30 个字' },
        options: {
          type: 'array',
          description: '可选项，最多 4 个；省略时默认 ["确定", "取消"]',
          items: { type: 'string' },
        },
        timeoutSeconds: { type: 'number', description: '等待秒数，默认 60，最大 300' },
      },
      required: ['question'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          answered: { type: 'boolean', description: '用户是否在设备上作答' },
          selectedIndex: { description: '选项下标；未作答时为 null', oneOf: [{ type: 'number' }, { type: 'null' }] },
          selected: { description: '选中的文本；未作答时为 null', oneOf: [{ type: 'string' }, { type: 'null' }] },
          reason: { description: '未作答的原因；已作答时为 null', oneOf: [{ type: 'string' }, { type: 'null' }] },
        },
        required: ['answered', 'selectedIndex', 'selected', 'reason'],
        additionalProperties: false,
      },
      render: (_args, value) =>
        textBlock(value.answered ? `用户在设备上选择了「${value.selected}」` : value.reason),
    },
    async execute(input) {
      requireConnection(runtime)
      const question = String(input.question ?? '').trim()
      if (!question) throw new Error('问题不能为空')
      const options = Array.isArray(input.options) && input.options.length > 0
        ? input.options.slice(0, 4).map((option) => String(option))
        : ['确定', '取消']
      const timeoutSeconds = Math.min(300, Math.max(5, Number(input.timeoutSeconds) || 60))

      const id = `ask-${Date.now().toString(36)}`
      const answer = await askDevice(runtime, { id, question, options, timeoutSeconds })
      if (answer === null) {
        return {
          answered: false,
          selectedIndex: null,
          selected: null,
          reason: '用户在设备上没有作答（超时或断开），请改用普通提问。',
        }
      }
      return {
        answered: true,
        selectedIndex: answer.index,
        selected: options[answer.index] ?? null,
        reason: null,
      }
    },
  })

  define({
    name: 'ap_balance',
    description:
      '读取 DeepSeek 账户余额（总额 / 充值余额 / 赠送余额）。设备上的余额页用的是同一份数据。',
    parameters: {
      type: 'object',
      properties: {
        refresh: { type: 'boolean', description: '是否强制忽略缓存重新拉取，默认 false' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          available: { type: 'boolean', description: '是否拿到了余额' },
          currency: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          totalBalance: { oneOf: [{ type: 'number' }, { type: 'null' }] },
          rechargeBalance: { oneOf: [{ type: 'number' }, { type: 'null' }] },
          bonusBalance: { oneOf: [{ type: 'number' }, { type: 'null' }] },
          todayUsed: { oneOf: [{ type: 'number' }, { type: 'null' }] },
          source: { description: '余额来源（账号接口 / API key）', oneOf: [{ type: 'string' }, { type: 'null' }] },
          fetchedAt: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'null' }] },
          reason: { description: '取不到余额时的原因；成功时为 null', oneOf: [{ type: 'string' }, { type: 'null' }] },
          hint: { description: '取不到余额时的下一步提示；成功时为 null', oneOf: [{ type: 'string' }, { type: 'null' }] },
        },
        required: ['available'],
        additionalProperties: true,
      },
      render: (_args, value) => textBlock(renderBalance(value)),
    },
    async execute(input) {
      const balance = await runtime.domains.balance.refresh({ force: Boolean(input.refresh), push: false })
      if (!balance) {
        return {
          available: false,
          currency: null,
          totalBalance: null,
          rechargeBalance: null,
          bonusBalance: null,
          todayUsed: null,
          source: null,
          fetchedAt: null,
          reason: runtime.snapshot().balanceError ?? '未获取到余额',
          hint: '可以在 DSH 里登录 DeepSeek 账号，或配置 API key。',
        }
      }
      return {
        available: true,
        currency: balance.currency == null ? null : String(balance.currency),
        totalBalance: finiteOrNull(balance.totalBalance),
        rechargeBalance: finiteOrNull(balance.rechargeBalance),
        bonusBalance: finiteOrNull(balance.bonusBalance),
        todayUsed: finiteOrNull(balance.todayUsed),
        source: balance.source == null ? null : String(balance.source),
        fetchedAt: toJsonScalar(balance.fetchedAt),
        reason: null,
        hint: null,
      }
    },
  })

  return disposers
}

/** 宿主 output.render 的内容块格式：一个文本块。 */
function textBlock(text) {
  return [{ type: 'text', text: String(text ?? '') }]
}

function renderStatus(value) {
  const lines = [
    `连接状态：${value.connected ? '已连接' : '未连接'}（${value.state}）`,
    `传输方式：${value.transport}`,
    `协议握手：${value.handshakeComplete ? '已完成' : '未完成'}`,
  ]
  if (value.device) {
    const name = value.device.name ?? value.device.id
    const rssi = value.device.rssi == null ? '' : `，信号 ${value.device.rssi} dBm`
    lines.push(`设备：${name}${rssi}`)
  } else {
    lines.push('设备：无')
  }
  if (value.firmware != null) lines.push(`固件：${value.firmware}（协议 v${value.protocolVersion ?? '?'}）`)
  if (value.batteryPercent != null) lines.push(`电量：${value.batteryPercent}%`)
  const stats = value.stats ?? {}
  const statText = Object.entries(STAT_LABELS)
    .filter(([key]) => typeof stats[key] === 'number')
    .map(([key, label]) => `${label} ${stats[key]}`)
    .join(' / ')
  if (statText) lines.push(`链路统计：${statText}`)
  if (value.lastError) lines.push(`最近错误：${value.lastError.code} ${value.lastError.message}`)
  if (value.hint) lines.push(`提示：${value.hint}`)
  return lines.join('\n')
}

const STAT_LABELS = {
  messagesOut: '发送',
  messagesIn: '接收',
  bytesDropped: '丢弃字节',
  gaps: '序号缺口',
  ackTimeouts: 'ACK 超时',
  reconnects: '重连',
}

function renderBalance(value) {
  if (!value.available) {
    const lines = [`未取到余额：${value.reason}`]
    if (value.hint) lines.push(`提示：${value.hint}`)
    return lines.join('\n')
  }
  const currency = value.currency ?? ''
  const lines = [`总余额：${currency} ${formatAmount(value.totalBalance)}`]
  if (value.rechargeBalance != null) lines.push(`充值余额：${currency} ${formatAmount(value.rechargeBalance)}`)
  if (value.bonusBalance != null) lines.push(`赠送余额：${currency} ${formatAmount(value.bonusBalance)}`)
  if (value.todayUsed != null) lines.push(`今日消耗：${currency} ${formatAmount(value.todayUsed)}`)
  return lines.join('\n')
}

function formatAmount(value) {
  return value == null ? '—' : String(value)
}

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 只保留可安全 JSON 序列化的统计字段，避免 undefined / BigInt 触发 schema 校验失败。 */
function sanitizeStats(stats) {
  const out = {}
  for (const [key, value] of Object.entries(stats ?? {})) {
    if (typeof value === 'string' || typeof value === 'boolean') out[key] = value
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
  }
  return out
}

function toJsonScalar(value) {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return null
}

function requireConnection(runtime) {
  const state = runtime.link.snapshot().state
  if (state !== 'connected') {
    throw new Error(
      `AI Passport 未连接（当前状态：${state}），无法在设备上显示内容。请先确认设备已开机并在广播，然后打开控制面板 /dsh-passport 点「扫描并连接」。`,
    )
  }
}

/**
 * 在设备上提问并等作答。
 *
 * 走的是审批域那套"请求-应答"机制（同一份 pending 表），
 * 因此超时、断链、面板代答这些边界情况只需要维护一处。
 */
function askDevice(runtime, { id, question, options, timeoutSeconds }) {
  const approval = runtime.domains.approval
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      approval.pending.delete(id)
      resolve(null)
    }, timeoutSeconds * 1000)
    timer.unref?.()

    approval.pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer)
        // 设备回的是 options 的下标，这里做一次范围校验，避免越界取值
        const index = Number(value?.index)
        resolve(Number.isInteger(index) && index >= 0 && index < options.length ? { index } : null)
      },
      timer,
      request: { id, question, options, kind: 'question' },
      settled: false,
    })

    void runtime.link
      .send(MSG.QUESTION_REQ, { id, question, options, timeoutMs: timeoutSeconds * 1000 })
      .catch(() => {
        clearTimeout(timer)
        approval.pending.delete(id)
        resolve(null)
      })
  })
}
