/**
 * `link/handshake.js`：握手与配对状态机（docs/03 §3.1–§3.5，docs/04 Task 11）。
 *
 * 职责：接收设备发来的 JSON 消息，驱动握手（idle → acking → ready/rejected）
 * 与应用层配对（pair.required / pair.begin / pair.ok / pair.failed / pair.reset）。
 * 链路层消息（ping/pong/ack/nack）转成 `message` 事件交给 keepalive/acks 处理；
 * ready 之后业务消息返回 `false` 交还上层（link.js → api 层）。
 *
 * 关键定案（与 v1 相反或修复 v1 缺陷）：
 * - **设备发起握手**：主机绝不主动发 hello，只回 hello.ack。
 * - **proto 不符即拒绝**：回 `accepted:false, code:"PROTO_MISMATCH"` 并 emit
 *   `rejected`，绝不按低版本静默继续跑（v1 只打 warn）。
 * - **环检测**：token 失配只自动发一次 `pair.reset`；再失配只报
 *   `pair-required`，否则 `pair.required → 重置 → 旧 token` 无限循环
 *   （v1 真实事故）。重新配对成功（pair.ok）后计数清零，允许新一轮重置。
 * - **信任表注入**：默认实现 `createTrustStore()` 写
 *   `~/.dsh/dsh-ai-passport.pairing.json`（权限 0600）；测试必须注入
 *   `{load, save}` fake，绝不触碰真实 home。
 * - `dispose()` 不删信任表（用户凭证与组件生命周期无关）。
 */

import EventEmitter from 'node:events';
import { mkdir, readFile, writeFile, chmod, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import {
  MSG,
  PROTOCOL_VERSION,
  MAX_CHUNKS,
  MAX_MESSAGE_BYTES_CEILING,
} from '../wire/constants.js';

/** 握手状态机四态。 */
export const HANDSHAKE_STATE = Object.freeze({
  IDLE: 'idle',
  ACKING: 'acking',
  READY: 'ready',
  REJECTED: 'rejected',
});

/** hello.ack 中的 server 标识。 */
const SERVER_NAME = 'dsh-ai-passport/2.0.0';

/** 默认信任表：目录名与文件名。 */
const TRUST_DIR_NAME = '.dsh';
const TRUST_FILE_NAME = 'dsh-ai-passport.pairing.json';
const TRUST_FILE_MODE = 0o600;

/**
 * 默认信任表实现：`~/.dsh/dsh-ai-passport.pairing.json`，权限 0600。
 * `{dir}` 可注入覆盖目录（测试用 tmpdir）；`path` 暴露文件绝对路径。
 * `load()` 文件不存在/损坏返回 null；`save()` 原子写 + 0600（目录 0700）。
 */
export function createTrustStore({ dir } = {}) {
  const base = dir ?? path.join(homedir(), TRUST_DIR_NAME);
  const filePath = path.join(base, TRUST_FILE_NAME);
  return {
    path: filePath,
    async load() {
      let raw;
      try {
        raw = await readFile(filePath, 'utf8');
      } catch (err) {
        if (err?.code === 'ENOENT') return null;
        return null;
      }
      try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },
    async save(table) {
      await mkdir(base, { recursive: true, mode: 0o700 });
      const tmp = filePath + '.tmp';
      await writeFile(tmp, JSON.stringify(table, null, 2), { mode: TRUST_FILE_MODE });
      await chmod(tmp, TRUST_FILE_MODE);
      // 先写临时文件再 rename：进程中途被杀不会留下半个 JSON。
      await rename(tmp, filePath);
      await chmod(filePath, TRUST_FILE_MODE);
    },
  };
}

/**
 * 握手与配对状态机。
 *
 * @param {object} opts
 * @param {(msg: object) => void} opts.send        发送一条 JSON 消息给设备（link.js 负责编码分帧）。
 * @param {{load: () => Promise<object|null>, save: (table: object) => Promise<void>}} opts.store
 *        信任表读写（deviceId → token 映射）。
 * @param {string} [opts.deviceId]                 已知目标设备 id（信任表 key；缺省用 hello.deviceId）。
 * @param {string} [opts.deviceName]               展示名（ready info.name）。
 * @param {number} [opts.chunkPayload=510]         当前链路单片载荷，maxPayload 协商用。
 * @param {string} [opts.hostName=os.hostname()]   pair.begin.host。
 */
export class Handshake extends EventEmitter {
  #send;
  #store;
  #deviceId;
  #deviceName;
  #chunkPayload;
  #hostName;
  #state = HANDSHAKE_STATE.IDLE;
  #info = null;
  #disposed = false;
  /** token 失配自动重置已用掉（每次成功配对后清零）。 */
  #autoResetUsed = false;
  /**
   * 会话世代：reset()/dispose() 自增，作废在飞的 hello。
   * t34-F1：`await store.load()` 可能很慢；期间断链/停链会 reset 本实例，
   * 晚到的 load 不得再发 hello.ack、也不得把状态改回 ready。
   */
  #generation = 0;

  constructor({
    send,
    store,
    deviceId = null,
    deviceName = null,
    chunkPayload = 510,
    hostName,
  } = {}) {
    super();
    if (typeof send !== 'function') throw new TypeError('Handshake 需要 send 回调');
    if (!store || typeof store.load !== 'function' || typeof store.save !== 'function') {
      throw new TypeError('Handshake 需要 store: {load, save}');
    }
    this.#send = send;
    this.#store = store;
    this.#deviceId = deviceId;
    this.#deviceName = deviceName;
    this.#chunkPayload = chunkPayload;
    this.#hostName = hostName ?? '';
  }

  /** 当前状态：idle | acking | ready | rejected。 */
  get state() {
    return this.#state;
  }

  /** 握手是否完成（rejected 或 dispose 后为 false）。 */
  get ready() {
    return this.#state === HANDSHAKE_STATE.READY;
  }

  /** ready 事件携带的 info；未就绪为 null。 */
  get info() {
    return this.#info;
  }

  /**
   * 处理一条设备发来的 JSON 消息。
   *
   * 返回 `true` 表示消息已被本层消费（链路层或被静默丢弃），
   * 返回 `false` 表示与本层无关、应交给上层（api 层业务分发）。
   */
  async handle(msg) {
    if (this.#disposed) return true; // 静默吞掉，不外泄
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return true;

    switch (msg.type) {
      case MSG.HELLO:
        await this.#onHello(msg);
        return true;
      case MSG.PING:
      case MSG.PONG:
      case MSG.ACK:
      case MSG.NACK:
        this.emit('message', msg); // 链路层消息任何时候都转发
        return true;
      case MSG.PAIR_REQUIRED:
        this.#onPairRequired(msg);
        return true;
      case MSG.PAIR_OK:
        await this.#onPairOk(msg);
        return true;
      case MSG.PAIR_FAILED:
        this.emit('pair-failed', { reason: msg.reason ?? 'unknown', remaining: msg.remaining });
        return true;
      default:
        // ready 之前的业务消息静默丢弃（不回 nack、不 emit）；
        // ready 之后交上层。
        return this.#state === HANDSHAKE_STATE.READY ? false : true;
    }
  }

  /** 主机侧发起配对：发 pair.begin{code, host}。 */
  async beginPairing(code) {
    this.#send({
      type: MSG.PAIR_BEGIN,
      code: String(code),
      host: this.#hostName,
    });
  }

  /**
   * 断链/重连清理（docs/02 §6 第一行）：ready 归零、丢弃动态 info。
   * 保留 #autoResetUsed —— 环检测记忆必须跨连接，否则重连循环永不停止。
   */
  reset() {
    this.#generation += 1; // 作废在飞的 #onHello（t34-F1）
    this.#state = HANDSHAKE_STATE.IDLE;
    this.#info = null;
  }

  /** 组件销毁：不再处理任何消息、不再发送。**不删信任表**。 */
  dispose() {
    this.#generation += 1; // 作废在飞的 #onHello（t34-F1）
    this.#disposed = true;
    this.#state = HANDSHAKE_STATE.IDLE;
    this.#info = null;
    this.removeAllListeners();
  }

  // ------------------------------------------------------------------ //

  async #onHello(msg) {
    if (this.#state === HANDSHAKE_STATE.REJECTED) return; // 终态，等用户干预

    // READY 下的新 hello 合法：docs/03 §3.1 常见配对顺序里，pair.ok 之后
    // 设备会带 token「重发 hello」，必须重新校验并回 paired:true。

    this.#state = HANDSHAKE_STATE.ACKING;
    // t34-F1：从进入 #onHello 到 store.load 返回之间可能发生 reset/dispose
    // （断链、stop、restartScan）。记录世代，await 之后复核；晚到的 hello
    // 必须彻底作废，不能发 hello.ack、不能 emit ready。
    const generation = this.#generation;

    // 1. 协议版本：只接受 PROTOCOL_VERSION，绝不降级（v1 缺陷修复）。
    if (msg.proto !== PROTOCOL_VERSION) {
      this.#send({
        type: MSG.HELLO_ACK,
        accepted: false,
        code: 'PROTO_MISMATCH',
        server: SERVER_NAME,
      });
      this.#state = HANDSHAKE_STATE.REJECTED;
      this.emit('rejected', { code: 'PROTO_MISMATCH' });
      return;
    }

    // 2. 配对校验（docs/02 §5.2.2）：主机查信任表比对 token。
    const deviceId = msg.deviceId ?? this.#deviceId;
    const token = typeof msg.token === 'string' ? msg.token : null;
    let table;
    try {
      table = (await this.#store.load()) ?? {};
    } catch (err) {
      if (generation !== this.#generation) return; // 已断链/销毁：静默作废
      this.#state = HANDSHAKE_STATE.IDLE;
      this.emit('error', err);
      return;
    }
    if (generation !== this.#generation || this.#disposed) return;
    const expected = deviceId != null ? table[deviceId] : undefined;
    const paired =
      token !== null &&
      typeof expected === 'string' &&
      expected.length > 0 &&
      token === expected;

    // 3. maxPayload 协商（docs/04 契约 3）。
    const maxPayload = Math.min(
      Number.isFinite(msg.maxPayload) ? msg.maxPayload : Infinity,
      MAX_CHUNKS * this.#chunkPayload,
      MAX_MESSAGE_BYTES_CEILING,
    );

    this.#send({
      type: MSG.HELLO_ACK,
      accepted: true,
      proto: PROTOCOL_VERSION,
      maxPayload,
      maxChunks: MAX_CHUNKS,
      server: SERVER_NAME,
      paired,
    });

    this.#info = {
      deviceId: deviceId ?? null,
      name: this.#deviceName ?? msg.name ?? null,
      firmware: msg.fw ?? null,
      maxPayload,
      maxChunks: MAX_CHUNKS,
      capabilities: Number.isFinite(msg.caps) ? msg.caps : 0,
      paired,
    };
    this.#state = HANDSHAKE_STATE.READY;
    this.emit('ready', { ...this.#info });

    // 4. token 失配的后续动作（docs/03 §3.5 环检测）。
    if (!paired) {
      const reason = token === null ? 'first' : 'token-mismatch';
      if (reason === 'token-mismatch' && !this.#autoResetUsed) {
        // 只自动重置一次：pair.required → 重置 → 旧 token 再 hello 会无限循环。
        this.#autoResetUsed = true;
        this.#send({ type: MSG.PAIR_RESET, ack: true });
      }
      this.emit('pair-required', { reason });
    }
  }

  #onPairRequired(msg) {
    this.emit('pair-required', { reason: msg.reason ?? 'first' });
  }

  async #onPairOk(msg) {
    const { deviceId, token } = msg;
    if (typeof deviceId !== 'string' || deviceId.length === 0 || typeof token !== 'string') {
      this.emit('pair-failed', { reason: 'bad-pair-ok' });
      return;
    }
    // t37：进入时捕获会话世代；stop/reset/dispose 会自增。pair.ok 的 load/save
    // 可能挂起（真实信任表写盘），晚到的完成不得把已断开的会话重新 emit paired。
    const generation = this.#generation;
    let table;
    try {
      table = (await this.#store.load()) ?? {};
      // load 之后、写表之前复核：会话已被 stop/reset/dispose 作废时，pair.ok
      // 是旧会话的迟到消息，既不再广播 paired，也不写信任表（t37-F9 显式决策：
      // 信任表是持久事实，但本机已放弃该会话，不能让它产生任何副作用）。
      if (generation !== this.#generation || this.#disposed) return;
      table[deviceId] = token;
      await this.#store.save(table);
      // save 之后再次复核，覆盖保存期间发生 reset/dispose 的窗口。此时 save
      // 已发起、无法撤回（写盘是外部副作用），但绝不 emit paired / 不改状态。
      if (generation !== this.#generation || this.#disposed) return;
    } catch (err) {
      this.emit('error', err);
      return;
    }
    this.#autoResetUsed = false; // 配对成功，环检测计数清零（新一轮允许一次重置）
    this.emit('paired', { deviceId, token });
  }
}
