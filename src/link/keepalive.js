/**
 * link/keepalive.js · 双向保活与判死（docs/03 §9.1，docs/04 Task 12）。
 *
 * 这是 v1 三个缺陷的集中修复点：
 * ① v1 `missedHeartbeats += 1` 写在发 ping 之前——发送队列积压跳过发送时也在
 *    计数。**v2 模块内不存在任何计数器**，只有 `lastInboundAt` 时间戳比较。
 * ② v1 只有 `pong` 清零计数——语音上行期 ack 挤占通道就误判断链。**v2 任意
 *    入站帧都刷新存活**（`touch()`，由 link.js 在每次入站帧时调用）。
 * ③ v1 发送队列积压时仍发 ping 加剧拥塞——v2 有流量即不发 ping（touch 已把
 *    `lastInboundAt` 刷新，>5000ms 判定自然不成立）。
 *
 * 规则（协议 §9.1，双向对等）：
 *   每 5 秒 tick 一次：
 *     now - lastInboundAt >  5000 → 发 ping {type:'ping', seq:N}
 *     now - lastInboundAt > 30000 → emit('dead', {reason:'keepalive-timeout'})
 *
 * T1 回归的支撑：对端只回 ack 不回 pong 时，ack 也是入站帧，touch 持续刷新，
 * 永不满足 >30000，不会误判（v1 必死，v2 通过）。
 *
 * 时钟与定时器全部注入（{now, setTimer, clearTimer}），测试用假时钟驱动，
 * 不存在真实的 5 秒/30 秒等待。
 */

import { EventEmitter } from 'node:events';

const DEFAULT_TICK_MS = 5_000;
const PING_AFTER_IDLE_MS = 5_000;
const DEAD_AFTER_IDLE_MS = 30_000;

/**
 * 保活器。
 *
 * @fires dead {reason: 'keepalive-timeout', idleMs} 连续 30 秒无任何入站
 * @fires pong {{type:'pong', seq:number}} 收到对端 ping 后的应答（经 send 回调发出）
 */
export class Keepalive extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {() => number} [options.now] 时钟（可注入假时钟）
   * @param {(fn: () => void, ms: number) => any} [options.setTimer]
   * @param {(handle: any) => void} [options.clearTimer]
   * @param {(payload: object) => void|Promise<void>} [options.send]
   *   发送回调：发 ping 与回 pong 都走它（link 层接到 FrameIO.sendMessage）
   * @param {number} [options.tickMs] tick 间隔，默认 5000（仅测试注入）
   * @param {number} [options.pingIntervalMs] 空闲多久发 ping，默认 5000
   * @param {number} [options.deadTimeoutMs] 空闲多久判死，默认 30000
   */
  constructor({
    now = () => Date.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (h) => clearTimeout(h),
    send = () => {},
    tickMs,
    pingIntervalMs,
    deadTimeoutMs,
  } = {}) {
    super();
    this.#now = now;
    this.#setTimer = setTimer;
    this.#clearTimer = clearTimer;
    this.#send = send;
    this.#tickMs = tickMs ?? DEFAULT_TICK_MS;
    this.#pingAfter = pingIntervalMs ?? PING_AFTER_IDLE_MS;
    this.#deadAfter = deadTimeoutMs ?? DEAD_AFTER_IDLE_MS;
    if (!(this.#tickMs > 0) || !(this.#pingAfter > 0) || !(this.#deadAfter > this.#pingAfter)) {
      throw new Error(
        `Keepalive 阈值非法：tickMs=${this.#tickMs} pingAfter=${this.#pingAfter} deadAfter=${this.#deadAfter}`,
      );
    }
    // lastInboundAt 起点即构造时刻：链路刚建立视为「刚收到入站」
    this.#lastInboundAt = now();
  }

  #now;
  #setTimer;
  #clearTimer;
  #send;
  #tickMs;
  #pingAfter;
  #deadAfter;

  /** 收到任意通道任意帧的时间戳。 */
  #lastInboundAt;
  #timer = null;
  #running = false;
  #seq = 0;

  /** 最近一次入站时间（诊断用）。 */
  get lastInboundAt() {
    return this.#lastInboundAt;
  }

  /** tick 是否在跑。 */
  get running() {
    return this.#running;
  }

  /** 启动 tick。重复 start 无副作用。 */
  start() {
    if (this.#running) return;
    this.#running = true;
    this.#lastInboundAt = this.#now();
    this.#arm();
  }

  /**
   * 收到任意入站帧时刷新存活（T1 的关键入口）。
   * link.js 应在 #handleFrame 的最前面无条件调用——不只是 pong。
   *
   * @param {number} [at] 入站时间戳，缺省取当前时钟
   */
  touch(at = this.#now()) {
    this.#lastInboundAt = at;
  }

  /**
   * 收到对端消息时的便捷入口：任何消息都 touch；ping 额外立即回 pong{seq}。
   * pong 本身只 touch 不校验（协议 §9.1：seq 不匹配也正常）。
   *
   * @param {{type?: string, seq?: number}} message
   */
  handleMessage(message) {
    this.touch();
    if (message?.type === 'ping') {
      void this.#send({ type: 'pong', seq: message.seq });
      this.emit('pong', { type: 'pong', seq: message.seq });
    }
    // pong / 其它消息：只 touch，不校验 seq，不做任何其他动作
  }

  /** 停止 tick。幂等；停后不再发 ping、不再 emit。 */
  stop() {
    this.#running = false;
    if (this.#timer !== null) {
      this.#clearTimer(this.#timer);
      this.#timer = null;
    }
  }

  /** 挂下一轮 tick。判死或 stop 后不再挂。 */
  #arm() {
    if (!this.#running) return;
    this.#timer = this.#setTimer(() => this.#tick(), this.#tickMs);
  }

  /**
   * tick：纯时间戳比较，**没有计数器**（v1 缺陷①的修复点——发 ping 之前
   * 不自增任何东西，发送被跳过也不会累积任何状态）。
   *
   * 阈值语义为「满」（>=）：tick 步进恰为 pingAfter（5 秒），若用严格大于，
   * 检查点永远恰好落在阈值上，首个 ping 会被推迟整整一个周期（10 秒），
   * 与「空闲满 5 秒就发 ping」的规格意图相悖。
   */
  #tick() {
    this.#timer = null;
    if (!this.#running) return;
    const idle = this.#now() - this.#lastInboundAt;
    if (idle >= this.#deadAfter) {
      this.stop(); // 先停 tick，保证 'dead' 之后不再 emit
      this.emit('dead', { reason: 'keepalive-timeout', idleMs: idle });
      return;
    }
    if (idle >= this.#pingAfter) {
      // 有业务流量时 idle 达不到 pingAfter——无需单独判断「有无流量」
      this.#seq += 1;
      void this.#send({ type: 'ping', seq: this.#seq });
    }
    this.#arm();
  }
}
