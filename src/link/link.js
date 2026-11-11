/**
 * link/link.js — 链路层门面（docs/02 §4.3 / docs/04 Task 13）
 *
 * 把 FrameIO（收发管线）、Handshake（握手与配对）、Keepalive（双向保活）
 * 装配成一条"可用链路"，并实现断链清理矩阵的链路层部分：
 *
 *   断链顺序（验收 1，顺序不能反）：
 *     1. 停 keepalive tick（停后不再发 ping）
 *     2. frameIO.dispose() —— 队列 reject、acks.clear、reassembler.clear
 *     3. msgIds.releaseAll() —— T9 号段回归（FrameIO.dispose 不做这步）
 *     4. handshake.reset() —— ready=false、info=null（重连必须重新握手）
 *     5. emit('disconnected', …) —— 恰好一次
 *
 *   Link 不持有业务状态（C5）：审批/提问/ASR 的 pending 由各能力层自己清理，
 *   本层只保证 disconnected 事件一定发出。
 *
 *   退避重连：意外断开按 [1000,2000,5000,10000,20000,30000]ms 重试，重连
 *   成功（ready）后序号复位；主动 stop() 不重连。
 */

import { EventEmitter } from 'node:events';

import { WireError, ERR } from '../wire/errors.js';
import { MsgIdAllocator } from '../wire/msgid.js';
import { PendingAcks } from '../wire/acks.js';
import { Reassembler } from '../wire/reassembler.js';
import { MAX_MESSAGE_BYTES_CEILING } from '../wire/constants.js';
import { FrameIO } from './frame-io.js';
import { Handshake, HANDSHAKE_STATE } from './handshake.js';
import { Keepalive } from './keepalive.js';

/** Link 状态与 transport 层同名（docs/02 §4.3）。 */
export const LINK_STATE = Object.freeze({
  IDLE: 'idle',
  SCANNING: 'scanning',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting',
  FAILED: 'failed',
});

/** 意外断开的重连退避序列（docs/04 Task 13 验收 4）。 */
const DEFAULT_BACKOFF_MS = Object.freeze([1000, 2000, 5000, 10000, 20000, 30000]);

const NULL_LOGGER = Object.freeze({
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
});

export class Link extends EventEmitter {
  /**
   * @param {object} options
   * @param {import('../ble/transport.js').Transport} options.transport 传输层
   * @param {import('./handshake.js').TrustStore} [options.store] 信任表（默认内存表）
   * @param {number} [options.chunkPayload=510] 出站分片大小
   * @param {(code: string) => Promise<void>} [options.beginPairing] —— 不用，
   *        配对由上层经 link.handshake.beginPairing(code) 发起
   * @param {{debug?, info?, warn?, error?}} [options.logger]
   * @param {() => number} [options.now] 假时钟注入（透传 keepalive）
   * @param {(fn: () => void, ms: number) => unknown} [options.setTimer]
   * @param {(id: unknown) => void} [options.clearTimer]
   * @param {number[]} [options.backoffMs=DEFAULT_BACKOFF_MS]
   * @param {MsgIdAllocator} [options.msgIds] 注入用
   * @param {PendingAcks} [options.acks] 注入用
   * @param {Reassembler} [options.reassembler] 注入用
   */
  constructor({
    transport,
    store,
    chunkPayload = 510,
    logger,
    now,
    setTimer,
    clearTimer,
    backoffMs = DEFAULT_BACKOFF_MS,
    msgIds,
    acks,
    reassembler,
  } = {}) {
    super();
    if (!transport || typeof transport.connect !== 'function') {
      throw new WireError(ERR.BAD_PAYLOAD, 'Link 需要一个带 connect 的 transport');
    }

    this.#transport = transport;
    this.#logger = { ...NULL_LOGGER, ...logger };
    this.#now = now ?? (() => Date.now());
    this.#setTimer =
      setTimer ??
      ((fn, ms) => setTimeout(fn, ms).unref?.());
    this.#clearTimer = clearTimer ?? ((id) => clearTimeout(id));
    this.#backoffMs = backoffMs;
    this.#chunkPayload = chunkPayload;
    this.#msgIds = msgIds ?? new MsgIdAllocator();

    // 断链清理依赖注入：测试断言"事件到达时清理已完成"必须能拿到这些件。
    this.#acks = acks ?? null;
    this.#reassembler = reassembler ?? null;
    this.#store = store ?? null;

    /** 意外断开时的重连退避序号；ready 后复位。 */
    this.#backoffIndex = 0;
    /** 主动 stop() 时为 true：不再重连。 */
    this.#stopping = false;
    /**
     * 会话世代。stop()/restartScan() 自增，使任何在飞的 connect 作废：
     * connect 最长要等 70 秒（30s 扫描 + 30s 连接 + 服务发现），「点了连接、
     * 等不及、点断开」是真实可达路径。#openSession 在 await connect 之后比对
     * 世代，不一致就不再建管线——否则晚到的成功会把链路复活为 connected
     * （ready=false、pipeline 绑在已停的 transport 上），而 start() 在
     * state ∈ {CONNECTED, CONNECTING} 时早退，用户再也点不动「连接」。
     */
    this.#generation = 0;
    /**
     * Link 自己发起断开动作（keepalive 判死 / stop() / restartScan()）的嵌套计数。
     * >0 时忽略 transport 同步 emit 的 disconnected 回调，由发起方自己做唯一一次
     * 清理与广播，避免「transport 事件 + 显式广播」叠成双发。
     */
    this.#selfInitiatedDown = 0;
    /** 已排定的重连 timer（可被 stop() 取消）。 */
    this.#reconnectTimer = null;
    /** Link 自身状态（ready 是握手态，独立于 transport 态）。 */
    this.#state = LINK_STATE.IDLE;
    /** 最近一次握手协商结果，断链即清（验收 3）。 */
    this.#info = null;

    // transport 事件：
    //   data → touch keepalive → FrameIO 解帧
    //   disconnected → Link 断链清理 + 退避重连
    // FrameIO 的入站入口是私有 #handleFrame（经自身 #onData 监听 transport）。
    // FrameIO 自己监听 transport 'data'，Link 无需转发——但要防止测试里
    // transport 二次 emit 双投递。Link 的 data 监听只做 keepalive touch。
    this.#onTransportData = () => {
      this.#keepalive?.touch();
    };
    this.#onTransportDisconnected = (payload) => {
      // Link 自己发起的断开动作也会让 transport emit disconnected
      // （transport.js:201 stop、:214 restartScan、:242 disconnect）。那次事件
      // 描述的只是「断开动作」本身，不是断链清理广播；由发起方显式做清理与
      // 唯一一次广播，否则会双发（判死还会被打成 unexpected:false 的
      // 「主动断开」错误语义）。见 #onTransportDown 的调用点：
      //   - keepalive dead → 显式 #onTransportDown({unexpected:true,...})
      //   - stop()         → 自己 emit({unexpected:false, reason})
      //   - restartScan()  → 自己 emit({unexpected:false, reason})
      if (this.#selfInitiatedDown > 0) return;
      void this.#onTransportDown(payload ?? {});
    };

    transport.on('data', this.#onTransportData);
    transport.on('disconnected', this.#onTransportDisconnected);
  }

  // -- 状态 ------------------------------------------------------------------

  #transport;
  #logger;
  #now;
  #setTimer;
  #clearTimer;
  #backoffMs;
  #chunkPayload;
  #msgIds;
  #acks; // 注入引用（断链清理断言用）；未注入时由 FrameIO 自建
  #reassembler;
  #store;

  #frameIO = null;
  #handshake = null;
  #keepalive = null;

  #backoffIndex;
  #stopping;
  #generation;
  #selfInitiatedDown;
  /** 启动串行化令牌：非 null 表示一次 start() 仍在飞（t34-F3）。 */
  #startToken = null;
  /** stop() 重入保护：第二次并发调用直接返回（t34-F6）。 */
  #stopInFlight = false;
  #reconnectTimer;
  #state;
  #info;

  #onTransportData;
  #onTransportDisconnected;

  /** idle|scanning|connecting|connected|reconnecting|failed */
  get state() {
    return this.#state;
  }

  /** 握手是否完成（重连/断链后为 false，验收 3）。 */
  get ready() {
    return this.#handshake?.state === HANDSHAKE_STATE.READY;
  }

  /** 最近握手协商结果；断链/未握手为 null。 */
  get info() {
    return this.#info;
  }

  /** 握手组件（上层经 link.handshake.beginPairing(code) 发起配对）。 */
  get handshake() {
    return this.#handshake;
  }

  /** 注入的 msgIds（测试断言 T9 用）。 */
  get msgIds() {
    return this.#msgIds;
  }

  /** 注入的 acks（测试断言清理顺序用；未注入为 null）。 */
  get acks() {
    return this.#acks;
  }

  /** 注入的 reassembler（测试断言 C6/C8 用；未注入为 null）。 */
  get reassembler() {
    return this.#reassembler;
  }

  // -- 生命周期 ---------------------------------------------------------------

  /**
   * 启动链路：transport.start() → connect → 建 FrameIO/Handshake/Keepalive。
   * 幂等：已连接时直接返回。
   */
  async start() {
    // t34-F3：SCANNING 期间并发 start()（例如 React 双调用）会让两次调用都越过
    // 下面的状态早退，各自在 await transport.start 后进入 #openSession，建出
    // 两套 FrameIO/Handshake/Keepalive（connect 两次、hello.ack 两条）。
    // 用「启动令牌」串行化：令牌在时第二次调用直接返回。
    // 令牌不是永久锁：stop()/restartScan() 会作废本次启动并清空令牌，迟到的
    // 启动在 await 后因世代不符返回；其 finally 只在仍持有同一令牌时才清空，
    // 不会误清新启动的令牌。
    if (this.#startToken !== null) return;
    if (this.#state === LINK_STATE.CONNECTED || this.#state === LINK_STATE.CONNECTING) {
      return;
    }
    const token = Symbol('link-start');
    this.#startToken = token;
    try {
      this.#stopping = false;
      this.#clearReconnectTimer();
      // t29：transport.start 可能挂起数十秒（真实 bridge-client 最长 70s：
      // 30s 扫描 + 30s 连接 + 服务发现）。期间用户点断开/换设备时，本次启动
      // 已被 stop()/restartScan() 作废；晚到的完成不得再进入 #openSession，
      // 否则会把已停止的链路复活成 connected（P1），或 connect 抛「已销毁」
      // 后把 state 卡死在 connecting（P2）。
      const generation = this.#generation;
      this.#setState(LINK_STATE.SCANNING);
      try {
        await this.#transport.start?.();
        if (generation !== this.#generation || this.#stopping) return;
        await this.#openSession();
      } catch (e) {
        // 调用方常写成 void link.start()：失败只记录，不能变成 unhandledRejection。
        // #openSession 已在 connect 失败时把 state 从 connecting 落回 idle（可重试）；
        // 这里兜底 transport.start 自身抛错的情形。
        this.#logger?.warn?.('启动链路失败：%s', e?.message ?? e);
        if (generation === this.#generation && this.#state === LINK_STATE.SCANNING) {
          this.#setState(LINK_STATE.IDLE);
        }
      }
    } finally {
      if (this.#startToken === token) this.#startToken = null;
    }
  }

  /**
   * 主动停止：断开并释放，**不重连**（验收 4）。
   * 断链清理顺序与意外断开一致，之后 emit 一次 disconnected{unexpected:false}。
   * transport.stop() 自己也会 emit 断链事件（transport.js:200-203）：期间置
   * #selfInitiatedDown 忽略该回调，由本方法做唯一一次广播（验收 2：恰好一次）。
   */
  async stop(reason = '手动停止') {
    // t34-F6：并发 stop()（例如「关闭」与断链/退出清理同时触发）会让两次调用
    // 都通过下面的状态早退，并各自清一次、广播一次。第二次直接返回：第一次
    // 会完成清理并把状态落到 idle。
    if (this.#stopInFlight) return;
    if (this.#state === LINK_STATE.IDLE && !this.#frameIO) return;
    this.#stopInFlight = true;
    try {
      // 作废任何在飞的 connect（见 #generation 注释），也作废在飞的 start：
      // stop 之后用户应能立刻重新 start，不必等迟到的 transport.start 返回。
      this.#generation += 1;
      this.#startToken = null;
      this.#stopping = true;
      this.#clearReconnectTimer();
      this.#selfInitiatedDown += 1;
      try {
        await this.#teardown();
        await this.#transport.stop?.(reason);
        this.#setState(LINK_STATE.IDLE);
        // 验收 2：主动断开也必须广播一次 disconnected（Link 不持有业务状态，
        // 上层靠这个事件清理自己的 pending）。
        this.emit('disconnected', { unexpected: false, reason });
      } finally {
        this.#selfInitiatedDown -= 1;
      }
    } finally {
      this.#stopInFlight = false;
    }
  }

  /**
   * 重启扫描（例如用户切换设备）。状态回 scanning。
   * CONNECTED 时 transport.restartScan 也会 emit 断链事件（transport.js:213-216）：
   * 期间置 #selfInitiatedDown 忽略该回调，由本方法做唯一一次广播。
   */
  async restartScan(reason = '重启扫描') {
    // 作废任何在飞的 connect：否则它晚到成功会把链路拉回 connected，
    // 而本次 restartScan 的目的正是「换设备重扫」。也作废在飞的 start
    // （同 stop：用户换设备后应能立刻重新 start）。
    this.#generation += 1;
    const generation = this.#generation;
    this.#startToken = null;
    if (this.#state !== LINK_STATE.CONNECTED) {
      // 未连接：没有会话要拆，也没有断链可广播；只让 transport 重扫描。
      await this.#transport.restartScan?.(reason);
      // t34-F5：等待期间 stop() 可能已把状态落到 idle；晚到的 restartScan
      // 不得把终态改回 scanning（复活）。
      if (generation !== this.#generation || this.#stopping) return;
      this.#setState(LINK_STATE.SCANNING);
      return;
    }
    this.#selfInitiatedDown += 1;
    try {
      await this.#teardown();
      this.#setState(LINK_STATE.SCANNING);
      this.emit('disconnected', { unexpected: false, reason });
      await this.#transport.restartScan?.(reason);
    } finally {
      this.#selfInitiatedDown -= 1;
    }
  }

  // -- 收发 -------------------------------------------------------------------

  /**
   * 发送业务/白名单消息。未 ready 时业务消息抛 WireError(NOT_CONNECTED)，
   * 白名单（链路层与配对）放行（验收 6）。
   */
  async send(type, payload = {}, { ack = true, channel = 0 } = {}) {
    if (!this.#isWhitelisted(type) && !this.ready) {
      throw new WireError(
        ERR.NOT_CONNECTED,
        `链路未就绪（ready=false），不能发送业务消息 ${type}`,
      );
    }
    if (!this.#frameIO) {
      throw new WireError(ERR.NOT_CONNECTED, '链路未启动');
    }
    return this.#frameIO.sendMessage(type, payload, { ack, channel });
  }

  /**
   * 发送音频（docs/02 §4.3）：直接切分走 AUDIO 通道，不分配消息号、
   * 不登记 ACK、不重传（验收 5）。
   */
  async sendAudio(bytes, requestId) {
    if (!this.#frameIO) {
      throw new WireError(ERR.NOT_CONNECTED, '链路未启动');
    }
    if (!this.ready) {
      // 音频也要求链路就绪：半开的链路会静默丢音频。
      throw new WireError(ERR.NOT_CONNECTED, `链路未就绪，丢弃音频 ${requestId ?? ''}`);
    }
    await this.#frameIO.sendRaw(1 /* CHANNEL_AUDIO */, bytes);
    this.#logger.debug('sendAudio: %d 字节，requestId=%s（不占消息号）', bytes.length, requestId);
  }

  // -- 内部 -------------------------------------------------------------------

  #isWhitelisted(type) {
    // docs/03 §3.1 白名单：链路层 + 配对在握手前放行。
    return (
      type === 'ping' ||
      type === 'pong' ||
      type === 'ack' ||
      type === 'nack' ||
      (typeof type === 'string' && type.startsWith('pair.'))
    );
  }

  #setState(next) {
    if (this.#state === next) return;
    this.#state = next;
    this.emit('state', next);
  }

  /** 建立一条会话：transport.connect → 新建三件套。失败时抛出（由退避接管）。 */
  async #openSession() {
    const generation = this.#generation;
    this.#setState(LINK_STATE.CONNECTING);
    try {
      await this.#transport.connect();
    } catch (e) {
      // t29：connect 失败（典型：stop() 已 dispose transport，connect 抛
      // 「Transport 已销毁」）不能把 state 留在 connecting——start() 在
      // state ∈ {CONNECTED, CONNECTING} 时早退，之后永远点不动「连接」。
      // 落回 idle：Link 的 failed 目前没有产生者，idle 是「未启动、可重入」
      // 的终态，start() 不会早退。世代已变时不动 state（stop/restartScan
      // 已给出自己的终态，如 idle/scanning）。
      if (generation === this.#generation && this.#state === LINK_STATE.CONNECTING) {
        this.#setState(LINK_STATE.IDLE);
      }
      throw e;
    }
    if (generation !== this.#generation) {
      // 等待期间被 stop()/restartScan() 取消：这次会话作废。
      await this.#reconcileAbandonedSession();
      return;
    }
    this.#buildPipeline();
    this.#setState(LINK_STATE.CONNECTED);
  }

  /**
   * 收尾一次「作废但晚到成功」的会话。
   *
   * 此时 transport 认为自己是 CONNECTED，而 Link 已经回到别的状态。必须让两者
   * 对齐，否则下一次 connect() 会因 transport 仍 CONNECTED 而早退、新 Handshake
   * 永远等不到 hello（与判死重连卡死同源）。收尾期间屏蔽 transport 自己 emit 的
   * 断链事件：发起方（stop/restartScan）已经做过唯一一次广播。
   */
  async #reconcileAbandonedSession() {
    this.#selfInitiatedDown += 1;
    try {
      if (this.#state === LINK_STATE.IDLE) {
        // stop() 是终态：transport 一并停掉。
        await this.#transport.stop?.('连接期间被取消');
      } else if (this.#state === LINK_STATE.SCANNING) {
        // restartScan() 想继续找设备：把 transport 拉回扫描，不要停掉它。
        await this.#transport.restartScan?.('连接期间被取消');
      } else {
        // 判死/重连路径：断开即可，退避到期后会重新 connect。
        await this.#transport.disconnect?.();
      }
    } catch (err) {
      this.#logger?.warn?.('作废会话的 transport 收尾失败：%s', err?.message ?? err);
    } finally {
      this.#selfInitiatedDown -= 1;
    }
  }

  #buildPipeline() {
    // FrameIO 注入共享件（有注入用注入，没有则 FrameIO 自建并回填引用）。
    this.#frameIO = new FrameIO({
      transport: this.#transport,
      chunkPayload: this.#chunkPayload,
      maxMessageBytes: MAX_MESSAGE_BYTES_CEILING,
      logger: this.#logger,
      ...(this.#msgIds ? { msgIds: this.#msgIds } : {}),
      ...(this.#acks ? { acks: this.#acks } : {}),
      ...(this.#reassembler ? { reassembler: this.#reassembler } : {}),
    });
    if (!this.#acks) {
      this.#acks = null; // FrameIO 自建时拿不到内部引用——注入路径才是测试路径
    }

    this.#handshake = new Handshake({
      // t34-F1：断链/停链会把 #frameIO 置 null。send 闭包若直接解引用，
      // 会在调用点同步抛 TypeError（.catch 根本没挂上），再经 void #routeMessage
      // 变成进程级 unhandledRejection。先取局部引用并判空。
      send: (msg) => {
        const fio = this.#frameIO;
        if (!fio) return;
        fio.sendMessage(msg.type, msg, { ack: false }).catch(() => {});
      },
      store: this.#store ?? { load: async () => ({}), save: async () => {} },
      chunkPayload: this.#chunkPayload,
    });
    this.#handshake.on('ready', (info) => {
      this.#info = info;
      this.#backoffIndex = 0; // 握手成功 → 退避序号复位
      this.#keepalive?.start();
      this.emit('ready', info);
    });
    this.#handshake.on('rejected', (p) => this.emit('handshake-rejected', p));
    this.#handshake.on('pair-required', (p) => this.emit('pair-required', p));
    this.#handshake.on('paired', (p) => this.emit('paired', p));
    this.#handshake.on('pair-failed', (p) => this.emit('pair-failed', p));

    this.#keepalive = new Keepalive({
      now: this.#now,
      setTimer: this.#setTimer,
      clearTimer: this.#clearTimer,
      // 同上：keepalive ping 发送失败（判死/断链后销毁）不上抛（T16 缺陷①）。
      // t34-F1：同样先取局部引用，避免 #frameIO 已置 null 时同步抛 TypeError。
      send: (msg) => {
        const fio = this.#frameIO;
        if (!fio) return;
        fio.sendMessage(msg.type, msg, { ack: false }).catch(() => {});
      },
    });
    this.#keepalive.on('dead', (p) => {
      this.#logger.warn('keepalive 判死：%j', p);
      // 判死必须先真正断开 transport（T16 缺陷②）：transport 停留在 CONNECTED
      // 时，退避重连的 connect() 会在基类早退（transport.js:231），设备不会重发
      // hello，新 Handshake 永远停在 idle → ready 永久 false。
      // 但 disconnect() 自己会 emit disconnected{unexpected:false,'主动断开'}：
      // 置 #selfInitiatedDown 让 Link 忽略该回调，只由本 handler 显式调用
      // #onTransportDown 完成一次清理与一次 {unexpected:true, keepalive-timeout}
      // 广播（T16 缺陷③：既不能双发，也不能把判死标成主动断开）。
      // t34-F2：disconnect() 可能挂起（真实 transport 最长数秒）。期间 stop()
      // 或 restartScan() 可能已抢先接管并做了唯一一次广播/清理；只查
      // #stopping 不够（restartScan 不改它），必须比对 dead 触发时的世代。
      const generation = this.#generation;
      this.#selfInitiatedDown += 1;
      void (async () => {
        try {
          await this.#transport.disconnect?.();
        } catch (e) {
          // 断开失败也必须继续判死清理与重连，且不得变成 unhandledRejection。
          this.#logger.warn('判死断开 transport 失败：%s', e?.message ?? e);
        } finally {
          this.#selfInitiatedDown -= 1;
          // stop()/restartScan() 抢先接管时由它们自己广播，避免重复；
          // 世代不符说明本次判死已作废，既不清也不再排重连。
          if (this.#stopping || generation !== this.#generation) return;
          this.#onTransportDown({ unexpected: true, reason: 'keepalive-timeout' });
        }
      })();
    });

    // FrameIO message → 路由：握手先消费；业务消息透传上层。
    this.#frameIO.on('message', (msg) => {
      void this.#routeMessage(msg);
    });
    this.#frameIO.on('audio', (a) => this.emit('audio', a));
    this.#frameIO.on('gap', (g) => this.emit('gap', g));
    this.#frameIO.on('ack-timeout', (p) => this.emit('ack-timeout', p));
    this.#frameIO.on('error', (e) => this.emit('error', e));
  }

  /**
   * FrameIO 完整消息路由：
   *   - ping/pong/pair.*（以及任何握手期消息）→ handshake.handle 消费，
   *     ping/pong 另喂 keepalive（保活自回复 pong 的职责在 keepalive）；
   *   - ready 后的业务消息 → emit('message') 交上层。
   */
  async #routeMessage(msg) {
    if (this.#keepalive && (msg.type === 'ping' || msg.type === 'pong')) {
      this.#keepalive.handleMessage(msg.payload ?? msg);
    }
    const consumed = await this.#handshake.handle(msg.payload ?? msg);
    if (!consumed) {
      this.emit('message', msg);
    }
  }

  /**
   * 断链清理（验收 1 顺序）+ 退避重连（验收 4）。
   * 注意：必须先完成全部清理，再 emit 一次 disconnected。
   * FrameIO.dispose() 声明为 async 但主体全同步；这里同步调用并在微任务
   * 上挂上"异步续体"保险（万一 dispose 未来变成真异步，仍由
   * disposeAftermath 兜底重置），保证"事件到达时清理已完成"同步成立。
   */
  #onTransportDown({ unexpected, reason }) {
    const isUnexpected = unexpected === true;
    if (this.#state === LINK_STATE.IDLE && !this.#frameIO) return;

    // 1. 停保活 tick（停后不再发 ping）
    this.#keepalive?.stop();

    // 2. 清 FrameIO：队列 reject、acks.clear、reassembler.clear（dispose 同步主体）
    const disposePromise = this.#frameIO?.dispose();
    if (disposePromise) {
      void disposePromise.then(() => this.#disposeAftermath());
    }

    // 3. T9：释放全部消息号（FrameIO.dispose 不做这步）
    this.#msgIds.releaseAll();

    // 4. 握手复位：ready=false、info=null（验收 3：重连必须重新握手）
    this.#handshake?.reset();
    this.#info = null;
    this.#frameIO = null;
    this.#handshake = null;
    this.#keepalive = null;

    // 5. 先定状态再广播：事件观察者读到的 state 已是终态
    //    （意外→reconnecting；否则保持 transport.stop/disconnect 设定值）。
    if (isUnexpected && !this.#stopping) {
      this.#setState(LINK_STATE.RECONNECTING);
    }
    this.emit('disconnected', {
      unexpected: isUnexpected,
      reason: reason ?? (isUnexpected ? '链路断开' : '主动断开'),
    });

    if (isUnexpected && !this.#stopping) {
      this.#scheduleReconnect();
    } else if (!isUnexpected) {
      // transport.disconnect() 的场景：回 scanning 继续（docs/04 验收 6 走 stop()）
      if (this.#state === LINK_STATE.CONNECTED) this.#setState(LINK_STATE.SCANNING);
    }
  }

  /** dispose 的异步续体：真正的异步收尾（当前 dispose 全同步，此为保险）。 */
  #disposeAftermath() {
    // 预留：FrameIO 未来若引入异步释放，在这里补清理。
  }

  /** 按退避序列排定下一次重连；序号越界后按尾值继续（不放弃重连）。 */
  #scheduleReconnect() {
    if (this.#stopping) return;
    const idx = Math.min(this.#backoffIndex, this.#backoffMs.length - 1);
    this.#backoffIndex += 1;
    const delay = this.#backoffMs[idx];
    this.#reconnectTimer = this.#setTimer(() => {
      this.#reconnectTimer = null;
      void this.#reconnectOnce();
    }, delay);
  }

  async #reconnectOnce() {
    if (this.#stopping) return;
    // t29：重连的 connect 在飞时被 stop() 作废（generation 变化 / stopping），
    // 失败上抛后不得再把 state 拉回 reconnecting——stop() 的 idle 才是终态。
    const generation = this.#generation;
    try {
      await this.#openSession();
    } catch (e) {
      if (this.#stopping || generation !== this.#generation) return;
      this.#logger.warn('重连失败：%s', e?.message ?? e);
      this.#setState(LINK_STATE.RECONNECTING);
      this.#scheduleReconnect();
    }
  }

  #clearReconnectTimer() {
    if (this.#reconnectTimer !== null) {
      this.#clearTimer(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
  }

  /**
   * 清理当前会话（stop/restartScan 路径）。与意外断开共用同一清理序列，
   * 但不发 disconnected（调用方自己发，避免双发）。
   */
  async #teardown() {
    this.#keepalive?.stop();
    await this.#frameIO?.dispose();
    this.#msgIds.releaseAll();
    this.#handshake?.reset();
    this.#info = null;
    this.#frameIO = null;
    this.#handshake = null;
    this.#keepalive = null;
  }
}
