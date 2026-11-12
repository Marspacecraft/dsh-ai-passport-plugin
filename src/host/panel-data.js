/**
 * 面板的纯数据投影。
 *
 * `panelSnapshot()` 只读取传入的领域对象，不 import 任何 UI、DOM、HTTP 或宿主模块；
 * 它可以在 `node --test` 里直接调用。面板客户端只负责把这些字段画出来：
 * 这里没有的字段一律是 `null`/`false` + 一个可读的 `*Note`，不拿 0 或假字符串冒充数据。
 *
 * 输入：
 *   - link:      Link 实例（`state` / `ready` / `info`），可缺省
 *   - sessions:  Sessions 实例（`snapshot()`）或 `{sessions: []}` / 数组
 *   - trust:     可选的信任表同步摘要（`snapshot()`、`list()`、`table`、`devices`
 *                或直接带 deviceId/hostName/remaining/error 的普通对象）。
 *                 默认的 createTrustStore 只有异步 load/save，不能同步读取；
 *                 这种情况下配对字段为 null，并由 pairingNote 说明原因。
 *   - asr:       ASR 提供者、`{provider}`/`{host:{asr}}` 包装或能力摘要
 *   - timeline:  Timeline 实例（只读 `stats.entries`）
 *   - now:       可选时钟（毫秒数或返回毫秒数的函数），用于稳定测试
 *
 * 返回的是普通对象（JSON 可序列化），字段名固定；新增字段只能追加。
 */

export const PANEL_SCHEMA_VERSION = 2;

const LINK_LABELS = Object.freeze({
  idle: '未连接',
  scanning: '搜索中',
  connecting: '连接中',
  connected: '已连接',
  reconnecting: '重连中',
  failed: '连接失败',
});

// docs/03 §3.4：能力位 0..6 有定义，7..15 保留。只展示已定义的位，
// 未知保留位不猜测含义；0 是合法值（设备明确声明“没有任何能力”）。
const CAPABILITY_LABELS = Object.freeze([
  'DISPLAY',
  'INPUT_NAV',
  'INPUT_TOUCH',
  'MIC',
  'SPEAKER',
  'BATTERY',
  'NOTIFY',
]);

const ASR_STATE_LABELS = Object.freeze({
  ready: '就绪',
  idle: '就绪',
  recording: '录音中',
  transcribing: '转写中',
  error: '错误',
  failed: '错误',
  unknown: '未获取',
});

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function textOrNull(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readLinkState(link) {
  const state = typeof link?.state === 'string' ? link.state : 'unknown';
  return state;
}

function readInfo(link) {
  return isObject(link?.info) ? link.info : null;
}

function readPaired(info) {
  return info?.paired === true || info?.paired === 1;
}

function readCapabilities(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return { bits: null, labels: null, note: '设备未上报能力位' };
  }
  const labels = [];
  for (let bit = 0; bit < CAPABILITY_LABELS.length; bit += 1) {
    if ((value & (1 << bit)) !== 0) labels.push(CAPABILITY_LABELS[bit]);
  }
  return {
    bits: value,
    labels,
    note: labels.length === 0 ? '设备未声明任何能力' : null,
  };
}

function truncateSummary(value, limit = 120) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const points = Array.from(value);
  if (points.length <= limit) return value;
  return points.slice(0, limit).join('') + '…';
}

function normalizeAsrState(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const normalized = value.toLowerCase();
  return Object.hasOwn(ASR_STATE_LABELS, normalized) ? normalized : 'unknown';
}

function readTrust(trust) {
  const out = {
    available: false,
    deviceId: null,
    hostName: null,
    remaining: null,
    error: null,
  };
  if (!isObject(trust)) return out;

  let view = null;
  if (typeof trust.snapshot === 'function') {
    try {
      const snapshot = trust.snapshot();
      if (isObject(snapshot)) view = snapshot;
    } catch {
      // 读取摘要失败不是面板崩溃的理由；下面用 available=false 说明。
    }
  }
  if (!view && isObject(trust.table)) view = trust.table;
  if (!view && Array.isArray(trust.devices)) {
    const first = trust.devices.find((row) => isObject(row));
    if (first) view = first;
  }
  if (!view && typeof trust.list === 'function') {
    try {
      const rows = trust.list();
      if (Array.isArray(rows) && isObject(rows[0])) view = rows[0];
      else if (isObject(rows)) view = rows;
    } catch {
      // 同上：保持 available=false。
    }
  }
  if (!view && isObject(trust.devices)) view = trust.devices;
  if (!view && (trust.deviceId !== undefined || trust.paired !== undefined)) view = trust;

  if (!view) {
    // 只有异步 load/save 的 store（例如 createTrustStore）不能在这里 await。
    out.error = textOrNull(trust.error);
    return out;
  }

  // `table` 形态：{ deviceId: token }，没有展示名/剩余次数。
  if (isObject(trust.table) && view === trust.table) {
    const ids = Object.keys(view);
    out.available = true;
    out.deviceId = ids.length > 0 ? ids[0] : null;
    return out;
  }

  out.available = true;
  out.deviceId = textOrNull(view.deviceId) ?? textOrNull(view.id);
  out.hostName = textOrNull(view.hostName);
  out.remaining = numberOrNull(view.remaining);
  out.error = textOrNull(view.error);
  return out;
}

function readSessions(sessions) {
  if (Array.isArray(sessions)) return sessions;
  if (Array.isArray(sessions?.sessions)) return sessions.sessions;
  if (typeof sessions?.snapshot === 'function') {
    try {
      const snapshot = sessions.snapshot();
      if (Array.isArray(snapshot)) return snapshot;
      if (Array.isArray(snapshot?.sessions)) return snapshot.sessions;
    } catch {
      return [];
    }
  }
  return [];
}

function readTimelineEntries(timeline) {
  const fromStats = numberOrNull(timeline?.stats?.entries);
  if (fromStats !== null) return fromStats;
  if (Array.isArray(timeline?.entries)) return timeline.entries.length;
  return null;
}

function readAsr(asr) {
  const direct =
    isObject(asr) &&
    (typeof asr.transcribe === 'function' ||
      typeof asr.prepare === 'function' ||
      typeof asr.ready === 'boolean' ||
      typeof asr.providerId === 'string')
      ? asr
      : null;
  const provider =
    asr?.provider ??
    asr?.transcriber ??
    (isObject(asr?.host) ? asr.host.asr : null) ??
    direct ??
    null;
  const available = asr?.available === true || provider !== null;
  const ready = asr?.ready === true || provider?.ready === true;

  let state = normalizeAsrState(asr?.state) ?? normalizeAsrState(asr?.status);
  if (!state && asr?.transcribing === true) state = 'transcribing';
  if (!state && asr?.recording === true) state = 'recording';
  if (!state && ready) state = 'ready';

  const lastRaw = asr?.lastResult ?? asr?.last_result ?? null;
  let lastResult = null;
  let lastResultAt = null;
  if (typeof lastRaw === 'string') {
    lastResult = textOrNull(lastRaw);
  } else if (isObject(lastRaw)) {
    lastResult = textOrNull(lastRaw.text) ?? textOrNull(lastRaw.summary);
    lastResultAt = numberOrNull(lastRaw.at) ?? numberOrNull(lastRaw.finishedAt);
  }
  if (lastResultAt === null) {
    lastResultAt = numberOrNull(asr?.lastResultAt) ?? numberOrNull(asr?.lastResult?.at);
  }

  const stats = isObject(asr?.stats) ? asr.stats : null;
  const sessionCount =
    numberOrNull(asr?.sessions) ??
    numberOrNull(stats?.sessions) ??
    (Array.isArray(asr?.sessions) ? asr.sessions.length : null);

  return {
    available,
    ready,
    provider: textOrNull(asr?.providerId) ?? textOrNull(provider?.id) ?? textOrNull(provider?.name),
    preparing: asr?.preparing === true,
    detail: textOrNull(asr?.detail),
    error: textOrNull(asr?.error),
    state: state ?? 'unknown',
    stateLabel: ASR_STATE_LABELS[state ?? 'unknown'] ?? '未获取',
    sessionCount,
    lastResult,
    lastResultSummary: truncateSummary(lastResult),
    lastResultAt,
  };
}

/**
 * @param {{link?: object, sessions?: object|Array, trust?: object, asr?: object, timeline?: object, now?: number|Function}} [input]
 * @returns {object}
 */
export function panelSnapshot(input = {}) {
  const { link, sessions, trust, asr, timeline, now } = input;
  const state = readLinkState(link);
  const ready = link?.ready === true;
  const info = readInfo(link);
  const paired = readPaired(info);
  const trustView = readTrust(trust);
  const sessionRows = readSessions(sessions);
  const attentionCount = sessionRows.reduce((count, row) => {
    const attention = row?.attention;
    return attention && attention !== 'none' ? count + 1 : count;
  }, 0);
  const asrView = readAsr(asr);
  const timestamp =
    typeof now === 'function' ? numberOrNull(now()) : numberOrNull(now) ?? Date.now();

  const deviceId = textOrNull(info?.deviceId) ?? trustView.deviceId;
  const deviceName = textOrNull(info?.name);
  const deviceModel = textOrNull(info?.model) ?? textOrNull(info?.deviceModel);
  const firmware = textOrNull(info?.firmware);
  const deviceMtu = numberOrNull(info?.mtu);
  const deviceMaxPayload = numberOrNull(info?.maxPayload);
  const deviceMaxChunks = numberOrNull(info?.maxChunks);
  const capabilities = readCapabilities(info?.capabilities);
  const battery = numberOrNull(info?.battery);
  const signal = numberOrNull(info?.signal) ?? numberOrNull(info?.rssi);

  let linkLabel;
  if (state === 'unknown') linkLabel = '未知（未注入链路）';
  else linkLabel = LINK_LABELS[state] ?? `未知（${state}）`;

  let linkError = null;
  if (state === 'failed') {
    linkError =
      textOrNull(link?.lastError?.message) ??
      textOrNull(link?.error) ??
      '链路失败，原因未上报';
  }

  let deviceNote = null;
  if (!info) deviceNote = '尚未握手，设备信息不可用';
  else if (battery === null && signal === null) {
    deviceNote = '设备未上报电量/信号（BLE 握手信息没有对应字段）';
  }

  let pairingNote;
  if (!ready) pairingNote = '设备未连接，配对不可用';
  else if (paired) pairingNote = '已完成配对';
  else if (!trustView.available) {
    pairingNote = '等待设备发起配对（信任表未提供同步摘要）';
  } else {
    pairingNote = '请输入设备屏幕上显示的 6 位配对码';
  }

  let asrNote;
  if (!asrView.available) asrNote = '宿主未配置 ASR 提供者';
  else if (asrView.preparing) asrNote = '正在准备 ASR 模型…';
  else if (asrView.state === 'recording') asrNote = '正在录音…';
  else if (asrView.state === 'transcribing') asrNote = '正在转写…';
  else if (asrView.state === 'error') asrNote = 'ASR 状态异常，见错误信息';
  else if (!asrView.ready) asrNote = 'ASR 提供者尚未就绪';
  else asrNote = 'ASR 可用';

  return {
    schemaVersion: PANEL_SCHEMA_VERSION,
    generatedAt: timestamp,
    linkState: state,
    linkReady: ready,
    linkLabel,
    linkError,
    attentionCount,
    deviceId,
    deviceName,
    deviceModel,
    deviceFirmware: firmware,
    deviceMtu,
    deviceMaxPayload,
    deviceMaxChunks,
    deviceCapabilities: capabilities.bits,
    deviceCapabilityLabels: capabilities.labels,
    deviceCapabilityNote: capabilities.note,
    deviceBattery: battery,
    deviceSignal: signal,
    deviceHandshake: ready ? 'ready' : info ? 'handshaking' : null,
    deviceNote,
    pairingNeeded: ready && !paired,
    pairingPaired: paired,
    pairingDeviceId: deviceId,
    pairingHostName: trustView.hostName,
    pairingRemaining: trustView.remaining,
    pairingError: trustView.error,
    pairingNote,
    asrAvailable: asrView.available,
    asrReady: asrView.ready,
    asrProvider: asrView.provider,
    asrPreparing: asrView.preparing,
    asrState: asrView.state,
    asrStateLabel: asrView.stateLabel,
    asrSessionCount: asrView.sessionCount,
    asrLastResult: asrView.lastResult,
    asrLastResultSummary: asrView.lastResultSummary,
    asrLastResultAt: asrView.lastResultAt,
    asrDetail: asrView.detail,
    asrError: asrView.error,
    asrNote,
    sessionCount: sessionRows.length,
    timelineEntries: readTimelineEntries(timeline),
  };
}
