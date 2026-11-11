/**
 * 内存传输与虚拟设备（docs/04 Task 3）。
 *
 * MockTransport 是主机侧的 Transport 实现，内部带一台**虚拟设备**：
 *
 * - `connect()` 成功后，虚拟设备**主动**发 `hello`（协议 §3.1：设备发起握手）
 * - 收到 `MSG` 消息时按映射自动应答：
 *   `hello → hello.ack`、`ping → pong`、`session.state → ack`、
 *   `asr.end → asr.result`、`balance.req → balance`
 *   （`asr.begin` 无应答：docs/03 §7.1，协议里不存在 `asr.started`）
 * - 通道语义（协议 §2.3）：ping/pong 走 HEARTBEAT(2)（单帧 JSON，不重组，
 *   不经 Reassembler，无 ACK_REQ）；hello/hello.ack/ack/nack/asr.result/balance
 *   走 CONTROL(0)（分片重组）；AUDIO(1) 丢弃。CONTROL 上的 ping 属固件容错路径，
 *   pong 原路回 CONTROL
 * - 控制通道收到带 `FLAG_ACK_REQ` 的消息，整条重组成功后回 `ack {msgId}`
 *   （协议 §2.5：接收方重组成功后回 ack；ack 自身永不带 ACK_REQ）
 * - 收到不连续分片回 `nack {msgId, reason, missing}`，`missing` 列表来自
 *   `wire/reassembler` 的 gap 结果，让选择性重传被真实覆盖
 *
 * 故障注入：
 * - `dropRate`：每帧按概率丢弃（双向都丢）。随机源可注入（`random`）或用
 *   `seed` 构造确定性的 mulberry32，同一 seed 下测试结果可复现
 * - `latencyMs`：每帧延迟投递（双向），同延迟下 FIFO 顺序不变
 * - `failConnect` / `connectError`：`doConnect` 抛 `TransportError(CONNECT_FAILED)`
 * - `simulateDrop(n)`：接下来 n 帧确定性丢弃（不经过随机源）
 * - `simulateDisconnect(reason)`：以 unexpected 语义上报断链
 *
 * 与 Transport 基类的关系：状态机、`state`/`mtuPayload`、事件名
 * （`state`/`data`/`disconnected`/`error`）全部继承自基类，本类只覆盖 `do*` 钩子。
 */

import {
  PROTOCOL_VERSION,
  FLAG_ACK_REQ,
  CHANNEL_CONTROL,
  CHANNEL_AUDIO,
  CHANNEL_HEARTBEAT,
  MAX_MESSAGE_BYTES_CEILING,
  MSGID_MASK,
  MSG,
  channelName,
} from '../wire/constants.js';
import { decodeHeader, encodeFrames, frameBody } from '../wire/frame.js';
import { Reassembler } from '../wire/reassembler.js';
import {
  Transport,
  TransportError,
  TRANSPORT_ERROR,
  LINK_STATE,
} from './transport.js';

/** 默认随机种子：随便选的一个常数，保证默认构造也是确定性的。 */
const DEFAULT_SEED = 0x2f6e2b1;

/**
 * mulberry32：32 位 PRNG，体积小、周期长、分布够测试用。
 *
 * @param {number} seed
 * @returns {() => number} 返回 [0, 1) 的伪随机数
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const JSON_ENCODER = new TextEncoder();
const JSON_DECODER = new TextDecoder();
/**
 * @typedef {object} MockTransportOptions
 * @property {number} [dropRate=0] 每帧丢弃概率，0..1（双向都生效）
 * @property {number} [latencyMs=0] 每帧投递延迟（毫秒），同延迟下保持 FIFO
 * @property {number} [mtuPayload] 单帧有效载荷，最小 16；默认走基类的 240
 * @property {boolean} [failConnect=false] 为 true 时 doConnect 抛 CONNECT_FAILED
 * @property {string} [connectError] 自定义连接失败文案（默认「模拟连接失败」）
 * @property {boolean} [autoRespond=true] 虚拟设备是否主动发 hello 并按 MSG 自动应答；
 *   false 时设备完全被动（ack/nack 回执仍保留，那是协议义务不是应答）
 * @property {number} [seed] 确定性随机种子；未传 random 时用 mulberry32(seed)
 * @property {() => number} [random] 注入随机源，返回 [0,1)；优先于 seed
 */
export class MockTransport extends Transport {
  // --- 注入配置 ---
  /** @type {number} */ #dropRate;
  /** @type {number} */ #latencyMs;
  /** @type {boolean} */ #failConnect;
  /** @type {string} */ #connectError;
  /** @type {boolean} */ #autoRespond;
  /** @type {() => number} */ #random;

  // --- 运行状态 ---
  /** @type {number} */ #pendingDrops;
  /** @type {Set<any>} */ #timers;

  // --- 虚拟设备 ---
  /** @type {Reassembler|null} */ #deviceReassembler;
  /** @type {Map<string, boolean>} */ #deviceAckReq;
  /** @type {number} */ #deviceMsgId;
  /** @type {{received: number, dropped: number, replied: number, gaps: number}} */ #deviceStats;

  /**
   * @param {MockTransportOptions} [options]
   */
  constructor(options = {}) {
    const {
      dropRate = 0,
      latencyMs = 0,
      mtuPayload,
      failConnect = false,
      connectError,
      autoRespond = true,
      seed,
      random,
    } = options;

    super(mtuPayload === undefined ? {} : { mtuPayload });
    if (mtuPayload !== undefined) this._setMtuPayload(mtuPayload);

    if (!Number.isFinite(dropRate) || dropRate < 0 || dropRate > 1) {
      throw new RangeError(`dropRate 非法：${dropRate}（应为 0..1）`);
    }
    if (!Number.isInteger(latencyMs) || latencyMs < 0) {
      throw new RangeError(`latencyMs 非法：${latencyMs}`);
    }

    this.#dropRate = dropRate;
    this.#latencyMs = latencyMs;
    this.#failConnect = Boolean(failConnect);
    this.#connectError = connectError ?? '模拟连接失败';
    this.#autoRespond = Boolean(autoRespond);
    this.#random = random ?? mulberry32(seed ?? DEFAULT_SEED);

    this.#pendingDrops = 0;
    this.#timers = new Set();
    this.#deviceAckReq = new Map();
    this.#deviceMsgId = 1;
    this.#deviceStats = { received: 0, dropped: 0, replied: 0, gaps: 0 };
    this.#deviceReassembler = null;
  }

  /** 虚拟设备侧的统计（received/dropped/replied/gaps），诊断用。 */
  get deviceStats() {
    return { ...this.#deviceStats };
  }

  // ------------------------------------------------------------------
  // 故障注入 API（供集成测试主动制造故障）
  // ------------------------------------------------------------------

  /**
   * 接下来 n 帧确定性丢弃（双向都算，每发一帧消耗一次），不经过随机源。
   *
   * @param {number} n
   * @returns {number} 累计的待丢弃帧数
   */
  simulateDrop(n) {
    if (!Number.isInteger(n) || n < 0) {
      throw new RangeError(`simulateDrop 需要非负整数，收到 ${n}`);
    }
    this.#pendingDrops += n;
    return this.#pendingDrops;
  }

  /**
   * 模拟意外断链：置 FAILED 并 emit `disconnected {unexpected: true, reason}`，
   * 同时清空虚拟设备状态与在途投递定时器（断链即丢一切在途帧）。
   *
   * @param {string} [reason]
   */
  simulateDisconnect(reason = '模拟断链') {
    this.#clearTimers();
    this.#resetDevice();
    this.emitUnexpectedDisconnect(
      reason,
      new TransportError(TRANSPORT_ERROR.DISCONNECTED, reason),
    );
  }

  // ------------------------------------------------------------------
  // Transport 钩子覆盖
  // ------------------------------------------------------------------

  /** @returns {Promise<void>} */
  async doStartScan() {
    // mock 不扫任何东西：状态机由基类负责，这里无事可做
  }

  /** @returns {Promise<void>} */
  async doStopScan() {}

  /**
   * 连接虚拟设备。failConnect 时抛 CONNECT_FAILED（文案可由 connectError 定制）。
   *
   * @returns {Promise<void>}
   */
  async doConnect() {
    if (this.#failConnect) {
      throw new TransportError(TRANSPORT_ERROR.CONNECT_FAILED, this.#connectError);
    }
    this.#resetDevice();
    // 协议 §3.1：BLE 连接成功后设备**主动**发 hello。
    if (this.#autoRespond) {
      this.#deviceSend({
        type: MSG.HELLO,
        proto: PROTOCOL_VERSION,
        caps: 63,
        maxPayload: 8192,
        fw: '2.0.0-mock',
      });
    }
  }

  /** @returns {Promise<void>} */
  async doDisconnect() {
    this.#clearTimers();
    this.#resetDevice();
  }

  /**
   * 主机 → 设备：把一帧（4 字节帧头 + 数据）交给虚拟设备。
   *
   * 丢帧与延迟都在这里注入。上层（Link/wire）负责分片，本类不重组发送方向。
   *
   * @param {Uint8Array} bytes
   * @param {{channel?: string}} _options
   * @returns {Promise<void>}
   */
  async doSend(bytes, _options = {}) {
    const frame = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
    this.#transmit(frame, () => this.#deviceFeed(frame));
  }

  /** @returns {Promise<void>} */
  async doDispose() {
    this.#clearTimers();
    this.#resetDevice();
  }

  // ------------------------------------------------------------------
  // 双向传输管道
  // ------------------------------------------------------------------

  /**
   * 传一帧：先判丢（simulateDrop 优先于随机 dropRate），再按 latencyMs 延迟投递。
   *
   * @param {Uint8Array} frame
   * @param {() => void} deliver
   * @returns {boolean} 是否未被丢弃
   */
  #transmit(frame, deliver) {
    if (this.#pendingDrops > 0) {
      this.#pendingDrops -= 1;
      return false;
    }
    if (this.#random() < this.#dropRate) {
      return false;
    }
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      deliver();
    }, this.#latencyMs);
    this.#timers.add(timer);
    return true;
  }

  /** 清空所有在途投递定时器。 */
  #clearTimers() {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
  }

  // ------------------------------------------------------------------
  // 虚拟设备
  // ------------------------------------------------------------------

  /** 复位虚拟设备状态（断链 / 重连 / dispose 都要走这里）。 */
  #resetDevice() {
    this.#deviceReassembler = new Reassembler({
      maxMessageBytes: MAX_MESSAGE_BYTES_CEILING,
    });
    this.#deviceAckReq.clear();
  }

  /**
   * 设备收到主机发来的一帧。
   *
   * @param {Uint8Array} frame
   */
  /**
   * 虚拟设备当前是否在线：连接中（doConnect 主动发 hello 时是 CONNECTING）
   * 或已连接。其余状态（扫描中/断开/失败）设备不收不发。
   */
  get #deviceOnline() {
    return this.state === LINK_STATE.CONNECTED || this.state === LINK_STATE.CONNECTING;
  }

  #deviceFeed(frame) {
    if (!this.#deviceOnline) {
      // 尚未连接（或已被断链/断开清场）：设备不该收到任何帧
      this.#deviceStats.dropped += 1;
      return;
    }
    const head = decodeHeader(frame);
    if (head.channel === CHANNEL_AUDIO) {
      // 音频通道不重组（协议 §2.3）：mock 不处理音频，静默丢弃
      this.#deviceStats.dropped += 1;
      return;
    }
    if (head.channel === CHANNEL_HEARTBEAT) {
      // HEARTBEAT 通道（协议 §2.3）：单帧极小 JSON（ping/pong），不经过 Reassembler，
      // ACK_REQ 对它无意义（链路层消息单帧即完整，协议 §12）
      this.#deviceStats.received += 1;
      let hb;
      try {
        hb = JSON.parse(JSON_DECODER.decode(frameBody(frame)));
      } catch {
        this.#deviceStats.dropped += 1;
        return;
      }
      if (hb?.type === MSG.PING) {
        this.#deviceSend({ type: MSG.PONG, seq: hb.seq }, CHANNEL_HEARTBEAT);
      }
      return;
    }
    if (head.channel !== CHANNEL_CONTROL) {
      // 其它通道（LOG 等）mock 不处理
      this.#deviceStats.dropped += 1;
      return;
    }

    // 记录本条消息是否带 ACK_REQ（协议 §2.5：一条消息的全部分片都带）
    const key = `${head.channel}:${head.msgId}`;
    if ((head.flags & FLAG_ACK_REQ) !== 0) {
      this.#deviceAckReq.set(key, true);
    }

    this.#deviceStats.received += 1;
    let result;
    try {
      result = this.#deviceReassembler.push(frame);
    } catch {
      // 非法帧（版本不符等）：丢弃，不回任何东西
      this.#deviceStats.dropped += 1;
      this.#deviceAckReq.delete(key);
      return;
    }

    if (result.kind === 'gap') {
      this.#deviceStats.gaps += 1;
      this.#deviceAckReq.delete(key);
      // 不连续分片：回 nack，missing 列表交给发送方做选择性重传（协议 §2.5）
      this.#deviceSend({
        type: MSG.NACK,
        msgId: result.msgId,
        reason: 'REASSEMBLY_GAP',
        missing: result.missing,
      });
      return;
    }
    if (result.kind !== 'message') {
      // pending / stale / overflow：不回执（协议 §3.1：业务消息重组完成前不回 nack）
      return;
    }

    const needAck = this.#deviceAckReq.get(key) === true;
    this.#deviceAckReq.delete(key);

    let obj;
    try {
      obj = JSON.parse(JSON_DECODER.decode(result.payload));
    } catch {
      // JSON 解析失败（协议 §10 BAD_PAYLOAD）：不回执，交给上层超时
      this.#deviceStats.dropped += 1;
      return;
    }

    if (needAck) {
      // 重组成功且带 ACK_REQ → 回 ack。ack 自身永不带 ACK_REQ（否则无限递归）
      this.#deviceSend({ type: MSG.ACK, msgId: result.msgId });
    }

    if (this.#autoRespond) {
      // CONTROL 上的 ping 是容错路径，pong 原路回 CONTROL；
      // HEARTBEAT 上的 ping 在上面单独分支处理（不经重组、不进 #deviceReply）
      this.#deviceReply(result.msgId, obj, needAck);
    }
  }

  /**
   * 设备按 MSG 自动应答（docs/04 Task 3 的映射表）。
   *
   * @param {number} requestMsgId 触发应答的那条消息的 msgId
   * @param {{type?: string, seq?: number, requestId?: number}} obj
   * @param {boolean} alreadyAcked 该消息已因 FLAG_ACK_REQ 回过 ack，
   *   避免对同一条消息回两个 ack
   */
  #deviceReply(requestMsgId, obj, alreadyAcked = false) {
    switch (obj?.type) {
      case MSG.HELLO:
        this.#deviceSend({
          type: MSG.HELLO_ACK,
          accepted: true,
          proto: PROTOCOL_VERSION,
          maxPayload: MAX_MESSAGE_BYTES_CEILING,
          maxChunks: 16,
          server: 'dsh-ai-passport/2.0.0-mock',
          paired: true,
        });
        break;
      case MSG.PING:
        // CONTROL 上的 ping 属容错路径（真实固件可能不严格守 §2.3），pong 原路回 CONTROL；
        // HEARTBEAT 通道的 ping/pong 在 #deviceFeed 的独立分支处理，不走这里
        this.#deviceSend({ type: MSG.PONG, seq: obj.seq }, CHANNEL_CONTROL);
        break;
      case MSG.SESSION_STATE:
        if (!alreadyAcked) {
          this.#deviceSend({ type: MSG.ACK, msgId: requestMsgId });
        }
        break;
      case MSG.ASR_BEGIN:
        // docs/03 §7.1：asr.begin 无应答，协议里不存在 asr.started
        break;
      case MSG.ASR_END:
        this.#deviceSend({
          type: MSG.ASR_RESULT,
          requestId: obj.requestId,
          text: 'mock 识别结果',
          durationMs: 1200,
        });
        break;
      case MSG.BALANCE_REQ:
        this.#deviceSend({
          type: MSG.BALANCE,
          currency: 'CNY',
          totalBalance: '42.750000',
          recharge: '40.000000',
          bonus: '2.750000',
        });
        break;
      default:
        // 其它类型不自动应答，留给上层（Link/api）驱动
        break;
    }
  }

  /**
   * 设备 → 主机：编码 JSON 并按主机的 mtuPayload 分片后逐帧发出。
   *
   * @param {object} obj
   * @param {number} [channel]
   */
  #deviceSend(obj, channel = CHANNEL_CONTROL) {
    if (!this.#deviceOnline) return;
    const payload = JSON_ENCODER.encode(JSON.stringify(obj));
    const msgId = this.#deviceMsgId;
    this.#deviceMsgId = (this.#deviceMsgId + 1) & MSGID_MASK;
    const frames = encodeFrames({
      msgId,
      payload,
      chunkPayload: this.mtuPayload,
      channel,
    });
    for (const frame of frames) {
      // meta.channel 必须反映帧头真实通道（docs/02 §4.2）：由 encodeFrames
      // 写入帧头的同一个 channel 数值经 channelName() 反查，不得硬编码。
      this.#transmit(
        frame,
        () => this._onData(frame, { channel: channelName(channel) }),
      );
    }
    this.#deviceStats.replied += 1;
  }
}
