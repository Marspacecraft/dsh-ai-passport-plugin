/**
 * 子进程侧 BLE 桥 worker（docs/04 Task 2）。
 *
 * 独立进程，只依赖 `node:readline` 与（懒加载的）noble。
 * 它不知道自己服务的是 AI Passport，只认「这个 UUID 特征要 write、
 * 那个要 subscribe」（docs/02 §4.2）。
 *
 * 启动参数：`--mock` 走内置内存设备（M2 集成测试用），不碰真机蓝牙。
 *
 * stdout 上只允许出现 JSONL 协议行；调试信息一律走 stderr。
 */

import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  ADV_DEVICE_NAMES,
  ADV_MFG_TAG,
  CHAR_AUDIO_UUID,
  CHAR_CTRL_UUID,
  CHAR_RX_UUID,
  CHAR_TX_UUID,
  MTU_FALLBACK,
  MTU_TARGET,
  SERVICE_UUID,
} from '../wire/constants.js';

// ---------------------------------------------------------------------------
// JSONL 下行（子 → 父）
// ---------------------------------------------------------------------------

/** @type {(line: string) => void} */
let writeOut = (line) => process.stdout.write(`${line}\n`);

function sendReply(id, ok, valueOrError) {
  writeOut(JSON.stringify(ok ? { id, ok: true, value: valueOrError } : {
    id,
    ok: false,
    error: valueOrError,
  }));
}

function sendEvent(obj) {
  writeOut(JSON.stringify(obj));
}

// noble 的 data 回调给 Buffer；字符串/字符串数组按 latin1 转（特征 UUID 匹配用）
function toHex(value) {
  if (Buffer.isBuffer(value)) return value.toString('hex');
  if (Array.isArray(value)) return value.map((v) => Number(v) & 0xff).map((v) => v.toString(16).padStart(2, '0')).join('');
  if (typeof value === 'string') return Buffer.from(value, 'latin1').toString('hex');
  return '';
}

/**
 * 广播里的服务 UUID 列表（noble 平台差异大，逐项匹配）。
 * noble 的 serviceUuids 元素本身就是 hex 字符串（无连字符），原样取用；
 * 极少数平台给字节数组，再走 toHex 转换。
 */
function advertisedUuids(peripheral) {
  const raw = peripheral?.advertisement?.serviceUuids;
  if (!Array.isArray(raw)) return [];
  return raw.map((v) => (typeof v === 'string' ? v.toLowerCase() : toHex(v)));
}

function uuidMatches(uuidA, uuidB) {
  const a = String(uuidA ?? '').replace(/-/g, '').toLowerCase();
  const b = String(uuidB ?? '').replace(/-/g, '').toLowerCase();
  if (!a || !b) return false;
  return a === b || a.endsWith(b) || b.endsWith(a);
}

/** 广播 manufacturerData 的前 4 字节是否为 ADV_MFG_TAG（ASCII）。 */
function mfgTagMatches(peripheral) {
  const data = peripheral?.advertisement?.manufacturerData;
  if (!Buffer.isBuffer(data) || data.length < 4) return false;
  return data.subarray(0, 4).toString('latin1') === ADV_MFG_TAG;
}

/**
 * 设备识别三选一（docs/04 Task 2 / docs/03 §1.2）：
 * ①广播服务 UUID 命中 ②本地名 ∈ ADV_DEVICE_NAMES ③厂商数据前 4 字节为 ADV_MFG_TAG。
 * 任一命中即认——广播实际 39 字节装不下 31 字节预算，三选一是刻意的宽容。
 *
 * 命中后仍须 GATT 服务发现校验；服务不匹配按系统 BLE 缓存残留丢弃（docs/03 §1.2 stale-cache）。
 */
function looksLikeOurDevice(peripheral) {
  if (uuidMatches(peripheral?.address, SERVICE_UUID)) return true; // 某些平台把 uuid 放 address
  if (advertisedUuids(peripheral).some((u) => uuidMatches(u, SERVICE_UUID))) return true;
  const name = peripheral?.advertisement?.localName ?? peripheral?.localName ?? '';
  if (ADV_DEVICE_NAMES.includes(name)) return true;
  if (mfgTagMatches(peripheral)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// noble 懒加载
// ---------------------------------------------------------------------------

const NOBLE_CANDIDATES = ['@stoprocent/noble', '@abandonware/noble', 'noble'];

/**
 * 依次尝试加载 noble。全失败 → emit fatal 后退出。
 * 必须整体 try/catch：仓库不把 noble 列为依赖，静态 import 会让 worker 直接崩。
 *
 * @returns {Promise<any>} noble 模块（含 startScanning）
 */
async function loadNoble() {
  const failures = [];
  for (const name of NOBLE_CANDIDATES) {
    try {
      const mod = await import(name);
      const noble = mod?.default ?? mod;
      if (typeof noble?.startScanning === 'function') return noble;
      failures.push(`${name}: 缺少 startScanning`);
    } catch (e) {
      failures.push(`${name}: ${e?.message ?? e}`);
    }
  }
  throw new Error(`无法加载 BLE 驱动（${failures.join('; ')}）`);
}

// ---------------------------------------------------------------------------
// 内存虚拟设备（--mock）
// ---------------------------------------------------------------------------

function createMockDevice() {
  const mock = {
    scanning: false,
    connected: false,
    mtu: MTU_FALLBACK,
    /** 挂在 RX 特征上的字节回调（父进程 write 的入口） */
    onRxWrite: null,
    /** 设备 → 主机的上行通知（TX/AUDIO） */
    notify(channel, bytes) {
      if (!mock.connected) return;
      sendEvent({ event: 'data', b64: Buffer.from(bytes).toString('base64'), channel });
    },
  };
  return mock;
}

// ---------------------------------------------------------------------------
// 主循环
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const useMock = args.includes('--mock');

  const state = {
    inited: false,
    scanning: false,
    connected: false,
    intentionalDisconnect: false,
    /** @type {any|null} noble peripheral */
    peripheral: null,
    /** @type {any} {rxWrite, txNotify, audioNotify, ctrlRead} */
    chars: null,
    seen: new Map(), // macOS 上 noble._peripherals 恒空，自己维护
    pendingScanWaiters: [], // stopScan/disconnect 中断进行中的等待
    mtu: MTU_FALLBACK,
    ctrlSnapshot: null,
    mock: null,
    noble: null,
  };

  const rl = createInterface({ input: process.stdin });
  rl.on('close', async () => {
    await disposeInternal(true);
    // fatal 已发生时不在此退出：留给 fatal 路径的 exit(1)，避免 exit(0) 抢跑
    if (fataled) return;
    process.exit(0);
  });
  process.on('uncaughtException', (err) => {
    try {
      sendEvent({
        event: 'fatal',
        code: 'unknown',
        message: err?.message ?? String(err),
      });
    } catch { /* stdout 已坏就算了 */ }
    setTimeout(() => process.exit(1), 50);
  });

  function emitState(s) {
    sendEvent({ event: 'state', value: s });
  }

  function handleDeviceDiscovered(peripheral) {
    if (!looksLikeOurDevice(peripheral)) return;
    const id = peripheral.address ?? peripheral.uuid ?? String(peripheral.id ?? '');
    const name = peripheral.advertisement?.localName ?? peripheral.localName ?? '';
    const rssi = typeof peripheral.rssi === 'number' ? peripheral.rssi : null;
    state.seen.set(id, peripheral);
    sendEvent({ event: 'device', id, name, rssi });
  }

  async function scan() {
    if (state.mock) {
      state.scanning = true;
      emitState('scanning');
      // 内存设备只广播一次（回调由集成测试注入，本 worker 不内置广播事件）
      return;
    }
    const noble = state.noble;
    if (typeof noble?.on === 'function' && !noble.__dshBleBridgeWired) {
      noble.__dshBleBridgeWired = true;
      noble.on('discover', (peripheral) => handleDeviceDiscovered(peripheral));
    }
    try {
      await noble.startScanningAsync([], true);
      state.scanning = true;
      emitState('scanning');
    } catch (e) {
      // startScan 失败必须回滚 scanning，否则后续所有 scan 被永久吞掉
      state.scanning = false;
      throw e;
    }
  }

  async function stopScan() {
    if (state.mock) {
      state.scanning = false;
      return;
    }
    try {
      await state.noble?.stopScanningAsync?.();
    } finally {
      state.scanning = false;
    }
    // 唤醒任何在等扫描结束的等待者（例如 connect 的取消路径）
    for (const w of state.pendingScanWaiters.splice(0)) w();
  }

  async function connect({ deviceId } = {}) {
    if (!state.mock) {
      const peripheral =
        state.seen.get(deviceId) ??
        [...state.seen.values()].find(
          (p) => (p.advertisement?.localName ?? '') === deviceId || (p.address ?? '') === deviceId,
        );
      if (!peripheral) {
        throw { code: 'device-not-found', message: `未发现设备 ${deviceId ?? '(未指定)'}` };
      }
      state.intentionalDisconnect = false;
      peripheral.on('disconnect', () => {
        if (state.intentionalDisconnect) return;
        sendEvent({ event: 'disconnected', reason: '设备断开' });
      });
      try {
        await peripheral.connectAsync();
      } catch (e) {
        throw { code: 'connect-failed', message: `连接失败：${e?.message ?? e}` };
      }
      state.peripheral = peripheral;

      // 特征发现必须全量，禁止 UUID 过滤（@stoprocent/noble macOS 静默失败）
      try {
        await peripheral.discoverAllServicesAndCharacteristicsAsync();
      } catch (e) {
        throw { code: 'connect-failed', message: `服务发现失败：${e?.message ?? e}` };
      }

      const service = peripheral.services.find((s) => uuidMatches(s.uuid, SERVICE_UUID));
      if (!service) {
        // docs/03 §1.2 stale-cache：广播命中但 GATT 不匹配 → 系统 BLE 缓存残留
        throw { code: 'device-not-found', message: 'GATT 服务不匹配（疑似系统 BLE 缓存残留）' };
      }

      const find = (uuid) =>
        service.characteristics.find((c) => uuidMatches(c.uuid, uuid));
      const rx = find(CHAR_RX_UUID);
      const tx = find(CHAR_TX_UUID);
      const audio = find(CHAR_AUDIO_UUID);
      const ctrl = find(CHAR_CTRL_UUID);
      if (!rx || !tx) {
        throw { code: 'device-not-found', message: 'GATT 缺少 RX/TX 特征' };
      }

      // data 监听器必须在 subscribe() 之前挂（docs/04 Task 2）；
      // TX/AUDIO 分别内联回调，事件里带 channel 区分通道
      tx.removeAllListeners?.('data');
      tx.on('data', (data) =>
        sendEvent({ event: 'data', b64: Buffer.from(data).toString('base64'), channel: 'control' }),
      );
      if (audio) {
        audio.removeAllListeners?.('data');
        audio.on('data', (data) =>
          sendEvent({ event: 'data', b64: Buffer.from(data).toString('base64'), channel: 'audio' }),
        );
      }

      // MTU：成功取返回值，失败回 MTU_FALLBACK（docs/04 Task 2）
      let mtu = MTU_FALLBACK;
      if (typeof peripheral.requestMtuAsync === 'function') {
        try {
          mtu = (await peripheral.requestMtuAsync(MTU_TARGET)) || MTU_FALLBACK;
        } catch {
          mtu = MTU_FALLBACK;
        }
      }
      state.mtu = mtu;

      // 通知订阅放在监听器之后
      await tx.subscribeAsync?.();
      if (audio) await audio.subscribeAsync?.();

      state.chars = { rx, tx, audio, ctrl };
      state.connected = true;
      emitState('connected');
      sendEvent({ event: 'connected', mtu, deviceId: deviceId ?? '' });
      return;
    }

    // --- --mock 分支 -----------------------------------------------------
    state.intentionalDisconnect = false;
    const mock = state.mock;
    mock.connected = true;
    mock.mtu = MTU_FALLBACK;
    state.connected = true;
    emitState('connected');
    sendEvent({ event: 'connected', mtu: mock.mtu, deviceId: 'mock-device' });
  }

  async function disconnect() {
    state.intentionalDisconnect = true;
    try {
      if (state.mock) {
        state.mock.connected = false;
      } else if (state.peripheral) {
        try {
          await state.peripheral.disconnectAsync();
        } catch { /* 已断就算了 */ }
      }
    } finally {
      state.connected = false;
      state.chars = null;
      state.peripheral = null;
      emitState('disconnected');
    }
    // 唤醒进行中的扫描等待者
    for (const w of state.pendingScanWaiters.splice(0)) w();
  }

  async function write({ b64, channel } = {}) {
    const bytes = Buffer.from(String(b64 ?? ''), 'base64');
    if (state.mock) {
      if (!state.connected) throw { code: 'disconnected', message: '未连接' };
      state.mock.onRxWrite?.(bytes, channel ?? 'control');
      return;
    }
    const rx = state.chars?.rx;
    if (!rx || !state.connected) throw { code: 'disconnected', message: '未连接' };
    await new Promise((resolve, reject) => {
      // noble：write(bytes, withoutResponse, callback)
      rx.write(bytes, true, (err) => (err ? reject(err) : resolve()));
    });
  }

  async function readCtrl() {
    if (state.mock) {
      return state.mock.ctrlSnapshot ?? null;
    }
    const ctrl = state.chars?.ctrl;
    if (!ctrl) return null;
    const data = await ctrl.readAsync();
    return Buffer.from(data).toString('base64');
  }

  async function disposeInternal(fromClose = false) {
    try {
      if (!state.mock && state.peripheral) {
        try {
          state.intentionalDisconnect = true;
          await state.peripheral.disconnectAsync();
        } catch { /* 已断就算了 */ }
      }
      if (!state.mock && state.noble && state.scanning) {
        try {
          await state.noble.stopScanningAsync?.();
        } catch { /* 已停就算了 */ }
      }
    } finally {
      state.connected = false;
      state.scanning = false;
      state.peripheral = null;
      state.chars = null;
    }
    if (!fromClose) {
      // dispose 命令本身不需要回话；父进程会 kill 进程
    }
  }

  let fataled = false;
  function emitFatal(code, message) {
    if (fataled) return; // 只发一次 fatal
    fataled = true;
    sendEvent({ event: 'fatal', code, message });
    // docs/04 Task 2：emit fatal → 50ms 后 exit(1)
    setTimeout(() => process.exit(1), 50);
  }

  const handlers = {
    init: async () => {
      if (state.inited) return;
      state.inited = true;
      if (useMock) {
        state.mock = createMockDevice();
        return;
      }
      try {
        state.noble = await loadNoble();
      } catch {
        emitFatal('not-available', '无法加载 BLE 驱动，请重新安装本插件');
        // 回包也用 not-available：父进程 classify 后保持 NOT_AVAILABLE 语义
        throw { code: 'not-available', message: '无法加载 BLE 驱动（noble 未安装）' };
      }
    },
    scan,
    stopScan,
    connect,
    disconnect,
    write,
    readCtrl,
    dispose: disposeInternal,
    ping: async () => 'pong',
  };

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      process.stderr.write(`[worker] 非 JSON 输入被丢弃：${trimmed.slice(0, 120)}\n`);
      return;
    }
    const { id, cmd } = obj ?? {};
    if (typeof id !== 'number' || typeof cmd !== 'string') {
      process.stderr.write(`[worker] 无法识别的输入：${trimmed.slice(0, 120)}\n`);
      return;
    }
    const handler = handlers[cmd];
    if (!handler) {
      sendReply(id, false, { code: 'unknown', message: `未知命令 ${cmd}` });
      return;
    }
    try {
      const value = await handler(obj);
      sendReply(id, true, value ?? null);
    } catch (e) {
      sendReply(id, false, {
        code: typeof e?.code === 'string' ? e.code : 'unknown',
        message: typeof e?.message === 'string' ? e.message : String(e ?? '失败'),
      });
    }
  });

  // ready 同步点：唯一的启动握手信号
  emitState('idle');
  sendEvent({ event: 'ready' });
}

// 只有作为主模块运行才启动（测试会 import 纯函数，不能挂住它们的事件循环）
const isMain = await (async () => {
  try {
    const { realpath } = await import('node:fs/promises');
    const self = await realpath(fileURLToPath(import.meta.url));
    const entry = process.argv[1] ? await realpath(process.argv[1]) : '';
    return self === entry;
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((err) => {
    try {
      sendEvent({
        event: 'fatal',
        code: 'unknown',
        message: err?.message ?? String(err),
      });
    } catch { /* stdout 已坏就算了 */ }
    process.exitCode = 1;
  });
}

export {
  // 供测试直接复用的纯逻辑（不启进程）
  looksLikeOurDevice,
  uuidMatches,
  mfgTagMatches,
  advertisedUuids,
};
export default main;
