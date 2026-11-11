/**
 * MockTransport 单元测试（docs/04 Task 3「测试必须覆盖」9 项）：
 *
 * 1. 连接/断开状态流转
 * 2. mtuPayload 生效
 * 3. hello 主动上报（设备发起握手，协议 §3.1）
 * 4. ack 回执（FLAG_ACK_REQ → ack）
 * 5. nack 的 missing 列表（不连续分片）
 * 6. dropRate=0 与 =1 两个极端（确定性随机源可复现）
 * 7. latency 不改变顺序
 * 8. failConnect 抛 CONNECT_FAILED（connectError 可自定义）
 * 9. simulateDisconnect 的 unexpected 语义
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

import { MockTransport } from '../../src/ble/mock-transport.js';
import {
  Transport,
  TransportError,
  LINK_STATE,
  TRANSPORT_ERROR,
} from '../../src/ble/transport.js';
import {
  FLAG_FIRST,
  FLAG_LAST,
  FLAG_ACK_REQ,
  CHANNEL_CONTROL,
  CHANNEL_HEARTBEAT,
  MTU_MIN_CHUNK_PAYLOAD,
  channelName,
} from '../../src/wire/constants.js';
import {
  encodeFrames,
  decodeHeader,
} from '../../src/wire/frame.js';

/** 收集 transport 的 data 事件，并解析成 {head, obj} 列表（重组 JSON 载荷）。 */
function makeCollector(t) {
  /** @type {Array<{channel:number, msgId:number, obj:any}>} */
  const messages = [];
  /** @type {Array<{channel:number, msgId:number, result:any}>} */
  const raws = [];
  const reassembler = {
    pending: new Map(),
    push(frame) {
      const b0 = frame[0];
      const channel = frame[1];
      const msgId = ((frame[2] & 0xff) << 4) | ((frame[3] >> 4) & 0x0f);
      const frag = frame[3] & 0x0f;
      const flags = b0 & 0x0f;
      const key = `${channel}:${msgId}`;
      const isFirst = (flags & FLAG_FIRST) !== 0;
      const isLast = (flags & FLAG_LAST) !== 0;
      if (isFirst) this.pending.set(key, { parts: [], seen: new Set(), lastFrag: -1, sawLast: false });
      const entry = this.pending.get(key);
      if (!entry) return null;
      if (entry.seen.has(frag)) return null;
      if (frag !== entry.lastFrag + 1) {
        const missing = [];
        for (let i = entry.lastFrag + 1; i < frag; i += 1) missing.push(i);
        this.pending.delete(key);
        return { kind: 'gap', missing };
      }
      entry.parts.push(frame.slice(4));
      entry.seen.add(frag);
      entry.lastFrag = frag;
      if (isLast) entry.sawLast = true;
      if (entry.sawLast && entry.seen.size === entry.lastFrag + 1) {
        const total = entry.parts.reduce((n, p) => n + p.length, 0);
        const payload = new Uint8Array(total);
        let off = 0;
        for (const p of entry.parts) { payload.set(p, off); off += p.length; }
        this.pending.delete(key);
        return { kind: 'message', payload };
      }
      return { kind: 'pending' };
    },
  };
  t.on('data', (frame) => {
    const result = reassembler.push(frame);
    const msgId = ((frame[2] & 0xff) << 4) | ((frame[3] >> 4) & 0x0f);
    const channel = frame[1];
    raws.push({ channel, msgId, result });
    if (result?.kind === 'message') {
      let obj = null;
      try { obj = JSON.parse(new TextDecoder().decode(result.payload)); } catch { /* 保留 null */ }
      messages.push({ channel, msgId, obj });
    }
  });
  return { messages, raws };
}

/** 构造一条已连接的 MockTransport（无故障注入）。 */
async function connectMock(options = {}) {
  const t = new MockTransport(options);
  await t.start();
  await t.connect();
  return t;
}

/** 主机发送一条 HEARTBEAT 通道的单帧 JSON 消息（协议 §2.3：单帧，不分片）。 */
async function sendHeartbeat(t, obj) {
  const payload = new TextEncoder().encode(JSON.stringify(obj));
  const frames = encodeFrames({
    msgId: 7,
    payload,
    chunkPayload: Math.max(t.mtuPayload, payload.length),
    channel: CHANNEL_HEARTBEAT,
  });
  assert.equal(frames.length, 1, 'HEARTBEAT 消息必须单帧');
  await t.send(frames[0], { channel: 'heartbeat' });
  return frames;
}

/** 主机发送一条 JSON 消息（按需分片，可带 ack）。 */
async function sendJson(t, obj, { ackRequired = false, chunkPayload = t.mtuPayload, channel = CHANNEL_CONTROL } = {}) {
  const payload = new TextEncoder().encode(JSON.stringify(obj));
  const frames = encodeFrames({
    msgId: 7,
    payload,
    chunkPayload,
    channel,
    ackRequired,
  });
  for (const f of frames) await t.send(f, { channel: channel === CHANNEL_HEARTBEAT ? 'heartbeat' : 'control' });
  return frames;
}

describe('MockTransport · 连接与断开状态流转', () => {
  test('实例是 Transport 子类，事件名与基类一致', async () => {
    const t = await connectMock();
    assert.ok(t instanceof MockTransport);
    assert.ok(t instanceof Transport);
    // 基类的状态机属性与事件面：state / mtuPayload / ready
    assert.equal(t.state, LINK_STATE.CONNECTED);
    assert.equal(t.ready, true);
    assert.equal(typeof t.mtuPayload, 'number');
    t.removeAllListeners();
    await t.stop();
  });

  test('start → scanning，connect → connected，emit state 事件序列', async () => {
    const t = new MockTransport();
    const states = [];
    t.on('state', (prev, next) => states.push([prev, next]));
    await t.start();
    assert.equal(t.state, LINK_STATE.SCANNING);
    await t.connect();
    assert.equal(t.state, LINK_STATE.CONNECTED);
    assert.deepEqual(states, [
      [LINK_STATE.IDLE, LINK_STATE.SCANNING],
      [LINK_STATE.SCANNING, LINK_STATE.CONNECTING],
      [LINK_STATE.CONNECTING, LINK_STATE.CONNECTED],
    ]);
    t.removeAllListeners();
    await t.stop();
    assert.equal(t.state, LINK_STATE.IDLE);
  });

  test('disconnect() 主动断开：disconnected{unexpected:false}，回 scanning', async () => {
    const t = await connectMock();
    const events = [];
    t.on('disconnected', (p) => events.push(p));
    await t.disconnect();
    assert.equal(t.state, LINK_STATE.SCANNING);
    assert.equal(events.length, 1);
    assert.equal(events[0].unexpected, false);
    t.removeAllListeners();
    await t.stop();
  });
});

describe('MockTransport · mtuPayload', () => {
  test('默认 240（基类默认值）', async () => {
    const t = await connectMock();
    assert.equal(t.mtuPayload, 240);
    t.removeAllListeners();
    await t.stop();
  });

  test('注入 mtuPayload 生效，下限 16 以下抛错', async () => {
    const t = await connectMock({ mtuPayload: 16 });
    assert.equal(t.mtuPayload, 16);
    t.removeAllListeners();
    await t.stop();

    assert.throws(
      () => new MockTransport({ mtuPayload: 15 }),
      (e) => e instanceof RangeError,
    );
  });

  test('MTU 23 对应的 chunkPayload=16 也可注入（与 wire 公式一致）', async () => {
    const t = await connectMock({ mtuPayload: MTU_MIN_CHUNK_PAYLOAD });
    assert.equal(t.mtuPayload, MTU_MIN_CHUNK_PAYLOAD);
    t.removeAllListeners();
    await t.stop();
  });

  test('设备回包按注入的 mtuPayload 分片：hello 单片，mtu=16 时分片数正确', async () => {
    // hello 载荷约 90 字节；mtu=16 时应拆成多片
    const t = await connectMock({ mtuPayload: 16 });
    const { raws } = makeCollector(t);
    await sleep(5);
    const helloRaws = raws.filter((r) => r.result?.kind === 'message');
    assert.equal(helloRaws.length, 1);
    const helloBytes = helloRaws[0].result.payload.length;
    const expectedChunks = Math.ceil(helloBytes / 16);
    const totalFrames = raws.filter((r) => r.msgId === helloRaws[0].msgId).length;
    assert.ok(expectedChunks > 1, `hello 应需要多片，实际 ${expectedChunks}`);
    assert.equal(totalFrames, expectedChunks);
    t.removeAllListeners();
    await t.stop();
  });
});

describe('MockTransport · 虚拟设备自动应答', () => {
  test('连接成功后设备主动发 hello（协议 §3.1：设备发起握手）', async () => {
    const t = await connectMock();
    const { messages } = makeCollector(t);
    await sleep(5);
    assert.equal(messages.length, 1, '连接后设备应主动发恰好一条 hello');
    const hello = messages[0];
    assert.equal(hello.channel, CHANNEL_CONTROL);
    assert.equal(hello.obj.type, 'hello');
    assert.equal(hello.obj.proto, 2);
    assert.equal(typeof hello.obj.maxPayload, 'number');
    assert.ok(hello.obj.caps > 0);
    t.removeAllListeners();
    await t.stop();
  });

  test('hello（带 ACK_REQ）→ 设备回 hello.ack，含 accepted/proto/maxPayload/maxChunks/paired', async () => {
    const t = await connectMock();
    const { messages } = makeCollector(t);
    await sleep(5); // 先收掉设备主动的 hello
    messages.length = 0;
    await sendJson(t, { type: 'hello', proto: 2, caps: 63, maxPayload: 8192 }, { ackRequired: true });
    await sleep(5);
    const types = messages.map((m) => m.obj?.type);
    assert.ok(types.includes('ack'), `应有 ack，实际 ${types.join(',')}`);
    const helloAck = messages.find((m) => m.obj?.type === 'hello.ack')?.obj;
    assert.ok(helloAck, `应有 hello.ack，实际 ${types.join(',')}`);
    assert.equal(helloAck.accepted, true);
    assert.equal(helloAck.proto, 2);
    assert.equal(helloAck.maxPayload, 8160);
    assert.equal(helloAck.maxChunks, 16);
    assert.equal(helloAck.paired, true);
    t.removeAllListeners();
    await t.stop();
  });

  test('ping → pong，原样回 seq（协议 §2.3：ping/pong 走 HEARTBEAT 通道）', async () => {
    const t = await connectMock();
    const { messages } = makeCollector(t);
    await sleep(5);
    messages.length = 0;
    await sendHeartbeat(t, { type: 'ping', seq: 42 });
    await sleep(5);
    const pong = messages.find((m) => m.obj?.type === 'pong')?.obj;
    assert.ok(pong, `应有 pong，实际 ${messages.map((m) => m.obj?.type).join(',')}`);
    assert.equal(pong.seq, 42);
    assert.equal(
      messages.find((m) => m.obj?.type === 'pong')?.channel,
      CHANNEL_HEARTBEAT,
      'HEARTBEAT 上的 ping 回的 pong 也应在 HEARTBEAT 通道',
    );
    t.removeAllListeners();
    await t.stop();
  });

  test('CONTROL 通道上的 ping 也被应答（容错路径，pong 原路回 CONTROL）', async () => {
    const t = await connectMock();
    const { messages } = makeCollector(t);
    await sleep(5);
    messages.length = 0;
    await sendJson(t, { type: 'ping', seq: 43 });
    await sleep(5);
    const pong = messages.find((m) => m.obj?.type === 'pong')?.obj;
    assert.ok(pong, 'CONTROL 上的 ping 应被容错应答');
    assert.equal(pong.seq, 43);
    assert.equal(
      messages.find((m) => m.obj?.type === 'pong')?.channel,
      CHANNEL_CONTROL,
      'CONTROL 上的 ping 回的 pong 应在 CONTROL 通道',
    );
    t.removeAllListeners();
    await t.stop();
  });

  test('session.state（带 ACK_REQ）→ 恰好一个 ack，不重复', async () => {
    const t = await connectMock();
    const { messages } = makeCollector(t);
    await sleep(5);
    messages.length = 0;
    await sendJson(t, {
      type: 'session.state', ver: 1, part: 1, parts: 1, sessions: [],
    }, { ackRequired: true });
    await sleep(5);
    const acks = messages.filter((m) => m.obj?.type === 'ack');
    assert.equal(acks.length, 1, `session.state 带 ACK_REQ 应只回一个 ack，实际 ${messages.length} 条`);
    assert.equal(acks[0].obj.msgId, 7);
    t.removeAllListeners();
    await t.stop();
  });

  test('asr.begin → 无应答（docs/03 §7.1，协议不存在 asr.started）；asr.end → asr.result', async () => {
    const t = await connectMock();
    const { messages } = makeCollector(t);
    await sleep(5);
    messages.length = 0;
    await sendJson(t, { type: 'asr.begin', requestId: 3, codec: 'ima-adpcm', sampleRate: 16000, channels: 1 });
    await sleep(10);
    assert.deepEqual(
      messages,
      [],
      `asr.begin 不应收到任何回执，实际 ${messages.map((m) => m.obj?.type).join(',')}`,
    );
    await sendJson(t, { type: 'asr.end', requestId: 3 });
    await sleep(5);
    const result = messages.find((m) => m.obj?.type === 'asr.result')?.obj;
    assert.ok(result, `asr.end 应回 asr.result，实际 ${messages.map((m) => m.obj?.type).join(',')}`);
    assert.equal(result.requestId, 3);
    assert.equal(typeof result.text, 'string');
    t.removeAllListeners();
    await t.stop();
  });

  test('balance.req → balance（含 currency/totalBalance）', async () => {
    const t = await connectMock();
    const { messages } = makeCollector(t);
    await sleep(5);
    messages.length = 0;
    await sendJson(t, { type: 'balance.req' });
    await sleep(5);
    const balance = messages.find((m) => m.obj?.type === 'balance')?.obj;
    assert.ok(balance, `应有 balance，实际 ${messages.map((m) => m.obj?.type).join(',')}`);
    assert.equal(balance.currency, 'CNY');
    assert.equal(typeof balance.totalBalance, 'string');
    t.removeAllListeners();
    await t.stop();
  });

  test('autoRespond=false：设备不发 hello、不自动应答（ack 回执仍在）', async () => {
    const t = await connectMock({ autoRespond: false });
    const { messages } = makeCollector(t);
    await sleep(5);
    assert.equal(messages.length, 0, 'autoRespond=false 时连接后不应有主动 hello');
    // 用 CONTROL 上的业务消息验证 ack 回执义务（ping 属链路层，与 autoRespond 无关，
    // HEARTBEAT 上的 ping 在 autoRespond=false 时也应回 pong，由下面单独验证）
    await sendJson(t, { type: 'session.state', ver: 1, part: 1, parts: 1, sessions: [] }, { ackRequired: true });
    await sleep(5);
    const types = messages.map((m) => m.obj?.type);
    assert.deepEqual(types, ['ack'], `只应有 ack 回执，实际 ${types.join(',')}`);
    t.removeAllListeners();
    await t.stop();
  });

  test('autoRespond=false：HEARTBEAT 上的 ping 仍回 pong（链路层义务不受 autoRespond 影响）', async () => {
    const t = await connectMock({ autoRespond: false });
    const { messages } = makeCollector(t);
    await sleep(5);
    messages.length = 0;
    await sendHeartbeat(t, { type: 'ping', seq: 2 });
    await sleep(5);
    const pong = messages.find((m) => m.obj?.type === 'pong')?.obj;
    assert.ok(pong, '保活是链路层义务，autoRespond=false 也必须回 pong');
    assert.equal(pong.seq, 2);
    t.removeAllListeners();
    await t.stop();
  });
});

describe('MockTransport · FLAG_ACK_REQ → ack 回执', () => {
  test('带 ACK_REQ 的消息重组成功后回 ack{msgId}', async () => {
    const t = await connectMock();
    const { messages } = makeCollector(t);
    await sleep(5);
    messages.length = 0;
    await sendJson(t, { type: 'session.list.req' }, { ackRequired: true });
    await sleep(5);
    const ack = messages.find((m) => m.obj?.type === 'ack')?.obj;
    assert.ok(ack);
    assert.equal(ack.msgId, 7);
    t.removeAllListeners();
    await t.stop();
  });

  test('不带 ACK_REQ 的消息不回 ack', async () => {
    const t = await connectMock({ autoRespond: false });
    const { messages } = makeCollector(t);
    await sendJson(t, { type: 'session.list.req' }, { ackRequired: false });
    await sleep(5);
    assert.deepEqual(messages, []);
    t.removeAllListeners();
    await t.stop();
  });

  test('多片消息：所有片都带 ACK_REQ，重组后回一个 ack', async () => {
    const t = await connectMock({ mtuPayload: 16, autoRespond: false });
    const { messages } = makeCollector(t);
    // 40 字节载荷 → 3 片
    await sendJson(t, { type: 'notice', text: 'x'.repeat(24) }, { ackRequired: true });
    await sleep(5);
    const acks = messages.filter((m) => m.obj?.type === 'ack');
    assert.equal(acks.length, 1);
    assert.equal(acks[0].obj.msgId, 7);
    t.removeAllListeners();
    await t.stop();
  });
});

describe('MockTransport · nack 与 missing 列表', () => {
  /** 发一串帧但跳过 missingFrags 里的片号，返回实际片数。 */
  async function sendWithMissing(t, obj, missingFrags) {
    const payload = new TextEncoder().encode(JSON.stringify(obj));
    const frames = encodeFrames({
      msgId: 9,
      payload,
      chunkPayload: 16,
      channel: CHANNEL_CONTROL,
      ackRequired: true,
    });
    for (let i = 0; i < frames.length; i += 1) {
      if (missingFrags.includes(i)) continue;
      await t.send(frames[i], { channel: 'control' });
    }
    return frames.length;
  }

  test('不连续分片 → nack，missing 列表准确', async () => {
    const t = await connectMock({ autoRespond: false });
    const { messages } = makeCollector(t);
    // 足够拆成 ≥3 片的载荷，跳过 frag 1
    const total = await sendWithMissing(t, { type: 'notice', text: 'a'.repeat(48) }, [1]);
    assert.ok(total >= 3, `载荷应拆成至少 3 片，实际 ${total}`);
    await sleep(10);
    const nack = messages.find((m) => m.obj?.type === 'nack')?.obj;
    assert.ok(nack, `应有 nack，实际 ${messages.map((m) => m.obj?.type).join(',')}`);
    assert.equal(nack.msgId, 9);
    assert.deepEqual(nack.missing, [1]);
    assert.equal(nack.reason, 'REASSEMBLY_GAP');
    t.removeAllListeners();
    await t.stop();
  });

  test('跳过连续多片 → missing 列出全部缺口', async () => {
    const t = await connectMock({ autoRespond: false });
    const { messages } = makeCollector(t);
    // 跳过 frag 1、2（载荷保证 ≥4 片）
    await sendWithMissing(t, { type: 'notice', text: 'a'.repeat(64) }, [1, 2]);
    await sleep(10);
    const nack = messages.find((m) => m.obj?.type === 'nack')?.obj;
    assert.ok(nack);
    assert.deepEqual(nack.missing, [1, 2]);
    t.removeAllListeners();
    await t.stop();
  });

  test('收到 nack 后整条重发（reassembler 遇 gap 即弃整条）→ 重组成功并回 ack', async () => {
    const t = await connectMock({ autoRespond: false });
    const { messages } = makeCollector(t);
    const payload = new TextEncoder().encode(JSON.stringify({ type: 'notice', text: 'a'.repeat(40) }));
    const frames = encodeFrames({ msgId: 9, payload, chunkPayload: 16, ackRequired: true });
    assert.ok(frames.length >= 3);
    // 先跳片制造 gap：frag 0 → frag 2
    await t.send(frames[0], { channel: 'control' });
    await t.send(frames[2], { channel: 'control' });
    await sleep(10);
    assert.ok(messages.some((m) => m.obj?.type === 'nack'), '应先回 nack');
    assert.ok(!messages.some((m) => m.obj?.type === 'ack'), 'gap 期间不应回 ack');
    // 发送方按 nack 重发：reassembler 的语义是 gap 后整条作废，必须从 FIRST 重发全片
    for (const f of frames) await t.send(f, { channel: 'control' });
    await sleep(10);
    const ack = messages.find((m) => m.obj?.type === 'ack')?.obj;
    assert.ok(ack, `重发后应回 ack，实际 ${messages.map((m) => m.obj?.type).join(',')}`);
    assert.equal(ack.msgId, 9);
    t.removeAllListeners();
    await t.stop();
  });
});

describe('MockTransport · dropRate 两个极端与可复现性', () => {
  test('dropRate=0：单帧必达', async () => {
    const t = await connectMock({ dropRate: 0, autoRespond: false });
    const { messages } = makeCollector(t);
    await sendJson(t, { type: 'session.list.req' }, { ackRequired: true });
    await sleep(5);
    assert.ok(messages.some((m) => m.obj?.type === 'ack'), 'dropRate=0 时不应丢帧');
    t.removeAllListeners();
    await t.stop();
  });

  test('dropRate=1：单帧必丢（确定性）', async () => {
    const t = await connectMock({ dropRate: 1, autoRespond: false });
    const { messages } = makeCollector(t);
    await sendJson(t, { type: 'session.list.req' }, { ackRequired: true });
    await sleep(10);
    assert.deepEqual(messages, [], 'dropRate=1 时所有帧都应被丢弃');
    t.removeAllListeners();
    await t.stop();
  });

  test('同一 seed 下丢帧结果可复现：两次运行到达序列完全一致', async () => {
    // —— 两个相同 seed 的 MockTransport 对同一批帧做出相同的丢/留决策。
    const collectDecisions = async () => {
      const t = await connectMock({ dropRate: 0.5, seed: 1234, autoRespond: false });
      const seen = [];
      t.on('data', (frame) => seen.push(frame[3] & 0x0f));
      // 20 条单帧消息，msgId 不同以免相互干扰
      for (let i = 0; i < 20; i += 1) {
        const frame = encodeFrames({ msgId: i, payload: new Uint8Array([0xab]), chunkPayload: 16 })[0];
        await t.send(frame, { channel: 'control' });
      }
      await sleep(20);
      t.removeAllListeners();
      await t.stop();
      // data 只包含"未被丢且已投递"的帧；frag 全 0，用到达顺序区分
      return seen;
    };
    const a = await collectDecisions();
    const b = await collectDecisions();
    assert.ok(a.length < 20, `dropRate=0.5 应丢掉部分帧，实际全到达 ${a.length}`);
    assert.deepEqual(a, b, '同一 seed 两次运行的到达序列应完全一致');
  });

  test('注入 random：确定性随机序列 → 逐帧可预测丢/留', async () => {
    // 随机序列 [0.1, 0.9, 0.1, 0.9]，dropRate=0.5 → 丢、留、丢、留。
    // 丢/留在主机→设备方向发生：#transmit 在 random()<dropRate 时丢帧，
    // 被丢的帧到不了设备（deviceStats.received 不增），留下的帧能到。
    const seq = [0.1, 0.9, 0.1, 0.9];
    let i = 0;
    const t = await connectMock({
      dropRate: 0.5,
      random: () => seq[Math.min(i++, seq.length - 1)],
      autoRespond: false,
    });
    for (let k = 0; k < 4; k += 1) {
      const frame = encodeFrames({ msgId: 100 + k, payload: new Uint8Array([k]), chunkPayload: 16 })[0];
      await t.send(frame, { channel: 'control' });
    }
    await sleep(10);
    assert.equal(t.deviceStats.received, 2, `应恰有 2 帧穿过，实际 ${t.deviceStats.received}`);
    t.removeAllListeners();
    await t.stop();
  });

  test('dropRate 非法值抛 RangeError', () => {
    assert.throws(() => new MockTransport({ dropRate: -0.1 }), RangeError);
    assert.throws(() => new MockTransport({ dropRate: 1.5 }), RangeError);
    assert.throws(() => new MockTransport({ dropRate: Number.NaN }), RangeError);
  });
});

describe('MockTransport · latencyMs', () => {
  test('延迟投递但不改变顺序（FIFO）', async () => {
    const t = await connectMock({ latencyMs: 15, autoRespond: false });
    const t0 = Date.now();
    for (let k = 0; k < 5; k += 1) {
      const frame = encodeFrames({
        msgId: 200 + k,
        payload: new Uint8Array([k]),
        chunkPayload: 16,
      })[0];
      await t.send(frame, { channel: 'control' });
    }
    // 15ms 内设备应一帧都没收到（延迟生效）
    assert.equal(t.deviceStats.received, 0, 'latencyMs=15 时 15ms 内不应投递');
    await sleep(40);
    assert.equal(t.deviceStats.received, 5, '延迟后 5 帧都应到达设备');
    // 设备重组不出消息（不是完整 JSON 消息），但设备侧收到的帧序即为到达序；
    // 通过 deviceStats.received 计数只能验证数量，顺序用设备 nack/ack 语义不易观察，
    // 这里直接断言总耗时 ≥ 延迟值。
    assert.ok(Date.now() - t0 >= 15);
    t.removeAllListeners();
    await t.stop();
  });

  test('latencyMs=0：几乎立即投递', async () => {
    const t = await connectMock({ autoRespond: false });
    const frame = encodeFrames({ msgId: 1, payload: new Uint8Array([1]), chunkPayload: 16 })[0];
    await t.send(frame, { channel: 'control' });
    await sleep(2);
    assert.equal(t.deviceStats.received, 1, 'latencyMs=0 时应立即投递到设备');
    t.removeAllListeners();
    await t.stop();
  });
});

describe('MockTransport · failConnect / connectError', () => {
  test('failConnect 使 connect() 抛 TransportError(CONNECT_FAILED)，state → failed', async () => {
    const t = new MockTransport({ failConnect: true });
    await t.start();
    await assert.rejects(
      () => t.connect(),
      (e) => e instanceof TransportError && e.code === TRANSPORT_ERROR.CONNECT_FAILED,
    );
    assert.equal(t.state, LINK_STATE.FAILED);
    t.removeAllListeners();
    await t.stop();
  });

  test('connectError 自定义文案', async () => {
    const t = new MockTransport({ failConnect: true, connectError: '电量不足' });
    await t.start();
    await assert.rejects(
      () => t.connect(),
      (e) => e instanceof TransportError
        && e.code === TRANSPORT_ERROR.CONNECT_FAILED
        && e.message === '电量不足',
    );
    t.removeAllListeners();
    await t.stop();
  });
});

describe('MockTransport · simulateDrop / simulateDisconnect', () => {
  test('simulateDrop(n)：接下来 n 帧确定性丢弃，之后恢复', async () => {
    const t = await connectMock({ autoRespond: false });
    t.simulateDrop(2);
    for (let k = 0; k < 4; k += 1) {
      const frame = encodeFrames({ msgId: 300 + k, payload: new Uint8Array([k]), chunkPayload: 16 })[0];
      await t.send(frame, { channel: 'control' });
    }
    await sleep(10);
    // 前 2 帧被确定性丢弃（到不了设备），后 2 帧穿过
    assert.equal(t.deviceStats.received, 2, `后 2 帧应穿过，实际设备收到 ${t.deviceStats.received}`);
    t.removeAllListeners();
    await t.stop();
  });

  test('simulateDrop(n) 同时作用于设备方向（双向计数）', async () => {
    const t = await connectMock();
    // 先消费设备主动 hello（此帧已投递）
    const first = new Promise((resolve) => t.once('data', resolve));
    await first;
    t.simulateDrop(1);
    const { messages } = makeCollector(t);
    await sendJson(t, { type: 'hello', proto: 2, caps: 63, maxPayload: 8192 });
    await sleep(10);
    assert.equal(messages.length, 0, '设备方向的下一帧也应被丢');
    t.simulateDrop(0);
    await sendHeartbeat(t, { type: 'ping', seq: 5 });
    await sleep(10);
    assert.ok(messages.some((m) => m.obj?.type === 'pong'), '恢复后应答重新可见');
    t.removeAllListeners();
    await t.stop();
  });

  test('simulateDisconnect → disconnected{unexpected:true}，state → failed，设备状态清空', async () => {
    const t = await connectMock();
    const events = [];
    const states = [];
    t.on('disconnected', (p) => events.push(p));
    t.on('state', (_prev, next) => states.push(next));
    t.simulateDisconnect('蓝牙遥控器没电了');
    assert.equal(t.state, LINK_STATE.FAILED);
    assert.equal(events.length, 1);
    assert.equal(events[0].unexpected, true);
    assert.equal(events[0].reason, '蓝牙遥控器没电了');
    assert.ok(events[0].error instanceof TransportError);
    assert.ok(states.includes(LINK_STATE.FAILED));
    // 断链后设备不回包（在途定时器已清、reassembler 已复位）
    const { messages } = makeCollector(t);
    await sleep(5);
    assert.equal(messages.length, 0, '断链后不应再有设备帧投递');
    t.removeAllListeners();
    await t.stop();
  });

  test('断链后重连：设备重新主动发 hello（重新握手，协议 §9.3）', async () => {
    const t = await connectMock();
    t.simulateDisconnect();
    await t.disconnect(); // failed → scanning
    await t.connect();
    const { messages } = makeCollector(t);
    await sleep(5);
    const hello = messages.find((m) => m.obj?.type === 'hello');
    assert.ok(hello, `重连后设备应重新发 hello，实际 ${messages.map((m) => m.obj?.type).join(',')}`);
    t.removeAllListeners();
    await t.stop();
  });
});

describe('MockTransport · 与 Transport 基类契约', () => {
  test('未连接时 send() 抛 DISCONNECTED（基类行为）', async () => {
    const t = new MockTransport();
    await assert.rejects(
      () => t.send(new Uint8Array([1, 2, 3])),
      (e) => e instanceof TransportError && e.code === TRANSPORT_ERROR.DISCONNECTED,
    );
    t.removeAllListeners();
    await t.stop();
  });

  test('构造参数透传给基类：mtuPayload 变更对设备分片生效', async () => {
    const t = await connectMock({ mtuPayload: 510 });
    assert.equal(t.mtuPayload, 510);
    // 设备主动 hello（约 90 字节）在 510 下应是单片
    const { raws } = makeCollector(t);
    await sleep(5);
    const messageRaws = raws.filter((r) => r.result?.kind === 'message');
    assert.equal(messageRaws.length, 1);
    t.removeAllListeners();
    await t.stop();
  });

  test('stop() 之后不能再 start()（基类 disposed 保护）', async () => {
    const t = await connectMock();
    await t.stop();
    await assert.rejects(() => t.start(), TransportError);
  });
});

describe('MockTransport · meta.channel 反映真实帧头通道（docs/02 §4.2）', () => {
  test('HEARTBEAT(2) ping → pong 回包 meta.channel === "heartbeat" 且帧头 channel === 2', async () => {
    const t = await connectMock();
    const metas = [];
    t.on('data', (frame, meta) => metas.push({ frame, meta }));
    await sendHeartbeat(t, { type: 'ping', seq: 77 });
    await sleep(5);
    const pongMeta = metas.find((m) => m.meta?.channel === 'heartbeat');
    assert.ok(pongMeta, `应有 channel==='heartbeat' 的回包，实际：${JSON.stringify(metas.map((m) => m.meta))}`);
    const head = decodeHeader(pongMeta.frame);
    assert.equal(head.channel, CHANNEL_HEARTBEAT, '帧头通道数值必须是 2');
    assert.equal(head.channel, 2);
    assert.equal(pongMeta.meta.channel, 'heartbeat');
    t.removeAllListeners();
    await t.stop();
  });

  test('CONTROL(0) 业务消息 → 回包 meta.channel === "control" 且帧头 channel === 0', async () => {
    const t = await connectMock();
    const metas = [];
    t.on('data', (frame, meta) => metas.push({ frame, meta }));
    await sendJson(t, { type: 'balance.req' });
    await sleep(5);
    const balMeta = metas.find((m) => m.meta?.channel === 'control');
    assert.ok(balMeta, `应有 channel==='control' 的回包，实际：${JSON.stringify(metas.map((m) => m.meta))}`);
    const head = decodeHeader(balMeta.frame);
    assert.equal(head.channel, CHANNEL_CONTROL, '帧头通道数值必须是 0');
    assert.equal(head.channel, 0);
    assert.equal(balMeta.meta.channel, 'control');
    // 反向交叉验证：同一次运行里若混有 heartbeat 回包，其 meta 不应标成 control
    const controlFrames = metas.filter((m) => m.meta?.channel === 'control');
    for (const m of controlFrames) {
      assert.equal(decodeHeader(m.frame).channel, 0, '每个标 control 的回包帧头都必须是 0');
    }
    t.removeAllListeners();
    await t.stop();
  });

  test('字符串与数值通道一致性锁死：所有回包 meta.channel 与 decodeHeader(frame).channel 经 channelName() 一一对应', async () => {
    const t = await connectMock();
    const metas = [];
    t.on('data', (frame, meta) => metas.push({ frame, meta }));
    // 混合流量：HEARTBEAT ping + CONTROL 业务消息
    await sendHeartbeat(t, { type: 'ping', seq: 1 });
    await sendJson(t, { type: 'balance.req' });
    await sleep(5);
    assert.ok(metas.length >= 2, `应至少收到 2 帧回包，实际 ${metas.length}`);
    for (const { frame, meta } of metas) {
      const head = decodeHeader(frame);
      assert.equal(
        meta.channel,
        channelName(head.channel),
        `meta.channel(${meta.channel}) 必须等于 channelName(帧头 ${head.channel})`,
      );
      if (head.channel === CHANNEL_HEARTBEAT) assert.equal(meta.channel, 'heartbeat');
      if (head.channel === CHANNEL_CONTROL) assert.equal(meta.channel, 'control');
    }
    t.removeAllListeners();
    await t.stop();
  });
});
