/**
 * 父进程侧 BLE 桥（docs/04 Task 2）。
 *
 * 把原生 BLE 关进子进程：父进程只通过 stdin/stdout 的 JSON Lines 说话。
 *
 * JSONL 协议（docs/02 §4.2，形状不得改动）：
 *
 *   父 → 子   {"id":<int>,"cmd":<string>, ...args}
 *   子 → 父   {"id":<int>,"ok":true,"value":<any>}
 *             {"id":<int>,"ok":false,"error":{"code":<string>,"message":<string>}}
 *             {"event":<string>, ...payload}          // 无 id，单向下行
 *
 * 命令集：init / scan / stopScan / connect / disconnect / write / readCtrl /
 * dispose / ping。事件集：ready / state / device / connected / disconnected /
 * data / fatal。
 *
 * v1 踩坑对位（docs/02 §10）：
 * - BLE 依赖隔离到子进程：本文件绝不 import noble；
 * - 每个命令独立定时器且 unref()：防止 20s 定时器拖住事件循环；
 * - stop()/dispose() 里的 sleep() **不得 unref**：await 一个 unref 定时器在
 *   事件循环空闲时永不 settle，dispose 会卡死（v1 因此 11 条用例 cancelled）。
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { chunkPayloadForMtu } from '../wire/frame.js';
import {
  LINK_STATE,
  Transport,
  TransportError,
  TRANSPORT_ERROR,
} from './transport.js';

/** 子进程崩溃后的重启退避序列（docs/04 Task 2）。 */
const DEFAULT_BACKOFF_MS = [500, 1000, 2000, 5000, 10000];
const READY_TIMEOUT_MS = 15_000;
const COMMAND_TIMEOUT_MS = 20_000;
const CONNECT_TIMEOUT_MS = 70_000; // ≥ worker 内 30s 扫描 + 30s 连接 + 服务发现
const DISPOSE_GRACE_MS = 2_000;
const MAX_STDERR_LINES = 50;

/** sleep 的定时器刻意不 unref（v1 踩坑：stop/dispose 里用它等子进程退出）。 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 可取消的退避等待。重启退避的定时器若不能取消，
 * dispose 后它会继续拖住事件循环（node --test 下表现为用例 cancelled）。
 */
function backoffSleep(ms) {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  const timer = setTimeout(resolve, ms);
  return { promise, cancel: () => clearTimeout(timer) };
}

const DEFAULT_WORKER_PATH = fileURLToPath(
  new URL('./bridge-worker.js', import.meta.url),
);

/**
 * 父进程侧桥接传输。
 *
 * 事件（沿用 Transport 约定，另加桥自身的信息事件）：
 * - `state(prev, next)` / `data(bytes, {channel})` / `disconnected(payload)` /
 *   `error(err)`：基类约定
 * - `device({id, name, rssi})`：扫描发现设备（rssi 同时记入 `rssiById`）
 */
export class BridgeClient extends Transport {
  /** @type {string} */ #workerPath;
  /** @type {string[]} */ #args;
  /** @type {number} */ #readyTimeoutMs;
  /** @type {number} */ #commandTimeoutMs;
  /** @type {number} */ #connectTimeoutMs;
  /** @type {number[]} */ #backoffMs;

  /** @type {import('node:child_process').ChildProcess|null} */ #child = null;
  /** @type {import('node:readline').Interface|null} */ #rl = null;
  /** @type {Promise<void>|null} */ #spawning = null;

  /** @type {Map<number, {resolve:Function, reject:Function, timer:NodeJS.Timeout, cmd:string}>} */
  #pending = new Map();
  /** @type {{resolve:Function, reject:Function}|null} */ #readyWait = null;
  /** @type {NodeJS.Timeout|null} */ #readyTimer = null;
  /** @type {number} */ #nextId = 0;

  /** @type {boolean} 子进程至少 ready 过一次（未 ready 的崩溃不做重启） */
  #everReady = false;
  /** @type {boolean} doDispose 后不再重启、不再接受命令 */
  #spawnDisposed = false;
  /** @type {boolean} doDisconnect 进行中：worker 的 disconnected 事件按主动处理 */
  #intentionalDisconnect = false;
  /** @type {number} 当前处于第几次重启退避 */
  #restartAttempt = 0;
  /** @type {ReturnType<typeof backoffSleep>|null} 进行中的退避等待 */
  #backoffWait = null;

  /** @type {string[]} 最近 stderr 行（debug 日志，不进协议） */
  #stderrLog = [];

  /**
   * @param {object} [options]
   * @param {string} [options.workerPath] 子进程脚本路径，默认同目录 bridge-worker.js
   * @param {string[]} [options.args] 追加给子进程的参数
   * @param {boolean} [options.mock=false] 追加 `--mock`，子进程内部走内存设备
   * @param {number} [options.mtuPayload] 初始单帧载荷（默认基类的 240）
   * @param {number} [options.readyTimeoutMs=15000]
   * @param {number} [options.commandTimeoutMs=20000]
   * @param {number} [options.connectTimeoutMs=70000]
   * @param {number[]} [options.backoffMs] 重启退避序列
   */
  constructor(options = {}) {
    super({ mtuPayload: options.mtuPayload });
    this.#workerPath = options.workerPath ?? DEFAULT_WORKER_PATH;
    this.#args = [...(options.args ?? [])];
    if (options.mock) this.#args.push('--mock');
    this.#readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS;
    this.#commandTimeoutMs = options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;
    this.#connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    this.#backoffMs =
      options.backoffMs && options.backoffMs.length > 0
        ? [...options.backoffMs]
        : DEFAULT_BACKOFF_MS;
  }

  // ------------------------------------------------------------------
  // 桥自身的信息出口（诊断用）
  // ------------------------------------------------------------------

  /** 扫描发现过的设备 rssi（noble 只在发现时给，连接回包里没有）。 */
  get rssiById() {
    return this.#rssiById;
  }

  /** @type {Map<string, number>} */
  #rssiById = new Map();

  /** 最近 stderr 行（调试日志，不进协议）。 */
  get stderrLog() {
    return [...this.#stderrLog];
  }

  /** 当前重启退避次数（诊断用）。 */
  get restartAttempt() {
    return this.#restartAttempt;
  }

  /**
   * 发送一条命令并等待配对回包。测试与高级用法可用；生命周期请走 Transport 钩子。
   *
   * @param {string} cmd
   * @param {object} [args] 展开进 JSONL 顶层：`{id,cmd,...args}`
   * @returns {Promise<any>} 回包的 `value`
   */
  request(cmd, args = {}) {
    if (!this.#isChildAlive()) {
      return Promise.reject(
        new TransportError(TRANSPORT_ERROR.DISCONNECTED, '子进程未运行，无法发送命令'),
      );
    }
    const id = (this.#nextId += 1);
    return new Promise((resolve, reject) => {
      // 每个命令独立定时器且 unref()（docs/04 Task 2）
      const timeoutMs =
        cmd === 'connect' ? this.#connectTimeoutMs : this.#commandTimeoutMs;
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new TransportError(
            TRANSPORT_ERROR.TIMEOUT,
            `命令 ${cmd} 超时（${timeoutMs}ms 无回包）`,
          ),
        );
      }, timeoutMs);
      timer.unref();
      this.#pending.set(id, { resolve, reject, timer, cmd });
      this.#writeLine({ id, cmd, ...args });
    });
  }

  // ------------------------------------------------------------------
  // Transport 钩子
  // ------------------------------------------------------------------

  /** @returns {Promise<void>} */
  async doStartScan() {
    await this.#ensureSpawned();
    await this.request('init', {});
    await this.request('scan', {});
  }

  /** 停扫失败不阻断 stop 流程（stop 要幂等）。 */
  async doStopScan() {
    if (!this.#isChildAlive()) return;
    await this.request('stopScan', {}).catch(() => {});
  }

  /** @returns {Promise<{mtu?: number}>} worker 回包（含协商后的 MTU） */
  async doConnect() {
    await this.#ensureSpawned();
    const value = await this.request('connect', {});
    if (Number.isInteger(value?.mtu)) {
      this._setMtuPayload(chunkPayloadForMtu(value.mtu));
    }
    return value ?? {};
  }

  async doDisconnect() {
    this.#intentionalDisconnect = true;
    try {
      if (this.#isChildAlive()) {
        await this.request('disconnect', {});
      }
    } finally {
      this.#intentionalDisconnect = false;
    }
  }

  /**
   * @param {Uint8Array} bytes
   * @param {{channel?: string}} [options]
   */
  async doSend(bytes, { channel = 'control' } = {}) {
    if (!this.#isChildAlive()) {
      throw new TransportError(TRANSPORT_ERROR.DISCONNECTED, '子进程未运行，无法发送');
    }
    const b64 = Buffer.from(bytes).toString('base64');
    await this.request('write', { b64, channel });
  }

  async doDispose() {
    this.#spawnDisposed = true;
    this.#backoffWait?.cancel();
    this.#backoffWait = null;
    this.#clearReadyWait();
    this.#clearPending(
      new TransportError(TRANSPORT_ERROR.DISCONNECTED, '桥已 dispose'),
    );
    const child = this.#child;
    if (!child) return;
    if (this.#isChildAlive()) {
      await this.request('dispose', {}).catch(() => {});
    }
    child.kill();
    // sleep 定时器不得 unref（v1 踩坑：unref 后 Promise 永不 settle，dispose 卡死）
    const exited = await Promise.race([
      once(child, 'exit').then(() => true),
      sleep(DISPOSE_GRACE_MS).then(() => false),
    ]);
    if (!exited) {
      child.kill('SIGKILL');
      await once(child, 'exit').catch(() => {});
    }
    this.#child = null;
    this.#rl = null;
  }

  // ------------------------------------------------------------------
  // 子进程生命周期
  // ------------------------------------------------------------------

  #isChildAlive() {
    const child = this.#child;
    return Boolean(child) && child.exitCode === null && child.signalCode === null;
  }

  #writeLine(obj) {
    this.#child?.stdin?.write(`${JSON.stringify(obj)}\n`);
  }

  #spawnOnce() {
    const child = spawn(process.execPath, [this.#workerPath, ...this.#args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#child = child;

    // stdout：JSONL 协议通道
    this.#rl = createInterface({ input: child.stdout });
    this.#rl.on('line', (line) => this.#handleLine(line));

    // stderr：逐行转 debug 日志，不进协议（docs/04 Task 2）
    const stderrRl = createInterface({ input: child.stderr });
    stderrRl.on('line', (line) => this.#handleStderr(line));

    child.on('exit', (code, signal) => this.#handleExit(code, signal));
    child.on('error', (err) => {
      // spawn 本身失败（ENOENT 等）：让 ready 等待与在途命令立刻失败
      this.#failReadyWait(err);
      this.#clearPending(err);
      this._emitError(err);
    });
  }

  /**
   * 确保子进程已启动并完成 ready 同步点。
   *
   * 第一条 `{"event":"ready"}` 是唯一同步点（docs/04 Task 2）：
   * 抢先写命令会石沉大海。
   */
  async #ensureSpawned() {
    if (this.#isChildAlive()) return;
    if (this.#spawnDisposed) {
      throw new TransportError(TRANSPORT_ERROR.DISCONNECTED, '桥已 dispose，无法重启');
    }
    if (this.#spawning) return this.#spawning;

    this.#spawnOnce();
    this.#spawning = (async () => {
      await new Promise((resolve, reject) => {
        this.#readyWait = { resolve, reject };
        this.#readyTimer = setTimeout(() => {
          this.#readyWait = null;
          reject(
            new TransportError(
              TRANSPORT_ERROR.NOT_AVAILABLE,
              `子进程 ${this.#readyTimeoutMs}ms 内未上报 ready（蓝牙驱动可能未安装）`,
            ),
          );
        }, this.#readyTimeoutMs);
        this.#readyTimer.unref();
      });
      this.#everReady = true;
      this.#restartAttempt = 0; // 成功 ready 后退避计数归零
    })();

    try {
      await this.#spawning;
    } catch (e) {
      // ready 前失败：不做崩溃重启（重启救不了坏驱动），让调用方自己决定重试
      this.#killChild();
      throw e;
    } finally {
      this.#spawning = null;
    }
  }

  #killChild() {
    const child = this.#child;
    if (child && this.#isChildAlive()) child.kill();
  }

  #clearReadyWait() {
    if (this.#readyTimer) {
      clearTimeout(this.#readyTimer);
      this.#readyTimer = null;
    }
    this.#readyWait = null;
  }

  #failReadyWait(error) {
    if (!this.#readyWait) return;
    const { reject } = this.#readyWait;
    this.#clearReadyWait();
    reject(error);
  }

  #clearPending(error) {
    for (const entry of this.#pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error instanceof Error ? error : new Error(String(error)));
    }
    this.#pending.clear();
  }

  #handleExit(_code, _signal) {
    const child = this.#child;
    this.#clearReadyWait();
    this.#clearPending(
      new TransportError(TRANSPORT_ERROR.DISCONNECTED, '子进程已退出'),
    );
    // worker 退出后必须显式销毁管道：child.stdin 不 destroy 会一直挂住
    // 父进程事件循环（readline 已随数据流结束，但 Writable socket 仍是活跃 handle）
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
    this.#child = null;
    this.#rl = null;

    if (this.#spawnDisposed) return; // dispose 后不再重启
    if (!this.#everReady) return; // ready 前的失败不是可重启的运行时崩溃

    const wasConnected = this.state === LINK_STATE.CONNECTED;
    if (wasConnected && !this.#intentionalDisconnect) {
      // 只有「原本已连接 且 非主动断开」才算意外（docs/04 Task 2）
      this.emitUnexpectedDisconnect(
        '子进程意外退出',
        new TransportError(TRANSPORT_ERROR.DISCONNECTED, '子进程意外退出'),
      );
    }

    if (this.state === LINK_STATE.IDLE) return; // 空闲时退出：下次使用时再拉起

    // 指数退避重启：emit state 变化（reconnecting → scanning）
    const delay = this.#backoffMs[
      Math.min(this.#restartAttempt, this.#backoffMs.length - 1)
    ];
    this.#restartAttempt += 1;
    this.#backoffWait = backoffSleep(delay);
    (async () => {
      await this._transition(LINK_STATE.RECONNECTING, () => this.#backoffWait.promise);
      if (this.#spawnDisposed) return; // 退避期间被 dispose
      await this._transition(LINK_STATE.SCANNING, () => this.doStartScan());
    })().catch((e) => this._emitError(e));
  }

  // ------------------------------------------------------------------
  // 行解析
  // ------------------------------------------------------------------

  #handleStderr(line) {
    this.#stderrLog.push(line);
    if (this.#stderrLog.length > MAX_STDERR_LINES) this.#stderrLog.shift();
  }

  #handleLine(line) {
    const trimmed = line.trim();
    if (trimmed === '') return;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      // stdout 上的非 JSON 行不进协议：当 debug 日志丢弃
      this.#handleStderr(`[stdout 非协议行] ${trimmed}`);
      return;
    }

    if (typeof obj?.id === 'number') {
      this.#handleReply(obj);
      return;
    }
    if (typeof obj?.event === 'string') {
      this.#handleEvent(obj);
      return;
    }
    this.#handleStderr(`[stdout 无法识别行] ${trimmed}`);
  }

  #handleReply(obj) {
    const entry = this.#pending.get(obj.id);
    if (!entry) {
      this.#handleStderr(`[stdout 未知回包 id=${obj.id}]`);
      return;
    }
    this.#pending.delete(obj.id);
    clearTimeout(entry.timer);
    if (obj.ok === true) {
      entry.resolve(obj.value);
    } else {
      const err = obj.error ?? {};
      entry.reject(
        new TransportError(
          typeof err.code === 'string' ? err.code : TRANSPORT_ERROR.UNKNOWN,
          typeof err.message === 'string' ? err.message : '子进程返回失败',
        ),
      );
    }
  }

  #handleEvent(obj) {
    switch (obj.event) {
      case 'ready': {
        if (this.#readyWait) {
          const { resolve } = this.#readyWait;
          this.#clearReadyWait();
          resolve();
        }
        break;
      }
      case 'state':
        // worker 侧信息状态（scanning 等）：父进程状态机由钩子驱动，这里仅记录
        break;
      case 'device': {
        if (typeof obj.id === 'string') {
          this.#rssiById.set(obj.id, obj.rssi ?? null);
          this.emit('device', { id: obj.id, name: obj.name ?? '', rssi: obj.rssi ?? null });
        }
        break;
      }
      case 'connected': {
        if (Number.isInteger(obj.mtu)) {
          this._setMtuPayload(chunkPayloadForMtu(obj.mtu));
        }
        break;
      }
      case 'disconnected': {
        if (
          this.state === LINK_STATE.CONNECTED &&
          !this.#intentionalDisconnect
        ) {
          this.emitUnexpectedDisconnect(
            obj.reason ?? '设备断开',
            new TransportError(
              TRANSPORT_ERROR.DISCONNECTED,
              obj.reason ?? '设备断开',
            ),
          );
        }
        break;
      }
      case 'data': {
        const bytes = Buffer.from(obj.b64 ?? '', 'base64');
        this._onData(bytes, { channel: obj.channel ?? 'control' });
        break;
      }
      case 'fatal': {
        // worker 致命错误（如 noble 加载失败）：它随后会自行退出。
        // 环境级缺失（蓝牙驱动装不上）重启救不了：标记 disposed 阻止退避重启循环。
        if (obj.code === 'not-available') this.#spawnDisposed = true;
        if (this.#readyWait) {
          this.#failReadyWait(
            new TransportError(
              TRANSPORT_ERROR.NOT_AVAILABLE,
              obj.message ?? '子进程 fatal',
            ),
          );
        }
        this._emitError(
          new TransportError(
            typeof obj.code === 'string' ? obj.code : TRANSPORT_ERROR.UNKNOWN,
            obj.message ?? '子进程 fatal',
          ),
        );
        break;
      }
      default:
        this.#handleStderr(`[stdout 未知事件] ${obj.event}`);
        break;
    }
  }
}

export default BridgeClient;
