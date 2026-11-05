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

import { classifyError, TransportError, TRANSPORT_ERROR } from './transport.js'

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
