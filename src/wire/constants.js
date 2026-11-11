/**
 * 协议常量：`docs/03-蓝牙协议规格.md` 附录 B 的机器可读副本。
 *
 * 本文件**不是**权威 —— 权威是协议文档。改协议必须同时改两处，
 * `test/wire/constants.test.js` 会逐项对撞，不同步立刻红灯。
 *
 * 命名与文档表格一一对应，不要随意改名或增删导出。
 */

// --- B.1 协议版本与帧 -------------------------------------------------------
export const PROTOCOL_VERSION = 2;
export const FRAME_HEADER_BYTES = 4;
export const VERSION_SHIFT = 4;
export const VERSION_MASK = 0b1111;
export const FLAGS_MASK = 0b1111;
export const MSGID_BITS = 12;
export const MSGID_MASK = 0b1111_1111_1111;
export const MSGID_SPACE = 4096;
export const FRAG_MASK = 0b1111;
export const MAX_CHUNKS = 16;

// --- B.2 帧标志位 -----------------------------------------------------------
export const FLAG_FIRST = 0b0001;
export const FLAG_LAST = 0b0010;
export const FLAG_ACK_REQ = 0b0100;

// --- B.3 通道号 -------------------------------------------------------------
export const CHANNEL_CONTROL = 0;
export const CHANNEL_AUDIO = 1;
export const CHANNEL_HEARTBEAT = 2;
export const CHANNEL_LOG = 3;

/**
 * 数值通道 → 字符串名（docs/02 §4.2「data 事件的 channel 元数据契约」）。
 *
 * 传输层的 `data(bytes, meta)` 用字符串 `meta.channel` 交给上层；本表是
 * 唯一的数值↔字符串映射，任何地方都不要再手写 'control'/'audio' 字面量。
 */
export const CHANNEL_NAME = Object.freeze({
  [CHANNEL_CONTROL]: 'control',
  [CHANNEL_AUDIO]: 'audio',
  [CHANNEL_HEARTBEAT]: 'heartbeat',
  [CHANNEL_LOG]: 'log',
});

/** 数值通道 → 字符串名；未知通道返回 `'control'`（与握手前的容错口径一致）。 */
export function channelName(channel) {
  return CHANNEL_NAME[channel] ?? 'control';
}

// --- B.4 MTU 与分片 ---------------------------------------------------------
export const MTU_TARGET = 517;
export const MTU_FALLBACK = 247;
export const MTU_MIN = 23;
export const MTU_MIN_CHUNK_PAYLOAD = 16;
export const ATT_OVERHEAD_BYTES = 3;
export const MAX_MESSAGE_BYTES_CEILING = 8160;

// --- B.5 确认与重传 ---------------------------------------------------------
export const ACK_RETRY_DELAYS_MS = [400, 800, 1600];
export const ACK_MAX_RETRIES = 3;

// --- B.6 保活 ---------------------------------------------------------------
export const KEEPALIVE_TICK_MS = 5000;
export const KEEPALIVE_IDLE_MS = 5000;
export const KEEPALIVE_DEAD_MS = 30000;

// --- B.7 重连退避 -----------------------------------------------------------
export const RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 10000, 20000, 30000];

// --- B.8 推送与缓冲 ---------------------------------------------------------
export const PUSH_MIN_INTERVAL_MS = 500;
export const TIMELINE_LIMIT = 20;
export const REASSEMBLY_TIMEOUT_MS = 10000;
export const DONE_LINGER_MS = 8000;

// --- B.9 ASR 音频参数 -------------------------------------------------------
export const ASR_SAMPLE_RATE = 16000;
export const ASR_FALLBACK_RATE = 8000;
export const ASR_BITS_PER_SAMPLE = 16;
export const ASR_CHANNELS = 1;
export const ASR_MAX_SECONDS = 30;
export const ASR_MIN_SAMPLES = 8000;
export const ASR_TIMEOUT_MS = 60000;
export const ASR_REQUEST_ID_SPACE = 16;

/** 唯一的合法编码。没有 pcm16：30 秒 PCM 要 938 KB，实测 15–17 KB/s 传不完。 */
export const ASR_CODEC = 'ima-adpcm';

/** IMA ADPCM 块结构：4 字节头（predictor int16LE + stepIndex uint8 + 保留）+ 504 字节数据。 */
export const ASR_BLOCK_HEADER_BYTES = 4;
export const ASR_BLOCK_DATA_BYTES = 504;
export const ASR_BLOCK_BYTES = ASR_BLOCK_HEADER_BYTES + ASR_BLOCK_DATA_BYTES;

/** 每字节 2 个 4 位样本（低 nibble 在前），故每块 1008 个样本 = 63.0 ms @ 16 kHz。 */
export const ASR_SAMPLES_PER_BLOCK = ASR_BLOCK_DATA_BYTES * 2;
export const ASR_STEP_INDEX_MAX = 88;
export const ASR_NIBBLE_BITS = 4;

/** 实测 BLE 有效吞吐区间，仅用于判断 codec 可行性，不得据此限流。 */
export const BLE_MIN_THROUGHPUT_BPS = 15360;
export const BLE_MAX_THROUGHPUT_BPS = 17408;

// --- B.10 广播与 GATT -------------------------------------------------------
export const SERVICE_UUID = '0000a900-a900-5041-5353-544f524f5350';
export const CHAR_RX_UUID = 'a9005041-5353-544f-524f-5350f0a90002';
export const CHAR_TX_UUID = 'a9005041-5353-544f-524f-5350f0a90003';
export const CHAR_AUDIO_UUID = 'a9005041-5353-544f-524f-5350f0a90004';
export const CHAR_CTRL_UUID = 'a9005041-5353-544f-524f-5350f0a90005';
export const ADV_MFG_TAG = 'FAP1';
export const CTRL_READ_BYTES = 16;

// --- B.11 设备识别名 --------------------------------------------------------
export const ADV_DEVICE_NAMES = ['FoloPassport-DSH', 'Folo-PSP', 'FoloPassport'];

// --- B.12 能力位 ------------------------------------------------------------
export const CAP_DISPLAY = 1 << 0;
export const CAP_INPUT_NAV = 1 << 1;
export const CAP_INPUT_TOUCH = 1 << 2;
export const CAP_MIC = 1 << 3;
export const CAP_SPEAKER = 1 << 4;
export const CAP_BATTERY = 1 << 5;
export const CAP_NOTIFY = 1 << 6;

// --- 消息类型（协议 §4 消息总表）--------------------------------------------
// 这些是字符串常量，不在附录 B 的数值表里，但同样属于协议契约：
// 打错一个字符表现为「连上了但对方什么也不做」，因此单独列在这里便于对撞。

export const MSG = {
  // 通用
  HELLO: 'hello',
  HELLO_ACK: 'hello.ack',
  PING: 'ping',
  PONG: 'pong',
  ACK: 'ack',
  NACK: 'nack',

  // 推送族
  SESSION_STATE: 'session.state',
  SESSION_RESULT: 'session.result',
  APPROVAL_ASKED: 'approval.asked',
  APPROVAL_DONE: 'approval.done',
  QUESTION_ASKED: 'question.asked',
  QUESTION_DONE: 'question.done',
  NOTICE: 'notice',

  // 拉取族
  SESSION_LIST_REQ: 'session.list.req',
  SESSION_LIST: 'session.list',
  TIMELINE_REQ: 'timeline.req',
  TIMELINE: 'timeline',
  BALANCE_REQ: 'balance.req',
  BALANCE: 'balance',

  // ASR 族
  ASR_BEGIN: 'asr.begin',
  ASR_END: 'asr.end',
  ASR_CANCEL: 'asr.cancel',
  ASR_RESULT: 'asr.result',
  ASR_ERROR: 'asr.error',

  // 控制族
  SESSION_CANCEL: 'session.cancel',
  SESSION_CANCEL_ACK: 'session.cancel.ack',
  SESSION_INPUT: 'session.input',
  SESSION_INPUT_ACK: 'session.input.ack',
  APPROVAL_DECIDE: 'approval.decide',
  QUESTION_ANSWER: 'question.answer',

  // 配对
  PAIR_REQUIRED: 'pair.required',
  PAIR_BEGIN: 'pair.begin',
  PAIR_OK: 'pair.ok',
  PAIR_FAILED: 'pair.failed',
  PAIR_RESET: 'pair.reset',
};

// --- 会话状态（协议 §5.1）---------------------------------------------------
export const SESSION_STATE = {
  IDLE: 'idle',
  RUNNING: 'running',
  WAITING: 'waiting',
  DONE: 'done',
  ERROR: 'error',
};

export const SESSION_ROLE = {
  MAIN: 'main',
  SUB: 'sub',
};

export const ATTENTION = {
  NONE: 'none',
  APPROVAL: 'approval',
  QUESTION: 'question',
};

// --- 会议/审批结局（协议 §5.3）----------------------------------------------
export const APPROVAL_OUTCOME = {
  ALLOWED_ONCE: 'allowed-once',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
  UNAVAILABLE: 'unavailable',
  TIMEOUT: 'timeout',
};

export const DECIDED_BY = {
  DEVICE: 'device',
  PC: 'pc',
  PANEL: 'panel',
  TIMEOUT: 'timeout',
  ABORT: 'abort',
  DISCONNECT: 'disconnect',
};
