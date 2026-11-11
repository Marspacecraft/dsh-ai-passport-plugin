/**
 * M2 集成验收（docs/04 Task 4）：`wire/` + `ble/` 组合下的端到端链路。
 *
 * 覆盖 6 条必须用例（docs/04-实现计划.md:162-169）：
 *
 * 1. mock 连接成功后，Transport 收到虚拟设备主动发的 `hello`，
 *    字节经 wire/frame 解析出 `{channel:0, msgId, type:'hello'}`。
 * 2. dropRate=0 发送 3KB 载荷（多片），对端重组后逐字节相等
 *    （经 ping{seq} → pong{seq} 全量回程验证内容保真，ack 验证重组完成）。
 * 3. 丢失中间片：接收侧识别 gap 并回 nack{missing}（missing 仅诊断信息，
 *    不是重传指令 —— 协议 §2.5：gap 即丢弃整条缓冲，选择性补发永远无法
 *    重组）；发送方收到 nack 一律整条重发，真实链路重组成功。
 * 4. MTU 517/247/244/23 → chunkPayload 510/240/237/16，
 *    分片数 = ceil(len/chunkPayload)（docs/03 §1.4 四档表）。
 * 5. simulateDisconnect → disconnected{unexpected:true}；重连后回到 connected。
 * 6. bridge-client 的 --mock 子进程路径同样跑通 hello 收发与多片载荷还原
 *    （协议化假 worker 承担设备侧；另附真实 bridge-worker --mock 连接冒烟）。
 * 7. 音频通道帧绝不进入控制通道 Reassembler（docs/02 C6，结构性保证），
 *    且 data 事件的 meta.channel 正确标为 'audio'。
 * 8. 混合流量（CONTROL + HEARTBEAT + AUDIO）下，每个 data 事件的
 *    meta.channel 与帧头真实通道逐一对应。
 *
 * 全部用例不建立任何真实蓝牙连接：MockTransport 走内存管道，
 * bridge 走 --mock 子进程，不依赖外部硬件。
 */

import assert from 'node:assert/strict';
import { test, describe, before, after } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MockTransport } from '../../src/ble/mock-transport.js';
import { BridgeClient } from '../../src/ble/bridge-client.js';
import { LINK_STATE } from '../../src/ble/transport.js';
import {
  encodeFrames,
  decodeHeader,
  frameBody,
  chunkPayloadForMtu,
  chunkCount,
} from '../../src/wire/frame.js';
import { Reassembler } from '../../src/wire/reassembler.js';
import { PendingAcks } from '../../src/wire/acks.js';
import {
  MSG,
  CHANNEL_CONTROL,
  CHANNEL_AUDIO,
  CHANNEL_HEARTBEAT,
  channelName,
} from '../../src/wire/constants.js';

const ROOT_DIR = fileURLToPath(new URL('../../', import.meta.url));
const JSON_ENCODER = new TextEncoder();
const JSON_DECODER = new TextDecoder();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 轮询等待条件成立，超时返回 undefined（不抛错，由断言给出可读失败）。
 */
async function waitFor(fn, timeoutMs = 2000, stepMs = 5) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > deadline) return undefined;
    await sleep(stepMs);
  }
}

/**
 * 帧收集器：把 Transport 的 data 事件喂进一台独立 Reassembler，
 * 还原出上层消息，同时保留原始帧头用于通道断言。
 */
function makeFrameCollector() {
  const reasm = new Reassembler({ maxMessageBytes: 65536 });
  const frames = [];
  const messages = [];
  return {
    reasm,
    frames,
    messages,
    push(bytes, meta = {}) {
      let header = null;
      try {
        header = decodeHeader(bytes);
      } catch {
        return;
      }
      frames.push({ bytes, meta, header });
      try {
        const result = reasm.push(bytes);
        if (result.kind === 'message') {
          let obj = null;
          try {
            obj = JSON.parse(JSON_DECODER.decode(result.payload));
          } catch {
            // 非 JSON 载荷：保留原始字节
          }
          messages.push({
            msgId: result.msgId,
            channel: result.channel,
            payload: result.payload,
            obj,
          });
        }
      } catch {
        // AUDIO 通道等不入重组器的帧：仅保留原始帧
      }
    },
    findMessage(type) {
      return messages.find((m) => m.obj?.type === type) ?? null;
    },
  };
}

/**
 * 断言 data 事件的 meta.channel 与帧头真实通道一致（docs/02 §4.2 契约：
 * 不得按方向/调用点硬编码）。
 */
function assertChannelMeta(collector) {
  for (const { bytes, meta, header } of collector.frames) {
    assert.equal(
      meta.channel,
      channelName(header.channel),
      `meta.channel 应反查帧头通道 ${header.channel}`,
    );
  }
}

describe('M2 集成 · 用例 1：mock 连接后设备主动发 hello', () => {
  test('连接成功 → 收到 hello，帧头 channel=0，解析出 {channel:0,msgId,type:"hello"}', async () => {
    const t = new MockTransport({ mtuPayload: 240, autoRespond: true });
    const collector = makeFrameCollector();
    t.on('data', (bytes, meta) => collector.push(bytes, meta));

    await t.start();
    assert.equal(t.state, LINK_STATE.SCANNING);
    await t.connect();
    assert.equal(t.state, LINK_STATE.CONNECTED);
    assert.equal(t.ready, true);

    const hello = await waitFor(() => collector.findMessage(MSG.HELLO));
    assert.ok(hello, '连接后应收到设备主动发的 hello（协议 §3.1）');
    assert.equal(hello.msgId, 1, '设备 msgId 从 1 开始');
    assert.equal(hello.channel, CHANNEL_CONTROL, 'hello 走 CONTROL(0) 通道');
    assert.equal(hello.obj.type, MSG.HELLO);
    assert.equal(hello.obj.proto, 2, 'proto 应为协议版本 2');
    assert.equal(hello.obj.caps, 63);
    assert.equal(hello.obj.maxPayload, 8192);

    // 找到 hello 的首帧，验证帧头真实 channel 数值为 0
    const helloFrames = collector.frames.filter((f) => f.header.msgId === hello.msgId);
    assert.ok(helloFrames.length >= 1);
    assert.equal(helloFrames[0].header.channel, 0, '帧头 channel 应为数值 0');

    assertChannelMeta(collector);

    t.removeAllListeners();
    await t.stop();
  });
});

describe('M2 集成 · 用例 2：dropRate=0 下 3KB 多片载荷逐字节还原', () => {
  test('3KB seq 经 ping→pong 全量回程后逐字节相等，且 ack 确认设备侧重组成功', async () => {
    const t = new MockTransport({ mtuPayload: 240, dropRate: 0, autoRespond: true });
    const collector = makeFrameCollector();
    t.on('data', (bytes, meta) => collector.push(bytes, meta));
    await t.start();
    await t.connect();
    // 消化掉连接时的 hello，后续断言只看新消息
    const hello = await waitFor(() => collector.findMessage(MSG.HELLO));
    assert.ok(hello);

    const seq = 'A'.repeat(3072);
    const payload = JSON_ENCODER.encode(JSON.stringify({ type: MSG.PING, seq }));
    assert.ok(payload.length >= 3072, `载荷应 ≥3KB，实际 ${payload.length}`);

    const frames = encodeFrames({
      msgId: 0x123,
      payload,
      chunkPayload: t.mtuPayload,
      channel: CHANNEL_CONTROL,
      ackRequired: true,
    });
    const expectedCount = Math.ceil(payload.length / t.mtuPayload);
    assert.equal(frames.length, expectedCount, '分片数应为 ceil(len/chunkPayload)');
    assert.ok(frames.length >= 2, '3KB 载荷必须多片');
    assert.ok(frames.length <= 16, '不得超过 MAX_CHUNKS=16');

    for (const frame of frames) {
      await t.send(frame, { channel: 'control' });
    }

    // 设备重组成功（带 ACK_REQ）→ 回 ack{msgId}。
    // 注意：ack 帧自身带设备侧新 msgId，被确认的消息号在 ack.obj.msgId 里。
    const ack = await waitFor(
      () => collector.messages.find((m) => m.obj?.type === MSG.ACK && m.obj.msgId === 0x123) ?? null,
    );
    assert.ok(ack, '设备重组成功后应回 ack{obj.msgId:0x123}（协议 §2.5）');

    // pong 回程携带完整 seq → 逐字节相等验证
    const pong = await waitFor(() => collector.findMessage(MSG.PONG));
    assert.ok(pong, '设备应回 pong');
    assert.equal(pong.obj.seq, seq, '回程 seq 应与原始 3KB 内容逐字节相等');
    assert.equal(
      JSON_ENCODER.encode(pong.obj.seq).length,
      3072,
      '回程 seq 字节长度应为 3072',
    );

    assertChannelMeta(collector);
    t.removeAllListeners();
    await t.stop();
  });
});

describe('M2 集成 · 用例 3：丢中间片 → gap → nack（missing 仅诊断）→ 整条重发 → 重组成功', () => {
  test('dropRate>0 丢 frag1：设备回 nack{missing:[1]}（仅诊断），发送方整条重发后重组成功回 ack', async () => {
    const t = new MockTransport({
      mtuPayload: 240,
      dropRate: 0.5,
      random: () => 0.9, // 随机源恒不丢；丢片改用 simulateDrop 确定性制造
      autoRespond: true,
    });
    const collector = makeFrameCollector();
    t.on('data', (bytes, meta) => collector.push(bytes, meta));
    await t.start();
    await t.connect();
    await waitFor(() => collector.findMessage(MSG.HELLO));

    const payload = JSON_ENCODER.encode(
      JSON.stringify({ type: 'notice', text: 'x'.repeat(24) }),
    );
    const frames = encodeFrames({
      msgId: 0x2a,
      payload,
      chunkPayload: 16, // 小片载荷，确保 ≥3 片
      channel: CHANNEL_CONTROL,
      ackRequired: true,
    });
    assert.ok(frames.length >= 3, `应至少 3 片，实际 ${frames.length}`);

    const acks = new PendingAcks({
      send: (msgId, resent, frags) => {
        // 重传回调：把重发的帧真实发回链路
        for (const frame of resent) {
          void t.send(frame, { channel: 'control' });
        }
      },
    });
    acks.track(0x2a, frames, { channel: CHANNEL_CONTROL });

    // 确定性丢掉 frag 1：先发 frag 0，再挂 1 帧丢弃预算，随后发出的
    // frag 1 被丢（simulateDrop 丢「接下来 n 帧」），frag 2 到达即触发 gap
    await t.send(frames[0], { channel: 'control' });
    t.simulateDrop(1);
    for (const frame of frames.slice(1)) {
      await t.send(frame, { channel: 'control' });
    }

    // 接收侧识别 gap → 回 nack{missing:[1]}（端到端经 MockTransport 到达主机）
    const nack = await waitFor(() => collector.findMessage(MSG.NACK));
    assert.ok(nack, '丢中间片后应收到设备回的 nack');
    assert.equal(nack.obj.msgId, 0x2a);
    assert.equal(nack.obj.reason, 'REASSEMBLY_GAP');
    assert.deepEqual(nack.obj.missing, [1], 'missing 应精确指向被丢的 frag 1');
    assert.ok(!collector.findMessage(MSG.ACK), 'gap 期间不应回 ack');

    // 发送侧重传策略（协议 §2.5：missing 仅诊断信息，不是重传指令；
    // gap 即整条缓冲被删，选择性补发缺失片到不了连续序列，永远无法重组）。
    // 此处是接口层验证：negativeAcknowledge 确实能精确挑出缺失片，
    // 但真实链路不靠它完成重组 —— 见下方整条重发路径。
    const sends = [];
    const selectiveAcks = new PendingAcks({
      send: (msgId, resent, frags) => {
        sends.push({ resent, frags });
      },
    });
    selectiveAcks.track(0x2a, frames, { channel: CHANNEL_CONTROL });
    const hit = selectiveAcks.negativeAcknowledge(0x2a, nack.obj.missing);
    assert.equal(hit, true, 'nack 应命中待确认表');
    assert.equal(sends.length, 1, '应触发恰好一次重传发送');
    assert.equal(sends[0].resent.length, 1, '只重发缺失的 1 片');
    assert.deepEqual(sends[0].frags, [1], 'frags 应为缺失片号 [1]');
    assert.equal(
      Buffer.compare(Buffer.from(sends[0].resent[0]), Buffer.from(frames[1])),
      0,
      '重发的缺失片应与原帧逐字节一致',
    );
    assert.equal(selectiveAcks.stats.selective, 1);

    // 端到端收尾：gap 会令设备侧丢弃整条缓冲（协议 §2.4），选择性补发
    // 缺失片只能判 stale，**整条重发是唯一能成功的路径**（协议 §2.5）。
    // 发送方收到 nack 一律走 negativeAcknowledge 的整条重传路径
    // （无 missing → 全片重发），真实 MockTransport 设备重组成功并回 ack。
    assert.equal(acks.negativeAcknowledge(0x2a), true, '无 missing 应整条重传');
    const ack = await waitFor(
      () => collector.messages.find((m) => m.obj?.type === MSG.ACK && m.obj.msgId === 0x2a) ?? null,
    );
    assert.ok(ack, '重传后设备应重组成功并回 ack{msgId:0x2a}');

    acks.acknowledge(0x2a);
    selectiveAcks.acknowledge(0x2a);
    assertChannelMeta(collector);
    t.removeAllListeners();
    await t.stop();
  });
});

describe('M2 集成 · 用例 4：MTU 四档 → chunkPayload 与分片数', () => {
  const CASES = [
    [517, 510],
    [247, 240],
    [244, 237],
    [23, 16],
  ];

  for (const [mtu, expectedCp] of CASES) {
    test(`MTU ${mtu} → chunkPayload ${expectedCp}，分片数 = ceil(len/cp)`, () => {
      assert.equal(chunkPayloadForMtu(mtu), expectedCp);

      // 每档取 len = 5*cp + 7 → 恰好 6 片（不超过 MAX_CHUNKS）
      const len = expectedCp * 5 + 7;
      const payload = JSON_ENCODER.encode('a'.repeat(len));
      const frames = encodeFrames({
        msgId: 0x7,
        payload,
        chunkPayload: expectedCp,
        channel: CHANNEL_CONTROL,
      });
      assert.equal(chunkCount(len, expectedCp), Math.ceil(len / expectedCp));
      assert.equal(frames.length, Math.ceil(len / expectedCp));
      assert.equal(frames.length, 6);

      // 重组逐字节还原
      const reasm = new Reassembler({ maxMessageBytes: 65536 });
      let result = null;
      for (const frame of frames) {
        const r = reasm.push(frame);
        if (r.kind === 'message') result = r;
      }
      assert.ok(result);
      assert.equal(
        Buffer.compare(Buffer.from(result.payload), Buffer.from(payload)),
        0,
      );

      // MockTransport 注入同款 mtuPayload 生效（设备回包按它分片）
      const t = new MockTransport({ mtuPayload: expectedCp });
      assert.equal(t.mtuPayload, expectedCp);
    });
  }
});

describe('M2 集成 · 用例 5：simulateDisconnect → unexpected 断链 → 重连回 connected', () => {
  test('断链事件带 unexpected:true，state=failed；重连后回到 connected 并重新握手', async () => {
    const t = new MockTransport({ mtuPayload: 240, autoRespond: true });
    const collector = makeFrameCollector();
    const disconnections = [];
    t.on('data', (bytes, meta) => collector.push(bytes, meta));
    t.on('disconnected', (payload) => disconnections.push(payload));

    await t.start();
    await t.connect();
    const firstHello = await waitFor(() => collector.findMessage(MSG.HELLO));
    assert.ok(firstHello, '首次连接应收到 hello');
    const messageCountAtDisconnect = collector.messages.length;

    t.simulateDisconnect('集成测试断链');
    await waitFor(() => t.state === LINK_STATE.FAILED);
    assert.equal(t.state, LINK_STATE.FAILED);
    const unexpected = disconnections.find((d) => d.unexpected === true);
    assert.ok(unexpected, '应 emit disconnected{unexpected:true}');
    assert.equal(unexpected.reason, '集成测试断链');
    assert.ok(unexpected.error, '意外断链应携带 error');

    // 重连：设备重新主动发 hello（协议 §3.1/§9.3：重连即重新握手）
    await t.connect();
    assert.equal(t.state, LINK_STATE.CONNECTED);
    assert.equal(t.ready, true);
    const helloAfter = await waitFor(
      () => collector.messages.slice(messageCountAtDisconnect).find((m) => m.obj?.type === MSG.HELLO) ?? null,
    );
    assert.ok(helloAfter, '重连后设备应重新主动发 hello');

    t.removeAllListeners();
    await t.stop();
  });
});

describe('M2 集成 · 用例 6：bridge-client --mock 子进程路径', () => {
  /** @type {string} */
  let dir;
  /** @type {string} */
  let workerFile;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-m2-integration-'));
    // 协议化假 worker：接受 --mock 参数（bridge-client mock:true 会追加），
    // 承担设备侧职责：连接后主动发 hello，收到完整消息后把原帧逐字节回传。
    workerFile = join(dir, 'integration-worker.mjs');
    const frameMod = JSON.stringify(join(ROOT_DIR, 'src/wire/frame.js'));
    const reasmMod = JSON.stringify(join(ROOT_DIR, 'src/wire/reassembler.js'));
    const constMod = JSON.stringify(join(ROOT_DIR, 'src/wire/constants.js'));
    const source = [
      "import { createInterface } from 'node:readline';",
      "import { pathToFileURL } from 'node:url';",
      'const mod = (p) => import(pathToFileURL(p).href);',
      `const { encodeFrames, decodeHeader } = await mod(${frameMod});`,
      `const { Reassembler } = await mod(${reasmMod});`,
      `const { CHANNEL_CONTROL } = await mod(${constMod});`,
      'const enc = new TextEncoder();',
      'let connected = false;',
      'const reasm = new Reassembler({ maxMessageBytes: 65536 });',
      'const inbox = new Map();',
      'const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");',
      'const sendData = (frame) => send({ event: "data", b64: Buffer.from(frame).toString("base64"), channel: "control" });',
      'function deviceSend(obj, msgId) {',
      '  const payload = enc.encode(JSON.stringify(obj));',
      '  const frames = encodeFrames({ msgId, payload, chunkPayload: 240, channel: CHANNEL_CONTROL });',
      '  for (const f of frames) sendData(f);',
      '}',
      'const rl = createInterface({ input: process.stdin });',
      "rl.on('line', (line) => {",
      '  let obj;',
      '  try { obj = JSON.parse(line); } catch { return; }',
      "  if (typeof obj.id !== 'number') return;",
      '  const reply = (value, error) => send(error ? { id: obj.id, ok: false, error } : { id: obj.id, ok: true, value });',
      '  switch (obj.cmd) {',
      "    case 'init':",
      "    case 'scan':",
      "    case 'stopScan':",
      "    case 'dispose':",
      '      reply(null);',
      '      break;',
      "    case 'ping':",
      "      reply('pong');",
      '      break;',
      "    case 'readCtrl':",
      '      reply(null);',
      '      break;',
      "    case 'connect':",
      '      connected = true;',
      '      send({ event: "connected", mtu: 247, deviceId: "mock-device" });',
      '      deviceSend({ type: "hello", proto: 2, caps: 63, maxPayload: 8192, fw: "2.0.0-integration" }, 1);',
      '      reply({ mtu: 247 });',
      '      break;',
      "    case 'disconnect':",
      '      connected = false;',
      '      send({ event: "disconnected", reason: "integration-disconnect" });',
      '      reply(null);',
      '      break;',
      "    case 'write': {",
      '      const frame = Buffer.from(String(obj.b64 ?? ""), "base64");',
      '      const head = decodeHeader(frame);',
      '      const list = inbox.get(head.msgId) ?? [];',
      '      list.push(frame);',
      '      inbox.set(head.msgId, list);',
      '      let kind = null;',
      '      try { kind = reasm.push(frame).kind; } catch { kind = "invalid"; }',
      '      if (kind === "message") {',
      '        for (const f of list) sendData(f);',
      '        inbox.delete(head.msgId);',
      '      }',
      '      reply(null);',
      '      break;',
      '    }',
      '    default:',
      '      reply(null, { code: "unknown", message: "未知命令 " + obj.cmd });',
      '  }',
      '});',
      "rl.on('close', () => process.exit(0));",
      'send({ event: "state", value: "idle" });',
      'send({ event: "ready" });',
    ].join('\n');
    await writeFile(workerFile, source, 'utf8');
  });

  after(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test('--mock 子进程：连接后设备主动发 hello（帧头 channel=0），3KB 载荷多片逐字节回传', async () => {
    const client = new BridgeClient({
      workerPath: workerFile,
      mock: true, // 追加 --mock 参数，走 bridge-client 的 --mock 子进程路径
      readyTimeoutMs: 10000,
      commandTimeoutMs: 10000,
    });
    const collector = makeFrameCollector();
    client.on('data', (bytes, meta) => collector.push(bytes, meta));

    try {
      await client.start();
      await client.connect();
      assert.equal(client.state, LINK_STATE.CONNECTED);
      // worker 协商 MTU 247 → chunkPayload = 247-3-4 = 240
      assert.equal(client.mtuPayload, 240);

      // 第 1 条：设备主动 hello（先于主机任何下行，协议 §3.1）
      const hello = await waitFor(() => collector.findMessage(MSG.HELLO));
      assert.ok(hello, '子进程桥路径应收到设备主动 hello');
      assert.equal(hello.obj.type, MSG.HELLO);
      assert.equal(hello.channel, CHANNEL_CONTROL);
      const helloFrames = collector.frames.filter((f) => f.header.msgId === hello.msgId);
      assert.equal(helloFrames[0].header.channel, 0);

      // 第 2 条：3KB 载荷多片上行，设备把原帧逐字节回传 → 重组后逐字节相等
      const seq = 'B'.repeat(3072);
      const payload = JSON_ENCODER.encode(JSON.stringify({ type: 'echo', seq }));
      const frames = encodeFrames({
        msgId: 0x21,
        payload,
        chunkPayload: client.mtuPayload,
        channel: CHANNEL_CONTROL,
      });
      assert.ok(frames.length >= 2, '3KB 载荷必须多片');
      for (const frame of frames) {
        await client.send(frame, { channel: 'control' });
      }
      const echo = await waitFor(
        () => collector.messages.find((m) => m.msgId === 0x21) ?? null,
        4000,
      );
      assert.ok(echo, '设备应回传完整消息');
      assert.equal(
        Buffer.compare(Buffer.from(echo.payload), Buffer.from(payload)),
        0,
        '回传载荷应与原始 3KB 载荷逐字节相等',
      );

      assertChannelMeta(collector);
    } finally {
      client.removeAllListeners();
      await client.stop();
    }
  });

  test('真实 bridge-worker --mock 冒烟：连接、MTU 兜底 240、字节收发不炸、干净退出', async () => {
    const client = new BridgeClient({ mock: true });
    const collected = makeFrameCollector();
    client.on('data', (bytes, meta) => collected.push(bytes, meta));
    try {
      await client.start();
      assert.equal(client.state, LINK_STATE.SCANNING);
      await client.connect();
      assert.equal(client.state, LINK_STATE.CONNECTED);
      // 真实 worker --mock 协商 MTU 247（MTU_FALLBACK）→ mtuPayload 240
      assert.equal(client.mtuPayload, chunkPayloadForMtu(247));
      assert.equal(client.mtuPayload, 240);
      assert.ok(client.rssiById instanceof Map);
      assert.ok(Array.isArray(client.stderrLog));

      // 主机 → 设备字节下行不炸（mock 设备无协议层，字节被静默消费）
      await client.send(new Uint8Array([1, 2, 3, 4]), { channel: 'control' });
      await client.send(new Uint8Array(240), { channel: 'control' });
    } finally {
      client.removeAllListeners();
      await client.stop();
    }
    assert.equal(client.state, LINK_STATE.IDLE, 'stop 后应回到 idle');
  });
});

describe('M2 集成 · 用例 7：音频通道帧绝不进入控制通道 Reassembler（C6）', () => {
  test('AUDIO 帧不入控制通道 Reassembler：结构上抛 BAD_PAYLOAD，设备侧静默丢弃，控制消息不受污染', async () => {
    const t = new MockTransport({ mtuPayload: 240, autoRespond: true });
    const collector = makeFrameCollector();
    t.on('data', (bytes, meta) => collector.push(bytes, meta));

    await t.start();
    await t.connect();
    const hello = await waitFor(() => collector.findMessage(MSG.HELLO));
    assert.ok(hello, '先建立连接收到 hello');

    // 结构性保护（docs/02 C6）：Reassembler 对 AUDIO 帧直接抛错，
    // 音频永远不会被误当成控制消息重组。
    const audioBytes = JSON_ENCODER.encode(JSON.stringify({ pcm: new Array(40).fill(0) }));
    const audioFrames = encodeFrames({
      msgId: 0x30,
      payload: audioBytes,
      chunkPayload: t.mtuPayload,
      channel: CHANNEL_AUDIO,
    });
    const reasm = new Reassembler({ maxMessageBytes: 65536 });
    assert.throws(
      () => reasm.push(audioFrames[0]),
      (err) => err?.code === 'BAD_PAYLOAD',
      'Reassembler.push 对 AUDIO 通道帧必须抛 BAD_PAYLOAD',
    );

    // 端到端：主机经 MockTransport 下发 AUDIO 帧。设备侧 #deviceFeed 对
    // AUDIO 通道静默丢弃（不回显、不入 Reassembler），因此 data 事件
    // （设备→主机方向）不会出现任何 AUDIO 帧——音频从未污染控制通道。
    const droppedBefore = t.deviceStats.dropped;
    const framesBefore = collector.frames.length;
    const messagesBeforeAudio = collector.messages.length;
    for (const frame of audioFrames) {
      await t.send(frame, { channel: 'audio' });
    }
    await waitFor(() => t.deviceStats.dropped > droppedBefore, 500);
    assert.equal(
      t.deviceStats.dropped - droppedBefore,
      audioFrames.length,
      'AUDIO 帧应被设备侧逐帧静默丢弃',
    );
    await sleep(30);
    assert.equal(
      collector.frames.length,
      framesBefore,
      'AUDIO 帧不得产生任何 data 事件（设备不回显 AUDIO）',
    );
    assert.equal(
      collector.messages.length,
      messagesBeforeAudio,
      'AUDIO 帧不得在接收侧产生任何控制通道消息',
    );

    assertChannelMeta(collector);
    t.removeAllListeners();
    await t.stop();
  });
});

describe('M2 集成 · 用例 8：混合流量下 meta.channel 与帧头通道端到端一致', () => {
  test('CONTROL + HEARTBEAT + AUDIO 混跑：每个 data 事件的 meta.channel === channelName(帧头通道)', async () => {
    const t = new MockTransport({ mtuPayload: 240, autoRespond: true });
    const collector = makeFrameCollector();
    t.on('data', (bytes, meta) => collector.push(bytes, meta));

    await t.start();
    await t.connect();
    const hello = await waitFor(() => collector.findMessage(MSG.HELLO));
    assert.ok(hello, 'hello（CONTROL 方向）应先到达');

    // 三种通道混发：CONTROL ping、HEARTBEAT ping、AUDIO 原始帧
    const controlPayload = JSON_ENCODER.encode(JSON.stringify({ type: MSG.PING, seq: 1 }));
    for (const frame of encodeFrames({
      msgId: 0x41,
      payload: controlPayload,
      chunkPayload: t.mtuPayload,
      channel: CHANNEL_CONTROL,
    })) {
      await t.send(frame, { channel: 'control' });
    }

    const hbPayload = JSON_ENCODER.encode(JSON.stringify({ type: MSG.PING, seq: 2 }));
    for (const frame of encodeFrames({
      msgId: 0x42,
      payload: hbPayload,
      chunkPayload: t.mtuPayload,
      channel: CHANNEL_HEARTBEAT,
    })) {
      await t.send(frame, { channel: 'heartbeat' });
    }

    const audioPayload = JSON_ENCODER.encode(JSON.stringify({ pcm: [1, 2, 3] }));
    for (const frame of encodeFrames({
      msgId: 0x43,
      payload: audioPayload,
      chunkPayload: t.mtuPayload,
      channel: CHANNEL_AUDIO,
    })) {
      await t.send(frame, { channel: 'audio' });
    }

    // 设备对 HEARTBEAT ping 回 pong（HEARTBEAT 通道）、CONTROL ping 回 pong（CONTROL）。
    // AUDIO 帧被设备静默丢弃、不产生 data 事件（见用例 7）——
    // 它的存在性由设备侧 dropped 计数验证，不进 meta.channel 断言。
    const pongs = await waitFor(
      () => {
        const list = collector.messages.filter((m) => m.obj?.type === MSG.PONG);
        const channels = new Set(list.map((m) => m.channel));
        return channels.has(CHANNEL_CONTROL) && channels.has(CHANNEL_HEARTBEAT) ? list : null;
      },
      2000,
    );
    assert.ok(pongs, 'CONTROL 与 HEARTBEAT 通道各应收到 pong');
    const hbPong = pongs.find((m) => m.channel === CHANNEL_HEARTBEAT);
    assert.equal(hbPong.obj.seq, 2, 'HEARTBEAT pong 应回显 ping seq=2');
    const ctlPong = pongs.find((m) => m.channel === CHANNEL_CONTROL);
    assert.equal(ctlPong.obj.seq, 1, 'CONTROL pong 应回显 ping seq=1');

    // AUDIO 下行确被设备接收（dropped 增量 = AUDIO 帧数），但不出现在 data 事件
    const droppedAfter = t.deviceStats.dropped;
    assert.ok(droppedAfter >= 1, 'AUDIO 帧应计入设备侧 dropped（静默丢弃）');

    // data 事件出现的通道集合：CONTROL + HEARTBEAT（hello/pong），无 AUDIO
    const observed = new Set(collector.frames.map((f) => f.header.channel));
    assert.ok(observed.has(CHANNEL_CONTROL), '应观察到 CONTROL 帧');
    assert.ok(observed.has(CHANNEL_HEARTBEAT), '应观察到 HEARTBEAT 帧（含设备回的 pong）');
    assert.ok(!observed.has(CHANNEL_AUDIO), 'AUDIO 帧不得出现在 data 事件（设备不回显）');

    // 核心断言：每一个 data 事件的 meta.channel 都与帧头真实通道反查一致
    assertChannelMeta(collector);

    t.removeAllListeners();
    await t.stop();
  });
});
