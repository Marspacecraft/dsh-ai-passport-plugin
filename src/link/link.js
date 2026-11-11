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
 *
 * 生命周期模型（t43）：意图（level-triggered）+ 单一收敛 worker。
 *
 *   start()/stop()/restartScan() 只在调用瞬间写 #desired（{mode,
 *   reason}）并踢一次 #kick()，方法体里没有任何 await。因此「最后调用的
 *   那个赢」由调用顺序天然决定，不需要世代号仲裁，也不会出现「某个 await
 *   回来之后按旧假设改状态」——所有 setState/emit/建拆 pipeline 都只发生在
 *   worker 的步骤函数里，步骤在每次 await 之后比较 intent 身份，不等就
 *   立刻放弃剩余副作用。
 *
 *   唯一的单飞 promise 是 #worker（同一次收敛只跑一个）与 #lastStopPromise
 *   （start 复用「上一次 transport.stop 何时结束」这个结果，只用于等待，
 *   不参与「谁该写状态」的判定）。
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

/**
 * worker 无进展上限：同一 (step.type, intent) 连续执行、且 Link 状态没有变化
 * 达到该轮数即判定规划不收敛，落回 idle 并抛错（t46-F15 防呆）。
 * 取 8 是为了给「同一轮里状态先变后变回」的正常抖动留余量，同时远小于
 * 任何会让人误以为挂死的等待时间。
 */
const NO_PROGRESS_LIMIT = 8;

/** 单次收敛的总步数预算：防住「多种步骤循环、每步都不同」的环形规划。 */
const NO_PROGRESS_STEP_BUDGET = 100;

const NULL_LOGGER = Object.freeze({
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
});

/**
 * 允许的状态跃迁表。任何不在表内的跃迁都是生命周期缺陷，直接抛错，
 * 把「过程中不允许出现非法状态」变成会响的硬约束（而不是测试事后检查）。
 */
export const LEGAL_TRANSITIONS = Object.freeze({
  idle: Object.freeze(['scanning']),
  scanning: Object.freeze(['idle', 'connecting', 'reconnecting']),
  connecting: Object.freeze(['idle', 'scanning', 'connected', 'reconnecting']),
  connected: Object.freeze(['idle', 'scanning', 'reconnecting']),
  reconnecting: Object.freeze(['idle', 'scanning', 'connecting']),
  failed: Object.freeze(['idle', 'scanning', 'connecting', 'reconnecting']),
});

export class Link extends EventEmitter {
  /**
   * @param {object} options
   * @param {import('../ble/transport.js').Transport} options.transport 传输层
   * @param {import('./handshake.js').TrustStore} [options.store] 信任表（默认内存表）
   * @param {number} [options.chunkPayload=510] 出站分片大小
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
    /** 测试专用：强制规划结果（验证无进展防呆）。 */
    planHook = null,
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
    /**
     * 用户「最后想要的状态」。只由 start/stop/restartScan 在调用瞬间改写；
     * worker 用对象身份比较判断自己手里的 intent 是否已经过期。
     *
     * mode: 'idle' | 'scanning' | 'connected'
     * reason: 广播 disconnected 时的原因
     * unexpected: 意外断开（判死/掉线）触发的收敛，需要广播 + 退避重连
     * needDisconnect: 判死路径先真正断开 transport（掉线事件已断开则 false）
     * reconnect: 本次 connected 是退避重连（失败时继续排退避，而非落 idle）
     */
    this.#desired = { mode: 'idle', reason: 'init' };
    /**
     * 正在执行的「Link 自己发起断开动作」所属 intent 栈。
     * 只有栈里仍包含「当前 desired intent」时才忽略 transport 同步 emit 的
     * disconnected 回调——若用户在动作挂起期间改变了意图，晚到的真实断链
     * 不得再被吞掉（t46-F16）。
     */
    this.#selfInitiatedIntents = [];
    this.#planHook = planHook;
    /** 已排定的重连 timer（可被新意图取消）。 */
    this.#reconnectTimer = null;
    /** Link 自身状态（ready 是握手态，独立于 transport 态）。 */
    this.#state = LINK_STATE.IDLE;
    /** 最近一次握手协商结果，断链即清（验收 3）。 */
    this.#info = null;

    // transport 事件：
    //   data → Link 常驻监听，用于刷新 keepalive.lastInboundAt（任意入站帧）；
    //          FrameIO 另有一个 'data' 监听用于解帧。
    //   disconnected → 只改意图并踢 worker；清理/广播/重连全部由 worker 收敛。
    // 因此 transport 上 data 监听器总数 = 1（Link 常驻）+ 活跃管线数（0/1）。
    this.#onTransportDisconnected = (payload) => {
      // Link 自己发起的断开动作也会让 transport emit disconnected
      // （transport.js:201 stop、:214 restartScan、:242 disconnect）。那次事件
      // 描述的只是「断开动作」本身，不是断链清理广播；由发起方显式做清理与
      // 唯一一次广播，否则会双发（判死还会被打成 unexpected:false 的
      // 「主动断开」错误语义）。
      if (this.#isSelfInitiatedForCurrentDesired()) return;
      // 用户最后想要 idle：迟到/噪声断链事件不得把链路重新拉起来。
      if (this.#desired.mode === 'idle') return;
      // 已经有一次意外断开在收敛中：不重复排队、不重复广播。
      if (this.#desired.unexpected) return;
      if (this.#state === LINK_STATE.IDLE && !this.#frameIO) return;
      this.#publish({
        mode: 'connected',
        reason: payload?.reason ?? '链路断开',
        unexpected: true,
        needDisconnect: false,
        reconnect: true,
      });
    };

    this.#onTransportData = () => this.#keepalive?.touch();
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
  #desired;
  /** 正在执行的自我断开步骤所属 intent（栈；见构造器注释）。 */
  #selfInitiatedIntents;
  /** 测试注入的规划钩子（只用于无进展防呆用例；生产路径为 null）。 */
  #planHook;
  /** 单飞：同一时刻只有一个 #reconcile 在跑。 */
  #worker = null;
  /**
   * 无进展兜底触发后置位：此后 #kick() 一律不再拉起 worker。
   * abort 已经把 Link 落回 idle 并抛错，残留的 wake/晚到操作不得再让它复活。
   */
  #aborted = false;
  /** 当前步骤正在等待的 intent 变化信号（#publish 叫醒它）。 */
  #wake = null;
  /**
   * 上一次 transport.stop 的在飞 Promise。start 需要等它收尾才能调用
   * transport.start（F7 串行化）。它只用于「复用同一在飞结果」，不参与
   * 「谁该写状态」的判定——状态完全由 worker 的 intent 比较决定。
   */
  #lastStopPromise = null;
  /** 已经执行过 restartScan 的 intent 身份，避免 worker 对同一意图反复重扫。 */
  #scanApplied = null;
  /**
   * 最近一次主动把 transport 收到「干净态」后读到的 transport.state。
   * 用于识别「stop 完成后、被作废的 connect 又晚到把 transport 拉回
   * connected」这种陈旧副作用：只有 transport 状态相对基线发生了变化，
   * 才允许再 settle 一次，避免自定义 transport.stop 不更新 state 时死循环。
   */
  #transportCleanState = null;
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

  /** Keepalive 组件（测试断言监听器清理不变量用；断链后为 null）。 */
  get keepalive() {
    return this.#keepalive;
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

  // -- 生命周期（只写意图 + 踢 worker；方法体不得出现 await） ----------------

  /** 启动链路：transport.start() → connect → 建 FrameIO/Handshake/Keepalive。 */
  start() {
    if (
      this.#desired.mode === 'connected' &&
      this.#state === LINK_STATE.CONNECTED &&
      this.#frameIO
    ) {
      return Promise.resolve();
    }
    return this.#publish({ mode: 'connected', reason: '用户连接' });
  }

  /** 主动停止：断开并释放，**不重连**（验收 4）。 */
  stop(reason = '手动停止') {
    // 幂等：已经停过/正在停，第二次调用立即返回（旧语义：不等待第一次的
    // transport.stop，也不重复广播）。这不参与状态判定：worker 已经按
    // 第一个 idle intent 在收敛，重复的 idle 不会产生任何副作用。
    if (this.#desired.mode === 'idle') return Promise.resolve();
    return this.#publish({ mode: 'idle', reason });
  }

  /** 重启扫描（例如用户切换设备）。状态回 scanning。 */
  restartScan(reason = '重启扫描') {
    return this.#publish({ mode: 'scanning', reason });
  }

  // -- 意图 / worker ---------------------------------------------------------

  /** 写入新意图、叫醒在等的那一步、踢一次 worker（返回收敛 Promise）。 */
  #publish(intent) {
    // t44 根因：旧 #plan 对所有 connected 意图都在
    // `#reconnectTimer !== null` 处返回 null（视为已收敛），而 #reconnectTimer
    // 只由 #stepStop 和 timer 自身清除。意外断链后的退避等待期内，用户
    // start() 发布的 connected 意图因此被 worker 直接判成「已收敛」而吞掉，
    // 必须等 timer 到期才连。语义边界：只有退避自己发出的意图
    // （intent.reconnect === true）才允许等 timer；用户动作在写入意图的瞬间
    // 就要取消在跑的退避，立刻重新收敛。
    if (!intent.reconnect) this.#clearReconnectTimer();
    this.#desired = intent;
    const wake = this.#wake;
    this.#wake = null;
    if (wake) wake();
    return this.#kick();
  }

  /** 单飞收敛 worker 的启动器；已有一个在跑时返回它的续接结果。 */
  #kick() {
    // 单飞：worker 自己在每一轮顶部重读 #desired，因此这里只需返回同一个
    // 在飞结果，不再做「settle 后补踢」——补踢会掩盖 worker 重读缺失的缺陷。
    // abort 之后 Worker 永久停止：否则 wake/晚到操作还能把它重新拉起来。
    if (this.#aborted) return Promise.resolve();
    if (this.#worker) return this.#worker;
    const p = this.#reconcile().finally(() => {
      if (this.#worker === p) this.#worker = null;
    });
    this.#worker = p;
    return p;
  }

  async #reconcile() {
    let lastKey = null;
    let repeats = 0;
    let steps = 0;
    // 与 steps 不同，totalSteps 不在「意图变化」时清零：即使 intent 比较本身
    // 被改坏（永远认为意图变了），也不能让 worker 在微任务里无限热跑、饿死定时器。
    let totalSteps = 0;
    for (;;) {
      const intent = this.#desired; // ① 每轮重新读最新意图
      const step = this.#plan(intent); // ② 纯函数：实际状态 + 意图 → 下一小步
      if (!step) {
        // ④ 已收敛：worker 退出（#kick 的 finally 清单飞）。
        return;
      }
      // ③ 无进展防呆：同一 (step.type,intent) 连续执行且 Link 状态没有变化，
      // 说明规划永远收敛不了。落回 idle 并抛错，而不是无限热循环。
      const key = `${step.type}:${intent.mode}:${intent.reason ?? ''}:${this.#state}`;
      if (key === lastKey) {
        repeats += 1;
      } else {
        repeats = 1;
        lastKey = key;
      }
      steps += 1;
      totalSteps += 1;
      if (totalSteps % 16 === 0) {
        // 让出宏任务：环形规划即使每步都在 await，也可能全部落在微任务队列里，
        // 饿死 IO / 定时器。每 16 步强制回到事件循环一次。
        await new Promise((resolve) => setImmediate(resolve));
      }
      if (repeats > NO_PROGRESS_LIMIT) {
        this.#abortNoProgress(
          step,
          intent,
          repeats - 1,
          `Link 收敛无进展：连续 ${repeats - 1} 轮重复步骤 ${step.type}`,
        );
      }
      if (totalSteps > NO_PROGRESS_STEP_BUDGET * 10) {
        this.#abortNoProgress(
          step,
          intent,
          totalSteps,
          `Link 收敛无进展：worker 累计执行 ${totalSteps} 步仍未退出`,
        );
      }
      if (steps > NO_PROGRESS_STEP_BUDGET) {
        this.#abortNoProgress(
          step,
          intent,
          steps,
          `Link 收敛无进展：本次收敛已执行 ${steps} 步仍未达成意图`,
        );
      }
      await this.#runStep(step, intent); // ④ 执行一小步
      if (this.#desired !== intent) {
        // 意图在 await 期间变了 → 重规划；新一轮从干净计数开始。
        lastKey = null;
        repeats = 0;
        steps = 0;
      }
    }
  }

  /** 无进展兜底：落 idle、记 error、广播一次、抛错（绝不无限循环）。 */
  #abortNoProgress(step, intent, rounds, headline) {
    const message =
      `${headline}（desired=${intent.mode}/${intent.reason ?? '?'}，state=${this.#state}）`;
    this.#logger?.error?.(message);
    // 先关掉 worker 的复活路径，再做清理：清理期间任何 wake/晚到回调都不得
    // 重新进入规划。
    this.#aborted = true;
    this.#desired = { mode: 'idle', reason: 'no-progress' };
    if (this.#state !== LINK_STATE.IDLE) {
      // 从 scanning/connecting/reconnecting 都能合法落回 idle；
      // 若当前是 connected，先拆管线再落 idle（避免留下半开链路）。
      if (this.#state === LINK_STATE.CONNECTED) this.#destroyPipeline();
      this.#setState(LINK_STATE.IDLE);
    }
    // F23-②：紧急路径也要收拾 transport，不能让 Link=idle 而底层仍 connected。
    // 已在终态时跳过（避免多余的 stop 调用/日志）。
    const transportState = this.#transport.state;
    if (transportState !== LINK_STATE.IDLE && transportState !== LINK_STATE.FAILED) {
      try {
        const stopped = this.#transport.stop?.('no-progress');
        if (stopped) {
          Promise.resolve(stopped).catch((e) =>
            this.#logger?.warn?.('无进展兜底停止 transport 失败：%s', e?.message ?? e),
          );
        } else {
          this.#transport.dispose?.();
        }
      } catch (e) {
        this.#logger?.warn?.('无进展兜底停止 transport 抛错：%s', e?.message ?? e);
      }
    }
    this.emit('no-progress', { step: step.type, repeats: rounds, intent });
    throw new Error(message);
  }

  /**
   * 纯规划：不产生任何副作用，只根据当前 state/pipeline/transport 与意图
   * 返回下一小步。null = 该意图已经达成。
   */
  #plan(intent) {
    // 测试注入：用于证明「无进展防呆」在人为永不收敛时确实会停下。
    if (this.#planHook) return this.#planHook(intent);
    const transportState = this.#transport.state;

    if (intent.mode === 'idle') {
      if (this.#state === LINK_STATE.IDLE && !this.#frameIO) {
        // stop 完成后 transport 应已干净；但如果被作废的 connect 晚到成功，
        // 它会把 transport.state 改回 connected。只在「相对 stop 完成时的
        // 基线发生了变化」时再 settle 一次——自定义 transport.stop 不更新
        // state 的情况下基线就是当时的 state，不会因此死循环。
        const drifted =
          this.#transportCleanState !== null &&
          transportState !== this.#transportCleanState &&
          (transportState === 'connected' ||
            transportState === 'connecting' ||
            transportState === 'scanning');
        if (drifted) return { type: 'settle' };
        return null;
      }
      return { type: 'stop' };
    }

    if (intent.mode === 'scanning') {
      if (this.#state === LINK_STATE.CONNECTED || this.#frameIO) return { type: 'dropToScan' };
      if (
        this.#scanApplied === intent &&
        this.#state === LINK_STATE.SCANNING &&
        transportState === 'scanning'
      ) {
        return null;
      }
      return { type: 'rescan' };
    }

    // intent.mode === 'connected'
    if (intent.unexpected) {
      // 广播与退避已经做完，等 timer 到期（timer 回调会发新的 reconnect intent）。
      if (this.#state === LINK_STATE.RECONNECTING && this.#reconnectTimer !== null) return null;
      return { type: 'downUnexpected' };
    }
    if (this.#state === LINK_STATE.CONNECTED && this.#frameIO) {
      // F16：Link 处于 connected 时 transport 也必须 connected。晚到的
      // restartScan/disconnect 会把 transport 改为 scanning，而链路管线仍在，
      // 业务 send 必然失败。按 drift 处理：拆管线、落 scanning、重新 connect
      // （与 idle 分支的 drifted→settle 同一思路）。
      // 不会死循环：dropToScan 后 Link=SCANNING，下一轮走 connect；connect
      // 成功后 transport 处于 connected，drift 消失。若底层 transport 始终
      // 不进入 connected，由 #reconcile 的无进展防呆兜底落 idle。
      if (transportState === 'connected') return null;
      return { type: 'dropToScan', drift: true };
    }
    // 退避 timer 在跑：只有退避自己发出的 reconnect 意图才允许等它。
    // 用户动作（start/stop/restartScan）在 #publish 入口已同步清除 timer，
    // 因此对用户意图来说这里看到 timer 代表「清除逻辑被破坏」，而不是
    // 「应该等待」——t44 的回归用例正是钉住这个不变量。
    if (this.#reconnectTimer !== null) return null;
    // F7：上一次 transport.stop 还在飞（可能挂起数十秒），start 不能立刻
    // 调 transport.start，否则两路 transport 操作并发。先等 stop 收尾。
    // 必须放在 IDLE 分支之前：stop() 已把 Link 落回 idle，但 transport.stop
    // 仍挂起，此时 start() 若直接 begin 就会并发调用 transport.start。
    if (this.#lastStopPromise) return { type: 'waitStop' };
    if (this.#state === LINK_STATE.IDLE) return { type: 'begin' };
    if (this.#state === LINK_STATE.RECONNECTING && !intent.reconnect) {
      // t44：RECONNECTING 下用户点连接，必须先 transport.start() 对齐扫描态
      // 再 connect；真实 bridge 的 connect() 依赖此前 start() 过。
      return { type: 'begin' };
    }
    if (this.#state === LINK_STATE.SCANNING || this.#state === LINK_STATE.RECONNECTING) {
      return { type: 'connect' };
    }
    // CONNECTING 只可能出现在某个正在执行的 connect 步骤内部；若看到它而
    // worker 已经空闲，说明会话半开，重新走一次 begin 让 transport 对齐。
    return { type: 'begin' };
  }

  async #runStep(step, intent) {
    switch (step.type) {
      case 'begin':
        return this.#stepBegin(intent);
      case 'connect':
        return this.#stepConnect(intent);
      case 'stop':
        return this.#stepStop(intent);
      case 'waitStop':
        return this.#stepWaitStop(intent);
      case 'settle':
        return this.#stepSettle(intent);
      case 'dropToScan':
        return this.#stepDropToScan(step, intent);
      case 'rescan':
        return this.#stepRescan(intent);
      case 'downUnexpected':
        return this.#stepDownUnexpected(intent);
      default:
        throw new Error(`未知的 Link 收敛步骤：${step.type}`);
    }
  }

  /**
   * 等待一个 transport 操作；意图变化时提前唤醒（该操作本身无法取消，
   * 其结果由晚到的 #kick() 再做一次收敛，绝不在本步骤里继续施加副作用）。
   */
  #awaitOrIntent(op) {
    if (!op) return Promise.resolve({ status: 'done' });
    const p = Promise.resolve(op);
    return new Promise((resolve) => {
      let settled = false;
      this.#wake = () => {
        if (settled) return;
        settled = true;
        this.#wake = null;
        resolve({ status: 'changed' });
        // 被放弃的 transport 操作晚到完成时，让 worker 再收敛一次（例如
        // connect 晚到成功、stop 晚到完成）。只改意图/状态由 worker 决定。
        p.then(
          () => void this.#kick().catch(() => {}),
          () => void this.#kick().catch(() => {}),
        );
      };
      p.then(
        (value) => {
          if (settled) return;
          settled = true;
          this.#wake = null;
          resolve({ status: 'done', value });
        },
        (error) => {
          if (settled) return;
          settled = true;
          this.#wake = null;
          resolve({ status: 'error', error });
        },
      );
    });
  }

  /** 建链第一小步：进入 scanning 并启动 transport 扫描。 */
  async #stepBegin(intent) {
    this.#clearReconnectTimer();
    this.#setState(LINK_STATE.SCANNING);
    let r;
    try {
      r = await this.#awaitOrIntent(this.#transport.start?.());
    } catch (e) {
      r = { status: 'error', error: e };
    }
    if (this.#desired !== intent) return;
    if (r.status === 'error') {
      // 调用方常写成 void link.start()：失败只记录，不能变成 unhandledRejection。
      this.#logger?.warn?.('启动链路失败：%s', r.error?.message ?? r.error);
      if (this.#state === LINK_STATE.SCANNING) this.#setState(LINK_STATE.IDLE);
      // 本次「用户想连接」已经失败，收敛到 idle；用户可再次 start()。
      this.#desired = { mode: 'idle', reason: 'start-failed' };
    }
  }

  /** 建链第二小步：connect + 装配 pipeline。 */
  async #stepConnect(intent) {
    // start 必须等上一次 stop 完全收尾（F7）：transport.stop 可能挂起数十秒，
    // 期间调用 transport.start/connect 会让两路操作并发、旧 stop 晚到覆盖新链路。
    if (this.#lastStopPromise) {
      const waited = await this.#awaitOrIntent(this.#lastStopPromise);
      if (this.#desired !== intent) return;
      if (waited.status === 'error') {
        // stop 失败不阻断重连；旧实现同样把它降级为日志。
        this.#logger?.warn?.('等待上一次 stop 失败：%s', waited.error?.message ?? waited.error);
      }
      if (this.#lastStopPromise) this.#lastStopPromise = null;
    }
    if (this.#desired !== intent) return;

    this.#setState(LINK_STATE.CONNECTING);
    let r;
    try {
      r = await this.#awaitOrIntent(this.#transport.connect());
    } catch (e) {
      r = { status: 'error', error: e };
    }
    if (this.#desired !== intent) return;
    if (r.status === 'error') {
      this.#logger?.warn?.('连接失败：%s', r.error?.message ?? r.error);
      if (this.#state !== LINK_STATE.CONNECTING) return;
      if (intent.reconnect) {
        // 退避重连：保留 connected 意图，按序列再排一次；worker 等 timer。
        this.#setState(LINK_STATE.RECONNECTING);
        this.#scheduleReconnect();
      } else {
        // 用户发起的连接失败：落回 idle、可重入（与旧 #openSession 语义一致）。
        this.#setState(LINK_STATE.IDLE);
        this.#desired = { mode: 'idle', reason: 'connect-failed' };
      }
      return;
    }

    this.#buildPipeline();
    this.#setState(LINK_STATE.CONNECTED);
  }

  /** 主动停止的一小步：拆管线、落 idle、唯一一次广播、等 transport.stop。 */
  async #stepStop(intent) {
    this.#clearReconnectTimer();
    const hadSession = this.#state !== LINK_STATE.IDLE || this.#frameIO !== null;
    this.#beginSelfInitiated(intent);
    try {
      const disposing = this.#destroyPipeline();
      // 先定终态再广播：事件观察者读到的 state/清理结果已是终态。
      if (hadSession) {
        this.#setState(LINK_STATE.IDLE);
        this.emit('disconnected', { unexpected: false, reason: intent.reason });
      }
      if (this.#desired !== intent) return;
      if (disposing) {
        await this.#awaitOrIntent(disposing);
        if (this.#desired !== intent) return;
      }
      const stopResult = this.#transport.stop?.(intent.reason);
      if (!stopResult) return;
      const stopPromise = Promise.resolve(stopResult);
      stopPromise.catch(() => {});
      this.#lastStopPromise = stopPromise;
      void stopPromise.finally(() => {
        if (this.#lastStopPromise === stopPromise) this.#lastStopPromise = null;
      }).catch(() => {});
      const r = await this.#awaitOrIntent(stopPromise);
      // 意图已变：不要 throw（新意图会接着收敛），但保留 #lastStopPromise
      // 让 start 步骤等它结束再 start。
      if (this.#desired !== intent) return;
      this.#transportCleanState = this.#transport.state;
      if (r.status === 'error') throw r.error;
    } finally {
      this.#endSelfInitiated(intent);
    }
  }

  /**
   * 等上一次 stop 收尾（F7 串行化）：本步只等待，不施加任何副作用。
   * 等完回到循环顶部按最新 intent 重新规划。
   */
  async #stepWaitStop(intent) {
    const r = await this.#awaitOrIntent(this.#lastStopPromise);
    if (this.#desired !== intent) return;
    if (r.status === 'error') {
      this.#logger?.warn?.('等待上一次 stop 失败：%s', r.error?.message ?? r.error);
    }
    this.#lastStopPromise = null;
  }

  /** idle 但没有会话、transport 仍活着的静默收尾（不广播、不改 state）。 */
  async #stepSettle(intent) {
    this.#beginSelfInitiated(intent);
    try {
      const r = await this.#awaitOrIntent(this.#transport.stop?.('清理残留连接'));
      if (this.#desired !== intent) return;
      this.#transportCleanState = this.#transport.state;
      if (r.status === 'error') throw r.error;
    } finally {
      this.#endSelfInitiated(intent);
    }
    void intent;
  }

  /** 从 CONNECTED 切到 scanning：拆管线、广播一次、重启扫描。 */
  async #stepDropToScan(step, intent) {
    this.#clearReconnectTimer();
    this.#beginSelfInitiated(intent);
    try {
      const disposing = this.#destroyPipeline();
      this.#setState(LINK_STATE.SCANNING);
      // F22：漂移对齐不是用户可见的断线（transport 被晚到操作置回 scanning，
      // Link 只是拆掉已失效的会话并重建），因此不发 misleading 的
      // disconnected——上层会据此清理会话/提示断线。真正的 stop/用户切换
      // 仍由各自步骤广播。一次操作最多一条事件。
      if (!step.drift) {
        this.emit('disconnected', { unexpected: false, reason: intent.reason });
      }
      if (disposing) {
        const d = await this.#awaitOrIntent(disposing);
        if (this.#desired !== intent) return;
        if (d.status === 'error') {
          this.#logger?.warn?.('拆管线失败：%s', d.error?.message ?? d.error);
        }
      }
      const r = await this.#awaitOrIntent(this.#transport.restartScan?.(intent.reason));
      if (this.#desired !== intent) return;
      if (r.status === 'error') {
        // 与 rescan 同一落点：transport 已 disposed/idle 时不得停在 SCANNING
        // 假装扫描中，否则 plan 永远等不到 transportState==='scanning'。
        this.#logger?.warn?.('重启扫描失败：%s', r.error?.message ?? r.error);
        this.#scanApplied = null;
        this.#setState(LINK_STATE.IDLE);
        this.#desired = { mode: 'idle', reason: 'rescan-failed' };
        return;
      }
      this.#scanApplied = intent;
    } finally {
      this.#endSelfInitiated(intent);
    }
  }

  /** 非 CONNECTED 下重启扫描：没有会话可拆，也不广播断链。 */
  async #stepRescan(intent) {
    this.#clearReconnectTimer();
    let r;
    try {
      r = await this.#awaitOrIntent(this.#transport.restartScan?.(intent.reason));
    } catch (e) {
      r = { status: 'error', error: e };
    }
    if (this.#desired !== intent) return;
    if (r.status === 'error') {
      // F15 根因：这里曾丢弃返回值并继续 setState(SCANNING)，而 transport
      // 已 disposed/idle 时 plan 的 scanning 分支永远无法收敛 → 热循环。
      // 出错必须落回可重试的 idle，绝不谎报 scanning。
      this.#logger?.warn?.('重启扫描失败：%s', r.error?.message ?? r.error);
      this.#scanApplied = null;
      if (this.#state !== LINK_STATE.IDLE) this.#setState(LINK_STATE.IDLE);
      this.#desired = { mode: 'idle', reason: 'rescan-failed' };
      return;
    }
    this.#scanApplied = intent;
    if (this.#state !== LINK_STATE.SCANNING) this.#setState(LINK_STATE.SCANNING);
  }

  /**
   * 意外断开的一小步：判死先真正断开 transport；随后拆管线、落 reconnecting、
   * 唯一一次 {unexpected:true} 广播、排退避 timer。
   */
  async #stepDownUnexpected(intent) {
    this.#beginSelfInitiated(intent);
    try {
      if (intent.needDisconnect) {
        const r = await this.#awaitOrIntent(this.#transport.disconnect?.());
        if (this.#desired !== intent) return;
        if (r.status === 'error') {
          this.#logger?.warn?.('判死断开 transport 失败：%s', r.error?.message ?? r.error);
        }
      }
      const disposing = this.#destroyPipeline();
      this.#setState(LINK_STATE.RECONNECTING);
      this.emit('disconnected', {
        unexpected: true,
        reason: intent.reason ?? '链路断开',
      });
      // 同步排定退避 timer：断链事件到达后调用方可能立刻推进假时钟
      // （tests/link 既有断言），不能等到 dispose 的微任务之后才登记。
      this.#scheduleReconnect();
      if (disposing) {
        await this.#awaitOrIntent(disposing);
        if (this.#desired !== intent) return;
      }
    } finally {
      this.#endSelfInitiated(intent);
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
    assertLegalTransition(this.#state, next, this.#desired);
    this.#state = next;
    this.emit('state', next);
  }

  #beginSelfInitiated(intent) {
    this.#selfInitiatedIntents.push(intent);
  }

  #endSelfInitiated(intent) {
    const idx = this.#selfInitiatedIntents.lastIndexOf(intent);
    if (idx >= 0) this.#selfInitiatedIntents.splice(idx, 1);
  }

  /** 只有发起步骤的意图仍是当前意图时，才允许吞掉 transport 的断开回调。 */
  #isSelfInitiatedForCurrentDesired() {
    return this.#selfInitiatedIntents.includes(this.#desired);
  }

  /** 拆掉当前 pipeline；同步部分立即生效，返回 FrameIO.dispose 的 Promise。 */
  #destroyPipeline() {
    const fio = this.#frameIO;
    // 1. 停保活 tick，并摘掉死链上的全部监听器
    this.#keepalive?.stop();
    this.#keepalive?.removeAllListeners();
    // 2. 清 FrameIO：队列 reject、acks.clear、reassembler.clear（同步主体）
    const disposing = fio ? fio.dispose() : null;
    // 3. T9：释放全部消息号（FrameIO.dispose 不做这步）
    this.#msgIds.releaseAll();
    // 4. 握手复位：ready=false、info=null（重连必须重新握手）
    this.#handshake?.dispose();
    this.#info = null;
    this.#frameIO = null;
    this.#handshake = null;
    this.#keepalive = null;
    return disposing;
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
      if (this.#desired.mode === 'idle') return;
      if (this.#desired.unexpected) return;
      // 判死只改意图；真正 disconnect/清理/广播/reconnect 全部由 worker 串行执行。
      this.#publish({
        mode: 'connected',
        reason: 'keepalive-timeout',
        unexpected: true,
        needDisconnect: true,
        reconnect: true,
      });
    });

    // 任意入站帧刷新 lastInboundAt（docs/02 §4.3）由构造器的常驻 data 监听完成。
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
    const fio = this.#frameIO;
    const handshake = this.#handshake;
    if (!handshake) return;
    if (this.#keepalive && (msg.type === 'ping' || msg.type === 'pong')) {
      this.#keepalive.handleMessage(msg.payload ?? msg);
    }
    const consumed = await handshake.handle(msg.payload ?? msg);
    // F14：await 期间链路可能已被 stop/restartScan 拆掉；旧帧不得在
    // 新会话里 emit。只在「仍是同一条 connected 会话」时透传。
    if (!consumed) {
      if (
        this.#desired.mode === 'connected' &&
        this.#frameIO === fio &&
        this.#handshake === handshake
      ) {
        this.emit('message', msg);
      }
    }
  }

  /** 按退避序列排定下一次重连；序号越界后按尾值继续（不放弃重连）。 */
  #scheduleReconnect() {
    const idx = Math.min(this.#backoffIndex, this.#backoffMs.length - 1);
    this.#backoffIndex += 1;
    const delay = this.#backoffMs[idx];
    this.#reconnectTimer = this.#setTimer(() => {
      this.#reconnectTimer = null;
      if (this.#desired.mode !== 'connected') return;
      // timer 到期才把「意外断开」收敛意图升级为一次真正的 reconnect。
      this.#publish({ mode: 'connected', reason: 'reconnect', reconnect: true });
      void this.#kick().catch(() => {});
    }, delay);
  }

  #clearReconnectTimer() {
    if (this.#reconnectTimer !== null) {
      this.#clearTimer(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
  }
}

/**
 * 状态跃迁硬约束：非法跃迁抛错（带 from→to 与当前 desired）。
 * 导出给测试直接遍历跃迁表，避免只能通过复杂操作序列间接覆盖。
 */
export function assertLegalTransition(from, next, desired) {
  const allowed = LEGAL_TRANSITIONS[from] ?? [];
  if (!allowed.includes(next)) {
    throw new Error(
      `Link 非法状态跃迁 ${from}→${next}（desired=${desired?.mode ?? '?'}/${
        desired?.reason ?? '?'
      }）`,
    );
  }
}
