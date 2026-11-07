/**
 * 传输层错误分类测试。
 *
 * 这里守的是一条真实故障链：桥进程把 noble 的错误原样回给主机时只能带
 * code='unknown'，而消息里其实写着 "state is poweredOff" —— 如果分类器
 * 因为"已经是 TransportError"就短路返回，面板就永远显示"未知错误"，
 * 用户得不到"蓝牙未开启"这条唯一可操作的提示。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classifyError, humanizeError, Transport, TransportError, TRANSPORT_ERROR } from './transport.js'

test('未知类别的 TransportError 仍按 message 重新归类（poweredOff → adapter-off）', () => {
  // 与 @stoprocent/noble 的原文一致
  const raw = new TransportError(
    TRANSPORT_ERROR.UNKNOWN,
    'Could not start scanning, state is poweredOff (not poweredOn)',
  )
  const classified = classifyError(raw)
  assert.equal(classified.code, TRANSPORT_ERROR.ADAPTER_OFF)
  assert.ok(classified.hint, '应当给出"打开蓝牙后重试"的处置建议')
})

test('类别已明确的 TransportError 原样返回，不被 message 改写', () => {
  const error = new TransportError(TRANSPORT_ERROR.TIMEOUT, '适配器 poweredOff 超时')
  const classified = classifyError(error)
  assert.equal(classified, error)
  assert.equal(classified.code, TRANSPORT_ERROR.TIMEOUT)
})

test('普通 Error 仍按类别关键字归类', () => {
  assert.equal(classifyError(new Error('adapter powered off')).code, TRANSPORT_ERROR.ADAPTER_OFF)
  assert.equal(classifyError(new Error('Cannot find module native')).code, TRANSPORT_ERROR.NOT_AVAILABLE)
  assert.equal(classifyError(new Error('随便什么错')).code, TRANSPORT_ERROR.UNKNOWN)
})

// —— 真实反馈：挂件把 noble 的英文原文直接显示成红字 ——

test('类别正确但文案是 noble 原文时，humanizeError 给出中文提示与处置建议', () => {
  const raw = 'Could not start scanning, state is poweredOff (not poweredOn)'
  const error = new TransportError(TRANSPORT_ERROR.ADAPTER_OFF, raw)
  const human = humanizeError(error)
  assert.equal(human.code, TRANSPORT_ERROR.ADAPTER_OFF, '权威类别不能被改写')
  assert.equal(human.message, '系统蓝牙未开启')
  assert.match(human.hint, /打开蓝牙/)
  assert.match(String(human.cause?.message ?? ''), /poweredOff/, '原文必须留在 cause 供诊断')
})

test('humanizeError 不误伤已是中文的错误与普通 Error', () => {
  const error = new TransportError(TRANSPORT_ERROR.TIMEOUT, '连接超时')
  assert.equal(humanizeError(error), error)
  const plain = new Error('随便什么错')
  assert.equal(humanizeError(plain), plain)
})

test('Transport.startScan 抛底层原文时，对外 emit 的是可读中文错误', async () => {
  class FailingTransport extends Transport {
    async doStartScan() {
      throw new TransportError(
        TRANSPORT_ERROR.ADAPTER_OFF,
        'Could not start scanning, state is poweredOff (not poweredOn)',
      )
    }
  }
  const transport = new FailingTransport()
  const seen = []
  transport.on('error', (error) => seen.push(error))
  await assert.rejects(() => transport.startScan())
  assert.equal(seen.length, 1)
  assert.equal(seen[0].message, '系统蓝牙未开启')
  assert.match(seen[0].hint, /打开蓝牙/)
})
