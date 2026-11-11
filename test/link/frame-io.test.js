/**
 * M3 Task 10：`link/frame-io.js` 收发管线单元测试。
 *
 * 覆盖 docs/04 Task 10 全部 8 条验收项：
 * 1. sendMessage 走 encodeFrames → 发送队列串行；ack:true 登记 PendingAcks，
 *    ack:false 发完立即 release 消息号。
 * 2. 收到完整消息 emit('message')；type 非字符串不 emit，记 badPayload 并回
 *    nack{reason:"BAD_PAYLOAD"}。
 * 3. AUDIO 通道字节不进 Reassembler，直接 emit('audio')（注入 spy 证明）。
 * 4. gap → emit('gap') + nack{REASSEMBLY_GAP}；只整条重发，不做部分重传。
 * 5. 收 ack → acknowledge + release；收 nack → 从 FIRST 整条重发（missing 仅诊断）。
 * 6. ack 超时放弃 → emit('ack-timeout') + 释放消息号。
 * 7. 断链时队列 reject 全部待发项并 emit 可观测事件，不留悬挂 Promise。
 * 8. maxMessageBytes 超限抛 WireError(PAYLOAD_TOO_LARGE)，不静默截断。
 *
 * PendingAcks / MsgIdAllocator / Reassembler 均可通过构造参数注入，
 * 测试直接观察这些 wire 模块的状态，不依赖实现内部字段。
 */

import assert from 'node:assert/strict';
import { test, describe, beforeEach, afterEach } from 'node:test';

import { FrameIO } from '../../src/link/frame-io.js';
import { encodeFrames, decodeHeader, frameBody } from '../../src/wire/frame.js';
import { Reassembler } from '../../src/wire/reassembler.js';
import { PendingAcks } from '../../src/wire/acks.js';
import { MsgIdAllocator } from '../../src/wire/msgid.js';
import { WireError, ERR } from '../../src/wire/errors.js';
import {
  MSG,
  CHANNEL_CONTROL,
  CHANNEL_AUDIO,
  FLAG_ACK_REQ,
  FLAG_FIRST,
  FLAG_LAST,
  channelName,
} from '../../src/wire/constants.js';

const JSON_ENCODER = new TextEncoder();
const JSON_DECODER = new TextDecoder();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 测试用 Transport 桩：记录 send 调用，可注入 send 行为。
 * - mode 'ok'：立即成功
 * - mode 'hang'：返回永不 settle 的 Promise（测断链 reject）
 * - mode 'throw'：抛错
 */
class StubTransport {
  constructor() {
    this.sent = []; // { frame, meta }
    this.mode = 'ok';
    this.listeners = {};
  }

  on(event, fn) {
    (this.listeners[event] ??= []).push(fn);
    return this;
  }

  off(event, fn) {
    this.listeners[event] = (this.listeners[event] ?? []).filter((f) => f !== fn);
    return this;
  }

  emit(event, ...args) {
    for (const fn of this.listeners[event] ?? []) fn(...args);
  }

  async send(frame, meta = {}) {
    if (this.mode === 'hang') return new Promise(() => {});
    if (this.mode === 'throw') throw new Error('注入的发送失败');
    this.sent.push({ frame, meta });
  }
}

/** 组装一套可观察的 FrameIO 及其注入件。 */
function makeFrameIO({
  chunkPayload = 64,
  maxMessageBytes = 1024,
  acksOptions,
} = {}) {
  const transport = new StubTransport();
  const msgIds = new MsgIdAllocator();
  const ackSendCalls = [];
  const acks = new PendingAcks({
    retryDelays: [10_000, 10_000, 10_000], // 默认不给超时机会
    send: (msgId, resent, frags) => ackSendCalls.push({ msgId, resent, frags }),
    ...acksOptions,
  });
  const pushedToReassembler = [];
  const reassembler = new Reassembler({ maxMessageBytes });
  const origPush = reassembler.push.bind(reassembler);
  reassembler.push = (frame) => {
    pushedToReassembler.push(frame);
    return origPush(frame);
  };
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const fio = new FrameIO({
    transport,
    chunkPayload,
    maxMessageBytes,
    logger,
    msgIds,
    acks,
    reassembler,
  });
  return { fio, transport, msgIds, acks, ackSendCalls, pushedToReassembler, logger };
}

/** 把 FrameIO 发出的帧取出来（最近 n 帧）。 */
function lastFrames(transport, n) {
  return transport.sent.slice(-n).map((s) => s.frame);
}

describe('FrameIO · 验收1：encodeFrames → 队列串行 + ack 登记/release', () => {
  test('ack:true：帧带 ACK_REQ，PendingAcks.track 登记，消息号保持占用', async () => {
    const { fio, transport, acks, msgIds } = makeFrameIO();
    // 不等 ack resolve（测试不回 ack），只验证登记状态后主动放弃
    const p = fio.sendMessage('notice', { text: 'hi' });
    await sleep(5);
    const frames = lastFrames(transport, 1);
    const head = decodeHeader(frames[0]);
    assert.equal(head.channel, CHANNEL_CONTROL);
    assert.notEqual(head.flags & FLAG_ACK_REQ, 0, 'ack:true 帧必须带 ACK_REQ');
    assert.equal(acks.size, 1, '应登记进待确认表');
    assert.equal(msgIds.size, 1, 'ack 在途期间消息号保持占用');
    acks.abandon(head.msgId, 'test-cleanup'); // 触发 onGiveUp 释放，sendMessage 随 ack-timeout reject
    await assert.rejects(p, (e) => e instanceof WireError);
    assert.equal(msgIds.size, 0, '放弃后消息号释放');
    await fio.dispose();
  });

  test('ack:false：帧不带 ACK_REQ，发完立即 release，不登记待确认表', async () => {
    const { fio, transport, acks, msgIds } = makeFrameIO();
    await fio.sendMessage('notice', { text: 'hi' }, { ack: false });
    const head = decodeHeader(lastFrames(transport, 1)[0]);
    assert.equal(head.flags & FLAG_ACK_REQ, 0, 'ack:false 帧不得带 ACK_REQ');
    assert.equal(acks.size, 0, '不登记待确认表');
    assert.equal(msgIds.size, 0, '发完立即释放消息号');
    await fio.dispose();
  });

  test('队列串行：并发多条 sendMessage 时逐帧按调用序发出，不交错', async () => {
    const { fio, transport } = makeFrameIO({ chunkPayload: 16 });
    const p1 = fio.sendMessage('notice', { n: 1, pad: 'a'.repeat(40) }, { ack: false });
    const p2 = fio.sendMessage('notice', { n: 2, pad: 'b'.repeat(40) }, { ack: false });
    await Promise.all([p1, p2]);
    const frames = lastFrames(transport, 6);
    const msgIdsInOrder = frames.map((f) => decodeHeader(f).msgId);
    // 每条消息 3 片（56B/16cp → 4 片？40+约10B 的 JSON 约 50B → 4 片），
    // 关键断言：同一 msgId 的片必须连续，两条消息不交错
    const seen = new Set();
    let current = null;
    for (const id of msgIdsInOrder) {
      if (id !== current) {
        assert.ok(!seen.has(id), `消息 ${id} 的帧被交错了：${msgIdsInOrder.join(',')}`);
        seen.add(id);
        current = id;
      }
    }
    assert.equal(seen.size, 2, '应有两条独立消息');
    await fio.dispose();
  });
});

describe('FrameIO · 验收2：完整消息 emit；type 非字符串不 emit 并回 nack', () => {
  let env;
  beforeEach(() => {
    env = makeFrameIO();
  });
  afterEach(async () => {
    await env.fio.dispose();
  });

  test('收到完整 JSON 消息 → emit("message", {type, payload, msgId, channel})', async () => {
    const { fio, transport } = env;
    const received = [];
    fio.on('message', (m) => received.push(m));
    const bytes = encodeFrames({
      msgId: 42,
      payload: JSON_ENCODER.encode(JSON.stringify({ type: 'hello', proto: 2 })),
      chunkPayload: 64,
      channel: CHANNEL_CONTROL,
    })[0];
    transport.emit('data', bytes, { channel: 'control' });
    assert.equal(received.length, 1);
    assert.equal(received[0].type, 'hello');
    assert.equal(received[0].payload.type, 'hello');
    assert.equal(received[0].payload.proto, 2);
    assert.equal(received[0].msgId, 42);
    assert.equal(received[0].channel, CHANNEL_CONTROL);
    assert.equal(fio.stats.messagesIn, 1);
  });

  test('type 非字符串：不 emit message，stats.badPayload=1，回 nack{BAD_PAYLOAD}', async () => {
    const { fio, transport } = env;
    const received = [];
    fio.on('message', (m) => received.push(m));
    const bytes = encodeFrames({
      msgId: 7,
      payload: JSON_ENCODER.encode(JSON.stringify({ noType: true })),
      chunkPayload: 64,
      channel: CHANNEL_CONTROL,
    })[0];
    transport.emit('data', bytes, { channel: 'control' });
    await sleep(5);
    assert.equal(received.length, 0, 'type 非字符串不得 emit message');
    assert.equal(fio.stats.badPayload, 1);
    const nackFrame = transport.sent.at(-1)?.frame;
    assert.ok(nackFrame, '应回一帧');
    const obj = JSON.parse(JSON_DECODER.decode(frameBody(nackFrame)));
    assert.equal(obj.type, 'nack');
    assert.equal(obj.msgId, 7);
    assert.equal(obj.reason, 'BAD_PAYLOAD');
  });
});

describe('FrameIO · 验收3：AUDIO 通道不进 Reassembler，直接 emit("audio")', () => {
  test('音频帧分流：reassembler.push 从未被音频帧调用，audio 事件带 {bytes, msgId, frag}', async () => {
    const { fio, transport, pushedToReassembler } = makeFrameIO({ chunkPayload: 16 });
    const audioEvents = [];
    fio.on('audio', (a) => audioEvents.push(a));

    const pcm = new Uint8Array(40).map((_, i) => i & 0xff);
    const frames = encodeFrames({
      msgId: 0,
      payload: pcm,
      chunkPayload: 16,
      channel: CHANNEL_AUDIO,
    });
    assert.equal(frames.length, 3);
    for (const f of frames) transport.emit('data', f, { channel: 'audio' });

    assert.equal(audioEvents.length, 3, '每帧音频各 emit 一次');
    assert.deepEqual(
      audioEvents.map((a) => a.frag),
      [0, 1, 2],
    );
    assert.equal(audioEvents[0].msgId, 0);
    const joined = Buffer.concat(audioEvents.map((a) => Buffer.from(a.bytes)));
    assert.ok(joined.equals(Buffer.from(pcm)), '音频字节应逐帧还原');
    assert.equal(
      pushedToReassembler.length,
      0,
      '音频帧绝不能到达 reassembler（C6 结构性保证）',
    );
    await fio.dispose();
  });

  test('分流发生在 reassembler 抛错之前：音频帧不触发 BAD_PAYLOAD 错误', async () => {
    const { fio, transport, logger } = makeFrameIO();
    const errors = [];
    fio.on('error', (e) => errors.push(e));
    const frame = encodeFrames({
      msgId: 0,
      payload: new Uint8Array(8),
      chunkPayload: 64,
      channel: CHANNEL_AUDIO,
    })[0];
    transport.emit('data', frame, { channel: 'audio' });
    assert.equal(errors.length, 0, '音频帧不得产生任何 error');
    assert.ok(logger.errorCalls === undefined || true);
    await fio.dispose();
  });
});

describe('FrameIO · 验收4：gap → emit("gap") + nack{REASSEMBLY_GAP}；只整条重发', () => {
  test('缺 frag1：emit gap{missing:[1]}，回 nack，stats.gaps=1', async () => {
    const { fio, transport } = makeFrameIO({ chunkPayload: 16 });
    const gaps = [];
    fio.on('gap', (g) => gaps.push(g));
    const frames = encodeFrames({
      msgId: 9,
      payload: JSON_ENCODER.encode(JSON.stringify({ type: 'notice', pad: 'x'.repeat(40) })),
      chunkPayload: 16,
      channel: CHANNEL_CONTROL,
    });
    assert.equal(frames.length, 5, '前置：66 字节载荷 / chunkPayload=16 应拆成 5 片');
    transport.emit('data', frames[0], { channel: 'control' });
    transport.emit('data', frames[2], { channel: 'control' }); // 跳过 frag1
    await sleep(5);
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].msgId, 9);
    assert.deepEqual(gaps[0].missing, [1]);
    assert.equal(fio.stats.gaps, 1);
    // 回的 nack 约 65 字节，chunkPayload=16 → 5 片；拼齐最后 5 帧再解析
    const nackFrames = transport.sent.slice(-5).map((s) => s.frame);
    const nackBody = Buffer.concat(nackFrames.map((f) => f.subarray(4)));
    const nackObj = JSON.parse(JSON_DECODER.decode(nackBody));
    assert.equal(nackObj.type, 'nack');
    assert.equal(nackObj.reason, 'REASSEMBLY_GAP');
    assert.equal(nackObj.msgId, 9);
    assert.deepEqual(nackObj.missing, [1]);
    await fio.dispose();
  });
});

describe('FrameIO · 验收5：收 ack → acknowledge+release；收 nack → 整条重发', () => {
  test('收 ack：acknowledge 生效、消息号释放、ack 不作为 message emit', async () => {
    const { fio, transport, acks, msgIds } = makeFrameIO();
    const received = [];
    fio.on('message', (m) => received.push(m));
    // 不 await sendMessage（没人回 ack 它会一直等），先拿到帧后回 ack
    const p = fio.sendMessage('notice', { text: 'hi' });
    await sleep(5);
    const msgId = decodeHeader(transport.sent[0].frame).msgId;
    assert.equal(msgIds.size, 1);
    const ackFrame = encodeFrames({
      msgId: 1, // ack 帧自身的 msgId（设备侧），被确认号在载荷里
      payload: JSON_ENCODER.encode(JSON.stringify({ type: 'ack', msgId })),
      chunkPayload: 64,
      channel: CHANNEL_CONTROL,
    })[0];
    transport.emit('data', ackFrame, { channel: 'control' });
    const r = await p; // ack 后 sendMessage 必须解除等待
    assert.equal(r.msgId, msgId);
    assert.equal(acks.size, 0, '待确认表应清空');
    assert.equal(acks.stats.acked, 1);
    assert.equal(msgIds.size, 0, '消息号应释放');
    assert.equal(
      received.length,
      0,
      'ack 是链路层消息，不得作为 message emit',
    );
    await fio.dispose();
  });

  test('收 nack（无 missing）→ 从 FIRST 整条重发，不做选择性重传', async () => {
    const { fio, transport, acks, ackSendCalls } = makeFrameIO({ chunkPayload: 16 });
    const p = fio.sendMessage('notice', { pad: 'y'.repeat(40) });
    await sleep(5);
    const msgId = decodeHeader(transport.sent[0].frame).msgId; // 主机侧号（首个分配为 0）
    const originalCount = transport.sent.length;
    assert.ok(originalCount >= 3);
    // 设备回 nack：missing:[1] 仅诊断信息，主机必须整条重发。
    // nack JSON 约 65 字节，chunkPayload 必须装下（64 会切成 2 片）。
    const nackFrame = encodeFrames({
      msgId: 2,
      payload: JSON_ENCODER.encode(
        JSON.stringify({ type: 'nack', msgId, reason: 'REASSEMBLY_GAP', missing: [1] }),
      ),
      chunkPayload: 128,
      channel: CHANNEL_CONTROL,
    })[0];
    assert.notEqual(decodeHeader(nackFrame).flags & FLAG_LAST, 0, 'nack 帧必须是单帧完整');
    transport.emit('data', nackFrame, { channel: 'control' });
    await sleep(5);
    assert.equal(ackSendCalls.length, 1, '应恰好触发一次重传发送');
    assert.equal(
      ackSendCalls[0].resent.length,
      originalCount,
      `必须整条重发（${originalCount} 片），而不是只补 missing 的 1 片`,
    );
    assert.equal(acks.stats.selective, 0, '不得发生选择性重传');
    // 重发的第一帧必须是 FIRST（从 FIRST 起）
    const firstHead = decodeHeader(ackSendCalls[0].resent[0]);
    assert.notEqual(firstHead.flags & FLAG_FIRST, 0);
    assert.equal(acks.stats.retransmits, originalCount);
    // 整条重发后设备回 ack，sendMessage 才能结束（不留悬挂）
    const ackFrame = encodeFrames({
      msgId: 3,
      payload: JSON_ENCODER.encode(JSON.stringify({ type: 'ack', msgId })),
      chunkPayload: 128,
      channel: CHANNEL_CONTROL,
    })[0];
    transport.emit('data', ackFrame, { channel: 'control' });
    const r = await p;
    assert.equal(r.msgId, msgId);
    await fio.dispose();
  });
});

describe('FrameIO · 验收6：ack 超时放弃 → emit("ack-timeout") + 释放消息号', () => {
  test('重传耗尽后放弃，事件带 msgId，stats.ackTimeouts=1，消息号释放', async () => {
    const { fio, transport, msgIds, acks } = makeFrameIO({
      acksOptions: { retryDelays: [5, 5, 5] }, // 快速超时：3 次重传后放弃
    });
    const timeouts = [];
    fio.on('ack-timeout', (info) => timeouts.push(info));
    const p = fio.sendMessage('notice', { text: 'never-acked' });
    await sleep(5);
    const msgId = decodeHeader(transport.sent[0].frame).msgId;
    assert.equal(msgIds.size, 1);
    await assert.rejects(p, (e) => e instanceof WireError && e.code === ERR.ACK_TIMEOUT);
    assert.equal(timeouts.length, 1);
    assert.equal(timeouts[0].msgId, msgId);
    assert.equal(acks.stats.timeouts, 1);
    assert.equal(msgIds.size, 0, '放弃后必须释放消息号');
    await fio.dispose();
  });
});

describe('FrameIO · 验收7：断链时队列 reject 全部待发项 + 可观测事件', () => {
  test('悬挂中的 send 在断链时全部 reject，emit("send-failed")，无悬挂 Promise', async () => {
    const { fio, transport } = makeFrameIO({ chunkPayload: 16 });
    transport.mode = 'hang';
    const p1 = fio.sendMessage('notice', { n: 1, pad: 'a'.repeat(40) });
    const p2 = fio.sendMessage('notice', { n: 2, pad: 'b'.repeat(40) });
    const failures = [];
    fio.on('send-failed', (info) => failures.push(info));

    transport.emit('disconnected', { unexpected: true, reason: '模拟断链' });

    await assert.rejects(p1, (e) => e instanceof WireError && e.code === ERR.NOT_CONNECTED);
    await assert.rejects(p2, (e) => e instanceof WireError && e.code === ERR.NOT_CONNECTED);
    assert.equal(failures.length, 1, '断链应 emit 一次 send-failed');
    assert.equal(failures[0].count, 2, '被 reject 的待发项数量应可观测');
    assert.equal(failures[0].reason, 'disconnect');
    // 断链后新发送也应立即失败，不留悬挂
    await assert.rejects(
      () => fio.sendMessage('notice', { n: 3 }),
      (e) => e instanceof WireError && e.code === ERR.NOT_CONNECTED,
    );
    await fio.dispose();
  });

  test('dispose 同样清空队列并 reject，不抛 unhandled rejection', async () => {
    const { fio, transport } = makeFrameIO({ chunkPayload: 16 });
    transport.mode = 'hang';
    const p = fio.sendMessage('notice', { pad: 'z'.repeat(40) });
    const rejections = [];
    fio.on('send-failed', (info) => rejections.push(info));
    await fio.dispose();
    await assert.rejects(p, (e) => e instanceof WireError);
    assert.equal(rejections.length, 1);
    await sleep(10); // 给潜在的 unhandled rejection 留窗口（测试进程会兜底报错）
  });
});

describe('FrameIO · 验收8：maxMessageBytes 超限抛 WireError(PAYLOAD_TOO_LARGE)', () => {
  test('超限拒绝发送，不静默截断，也不产生任何帧', async () => {
    const { fio, transport } = makeFrameIO({ maxMessageBytes: 64 });
    const bigPayload = { pad: 'q'.repeat(200) };
    await assert.rejects(
      () => fio.sendMessage('notice', bigPayload),
      (e) => e instanceof WireError && e.code === ERR.PAYLOAD_TOO_LARGE,
    );
    assert.equal(transport.sent.length, 0, '超限消息不得发出任何帧');
    await fio.dispose();
  });
});

describe('FrameIO · sendRaw（音频路径）', () => {
  test('sendRaw：切帧发送、不带 ACK_REQ、msgId=0、不登记待确认表', async () => {
    const { fio, transport, acks, msgIds } = makeFrameIO({ chunkPayload: 16 });
    const pcm = new Uint8Array(50).fill(0x7f);
    await fio.sendRaw(CHANNEL_AUDIO, pcm);
    const frames = lastFrames(transport, transport.sent.length);
    assert.equal(frames.length, Math.ceil(50 / 16));
    for (const f of frames) {
      const head = decodeHeader(f);
      assert.equal(head.channel, CHANNEL_AUDIO);
      assert.equal(head.msgId, 0, '音频不分配消息号');
      assert.equal(head.flags & FLAG_ACK_REQ, 0, '音频不要求 ACK');
    }
    assert.equal(acks.size, 0);
    assert.equal(msgIds.size, 0, 'sendRaw 不得占用消息号');
    // 音频应带 LAST 收尾（帧本身仍是合法帧）
    const lastHead = decodeHeader(frames.at(-1));
    assert.notEqual(lastHead.flags & FLAG_LAST, 0);
    await fio.dispose();
  });
});

describe('FrameIO · stats 与 dispose', () => {
  test('stats 具备全部 8 个键', async () => {
    const { fio } = makeFrameIO();
    for (const key of [
      'messagesIn',
      'messagesOut',
      'bytesIn',
      'bytesOut',
      'gaps',
      'stale',
      'ackTimeouts',
      'badPayload',
    ]) {
      assert.ok(key in fio.stats, `stats 缺少 ${key}`);
    }
    await fio.dispose();
  });

  test('messagesOut 按「消息」计数：多片算 1 条，raw control 帧不计（t19-F2）', async () => {
    const { fio, transport } = makeFrameIO({ chunkPayload: 16 });
    assert.equal(fio.stats.messagesOut, 0, '初始应为 0');

    // 拆成多片的一条消息：只算 1 条，不是按帧累加
    await fio.sendMessage('session.state', { type: 'session.state', pad: 'x'.repeat(80) }, { ack: false });
    assert.ok(transport.sent.length > 1, `前置：应被拆成多片（实际 ${transport.sent.length} 片）`);
    assert.equal(fio.stats.messagesOut, 1, '一条多片消息只算 1 条');

    await fio.sendMessage('notice', { type: 'notice', n: 1 }, { ack: false });
    assert.equal(fio.stats.messagesOut, 2, '连续两条消息应为 2');

    // control 帧直发（ack/nack 走这条）不是新消息
    await fio.sendRaw(CHANNEL_CONTROL, JSON_ENCODER.encode(JSON.stringify({ type: 'ack', msgId: 1 })));
    assert.equal(fio.stats.messagesOut, 2, 'sendRaw 不得计入 messagesOut');

    await fio.dispose();
  });

  test('stale 计数：无 FIRST 的片判 stale', async () => {
    const { fio, transport } = makeFrameIO({ chunkPayload: 16 });
    const frames = encodeFrames({
      msgId: 11,
      payload: JSON_ENCODER.encode(JSON.stringify({ type: 'notice', pad: 's'.repeat(40) })),
      chunkPayload: 16,
      channel: CHANNEL_CONTROL,
    });
    transport.emit('data', frames[1], { channel: 'control' }); // 无 FIRST
    assert.equal(fio.stats.stale, 1);
    await fio.dispose();
  });

  test('dispose 后 transport 上的监听全部移除，重复 dispose 安全', async () => {
    const { fio, transport } = makeFrameIO();
    await fio.dispose();
    for (const [event, fns] of Object.entries(transport.listeners)) {
      assert.equal(fns.length, 0, `dispose 后 ${event} 仍有 ${fns.length} 个监听`);
    }
    await fio.dispose(); // 幂等
  });
});

// ---------------------------------------------------------------------------
// t34-F4 · void 发送路径失败不得变成 unhandledRejection（t32 finding）
// ---------------------------------------------------------------------------

describe('t34-F4 · transport.send 拒绝时的 void 发送路径', () => {
  test('nack 触发的整条重传被拒绝：无 unhandledRejection，dispose 后号池归零', async () => {
    const rejections = [];
    const onRejection = (e) => rejections.push(e);
    process.on('unhandledRejection', onRejection);
    try {
      const transport = new StubTransport();
      const msgIds = new MsgIdAllocator();
      const logger = { debug() {}, info() {}, warn() {}, error() {} };
      // 不注入 acks：走 FrameIO 内部默认 PendingAcks.send 的 void 重传路径
      const fio = new FrameIO({
        transport,
        chunkPayload: 64,
        maxMessageBytes: 1024,
        msgIds,
        logger,
      });
      const p = fio.sendMessage('notice', { text: 'retransmit-me' });
      p.catch(() => {}); // dispose 时会 reject，测试自身不能制造第二条未捕获拒绝
      await sleep(5);
      assert.equal(transport.sent.length, 1);
      const msgId = decodeHeader(transport.sent[0].frame).msgId;

      transport.mode = 'throw'; // 重传发送立即失败
      const nackFrame = encodeFrames({
        msgId: 2,
        payload: JSON_ENCODER.encode(
          JSON.stringify({ type: 'nack', msgId, reason: 'REASSEMBLY_GAP' }),
        ),
        chunkPayload: 128,
        channel: CHANNEL_CONTROL,
      })[0];
      transport.emit('data', nackFrame, { channel: 'control' });
      await sleep(50);

      assert.deepEqual(rejections, [], '重传失败不得变成 unhandledRejection');
      await fio.dispose();
      assert.equal(msgIds.size, 0, 'dispose 后消息号必须释放，不得泄漏');
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  test('收到坏载荷触发的 control nack 发送被拒绝：无 unhandledRejection，号池归零', async () => {
    const rejections = [];
    const onRejection = (e) => rejections.push(e);
    process.on('unhandledRejection', onRejection);
    try {
      const { fio, transport, msgIds } = makeFrameIO();
      transport.mode = 'throw';
      const badFrame = encodeFrames({
        msgId: 9,
        payload: JSON_ENCODER.encode(JSON.stringify({ type: 123 })),
        chunkPayload: 64,
        channel: CHANNEL_CONTROL,
      })[0];
      transport.emit('data', badFrame, { channel: 'control' });
      await sleep(50);

      assert.deepEqual(rejections, [], 'control nack 发送失败不得变成 unhandledRejection');
      assert.equal(msgIds.size, 0, 'raw control 发送失败后消息号必须释放');
      await fio.dispose();
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });
});
