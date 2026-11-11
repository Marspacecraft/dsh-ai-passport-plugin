// M3 集成：mock 下链路层端到端（docs/04 Task 14）。
//
// 用 MockTransport 把 M2（transport/frame/reassembler/acks）与 M3（frame-io/
// handshake/keepalive/link）串起来，验证握手就绪、大载荷逐字节还原、假时钟
// 心跳三态、T1（只回 ack 不回 pong 不判死）、T9（断链号段释放）、主动 stop
// 不重连、丢片 → nack → 整条重发（docs/03 §2.5）。
//
// 关键约束（实测探针结论，均非下层 bug）：
// - mock 虚拟设备的 CONTROL 载荷必须是合法 JSON（mock-transport.js:371-378
//   JSON.parse 失败即静默丢弃、不回 ack），所以二进制载荷以 base64 放进
//   ping{seq} 里走回程校验（设备 pong 原样回显 seq）。
// - JSON 载荷受 maxMessageBytes 限制：chunkPayload=240 时上限 3840，3KB b64
//   （4120B）放不下，必须用 chunkPayload=510（上限 8160）的构造。
// - pong/hello/ack 不经 link.on('message')（routeMessage 先喂 keepalive、
//   handshake.handle 消费），下行回程校验要在 transport.data 上挂独立
//   Reassembler 收集。
// - 判死用例需要吞掉设备 pong：monkey-patch Transport 的公共入口 _onData
//   （不改源码），单帧识别 type==='pong' 丢弃。
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { MockTransport } from '../../src/ble/mock-transport.js';
import { LINK_STATE } from '../../src/ble/transport.js';
import { Link } from '../../src/link/link.js';
import { Reassembler } from '../../src/wire/reassembler.js';
import { decodeHeader, frameBody } from '../../src/wire/frame.js';
import { WireError, ERR } from '../../src/wire/errors.js';
import { MSG } from '../../src/wire/constants.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询等待条件成立，超时抛错。 */
async function waitFor(fn, timeoutMs = 1000, stepMs = 5) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fn()) return;
    if (Date.now() > deadline) throw new Error(`waitFor 超时（${timeoutMs}ms）`);
    await sleep(stepMs);
  }
}

/** 假时钟：手动推进 now，定时器按到期序同步触发（mock 投递是宏任务，不参与 advance）。 */
function makeFakeClock() {
  let nowMs = 0;
  let tid = 0;
  const timers = new Map();
  const clock = {
    now: () => nowMs,
    setTimer: (fn, ms) => {
      const id = ++tid;
      timers.set(id, { fn, due: nowMs + ms });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
  };
  const advance = (ms) => {
    const target = nowMs + ms;
    for (;;) {
      let next = null;
      for (const [, tm] of timers) {
        if (tm.due <= target && (next === null || tm.due < next.due)) next = tm;
      }
      if (!next) break;
      timers.delete([...timers.entries()].find(([, tm]) => tm === next)[0]);
      nowMs = next.due;
      next.fn();
    }
    nowMs = target;
  };
  return { ...clock, advance, get nowMs() { return nowMs; } };
}

/**
 * 在 transport.data 上挂独立 Reassembler 收集下行完整 JSON 消息
 * （绕开 link 内部对 hello/ack/ping/pong 的消费）。
 */
function makeDownlinkCollector(transport) {
  const reassembler = new Reassembler({ maxMessageBytes: 8160 });
  const messages = [];
  transport.on('data', (frame) => {
    let head;
    try {
      head = decodeHeader(frame);
    } catch {
      return;
    }
    if (head.channel !== 0) return; // 只关心 CONTROL（音频在 M2 已测）
    let res;
    try {
      res = reassembler.push(frame);
    } catch {
      return;
    }
    if (res.kind !== 'message') return;
    try {
      messages.push(JSON.parse(Buffer.from(res.payload).toString('utf8')));
    } catch {
      // 下行也可能是非 JSON（本测试不产生）
    }
  });
  return messages;
}

/** 吞掉设备下行 pong（T1/判死用例）：monkey-patch Transport 公共数据入口。 */
function dropDownlinkPong(transport) {
  const orig = transport._onData.bind(transport);
  transport._onData = (frame, meta) => {
    try {
      const head = decodeHeader(frame);
      if (head.channel === 0) {
        const obj = JSON.parse(Buffer.from(frameBody(frame)).toString('utf8'));
        if (obj?.type === MSG.PONG) return; // 吞掉 pong
      }
    } catch {
      // 非 JSON / 非法帧照常放行
    }
    return orig(frame, meta);
  };
}

/** 统计出站 ping（载荷 {type:'ping'} 的出站帧，记录其帧头 msgId 供区分业务/keepalive）。 */
function countOutboundPings(transport) {
  const pings = [];
  const orig = transport.send.bind(transport);
  transport.send = async (frame, options) => {
    try {
      const head = decodeHeader(frame);
      if (head.frag === 0) {
        const obj = JSON.parse(Buffer.from(frameBody(frame)).toString('utf8'));
        if (obj?.type === MSG.PING) pings.push({ seq: obj.seq, msgId: head.msgId });
      }
    } catch {
      // 非 JSON 帧不关心
    }
    return orig(frame, options);
  };
  return pings;
}

/** 记录出站帧头（只观察，不改变发送行为）。 */
function recordOutboundFrames(transport) {
  const heads = [];
  const orig = transport.send.bind(transport);
  transport.send = async (frame, options) => {
    heads.push(decodeHeader(frame));
    return orig(frame, options);
  };
  return heads;
}

/** 注入式信任表（不落盘）。 */
const memoryStore = () => ({ load: async () => ({}), save: async () => {} });

/** 建一对 (transport, link) 并跑到 ready。 */
async function connectLink({
  mtuPayload = 240,
  chunkPayload = 240,
  clock = null,
  dropPong = false,
  dropRate,
  random,
} = {}) {
  const transport = new MockTransport({
    mtuPayload,
    ...(dropRate === undefined ? {} : { dropRate }),
    ...(random === undefined ? {} : { random }),
  });
  if (dropPong) dropDownlinkPong(transport);
  const downlink = makeDownlinkCollector(transport);
  const link = new Link({
    transport,
    chunkPayload,
    backoffMs: [10],
    store: memoryStore(),
    ...(clock
      ? { now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer }
      : {}),
  });
  const disconnectedEvents = [];
  link.on('disconnected', (p) => disconnectedEvents.push(p));
  await link.start();
  await waitFor(() => link.ready);
  return { transport, link, downlink, disconnectedEvents };
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('M3 集成（mock 端到端）', () => {
  describe('验收 1 · 握手就绪与协商', () => {
    test('mock 连接 → 设备主动 hello → ready=true → info.maxPayload=3840（MTU 247 档）', async () => {
      const { link, downlink } = await connectLink({ mtuPayload: 240, chunkPayload: 240 });
      assert.equal(link.ready, true);
      assert.equal(link.state, LINK_STATE.CONNECTED);
      // maxPayload = min(设备 8192, 16×chunkPayload 240, 8160) = 3840
      assert.equal(link.info.maxPayload, 3840);
      assert.equal(link.info.maxChunks, 16);
      assert.equal(link.info.firmware, '2.0.0-mock');
      // 设备主动 hello 已到达主机（协议 §3.1：设备先发）。hello.ack 是主机出站，
      // 不在下行 collector 里——只能经 mock 设备侧 #deviceReply 间接验证：主机 hello.ack
      // 到达后 mock 不会重复回 hello，且链路 ready 本身就证明 ack 流程闭环。
      const hello = downlink.find((m) => m.type === MSG.HELLO);
      assert.ok(hello, '应收到设备主动 hello');
      assert.equal(hello.proto, 2);
      assert.equal(hello.maxPayload, 8192);
      await link.stop();
    });
  });

  describe('验收 2 · 3KB 逐字节还原', () => {
    test('Link.send 发 3KB（base64 进 ping.seq），设备 pong 回显逐字节相等', async () => {
      // 3KB b64 ≈ 4120B 超出 chunkPayload=240 档的 3840 上限，用 510 档（上限 8160）
      const { transport, link, downlink } = await connectLink({ mtuPayload: 510, chunkPayload: 510 });
      assert.equal(link.info.maxPayload, 8160);
      const payload = new Uint8Array(3072).map((_, i) => i & 0xff);
      const b64 = Buffer.from(payload).toString('base64');
      const result = await link.send(MSG.PING, { seq: b64 });
      assert.equal(typeof result.msgId, 'number');
      await sleep(60); // pong 在 ack（send resolve）之后到达
      const pong = downlink.find((m) => m.type === MSG.PONG);
      assert.ok(pong, '设备应回 pong');
      assert.equal(pong.seq, b64, 'pong 应原样回显 seq');
      const restored = Buffer.from(pong.seq, 'base64');
      assert.equal(Buffer.compare(Buffer.from(payload), restored), 0, '设备侧回程应逐字节相等');
      assert.equal(transport.deviceStats.gaps, 0);
      await link.stop();
    });
  });

  describe('验收 3 · 假时钟心跳三态', () => {
    let clock;
    beforeEach(() => { clock = makeFakeClock(); });

    test('空闲满 5 秒发 ping；期间不判死', async () => {
      const { link, transport, disconnectedEvents } = await connectLink({ clock });
      const pings = countOutboundPings(transport);
      clock.advance(5000); // tick@5000：idle=5000 ≥ 5000 → 发 ping
      await sleep(20);
      assert.equal(pings.length, 1, '满 5 秒应发出 1 条 keepalive ping');
      assert.equal(link.state, LINK_STATE.CONNECTED);
      assert.equal(disconnectedEvents.length, 0, '不应判死');
      await link.stop();
    });

    test('有业务流量（入站续命）不发 ping', async () => {
      const { link, transport } = await connectLink({ clock });
      // keepalive ping 与业务 ping 载荷同为 {type:'ping',seq}，出站侧无法按载荷区分；
      // 改用 msgId 区分：链路出站号单调递增，业务 traffic 的 msgId 记下后，
      // 后续更高号的 ping 帧若出现必为 keepalive（keepalive 每次 allocate 新号）。
      const pings = countOutboundPings(transport); // 记录 {type:'ping'} 出站帧的 msgId
      clock.advance(100); // 无 tick 触发
      const traffic = await link.send(MSG.PING, { seq: 'traffic' }); // 设备回 pong → touch
      await sleep(20); // 等 pong 宏任务投递完成（touch 生效）
      clock.advance(4900); // tick@5000：idle=4900 < 5000 → 不发 ping
      await sleep(20);
      const keepalivePings = pings.filter((p) => p.msgId !== traffic.msgId);
      assert.equal(keepalivePings.length, 0, '5 秒内有入站流量不应发 keepalive ping');
      await link.stop();
    });

    test('空闲满 30 秒判死：disconnected{unexpected:true, keepalive-timeout} 恰好一次 → reconnecting', async () => {
      const { link, transport, disconnectedEvents } = await connectLink({ clock, dropPong: true });
      clock.advance(30000); // tick@30000：pong 被吞、无任何入站 → 判死
      // 判死路径异步断开 transport（disconnect → 显式 #onTransportDown），等它跑完
      await sleep(20);
      // 计数断言（不能只 .find）：transport.disconnect() 内部会 emit
      // disconnected{unexpected:false, reason:'主动断开'}，它只属于断开动作本身，
      // 不是判死的清理广播；Link 必须忽略这次回调，只由判死路径广播一次。
      assert.equal(
        disconnectedEvents.length,
        1,
        `判死只应广播一次 disconnected（实际 ${JSON.stringify(disconnectedEvents)}）`,
      );
      const [dead] = disconnectedEvents;
      assert.equal(dead.unexpected, true, '判死必须标记意外断开（上层据此重连）');
      assert.equal(dead.reason, 'keepalive-timeout');
      assert.ok(
        !disconnectedEvents.some((p) => p.unexpected === false),
        '判死路径不得出现 unexpected:false（会被上层误读为主动停止、不重连）',
      );
      assert.equal(link.state, LINK_STATE.RECONNECTING);
      // 判死必须真正断开 transport：否则退避重连的 connect() 因已 CONNECTED 早退，
      // 新 Handshake 永远等不到 hello（T16 缺陷②的回归点）。
      assert.notEqual(
        transport.state,
        LINK_STATE.CONNECTED,
        '判死必须真正断开 transport（否则重连永远无法重新握手）',
      );
      await link.stop();
    });
  });

  describe('验收 4 · T1 回归（只回 ack 不回 pong 不判死）', () => {
    test('每 4 秒一条业务消息（设备只回 ack），假时钟推 60 秒链路不判死', async () => {
      const clock = makeFakeClock();
      const { link, transport, disconnectedEvents } = await connectLink({ clock, dropPong: true });
      // 模拟 v1 场景：设备只回 ack（needAck 路径），pong 被网络吞掉。
      // 每 4 秒一次业务往返 → 每次入站 ack 都续命，60 秒内永不判死。
      // 注意：keepalive ping 与业务 ping 载荷同为 {type:'ping',seq}，出站侧无法
      // 区分；本用例的验收点是「不判死」，ping 频率归验收 3 的专项用例。
      for (let i = 0; i < 15; i += 1) {
        await link.send(MSG.PING, { seq: i }); // 设备回 ack（入站 → touch）
        clock.advance(4000);
      }
      await sleep(20);
      assert.equal(clock.nowMs, 60000, '假时钟应已推进 60 秒');
      assert.equal(disconnectedEvents.length, 0, '有 ack 续命不得判死（v1 缺陷回归点）');
      assert.equal(link.state, LINK_STATE.CONNECTED);
      assert.equal(link.ready, true);
      assert.ok(transport, '链路全程可用');
      await link.stop();
    });
  });

  describe('验收 5 · T9 回归（断链号段释放）', () => {
    test('占满 4096 消息号 → 断链 → releaseAll → 重连后可正常发送', async () => {
      const { transport, link } = await connectLink({ backoffMs: undefined });
      // 占满全部消息号（首个分配为 0，空间 4096）
      let exhausted = false;
      try {
        for (;;) link.msgIds.allocate();
      } catch (e) {
        assert.ok(e instanceof WireError);
        assert.equal(e.code, ERR.MSGID_EXHAUSTED);
        exhausted = true;
      }
      assert.equal(exhausted, true, '占满后 allocate 应抛 MSGID_EXHAUSTED');
      // 意外断链 → #onTransportDown → msgIds.releaseAll
      transport.simulateDisconnect('T9-test');
      await waitFor(() => link.state === LINK_STATE.RECONNECTING);
      assert.ok(link.msgIds.available > 0, '断链后号段应全部释放');
      // 真时钟 backoffMs=[10]，等待重连完成握手
      await waitFor(() => link.ready, 2000);
      assert.equal(link.state, LINK_STATE.CONNECTED);
      // 号段已释放 → 可正常发送（白名单 ping，ack:false 立即返回）
      await link.send(MSG.PING, { seq: 'after-reconnect' }, { ack: false });
      await link.stop();
    });
  });

  describe('验收 6 · 主动 stop() 不重连', () => {
    test('stop → 恰好一次 disconnected{unexpected:false} → state=idle，不再重连', async () => {
      const { transport, link, disconnectedEvents } = await connectLink({});
      await link.stop('用户关闭');
      assert.equal(link.state, LINK_STATE.IDLE);
      assert.equal(link.ready, false);
      // 验收 2：主动断开必须广播一次（transport.stop 自己也 emit 断链事件，
      // 不得因此变成两次）。
      assert.equal(
        disconnectedEvents.length,
        1,
        `主动 stop 只应广播一次 disconnected（实际 ${JSON.stringify(disconnectedEvents)}）`,
      );
      assert.deepEqual(disconnectedEvents[0], { unexpected: false, reason: '用户关闭' });
      // transport 已 dispose：不发生任何重连
      await sleep(50);
      assert.equal(link.state, LINK_STATE.IDLE, '不得重连');
      assert.equal(transport.state, LINK_STATE.IDLE);
      assert.equal(disconnectedEvents.length, 1, '停止后不得再补发 disconnected');
      await assert.rejects(() => link.send(MSG.PING, { seq: 1 }), (e) => e.code === ERR.NOT_CONNECTED);
    });
  });

  describe('验收 6b · restartScan() 重启扫描（主动断开语义）', () => {
    test('CONNECTED 时 restartScan → 恰好一次 disconnected{unexpected:false} → state=scanning', async () => {
      const { transport, link, disconnectedEvents } = await connectLink({});
      await link.restartScan('切换设备');
      // transport.restartScan 在 CONNECTED 时也会 emit disconnected（transport.js:214），
      // Link 自己又 emit 一次会变成两次——这里精确断言只有一次。
      assert.equal(
        disconnectedEvents.length,
        1,
        `restartScan 只应广播一次 disconnected（实际 ${JSON.stringify(disconnectedEvents)}）`,
      );
      assert.deepEqual(disconnectedEvents[0], { unexpected: false, reason: '切换设备' });
      assert.equal(link.state, LINK_STATE.SCANNING);
      assert.equal(link.ready, false);
      assert.equal(transport.state, LINK_STATE.SCANNING);
      await link.stop();
    });
  });

  describe('验收 7 · 丢片 → nack → 整条重发（docs/03 §2.5）', () => {
    test('dropRate 确定性丢 frag1 → 设备 gap → nack → 从 FIRST 整条重发 → ack → pong 逐字节还原', async () => {
      // 用 mock 自带的 dropRate（src/ble/mock-transport.js:258 的丢弃分支），
      // 注入确定性随机源让「丢第 2 个出站帧」可复现：armed 之前一律保留；
      // armed 之后第 2 次抽样返回 0（0 < 0.5 → 丢），其余返回 1（保留）。
      // 这样走的是 mock 自己的丢帧路径，而不是绕过它去 monkey-patch send。
      let armed = false;
      let draws = 0;
      const random = () => {
        if (!armed) return 1;
        draws += 1;
        return draws === 2 ? 0 : 1;
      };

      const { transport, link, downlink } = await connectLink({
        mtuPayload: 240,
        chunkPayload: 240,
        dropRate: 0.5,
        random,
      });
      const payload = new Uint8Array(2500).map((_, i) => i & 0xff);
      const b64 = Buffer.from(payload).toString('base64'); // 3336B / 240 = 14 片 ≤ 16
      const heads = recordOutboundFrames(transport); // 只观察帧头，不制造故障

      armed = true;
      const result = await link.send(MSG.PING, { seq: b64 });
      armed = false;

      assert.equal(typeof result.msgId, 'number');
      assert.ok(draws >= 2, `随机源应被 dropRate 抽样（实际 ${draws} 次）`);
      // 初次 14 片 + 整条重发 14 片，出站帧必然超过 14
      assert.ok(heads.length > 14, `应发生整条重发（出站帧 ${heads.length} > 初次 14）`);
      // 「从 FIRST 整条重发」的直接证据：同一 msgId 的 frag0 出现两次
      const firsts = heads.filter((h) => h.msgId === result.msgId && h.frag === 0);
      assert.equal(firsts.length, 2, `应看到 frag0 共 2 次（初次 + 整条重发），实际 ${firsts.length}`);
      // 关键区分（协议 §2.5）：重发必须「从 FIRST 整条重发」，而不是只补缺失片。
      // 若退回选择性重传，设备 gap 时已弃缓冲，补来的 frag1 只会判 stale，最终
      // 只能靠 400ms 的 ACK 超时兜底整条重发——那样 heads[14] 会是 frag1 而非 frag0。
      const frags = heads.map((h) => h.frag);
      assert.deepEqual(
        frags.slice(0, 14),
        [...Array(14).keys()],
        `初次应逐片 0..13，实际 ${frags.slice(0, 14)}`,
      );
      assert.deepEqual(
        frags.slice(14, 28),
        [...Array(14).keys()],
        `nack 后应从 frag0 起整条重发，实际 ${frags.slice(14, 28)}`,
      );
      const stats = transport.deviceStats;
      assert.equal(stats.gaps, 1, '设备侧应识别 1 次 gap');

      await sleep(60);
      const pong = downlink.find((m) => m.type === MSG.PONG);
      assert.ok(pong, '设备应回 pong');
      const restored = Buffer.from(pong.seq, 'base64');
      assert.equal(Buffer.compare(Buffer.from(payload), restored), 0, '重发后回程应逐字节相等');
      await link.stop();
    });
  });
});
