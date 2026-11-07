/**
 * BLE 桥工作进程的开扫路径测试。
 *
 * 守的是两条真机故障叠出来的链路：
 *   1. `startScanningAsync().catch(() => 走回调式)` 把「适配器 poweredOff」这类
 *      **业务性拒绝**误判成「老实现没有 Promise API」，原始错误被吞、类别丢失，
 *      主机侧再也认不出 adapter-off；
 *   2. 适配器刚从瞬断恢复时开扫仍可能被拒一帧，不重试就会把可自愈的抖动
 *      直接甩成红字（"state is poweredOff (not poweredOn)"）。
 *
 * bridge-worker.js 是独立进程（stdin/stdout JSON Lines），末尾的主循环会挂住
 * readline，不能直接 import。这里沿用 client-bundle.test.js 的做法：在 vm 里
 * 只执行「主循环之前」的类定义，注入最小依赖，测 Bridge 的方法本身。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const WORKER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bridge-worker.js')

async function loadBridge() {
  const source = await readFile(WORKER_PATH, 'utf8')
  const classOnly = source.split('// —— 主循环 ——')[0].replace(/^import .*$/gm, '')
  const sandbox = {
    process: { argv: [], stderr: { write() {} }, stdout: { write: () => true } },
    console, setTimeout, clearTimeout, Buffer,
    ADV: { MFG_TAG: 'FAP1' },
    DEVICE_NAME: 'test-device', SHORT_DEVICE_NAME: 'test', PROTOCOL_VERSION: 1,
    UUID: { SERVICE: '', RX: '', TX: '', VOICE: '', CTRL: '' },
  }
  vm.createContext(sandbox)
  vm.runInContext(`${classOnly}\nglobalThis.__Bridge = Bridge`, sandbox)
  return sandbox.__Bridge
}

/** 前 failTimes 次开扫抛 noble 原文错误，之后成功。 */
function rejectingNoble(failTimes) {
  return {
    state: 'poweredOn',
    calls: 0,
    async startScanningAsync() {
      this.calls += 1
      if (this.calls <= failTimes) {
        throw new Error('Could not start scanning, state is poweredOff (not poweredOn)')
      }
    },
  }
}

test('开扫被拒时保留 adapter-off 语义，不误判成「没有 Promise API」', async () => {
  const Bridge = await loadBridge()
  const bridge = new Bridge()
  bridge.noble = rejectingNoble(99)

  await assert.rejects(() => bridge.startScan(null), (error) => {
    assert.equal(error.code, 'adapter-off')
    assert.match(error.message, /poweredOff/)
    return true
  })
  assert.equal(bridge.scanning, false, '失败必须回滚，否则后续 scan 全被静默吞掉')
})

test('适配器瞬断被拒一次后重试成功，不留红字', async () => {
  const Bridge = await loadBridge()
  const bridge = new Bridge()
  bridge.noble = rejectingNoble(1)

  await bridge.startScan(null)
  assert.equal(bridge.noble.calls, 2, '应重试一次')
  assert.equal(bridge.scanning, true)
})

test('失败回滚后可以再次开扫；回调式的老 noble 实现仍兼容', async () => {
  const Bridge = await loadBridge()
  const bridge = new Bridge()
  bridge.noble = rejectingNoble(99)
  await assert.rejects(() => bridge.startScan(null))

  bridge.noble = rejectingNoble(0)
  await bridge.startScan(null)
  assert.equal(bridge.scanning, true, '回滚后不能被假状态卡死')

  const legacy = new Bridge()
  legacy.noble = { state: 'poweredOn', startScanning: (_uuids, _duplicates, cb) => cb(null) }
  await legacy.startScan(null)
  assert.equal(legacy.scanning, true)
})
