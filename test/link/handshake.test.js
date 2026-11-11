/**
 * M3 Task 11：`link/handshake.js` 握手与配对单元测试。
 *
 * 覆盖 docs/04 Task 11 全部 11 条验收项：
 * 1. 设备发起握手：主机从不主动发 hello，只在收到 hello 后回 hello.ack。
 * 2. proto 不符 → hello.ack{accepted:false, code:"PROTO_MISMATCH"} +
 *    emit('rejected')，状态机进 rejected，绝不按低版本继续跑。
 * 3. maxPayload = min(设备 maxPayload, MAX_CHUNKS × chunkPayload,
 *    MAX_MESSAGE_BYTES_CEILING)，ready 事件带完整 info。
 * 4. 握手前白名单 pair.* / ping / pong / ack / nack / hello 必须处理；
 *    其余业务消息静默丢弃（不回 nack、不 emit）。
 * 5. 配对独立于握手：pair.required 可以在 hello 之前到达。
 * 6. token 匹配 → paired:true；不匹配 → paired:false +
 *    emit('pair-required', {reason:'token-mismatch'})。
 * 7. 环检测：token 不匹配只自动发一次 pair.reset，第二次不再重置。
 * 8. 信任表可注入 {load, save}；默认实现（createTrustStore）写
 *    dsh-ai-passport.pairing.json 且权限 0600；测试用 tmpdir，绝不碰真实 home。
 * 9. pair.ok → emit('paired', {deviceId, token}) 并落表；dispose() 不删信任表。
 *
 * 测试不触碰真实 home 目录：信任表全部走注入的内存 fake（或 tmpdir）。
 */

import assert from 'node:assert/strict';
import { test, describe, beforeEach } from 'node:test';
import { mkdtemp, readFile, stat, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';

import { Handshake, HANDSHAKE_STATE, createTrustStore } from '../../src/link/handshake.js';
import { MSG, PROTOCOL_VERSION, MAX_CHUNKS, MAX_MESSAGE_BYTES_CEILING } from '../../src/wire/constants.js';

/** 设备侧 hello 报文构造器（docs/03 §3.2）。 */
function helloMsg(overrides = {}) {
  return {
    type: MSG.HELLO,
    proto: PROTOCOL_VERSION,
    caps: 63,
    maxPayload: 8192,
    fw: '2.0.0',
    ...overrides,
  };
}

/**
 * 测试装置：记录 handshake 发出的所有 JSON 消息与全部事件。
 * store 为内存 fake（记录 save 调用），绝不读写真实文件系统。
 */
function makeHarness({
  table = null,
  deviceId = null,
  deviceName = null,
  chunkPayload = 510,
  hostName = 'test-host',
} = {}) {
  const sent = [];
  const events = [];
  const saves = [];
  let record = table;
  const store = {
    load: async () => record,
    save: async (next) => {
      saves.push(next);
      record = next;
    },
  };
  const EVENT_NAMES = [
    'ready',
    'rejected',
    'pair-required',
    'paired',
    'pair-failed',
    'message',
    'error',
  ];
  const hs = new Handshake({
    send: (msg) => sent.push(msg),
    store,
    deviceId,
    deviceName,
    chunkPayload,
    hostName,
  });
  for (const name of EVENT_NAMES) {
    hs.on(name, (arg) => events.push({ name, arg }));
  }
  return {
    hs,
    sent,
    events,
    saves,
    of: (name) => events.filter((e) => e.name === name),
    sentOf: (type) => sent.filter((m) => m.type === type),
  };
}

async function handshakeToReady(t, { table, deviceId = 'dev-1', helloOverrides = {} } = {}) {
  const h = makeHarness({ table, deviceId });
  await h.hs.handle(helloMsg({ deviceId, token: 'a'.repeat(32), ...helloOverrides }));
  return h;
}

describe('Task 11 · handshake 状态机与常量', () => {
  test('HANDSHAKE_STATE 四态齐全', () => {
    assert.deepEqual({ ...HANDSHAKE_STATE }, {
      IDLE: 'idle',
      ACKING: 'acking',
      READY: 'ready',
      REJECTED: 'rejected',
    });
  });

  test('构造缺 send 回调抛 TypeError', () => {
    assert.throws(() => new Handshake({}), TypeError);
    assert.throws(() => new Handshake({ send: () => {}, store: {} }), TypeError);
  });
});

describe('验收 1 · 设备发起握手：主机不主动发 hello', () => {
  test('构造后主机不发送任何消息', () => {
    const h = makeHarness();
    assert.equal(h.sent.length, 0, '构造 handshake 不应产生任何出站消息');
    assert.equal(h.hs.state, HANDSHAKE_STATE.IDLE);
    assert.equal(h.hs.ready, false);
  });

  test('完整握手过程中主机只回 hello.ack，从不主动发 hello', async () => {
    const h = makeHarness({ table: { 'dev-1': 'a'.repeat(32) }, deviceId: 'dev-1' });
    await h.hs.handle(helloMsg({ deviceId: 'dev-1', token: 'a'.repeat(32) }));
    assert.equal(h.hs.ready, true);
    assert.equal(h.sent.length, 1, '握手成功只应产生 1 条出站消息（hello.ack）');
    assert.ok(
      h.sent.every((m) => m.type !== MSG.HELLO),
      `主机不得主动发 hello，实际出站：${JSON.stringify(h.sent.map((m) => m.type))}`,
    );
    assert.equal(h.sentOf(MSG.HELLO_ACK).length, 1);
  });
});

describe('验收 2 · proto 不符 → accepted:false + rejected，不降级', () => {
  test('hello.proto 与 PROTOCOL_VERSION 不同 → 回拒绝 ack 并 emit rejected', async () => {
    const h = makeHarness();
    await h.hs.handle(helloMsg({ proto: PROTOCOL_VERSION - 1 }));
    const nack = h.sentOf(MSG.HELLO_ACK);
    assert.equal(nack.length, 1);
    assert.equal(nack[0].accepted, false);
    assert.equal(nack[0].code, 'PROTO_MISMATCH');
    const rejected = h.of('rejected');
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].arg.code, 'PROTO_MISMATCH');
    assert.equal(h.hs.state, HANDSHAKE_STATE.REJECTED);
    assert.equal(h.hs.ready, false);
  });

  test('rejected 后再来 hello 不再应答（等用户干预，不循环）', async () => {
    const h = makeHarness();
    await h.hs.handle(helloMsg({ proto: 1 }));
    const ackCount = h.sentOf(MSG.HELLO_ACK).length;
    await h.hs.handle(helloMsg({ proto: 1 }));
    await h.hs.handle(helloMsg({ proto: 3 }));
    assert.equal(h.sentOf(MSG.HELLO_ACK).length, ackCount, 'rejected 是终态，不应再次应答');
    assert.equal(h.of('rejected').length, 1);
  });
});

describe('验收 3 · maxPayload 协商与 ready info', () => {
  test('min(设备 maxPayload, MAX_CHUNKS × chunkPayload, 上限) 回在 hello.ack', async () => {
    // 设备 8192、chunkPayload 510 → 16×510 = 8160 = 上限 → 8160
    const a = makeHarness({ chunkPayload: 510 });
    await a.hs.handle(helloMsg({ deviceId: 'd' }));
    assert.equal(a.sentOf(MSG.HELLO_ACK)[0].maxPayload, Math.min(8192, MAX_CHUNKS * 510, MAX_MESSAGE_BYTES_CEILING));

    // 设备较小 → 取设备值
    const b = makeHarness({ chunkPayload: 510 });
    await b.hs.handle(helloMsg({ deviceId: 'd', maxPayload: 1000 }));
    assert.equal(b.sentOf(MSG.HELLO_ACK)[0].maxPayload, 1000);

    // chunkPayload 小 → 分片数成为瓶颈
    const c = makeHarness({ chunkPayload: 100 });
    await c.hs.handle(helloMsg({ deviceId: 'd' }));
    assert.equal(c.sentOf(MSG.HELLO_ACK)[0].maxPayload, MAX_CHUNKS * 100);
  });

  test('hello.ack 字段完整：accepted/proto/maxChunks/server/paired', async () => {
    const h = makeHarness({ table: { 'dev-1': 'a'.repeat(32) }, deviceId: 'dev-1' });
    await h.hs.handle(helloMsg({ deviceId: 'dev-1', token: 'a'.repeat(32) }));
    const ack = h.sentOf(MSG.HELLO_ACK)[0];
    assert.equal(ack.accepted, true);
    assert.equal(ack.proto, PROTOCOL_VERSION);
    assert.equal(ack.maxChunks, MAX_CHUNKS);
    assert.equal(typeof ack.server, 'string');
    assert.ok(ack.server.length > 0);
    assert.equal(ack.paired, true);
  });

  test('emit(ready) 带 {deviceId,name,firmware,maxPayload,maxChunks,capabilities,paired}', async () => {
    const h = makeHarness({
      table: { 'dev-1': 'a'.repeat(32) },
      deviceId: 'dev-1',
      deviceName: 'Passport',
    });
    await h.hs.handle(helloMsg({ deviceId: 'dev-1', token: 'a'.repeat(32), fw: '9.9.9', caps: 5 }));
    const ready = h.of('ready');
    assert.equal(ready.length, 1);
    assert.deepEqual(ready[0].arg, {
      deviceId: 'dev-1',
      name: 'Passport',
      firmware: '9.9.9',
      maxPayload: Math.min(8192, MAX_CHUNKS * 510, MAX_MESSAGE_BYTES_CEILING),
      maxChunks: MAX_CHUNKS,
      capabilities: 5,
      paired: true,
    });
    assert.equal(h.hs.ready, true);
    assert.equal(h.hs.state, HANDSHAKE_STATE.READY);
    assert.deepEqual(h.hs.info, ready[0].arg);
  });
});

describe('验收 4 · 握手前白名单与非白名单静默丢弃', () => {
  test('ready 之前 ping/pong/ack/nack 必须处理：emit(message) 且不丢弃', async () => {
    const h = makeHarness();
    for (const type of [MSG.PING, MSG.PONG, MSG.ACK, MSG.NACK]) {
      const consumed = await h.hs.handle({ type, msgId: 7 });
      assert.equal(consumed, true, `${type} 属白名单，应被链路层消费`);
    }
    const forwarded = h.of('message').map((e) => e.arg.type);
    assert.deepEqual(forwarded, [MSG.PING, MSG.PONG, MSG.ACK, MSG.NACK]);
    assert.equal(h.sent.length, 0, 'ping/pong/ack/nack 不产生主机出站消息');
  });

  test('ready 之前业务消息（session.state）静默丢弃：无回包、无事件', async () => {
    const h = makeHarness();
    const consumed = await h.hs.handle({ type: MSG.SESSION_STATE, msgId: 9, payload: {} });
    assert.equal(consumed, true, '握手前业务消息按已消费丢弃处理，不给上层');
    assert.equal(h.sent.length, 0, '不得回 nack');
    assert.equal(h.events.length, 0, '不得 emit 任何事件');
  });

  test('ready 之后业务消息返回 false 交给上层，链路层消息仍 emit(message)', async () => {
    const h = await handshakeToReady(null, { table: { 'dev-1': 'a'.repeat(32) } });
    const business = await h.hs.handle({ type: MSG.SESSION_STATE, msgId: 9 });
    assert.equal(business, false, 'ready 后业务消息不属于 handshake，交上层');
    const link = await h.hs.handle({ type: MSG.PING, seq: 1 });
    assert.equal(link, true);
    assert.equal(h.of('message').at(-1).arg.type, MSG.PING);
  });
});

describe('验收 5 · 配对独立于握手（pair.* 两条时间线）', () => {
  test('hello 之前先来 pair.required：被处理并 emit(pair-required)', async () => {
    const h = makeHarness();
    const consumed = await h.hs.handle({ type: MSG.PAIR_REQUIRED, reason: 'first' });
    assert.equal(consumed, true);
    const ev = h.of('pair-required');
    assert.equal(ev.length, 1);
    assert.deepEqual(ev[0].arg, { reason: 'first' });
    assert.equal(h.hs.state, HANDSHAKE_STATE.IDLE, 'pair 流程不影响握手状态机');
  });

  test('pair.failed 转发为 pair-failed 事件', async () => {
    const h = makeHarness();
    await h.hs.handle({ type: MSG.PAIR_FAILED, reason: 'bad-code', remaining: 2 });
    const ev = h.of('pair-failed');
    assert.equal(ev.length, 1);
    assert.deepEqual(ev[0].arg, { reason: 'bad-code', remaining: 2 });
  });

  test('beginPairing 发出 pair.begin{code, host}', async () => {
    const h = makeHarness();
    await h.hs.beginPairing('123456');
    const begins = h.sentOf(MSG.PAIR_BEGIN);
    assert.equal(begins.length, 1);
    assert.equal(begins[0].code, '123456');
    assert.equal(begins[0].host, 'test-host');
  });

  test('常见完整顺序：hello(paired:false) → pair.required → begin → pair.ok → 重握手 paired:true', async () => {
    const h = makeHarness({ deviceId: 'dev-1' });
    // 1. 首次 hello，无 token
    await h.hs.handle(helloMsg({ deviceId: 'dev-1' }));
    assert.equal(h.sentOf(MSG.HELLO_ACK)[0].paired, false);
    // 2. 设备发 pair.required
    await h.hs.handle({ type: MSG.PAIR_REQUIRED, reason: 'first' });
    // 3. 用户输入码，主机发 pair.begin
    await h.hs.beginPairing('654321');
    // 4. 设备回 pair.ok
    await h.hs.handle({ type: MSG.PAIR_OK, deviceId: 'dev-1', token: 'f'.repeat(32) });
    assert.deepEqual(h.saves.at(-1), { 'dev-1': 'f'.repeat(32) }, 'pair.ok 必须落信任表');
    // 5. 设备带 token 重新 hello
    await h.hs.handle(helloMsg({ deviceId: 'dev-1', token: 'f'.repeat(32) }));
    const acks = h.sentOf(MSG.HELLO_ACK);
    assert.equal(acks.length, 2, '重发 hello 应得到第二次 hello.ack');
    assert.equal(acks[0].paired, false);
    assert.equal(acks.at(-1).paired, true);
    assert.equal(h.hs.info.paired, true);
  });
});

describe('验收 6 · token 校验：匹配 paired:true，不匹配 paired:false + pair-required', () => {
  test('hello.token 与信任表匹配 → hello.ack.paired === true', async () => {
    const h = makeHarness({ table: { 'dev-1': 'a'.repeat(32) }, deviceId: 'dev-1' });
    await h.hs.handle(helloMsg({ deviceId: 'dev-1', token: 'a'.repeat(32) }));
    assert.equal(h.sentOf(MSG.HELLO_ACK)[0].paired, true);
    assert.equal(h.hs.info.paired, true);
    assert.equal(h.of('pair-required').length, 0);
  });

  test('hello.token 不匹配 → paired:false + emit(pair-required, token-mismatch)', async () => {
    const h = makeHarness({ table: { 'dev-1': 'a'.repeat(32) }, deviceId: 'dev-1' });
    await h.hs.handle(helloMsg({ deviceId: 'dev-1', token: 'b'.repeat(32) }));
    assert.equal(h.sentOf(MSG.HELLO_ACK)[0].paired, false);
    assert.equal(h.hs.info.paired, false);
    const ev = h.of('pair-required');
    assert.equal(ev.length, 1);
    assert.deepEqual(ev[0].arg, { reason: 'token-mismatch' });
  });

  test('hello 不带 token → paired:false + emit(pair-required, first)，不发 pair.reset', async () => {
    const h = makeHarness({ table: { 'dev-1': 'a'.repeat(32) }, deviceId: 'dev-1' });
    await h.hs.handle(helloMsg({ deviceId: 'dev-1' }));
    assert.equal(h.sentOf(MSG.HELLO_ACK)[0].paired, false);
    assert.deepEqual(h.of('pair-required')[0].arg, { reason: 'first' });
    assert.equal(h.sentOf(MSG.PAIR_RESET).length, 0, '无 token 不是 token 失配，不触发重置');
  });
});

describe('验收 7 · 环检测：token 失配只自动重置一次', () => {
  test('连续两次 hello 带错误 token → pair.reset 只发一次，第二次只报 pair-required', async () => {
    const h = makeHarness({ table: { 'dev-1': 'a'.repeat(32) }, deviceId: 'dev-1' });
    await h.hs.handle(helloMsg({ deviceId: 'dev-1', token: 'b'.repeat(32) }));
    await h.hs.handle(helloMsg({ deviceId: 'dev-1', token: 'c'.repeat(32) }));
    await h.hs.handle(helloMsg({ deviceId: 'dev-1', token: 'd'.repeat(32) }));
    const resets = h.sentOf(MSG.PAIR_RESET);
    assert.equal(resets.length, 1, `环检测失败：pair.reset 发了 ${resets.length} 次`);
    assert.equal(resets[0].ack, true);
    assert.equal(h.of('pair-required').length, 3, '每次失配仍须告知上层需要配对');
  });

  test('pair.ok 成功配对后环检测计数清零：新的失配允许再重置一次', async () => {
    const h = makeHarness({ table: { 'dev-1': 'a'.repeat(32) }, deviceId: 'dev-1' });
    await h.hs.handle(helloMsg({ deviceId: 'dev-1', token: 'b'.repeat(32) })); // 重置一次
    assert.equal(h.sentOf(MSG.PAIR_RESET).length, 1);
    // 重新配对成功
    await h.hs.handle({ type: MSG.PAIR_OK, deviceId: 'dev-1', token: 'e'.repeat(32) });
    // 又一个旧 token 失配 → 允许新一轮自动重置
    await h.hs.handle(helloMsg({ deviceId: 'dev-1', token: 'c'.repeat(32) }));
    assert.equal(h.sentOf(MSG.PAIR_RESET).length, 2);
    await h.hs.handle(helloMsg({ deviceId: 'dev-1', token: 'd'.repeat(32) }));
    assert.equal(h.sentOf(MSG.PAIR_RESET).length, 2, '新一轮也只重置一次');
  });
});

describe('验收 8 · 信任表可注入；默认实现路径与 0600（tmpdir，不碰真实 home）', () => {
  test('注入 fake store：load/save 被按契约调用，测试全程无真实文件 IO', async () => {
    const h = makeHarness({ table: { 'dev-1': 'a'.repeat(32) } });
    await h.hs.handle({ type: MSG.PAIR_OK, deviceId: 'dev-x', token: 't'.repeat(32) });
    assert.deepEqual(h.saves[0], { 'dev-1': 'a'.repeat(32), 'dev-x': 't'.repeat(32) },
      'save 必须保留既有设备记录（信任表是多设备映射）');
  });

  test('createTrustStore 在 tmpdir：写入 0600、load 往返、文件名正确', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'handshake-test-'));
    try {
      const store = createTrustStore({ dir });
      assert.equal(path.basename(store.path), 'dsh-ai-passport.pairing.json');
      assert.equal(await store.load(), null, '无文件时 load 返回 null');
      await store.save({ 'dev-1': 'a'.repeat(32) });
      const info = await stat(store.path);
      assert.equal(info.mode & 0o777, 0o600, `信任表权限应为 0600，实际 ${info.mode.toString(8)}`);
      assert.deepEqual(await store.load(), { 'dev-1': 'a'.repeat(32) });
      // 多设备累计落表
      await store.save({ ...(await store.load()), 'dev-2': 'b'.repeat(32) });
      assert.deepEqual(await store.load(), { 'dev-1': 'a'.repeat(32), 'dev-2': 'b'.repeat(32) });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('默认目录为 ~/.dsh（只计算路径，不做任何 IO）', () => {
    const store = createTrustStore();
    assert.equal(store.path, path.join(homedir(), '.dsh', 'dsh-ai-passport.pairing.json'));
  });
});

describe('验收 9 · pair.ok 落表与 dispose 不删信任表', () => {
  test('pair.ok → emit(paired, {deviceId, token}) + 落表', async () => {
    const h = makeHarness();
    await h.hs.handle({ type: MSG.PAIR_OK, deviceId: 'dev-9', token: '9'.repeat(32) });
    const paired = h.of('paired');
    assert.equal(paired.length, 1);
    assert.deepEqual(paired[0].arg, { deviceId: 'dev-9', token: '9'.repeat(32) });
    assert.deepEqual(h.saves.at(-1), { 'dev-9': '9'.repeat(32) });
  });

  test('dispose() 后：状态复位、不再处理消息、信任表记录原样保留', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'handshake-dispose-'));
    try {
      const store = createTrustStore({ dir });
      await store.save({ 'dev-1': 'a'.repeat(32) });
      const sent = [];
      const hs = new Handshake({ send: (m) => sent.push(m), store, deviceId: 'dev-1' });
      await hs.handle(helloMsg({ deviceId: 'dev-1', token: 'a'.repeat(32) }));
      assert.equal(hs.ready, true);
      hs.dispose();
      assert.equal(hs.ready, false, 'dispose 后不得再处于 ready');
      const consumed = await hs.handle(helloMsg({ deviceId: 'dev-1', token: 'a'.repeat(32) }));
      assert.equal(consumed, true, 'dispose 后消息静默吞掉，不外泄');
      assert.equal(sent.length, 1, 'dispose 后不再发送任何消息');
      // 信任表未被删除
      assert.deepEqual(await store.load(), { 'dev-1': 'a'.repeat(32) }, 'dispose 不删信任表');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('断链重置（reset）：ready 归零、info 丢弃，但保留跨连接环检测记忆', async () => {
    const h = makeHarness({ table: { 'dev-1': 'a'.repeat(32) }, deviceId: 'dev-1' });
    await h.hs.handle(helloMsg({ deviceId: 'dev-1', token: 'b'.repeat(32) })); // 已重置一次
    h.hs.reset();
    assert.equal(h.hs.ready, false);
    assert.equal(h.hs.info, null);
    // 重连后旧 token 仍失配：不再自动重置（防跨连接循环）
    await h.hs.handle(helloMsg({ deviceId: 'dev-1', token: 'b'.repeat(32) }));
    assert.equal(h.sentOf(MSG.PAIR_RESET).length, 1, '重连后仍不得第二次自动重置');
  });
});

describe('健壮性补充', () => {
  test('非法消息（null / 无 type / 非对象）按消费处理且不炸', async () => {
    const h = makeHarness();
    assert.equal(await h.hs.handle(null), true);
    assert.equal(await h.hs.handle({}), true);
    assert.equal(await h.hs.handle(42), true);
    assert.equal(h.sent.length, 0);
    assert.equal(h.events.length, 0);
  });

  test('store.load 抛错 → emit(error)，状态回 idle，不发 ack', async () => {
    const sent = [];
    const hs = new Handshake({
      send: (m) => sent.push(m),
      store: { load: async () => { throw new Error('disk boom'); }, save: async () => {} },
    });
    const errors = [];
    hs.on('error', (err) => errors.push(err));
    const consumed = await hs.handle(helloMsg({ deviceId: 'd' }));
    assert.equal(consumed, true);
    assert.equal(sent.length, 0);
    assert.equal(errors.length, 1);
    assert.equal(hs.state, HANDSHAKE_STATE.IDLE);
  });

  test('store.save 抛错（pair.ok 落表失败）→ emit(error) 且不 emit paired', async () => {
    const hs = new Handshake({
      send: () => {},
      store: { load: async () => null, save: async () => { throw new Error('disk full'); } },
    });
    const errors = [];
    const paired = [];
    hs.on('error', (e) => errors.push(e));
    hs.on('paired', (a) => paired.push(a));
    await hs.handle({ type: MSG.PAIR_OK, deviceId: 'd', token: 't'.repeat(32) });
    assert.equal(errors.length, 1);
    assert.equal(paired.length, 0, '落表失败不得宣布已配对');
  });

  test('连续两次握手（重连场景）：第二次 ready info 覆盖第一次', async () => {
    const h = makeHarness({ table: { 'dev-1': 'a'.repeat(32) }, deviceId: 'dev-1' });
    await h.hs.handle(helloMsg({ deviceId: 'dev-1', token: 'a'.repeat(32), fw: '1.0.0' }));
    const firstInfo = h.hs.info;
    h.hs.reset();
    await h.hs.handle(helloMsg({ deviceId: 'dev-1', token: 'a'.repeat(32), fw: '2.0.0' }));
    assert.equal(h.of('ready').length, 2);
    assert.notEqual(h.hs.info, firstInfo);
    assert.equal(h.hs.info.firmware, '2.0.0');
  });
});
