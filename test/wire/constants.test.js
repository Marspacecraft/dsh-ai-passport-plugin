import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as C from '../../src/wire/constants.js';

const here = dirname(fileURLToPath(import.meta.url));
const DOC_PATH = join(here, '..', '..', 'docs', '03-蓝牙协议规格.md');

/**
 * 解析协议文档的附录 B 常量总表。
 *
 * 只认附录 B 之后、且第一列是反引号包裹的全大写名称的行：
 *   | `PROTOCOL_VERSION` | 2 | int |
 *
 * 返回 Map<name, {raw, type}>。
 */
export function parseAppendixB(markdown) {
  const start = markdown.indexOf('## 附录 B');
  if (start === -1) throw new Error('协议文档里找不到「## 附录 B」');

  const out = new Map();
  const row = /^\|\s*`([A-Z][A-Z0-9_]*)`\s*\|\s*([^|]+?)\s*\|\s*([a-z\[\]]+)\s*\|\s*$/;

  for (const line of markdown.slice(start).split('\n')) {
    const m = row.exec(line);
    if (!m) continue;
    const [, name, raw, type] = m;
    if (!['int', 'string', 'int[]', 'string[]'].includes(type)) {
      throw new Error(`附录 B 里 ${name} 的类型 ${type} 不认识`);
    }
    if (out.has(name)) throw new Error(`附录 B 里 ${name} 重复定义`);
    out.set(name, { raw: raw.trim(), type });
  }

  if (out.size === 0) throw new Error('附录 B 解析出 0 个常量，格式可能变了');
  return out;
}

/** 把文档里的原始文本按类型转成 JS 值。 */
function coerce(name, { raw, type }) {
  switch (type) {
    case 'int': {
      if (!/^-?\d+$/.test(raw)) throw new Error(`${name} 声明为 int 但不是整数：${raw}`);
      return Number(raw);
    }
    case 'string':
      return raw;
    case 'int[]': {
      const parts = raw.split(',').map((s) => s.trim());
      for (const p of parts) {
        if (!/^-?\d+$/.test(p)) throw new Error(`${name} 声明为 int[] 但含非整数：${p}`);
      }
      return parts.map(Number);
    }
    case 'string[]':
      return raw.split(',').map((s) => s.trim());
    default:
      throw new Error(`未知类型 ${type}`);
  }
}

const doc = readFileSync(DOC_PATH, 'utf8');
const table = parseAppendixB(doc);

test('附录 B 能被解析且包含预期的常量数量', () => {
  assert.ok(table.size >= 50, `解析出的常量太少：${table.size}`);
});

test('每个附录 B 常量都在 src/wire/constants.js 里导出且值一致', () => {
  const failures = [];
  for (const [name, entry] of table) {
    if (!(name in C)) {
      failures.push(`${name}：文档有，代码没有导出`);
      continue;
    }
    const expected = coerce(name, entry);
    const actual = C[name];
    try {
      assert.deepEqual(actual, expected);
    } catch {
      failures.push(
        `${name}：文档是 ${JSON.stringify(expected)}，代码是 ${JSON.stringify(actual)}`,
      );
    }
  }
  assert.deepEqual(failures, [], `常量不一致：\n${failures.join('\n')}`);
});

test('没有只存在于代码、文档却未记载的协议常量', () => {
  // 代码里额外的导出（MSG / SESSION_STATE 等枚举对象）不属于附录 B 的数值表，
  // 这里只检查"看起来像协议常量"的标量与数组，防止偷偷加常量绕过文档。
  const exempt = new Set([
    'MSG',
    'SESSION_STATE',
    'SESSION_ROLE',
    'ATTENTION',
    'APPROVAL_OUTCOME',
    'DECIDED_BY',
  ]);
  const orphans = [];
  for (const [name, value] of Object.entries(C)) {
    if (table.has(name) || exempt.has(name)) continue;
    if (name === 'default') continue;
    const kind = typeof value;
    if (kind === 'number' || kind === 'string' || Array.isArray(value)) {
      orphans.push(`${name} = ${JSON.stringify(value)}`);
    }
  }
  assert.deepEqual(orphans, [], `这些常量没写进附录 B：\n${orphans.join('\n')}`);
});

test('能力位掩码不重叠且能从 0 累加到全开', () => {
  const bits = [
    C.CAP_DISPLAY,
    C.CAP_INPUT_NAV,
    C.CAP_INPUT_TOUCH,
    C.CAP_MIC,
    C.CAP_SPEAKER,
    C.CAP_BATTERY,
    C.CAP_NOTIFY,
  ];
  for (const b of bits) {
    assert.equal(b & (b - 1), 0, `${b} 不是 2 的幂`);
  }
  assert.equal(new Set(bits).size, bits.length, '能力位有重复');
  const all = bits.reduce((a, b) => a | b, 0);
  assert.equal(all, 127, '七个能力位应覆盖 bit0..bit6');
});

test('帧标志位不重叠且互不影响', () => {
  assert.equal(C.FLAG_FIRST & C.FLAG_LAST, 0);
  assert.equal(C.FLAG_FIRST & C.FLAG_ACK_REQ, 0);
  assert.equal(C.FLAG_LAST & C.FLAG_ACK_REQ, 0);
  // 单帧消息 = FIRST|LAST
  assert.equal(C.FLAG_FIRST | C.FLAG_LAST, 3);
});

test('msgId 与 frag 的位宽与掩码自洽', () => {
  assert.equal(C.MSGID_SPACE, 2 ** C.MSGID_BITS);
  assert.equal(C.MSGID_MASK, C.MSGID_SPACE - 1);
  assert.equal(C.FRAG_MASK, C.MAX_CHUNKS - 1);
  assert.equal(C.VERSION_MASK, 0b1111);
  assert.equal(C.FLAGS_MASK, 0b1111);
});

test('通道号是 0..3 且与 4 位 flags 不冲突（在各自半字节/字节内）', () => {
  const channels = [C.CHANNEL_CONTROL, C.CHANNEL_AUDIO, C.CHANNEL_HEARTBEAT, C.CHANNEL_LOG];
  assert.deepEqual(channels, [0, 1, 2, 3]);
  for (const ch of channels) assert.ok(ch >= 0 && ch <= 0xff);
});

test('CHANNEL_NAME 覆盖全部四个数值通道，且与 docs/02 §4.2 的字符串集合一致', () => {
  // 反向锁死：docs/02 规定 meta.channel 只可能是这四个字符串。
  // 少一个或拼错，传输层就会把某类帧的元数据标错（M2 曾把 HEARTBEAT 标成 control）。
  assert.deepEqual(C.CHANNEL_NAME, {
    0: 'control',
    1: 'audio',
    2: 'heartbeat',
    3: 'log',
  });

  const CHANNELS = [C.CHANNEL_CONTROL, C.CHANNEL_AUDIO, C.CHANNEL_HEARTBEAT, C.CHANNEL_LOG];
  const names = CHANNELS.map((ch) => C.channelName(ch));
  assert.deepEqual(names, ['control', 'audio', 'heartbeat', 'log']);

  // 每个数值通道都能查到自己，且字符串两两不同（否则无法区分）
  assert.equal(new Set(names).size, CHANNELS.length);
  for (const ch of CHANNELS) {
    assert.equal(C.CHANNEL_NAME[ch], C.channelName(ch));
  }

  // 未知通道兜底为 control（握手前的最宽松口径），不抛错
  assert.equal(C.channelName(9), 'control');
  assert.equal(C.channelName(255), 'control');

  // 冻结：防止运行时被改写
  assert.ok(Object.isFrozen(C.CHANNEL_NAME));
});

test('MTU 三档推算出文档里写明的 chunkPayload，且与上限常量一致', () => {
  const chunkPayloadOf = (mtu) =>
    Math.max(20, mtu - C.ATT_OVERHEAD_BYTES) - C.FRAME_HEADER_BYTES;

  assert.equal(chunkPayloadOf(517), 510);
  assert.equal(chunkPayloadOf(247), 240);
  assert.equal(chunkPayloadOf(244), 237);
  assert.equal(chunkPayloadOf(23), 16);

  // 单条消息上限的绝对天花板 = 16 × mtU517 时的 chunkPayload
  assert.equal(C.MAX_CHUNKS * chunkPayloadOf(517), C.MAX_MESSAGE_BYTES_CEILING);

  // 兜底 MTU 不得低于 MTU_MIN，且其片载荷不得低于最小允许值
  assert.ok(C.MTU_FALLBACK >= C.MTU_MIN);
  assert.equal(chunkPayloadOf(C.MTU_FALLBACK), 240);
  assert.ok(chunkPayloadOf(C.MTU_MIN) >= C.MTU_MIN_CHUNK_PAYLOAD);
});

test('重传退避序列严格递增且次数与长度一致', () => {
  const d = C.ACK_RETRY_DELAYS_MS;
  assert.equal(d.length, C.ACK_MAX_RETRIES);
  for (let i = 1; i < d.length; i += 1) {
    assert.ok(d[i] > d[i - 1], `退避序列未递增：${d}`);
  }
  assert.deepEqual(d, [400, 800, 1600]);
});

test('重连退避序列严格递增且以 30 秒封顶', () => {
  const b = C.RECONNECT_BACKOFF_MS;
  for (let i = 1; i < b.length; i += 1) {
    assert.ok(b[i] > b[i - 1], `退避未递增：${b}`);
  }
  assert.equal(b.at(-1), 30000);
});

test('保活三阈值的关系：tick ≤ idle < dead', () => {
  assert.ok(C.KEEPALIVE_TICK_MS <= C.KEEPALIVE_IDLE_MS);
  assert.ok(C.KEEPALIVE_IDLE_MS < C.KEEPALIVE_DEAD_MS);
  // 死链判定必须是 tick 的整数倍，否则检查点会漂移
  assert.equal(C.KEEPALIVE_DEAD_MS % C.KEEPALIVE_TICK_MS, 0);
});

test('ASR 参数自洽：30 秒 @16kHz 的采样数与上限匹配', () => {
  assert.equal(C.ASR_SAMPLE_RATE * C.ASR_MAX_SECONDS, 480000);
  // 0.5 秒 @16kHz
  assert.equal(C.ASR_MIN_SAMPLES, 8000);
  assert.ok(C.ASR_MIN_SAMPLES < C.ASR_SAMPLE_RATE * C.ASR_MAX_SECONDS);
  assert.equal(C.ASR_BITS_PER_SAMPLE, 16);
  assert.equal(C.ASR_CHANNELS, 1);
  assert.equal(C.ASR_REQUEST_ID_SPACE, 16);
});

test('ADPCM 块结构自洽：4 字节头 + 504 字节数据 = 508 字节 = 1008 个样本', () => {
  assert.equal(C.ASR_CODEC, 'ima-adpcm');
  assert.equal(C.ASR_BLOCK_HEADER_BYTES, 4);
  assert.equal(C.ASR_BLOCK_DATA_BYTES, 504);
  // 派生量不能各写各的，必须由基本量算出
  assert.equal(C.ASR_BLOCK_BYTES, C.ASR_BLOCK_HEADER_BYTES + C.ASR_BLOCK_DATA_BYTES);
  assert.equal(C.ASR_BLOCK_BYTES, 508);
  // 每字节 2 个 4 位样本
  assert.equal(C.ASR_SAMPLES_PER_BLOCK, C.ASR_BLOCK_DATA_BYTES * 2);
  assert.equal(C.ASR_SAMPLES_PER_BLOCK, 1008);
  assert.equal(C.ASR_NIBBLE_BITS, 4);
  // 块头 4 字节刚好装下 predictor(int16) + stepIndex(uint8) + 保留(uint8)
  assert.equal(C.ASR_BLOCK_HEADER_BYTES, 2 + 1 + 1);
  // IMA STEP 表 89 项，下标 0..88
  assert.equal(C.ASR_STEP_INDEX_MAX, 88);
});

test('ADPCM 30 秒录音的字节数与文档 §7.1.2 的 241908 一致', () => {
  const totalSamples = C.ASR_SAMPLE_RATE * C.ASR_MAX_SECONDS;
  const fullBlocks = Math.floor(totalSamples / C.ASR_SAMPLES_PER_BLOCK);
  const remainingSamples = totalSamples - fullBlocks * C.ASR_SAMPLES_PER_BLOCK;
  const totalBytes =
    fullBlocks * C.ASR_BLOCK_BYTES +
    C.ASR_BLOCK_HEADER_BYTES +
    Math.ceil(remainingSamples / 2);
  assert.equal(fullBlocks, 476);
  assert.equal(remainingSamples, 192);
  assert.equal(totalBytes, 241908);

  // 每块是 63 ms，476 个满块 ≈ 30 秒
  const msPerBlock = (C.ASR_SAMPLES_PER_BLOCK / C.ASR_SAMPLE_RATE) * 1000;
  assert.equal(msPerBlock, 63);
});

test('只有 ima-adpcm 可行：pcm16 的 30 秒数据量超出实测带宽', () => {
  const seconds = C.ASR_MAX_SECONDS;
  const pcmBytes = C.ASR_SAMPLE_RATE * (C.ASR_BITS_PER_SAMPLE / 8) * C.ASR_CHANNELS * seconds;
  const adpcmBytes = 241908;

  // 30 秒窗口内实测能传的最大字节数（取上限 17 KB/s）
  const capacityHi = C.BLE_MAX_THROUGHPUT_BPS * seconds;

  // ADPCM 只占一半带宽
  assert.equal(adpcmBytes, 241908);
  assert.ok(adpcmBytes < capacityHi / 2, 'ADPCM 应只用不到一半带宽，给控制通道留空间');

  // PCM 在 30 秒窗口内根本传不完
  assert.equal(pcmBytes, 960000);
  assert.ok(pcmBytes > capacityHi, 'PCM 必须超出 30 秒窗口容量，否则这个约束没了理由');

  // 实测吞吐区间必须自洽：下限 < 上限，且都是正数
  assert.ok(C.BLE_MIN_THROUGHPUT_BPS > 0);
  assert.ok(C.BLE_MIN_THROUGHPUT_BPS < C.BLE_MAX_THROUGHPUT_BPS);
  // 15 KB/s = 15360 B/s，17 KB/s = 17408 B/s
  assert.equal(C.BLE_MIN_THROUGHPUT_BPS, 15 * 1024);
  assert.equal(C.BLE_MAX_THROUGHPUT_BPS, 17 * 1024);
});

test('UUID 均为 8-4-4-4-12 的 32 位十六进制', () => {
  const uuids = [
    C.SERVICE_UUID,
    C.CHAR_RX_UUID,
    C.CHAR_TX_UUID,
    C.CHAR_AUDIO_UUID,
    C.CHAR_CTRL_UUID,
  ];
  const shape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  for (const u of uuids) {
    assert.match(u, shape);
    assert.equal(u.replace(/-/g, '').length, 32);
  }
  // 四个特征的 UUID 必须互不相同，且与控制服务共享中段
  assert.equal(new Set(uuids).size, uuids.length);
  for (const c of uuids.slice(1)) {
    assert.ok(c.includes('5041-5353-544f-524f-5350'), `${c} 与服务工作区不一致`);
  }
});

test('设备识别名里既有长名也有短名（广播包 31 字节限制）', () => {
  assert.ok(C.ADV_DEVICE_NAMES.includes('FoloPassport-DSH'));
  assert.ok(C.ADV_DEVICE_NAMES.includes('Folo-PSP'));
  const short = C.ADV_DEVICE_NAMES.find((n) => n === 'Folo-PSP');
  assert.ok(short.length <= 8, '短名不得超过 8 字符');
});

test('CTRL 读取长度覆盖文档里声明的字段（2+2+2+2+1+7）', () => {
  assert.equal(C.CTRL_READ_BYTES, 2 + 2 + 2 + 2 + 1 + 7);
});

test('MSG 消息类型字符串与协议 §4 逐条一致', () => {
  // 这些字符串打错一个字符就表现为「连上了但对方什么也不做」，
  // 因此在此硬编码一份期望值，与文档同步维护。
  assert.deepEqual(
    { ...C.MSG },
    {
      HELLO: 'hello',
      HELLO_ACK: 'hello.ack',
      PING: 'ping',
      PONG: 'pong',
      ACK: 'ack',
      NACK: 'nack',

      SESSION_STATE: 'session.state',
      SESSION_RESULT: 'session.result',
      APPROVAL_ASKED: 'approval.asked',
      APPROVAL_DONE: 'approval.done',
      QUESTION_ASKED: 'question.asked',
      QUESTION_DONE: 'question.done',
      NOTICE: 'notice',

      SESSION_LIST_REQ: 'session.list.req',
      SESSION_LIST: 'session.list',
      TIMELINE_REQ: 'timeline.req',
      TIMELINE: 'timeline',
      BALANCE_REQ: 'balance.req',
      BALANCE: 'balance',

      ASR_BEGIN: 'asr.begin',
      ASR_END: 'asr.end',
      ASR_CANCEL: 'asr.cancel',
      ASR_RESULT: 'asr.result',
      ASR_ERROR: 'asr.error',

      SESSION_CANCEL: 'session.cancel',
      SESSION_CANCEL_ACK: 'session.cancel.ack',
      SESSION_INPUT: 'session.input',
      SESSION_INPUT_ACK: 'session.input.ack',
      APPROVAL_DECIDE: 'approval.decide',
      QUESTION_ANSWER: 'question.answer',

      PAIR_REQUIRED: 'pair.required',
      PAIR_BEGIN: 'pair.begin',
      PAIR_OK: 'pair.ok',
      PAIR_FAILED: 'pair.failed',
      PAIR_RESET: 'pair.reset',
    },
  );
});

test('MSG 的值互不重复（避免两类消息共用一个字符串）', () => {
  const values = Object.values(C.MSG);
  assert.equal(new Set(values).size, values.length, 'MSG 里有重复的消息类型字符串');
});

test('枚举值覆盖协议文档声明的全部取值', () => {
  assert.deepEqual(Object.values(C.SESSION_STATE).sort(), [
    'done',
    'error',
    'idle',
    'running',
    'waiting',
  ]);
  assert.deepEqual(Object.values(C.SESSION_ROLE).sort(), ['main', 'sub']);
  assert.deepEqual(Object.values(C.ATTENTION).sort(), ['approval', 'none', 'question']);
  assert.deepEqual(Object.values(C.APPROVAL_OUTCOME).sort(), [
    'allowed-once',
    'cancelled',
    'rejected',
    'timeout',
    'unavailable',
  ]);
  assert.deepEqual(Object.values(C.DECIDED_BY).sort(), [
    'abort',
    'device',
    'disconnect',
    'panel',
    'pc',
    'timeout',
  ]);
});
