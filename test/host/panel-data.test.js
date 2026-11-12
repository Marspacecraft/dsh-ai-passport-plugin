import assert from 'node:assert/strict';
import test from 'node:test';

import { PANEL_SCHEMA_VERSION, panelSnapshot } from '../../src/host/panel-data.js';

function link(overrides = {}) {
  return {
    state: 'connected',
    ready: true,
    info: {
      deviceId: 'dev-1',
      name: 'AI Passport',
      firmware: '1.2.3',
      paired: false,
    },
    ...overrides,
  };
}

test('空输入：所有未知字段都是 null/false，并说明原因，不伪造 0 或假数据', () => {
  const data = panelSnapshot({ now: 1234 });
  assert.equal(data.schemaVersion, PANEL_SCHEMA_VERSION);
  assert.equal(data.generatedAt, 1234);
  assert.equal(data.linkState, 'unknown');
  assert.equal(data.linkReady, false);
  assert.equal(data.linkLabel, '未知（未注入链路）');
  assert.equal(data.linkError, null);
  assert.equal(data.attentionCount, 0);
  assert.equal(data.deviceId, null);
  assert.equal(data.deviceName, null);
  assert.equal(data.deviceFirmware, null);
  assert.equal(data.deviceBattery, null);
  assert.equal(data.deviceSignal, null);
  assert.equal(data.deviceHandshake, null);
  assert.equal(data.deviceNote, '尚未握手，设备信息不可用');
  assert.equal(data.pairingNeeded, false);
  assert.equal(data.pairingPaired, false);
  assert.equal(data.pairingDeviceId, null);
  assert.equal(data.pairingRemaining, null);
  assert.equal(data.pairingNote, '设备未连接，配对不可用');
  assert.equal(data.asrAvailable, false);
  assert.equal(data.asrReady, false);
  assert.equal(data.asrProvider, null);
  assert.equal(data.asrNote, '宿主未配置 ASR 提供者');
  assert.equal(data.sessionCount, 0);
  assert.equal(data.timelineEntries, null);
});

test('链路状态映射固定：idle/scanning/connecting/connected/reconnecting/failed', () => {
  const cases = [
    ['idle', '未连接'],
    ['scanning', '搜索中'],
    ['connecting', '连接中'],
    ['connected', '已连接'],
    ['reconnecting', '重连中'],
    ['failed', '连接失败'],
  ];
  for (const [state, label] of cases) {
    const data = panelSnapshot({ link: { state, ready: false }, now: 1 });
    assert.equal(data.linkState, state);
    assert.equal(data.linkLabel, label);
  }
});

test('设备信息按握手字段投影：型号/固件/MTU/消息上限/能力位', () => {
  const data = panelSnapshot({
    link: link({
      info: {
        deviceId: 'dev-1',
        name: 'AI Passport',
        model: 'X1',
        firmware: '2.0.0',
        mtu: 247,
        maxPayload: 3840,
        maxChunks: 16,
        capabilities: 91,
      },
    }),
    now: 1,
  });
  assert.equal(data.deviceModel, 'X1');
  assert.equal(data.deviceFirmware, '2.0.0');
  assert.equal(data.deviceMtu, 247);
  assert.equal(data.deviceMaxPayload, 3840);
  assert.equal(data.deviceMaxChunks, 16);
  assert.equal(data.deviceCapabilities, 91);
  assert.deepEqual(data.deviceCapabilityLabels, [
    'DISPLAY',
    'INPUT_NAV',
    'MIC',
    'SPEAKER',
    'NOTIFY',
  ]);
  assert.equal(data.deviceCapabilityNote, null);
});

test('缺型号/MTU/能力位时保持 null，不用 maxPayload 冒充 MTU', () => {
  const data = panelSnapshot({
    link: link({ info: { deviceId: 'dev-1', firmware: '1.2.3', maxPayload: 8160 } }),
    now: 1,
  });
  assert.equal(data.deviceModel, null);
  assert.equal(data.deviceMtu, null);
  assert.equal(data.deviceMaxPayload, 8160);
  assert.equal(data.deviceCapabilities, null);
  assert.equal(data.deviceCapabilityLabels, null);
  assert.equal(data.deviceCapabilityNote, '设备未上报能力位');
});

test('能力位 0 是合法声明：空列表 + 明确文案，不当作未上报', () => {
  const data = panelSnapshot({
    link: link({ info: { deviceId: 'dev-1', capabilities: 0 } }),
    now: 1,
  });
  assert.equal(data.deviceCapabilities, 0);
  assert.deepEqual(data.deviceCapabilityLabels, []);
  assert.equal(data.deviceCapabilityNote, '设备未声明任何能力');
});

test('ASR 状态投影：就绪/录音/转写，上次结果摘要来自 asr 投影', () => {
  const recording = panelSnapshot({
    asr: { available: true, ready: true, state: 'recording', sessions: 1 },
    now: 1,
  });
  assert.equal(recording.asrState, 'recording');
  assert.equal(recording.asrStateLabel, '录音中');
  assert.equal(recording.asrSessionCount, 1);
  assert.equal(recording.asrNote, '正在录音…');

  const transcribing = panelSnapshot({
    asr: {
      available: true,
      ready: true,
      state: 'transcribing',
      stats: { sessions: 2 },
      lastResult: { text: '识别结果', at: 1700000000000 },
    },
    now: 1,
  });
  assert.equal(transcribing.asrStateLabel, '转写中');
  assert.equal(transcribing.asrSessionCount, 2);
  assert.equal(transcribing.asrLastResult, '识别结果');
  assert.equal(transcribing.asrLastResultSummary, '识别结果');
  assert.equal(transcribing.asrLastResultAt, 1700000000000);

  const ready = panelSnapshot({ asr: { available: true, ready: true }, now: 1 });
  assert.equal(ready.asrState, 'ready');
  assert.equal(ready.asrStateLabel, '就绪');
  assert.equal(ready.asrLastResult, null);
  assert.equal(ready.asrNote, 'ASR 可用');
});

test('ASR 上次结果摘要按 code point 截断，且不伪造缺失会话数', () => {
  const long = '识'.repeat(130);
  const data = panelSnapshot({
    asr: { available: true, ready: true, lastResult: long },
    now: 1,
  });
  assert.equal(Array.from(data.asrLastResultSummary).length, 121);
  assert.equal(data.asrLastResultSummary.endsWith('…'), true);
  assert.equal(data.asrLastResult, long);
  assert.equal(data.asrSessionCount, null);
});

test('投影不包含 v1 的审批/余额/任务字段', () => {
  const data = panelSnapshot({ now: 1 });
  for (const key of ['approvals', 'approval', 'balance', 'tasks', 'task', 'draft']) {
    assert.equal(Object.hasOwn(data, key), false, key);
  }
});

test('已握手：设备字段原样投影，配对需求由 ready && !paired 计算', () => {
  const data = panelSnapshot({ link: link(), now: 1 });
  assert.equal(data.linkState, 'connected');
  assert.equal(data.linkReady, true);
  assert.equal(data.linkLabel, '已连接');
  assert.equal(data.deviceId, 'dev-1');
  assert.equal(data.deviceName, 'AI Passport');
  assert.equal(data.deviceFirmware, '1.2.3');
  assert.equal(data.deviceBattery, null);
  assert.equal(data.deviceSignal, null);
  assert.equal(data.deviceHandshake, 'ready');
  assert.equal(data.deviceNote, '设备未上报电量/信号（BLE 握手信息没有对应字段）');
  assert.equal(data.pairingNeeded, true);
  assert.equal(data.pairingPaired, false);
  assert.equal(data.pairingDeviceId, 'dev-1');
  assert.equal(data.pairingHostName, null);
  assert.equal(data.pairingRemaining, null);
  assert.equal(data.pairingNote, '等待设备发起配对（信任表未提供同步摘要）');
});

test('电量/信号为 0 时保留 0，不被当成缺失', () => {
  const data = panelSnapshot({
    link: link({ info: { deviceId: 'dev-1', battery: 0, signal: 0 } }),
    now: 1,
  });
  assert.equal(data.deviceBattery, 0);
  assert.equal(data.deviceSignal, 0);
  assert.equal(data.deviceNote, null);
});

test('已配对：信任表快照的 hostName/remaining/error 进入配对区', () => {
  const data = panelSnapshot({
    link: link({ info: { deviceId: 'dev-1', paired: true } }),
    trust: {
      snapshot: () => ({ deviceId: 'dev-1', hostName: 'studio-mac', remaining: 2, error: '旧码过期' }),
    },
    now: 1,
  });
  assert.equal(data.pairingPaired, true);
  assert.equal(data.pairingNeeded, false);
  assert.equal(data.pairingDeviceId, 'dev-1');
  assert.equal(data.pairingHostName, 'studio-mac');
  assert.equal(data.pairingRemaining, 2);
  assert.equal(data.pairingError, '旧码过期');
  assert.equal(data.pairingNote, '已完成配对');
});

test('异步 trust store（只有 load/save）不伪造可用：字段保持 null，note 说明原因', () => {
  const data = panelSnapshot({
    link: link({ info: { deviceId: 'dev-1', paired: false } }),
    trust: { load: async () => ({}), save: async () => {} },
    now: 1,
  });
  assert.equal(data.pairingNeeded, true);
  assert.equal(data.pairingHostName, null);
  assert.equal(data.pairingRemaining, null);
  assert.equal(data.pairingError, null);
  assert.match(data.pairingNote, /信任表未提供同步摘要/);
});

test('trust table 形态：用第一个设备 id 展示，但不编造剩余次数', () => {
  const data = panelSnapshot({
    link: link({ info: { deviceId: 'dev-2', paired: false } }),
    trust: { table: { 'dev-2': 'token' } },
    now: 1,
  });
  assert.equal(data.pairingDeviceId, 'dev-2');
  assert.equal(data.pairingHostName, null);
  assert.equal(data.pairingRemaining, null);
  assert.equal(data.pairingNote, '请输入设备屏幕上显示的 6 位配对码');
});

test('会话 attention 角标只统计 approval/question，不统计 none/缺失', () => {
  const data = panelSnapshot({
    sessions: {
      snapshot: () => ({
        sessions: [
          { id: 'a', attention: 'approval' },
          { id: 'b', attention: 'question' },
          { id: 'c', attention: 'none' },
          { id: 'd' },
        ],
      }),
    },
    now: 1,
  });
  assert.equal(data.sessionCount, 4);
  assert.equal(data.attentionCount, 2);
});

test('会话输入也接受数组与 {sessions}，不依赖宿主实例', () => {
  assert.equal(panelSnapshot({ sessions: [{ attention: 'question' }], now: 1 }).attentionCount, 1);
  assert.equal(panelSnapshot({ sessions: { sessions: [] }, now: 1 }).sessionCount, 0);
});

test('timeline 只读 stats.entries；没有 timeline 时为 null，不冒充 0', () => {
  assert.equal(panelSnapshot({ now: 1 }).timelineEntries, null);
  assert.equal(panelSnapshot({ timeline: { stats: { entries: 42 } }, now: 1 }).timelineEntries, 42);
  assert.equal(panelSnapshot({ timeline: { entries: new Array(3) }, now: 1 }).timelineEntries, 3);
});

test('ASR 提供者对象：available/ready/provider 从 provider 读取，未就绪有明确文案', () => {
  const data = panelSnapshot({
    asr: { provider: { id: 'whisper-local', ready: false } },
    now: 1,
  });
  assert.equal(data.asrAvailable, true);
  assert.equal(data.asrReady, false);
  assert.equal(data.asrProvider, 'whisper-local');
  assert.equal(data.asrNote, 'ASR 提供者尚未就绪');
});

test('ASR host 包装与 preparing/detail/error 字段', () => {
  const data = panelSnapshot({
    asr: {
      host: { asr: { name: 'cloud-asr', ready: true } },
      preparing: true,
      detail: '正在加载 120MB 模型',
      error: '上次准备失败',
    },
    now: 1,
  });
  assert.equal(data.asrAvailable, true);
  assert.equal(data.asrReady, true);
  assert.equal(data.asrProvider, 'cloud-asr');
  assert.equal(data.asrPreparing, true);
  assert.equal(data.asrDetail, '正在加载 120MB 模型');
  assert.equal(data.asrError, '上次准备失败');
  assert.equal(data.asrNote, '正在准备 ASR 模型…');
});

test('ASR 直接传 provider（无 provider/host 包装）也不会被当成未配置', () => {
  const data = panelSnapshot({ asr: { id: 'local-whisper', ready: true }, now: 1 });
  assert.equal(data.asrAvailable, true);
  assert.equal(data.asrReady, true);
  assert.equal(data.asrProvider, 'local-whisper');
  assert.equal(data.asrNote, 'ASR 可用');
});

test('链路失败：优先 lastError.message，其次 error 字符串，最后给固定说明', () => {
  assert.equal(
    panelSnapshot({ link: { state: 'failed', lastError: { message: 'noble 打不开' } }, now: 1 }).linkError,
    'noble 打不开',
  );
  assert.equal(
    panelSnapshot({ link: { state: 'failed', error: 'adapter off' }, now: 1 }).linkError,
    'adapter off',
  );
  assert.equal(
    panelSnapshot({ link: { state: 'failed' }, now: 1 }).linkError,
    '链路失败，原因未上报',
  );
});

test('generatedAt 支持数字与函数；投影不修改输入对象', () => {
  const input = { link: link(), sessions: { sessions: [] }, now: () => 9876 };
  const before = JSON.stringify(input);
  const data = panelSnapshot(input);
  assert.equal(data.generatedAt, 9876);
  assert.equal(JSON.stringify(input), before);
  assert.equal(Object.getPrototypeOf(data), Object.prototype);
});

test('paired 接受握手层历史值 1，pairingNeeded 仍为 false', () => {
  const data = panelSnapshot({ link: link({ info: { deviceId: 'dev-1', paired: 1 } }), now: 1 });
  assert.equal(data.pairingPaired, true);
  assert.equal(data.pairingNeeded, false);
});
