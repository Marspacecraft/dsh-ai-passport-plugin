/**
 * 控制面板错误横幅的生命周期测试。
 *
 * 真实故障：断链重连的第一次开扫撞上蓝牙瞬断，红字「Could not start scanning...」
 * 被写进 lastError 后面板用 timeoutMs=0 挂成永久横幅；后来扫描恢复了，
 * renderDevice 只有 `if (lastError)` 没有 else，横幅永远不消失 ——
 * 于是出现「扫描中」+「蓝牙未开启」这种自相矛盾的画面。
 *
 * panel.js 是浏览器脚本、没有导出，沿用 client-bundle.test.js 的 vm 手法，
 * 注入最小 DOM 替身后从模块内部取出函数直接驱动。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const PANEL_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../lib/panel/static/panel.js')

function makeElement() {
  const classes = new Set()
  return {
    textContent: '', className: '', dataset: {}, style: {}, children: [], disabled: false,
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
    },
    replaceChildren(...items) { this.children = items },
    append(...items) { this.children.push(...items) },
    prepend() {},
    addEventListener() {},
    removeEventListener() {},
    get lastElementChild() { return this.children[this.children.length - 1] },
  }
}

async function loadPanel() {
  const source = await readFile(PANEL_PATH, 'utf8')
  const byId = new Map()
  const document = {
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, makeElement())
      return byId.get(id)
    },
    createElement: () => makeElement(),
    addEventListener() {},
  }
  const sandbox = {
    document,
    console,
    setTimeout, clearTimeout,
    setInterval: () => 1, clearInterval: () => {},
    // 永不 settle：启动时的初始 fetch 不会干扰同步断言
    fetch: () => new Promise(() => {}),
    EventSource: undefined,
  }
  vm.createContext(sandbox)
  vm.runInContext(`${source}\nglobalThis.__panel = { applyState, showBanner, els }`, sandbox)
  return sandbox.__panel
}

const withError = {
  link: { state: 'scanning', lastError: { message: '系统蓝牙未开启', hint: '打开蓝牙后重试' } },
  tasks: [], approvals: [],
}
const recovered = { link: { state: 'scanning', lastError: null }, tasks: [], approvals: [] }

test('链路恢复后自动收起持久错误横幅', async () => {
  const { applyState, els } = await loadPanel()
  const banner = els.banner

  applyState(withError)
  assert.match(banner.textContent, /系统蓝牙未开启/)
  assert.equal(banner.dataset.persistent, '1')
  assert.equal(banner.classList.contains('hidden'), false)

  applyState(recovered)
  assert.equal(banner.dataset.persistent, undefined, '持久标记必须清除')
  assert.equal(banner.classList.contains('hidden'), true, '旧红字必须收起')
})

test('临时提示会清掉持久标记，不会被当成旧错误误隐藏', async () => {
  const { applyState, showBanner, els } = await loadPanel()
  const banner = els.banner

  applyState(withError)
  showBanner('已断开连接', 'info')
  assert.equal(banner.dataset.persistent, undefined)
  assert.match(banner.textContent, /已断开连接/)

  applyState(recovered)
  assert.equal(banner.classList.contains('hidden'), false, '临时提示不该被链路恢复顺手收掉')
  clearTimeout(showBanner.timer)
})
