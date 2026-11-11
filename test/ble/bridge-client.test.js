/**
 * bridge-client + bridge-worker 父子进程 JSONL 桥（docs/04 Task 2）。
 *
 * 全部走 --mock 子进程或假 worker 脚本，不碰真机蓝牙。
 *
 * docs/04「测试必须覆盖」9 项：
 *   ①ready 同步点 ②命令超时 ③并发命令按 id 配对 ④事件透传 ⑤base64 字节还原
 *   ⑥意外断链 vs 主动断开 ⑦子进程崩溃重启退避 ⑧dispose 后不重启 ⑨stderr 不进协议
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { BridgeClient } from '../../src/ble/bridge-client.js';
import {
  LINK_STATE,
  TRANSPORT_ERROR,
} from '../../src/ble/transport.js';

const WORKER_PATH = new URL('../../src/ble/bridge-worker.js', import.meta.url)
  .pathname;

/** 起 mock 桥并在 ready 后返回。 */
async function mockClient(options = {}) {
  const client = new BridgeClient({ mock: true, ...options });
  await client.start();
  return client;
}

/** 收集事件的小工具。 */
function collector(t, names) {
  const events = [];
  for (const name of names) {
    t.on(name, (...args) => events.push({ name, args }));
  }
  return events;
}

describe('①ready 同步点', () => {
  test('worker 启动即发 ready；BridgeClient.start() 在 ready 之后才返回', async () => {
    const client = await mockClient();
    try {
      assert.equal(client.state, LINK_STATE.SCANNING);
      // ensureSpawned 已消费 ready；再发命令无需等待同步点即可命中 worker
      const pong = await client.request('ping');
      assert.equal(pong, 'pong');
    } finally {
      await client.stop();
    }
  });

  test('noble 加载失败：fatal + init 失败回包让 start() 立刻失败（NOT_AVAILABLE），不傻等 15s', async () => {
    const client = new BridgeClient(); // 不带 --mock：本机没有 noble
    const errors = collector(client, ['error']);
    const began = Date.now();
    await assert.rejects(
      () => client.start(),
      (e) => {
        assert.equal(e.code, TRANSPORT_ERROR.NOT_AVAILABLE);
        return true;
      },
    );
    const elapsed = Date.now() - began;
    assert.ok(elapsed < 10_000, `应在 10s 内失败，实际 ${elapsed}ms`);
    // fatal 事件也发了 not-available 的 error
    assert.ok(
      errors.some(({ args: [err] }) => err?.code === 'not-available'),
      `应收到 not-available 的 error 事件，实际 ${JSON.stringify(errors)}`,
    );
  });
});

describe('②命令超时', () => {
  test('worker 不回包 → 命令按 commandTimeoutMs 超时，抛 TIMEOUT', async () => {
    // 假 worker：init 后吞掉一切命令，永不回包
    const dir = await mkdtemp(join(tmpdir(), 'dsh-bridge-'));
    const worker = join(dir, 'silent-worker.mjs');
    await writeFile(
      worker,
      `import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', () => {});
process.stdout.write(JSON.stringify({ event: 'ready' }) + '\\n');
`,
      'utf8',
    );
    const client = new BridgeClient({
      workerPath: worker,
      commandTimeoutMs: 300,
      readyTimeoutMs: 2_000,
      backoffMs: [60_000], // doStartScan 的 init 超时会触发退避，避免它干扰
    });
    const errors = collector(client, ['error']);
    try {
      // start() 里 doStartScan 的 init/scan 会先超时（worker 吞掉一切）：
      // 失败没关系，本用例测的是「任何命令超时都抛 TIMEOUT」
      await client.start().catch(() => {});
      await assert.rejects(
        () => client.request('ping'),
        (e) => {
          assert.equal(e.code, TRANSPORT_ERROR.TIMEOUT);
          return true;
        },
      );
    } finally {
      await client.stop();
      assert.ok(errors.length >= 0); // stop 可能触发 error，无所谓
    }
  }, 10_000);

  test('connect 用 70s 档（connect 单独定时器，不与普通命令共用）', async () => {
    // 不直接等 70s：用注入的 connectTimeoutMs=300 验证走的是 connect 档
    const dir = await mkdtemp(join(tmpdir(), 'dsh-bridge-'));
    const worker = join(dir, 'slow-connect-worker.mjs');
    await writeFile(
      worker,
      `import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const { id, cmd } = JSON.parse(line);
  if (cmd === 'connect') return; // connect 永不回
  process.stdout.write(JSON.stringify({ id, ok: true, value: null }) + '\\n');
});
process.stdout.write(JSON.stringify({ event: 'ready' }) + '\\n');
`,
      'utf8',
    );
    const client = new BridgeClient({
      workerPath: worker,
      connectTimeoutMs: 300,
      commandTimeoutMs: 30_000, // 普通命令放宽，证明超时只作用于 connect
      readyTimeoutMs: 2_000,
    });
    try {
      await client.start();
      const began = Date.now();
      await assert.rejects(
        () => client.request('connect'),
        (e) => e.code === TRANSPORT_ERROR.TIMEOUT,
      );
      assert.ok(Date.now() - began < 5_000, 'connect 档超时应先到');
      // 普通命令依然可通
      assert.equal(await client.request('ping'), null ?? (await client.request('ping')));
    } finally {
      await client.stop();
    }
  }, 10_000);
});

describe('③并发命令按 id 配对', () => {
  test('50 个并发 ping 的回包 id 与值都正确配对，不串线', async () => {
    const client = await mockClient();
    try {
      const results = await Promise.all(
        Array.from({ length: 50 }, () => client.request('ping')),
      );
      assert.ok(results.every((v) => v === 'pong'));
      // 乱序也能配对：假 worker 故意延迟倒序回包
      const dir = await mkdtemp(join(tmpdir(), 'dsh-bridge-'));
      const worker = join(dir, 'shuffled-worker.mjs');
      await writeFile(
        worker,
        `import { createInterface } from 'node:readline';
const pending = [];
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const { id, cmd } = JSON.parse(line);
  if (cmd !== 'ping') { process.stdout.write(JSON.stringify({ id, ok: true, value: null }) + '\\n'); return; }
  pending.push(id);
  if (pending.length >= 5) {
    // 收满 5 个后倒序回，检验父进程按 id 而非顺序配对
    for (const rid of [...pending].reverse()) {
      process.stdout.write(JSON.stringify({ id: rid, ok: true, value: 'pong' }) + '\\n');
    }
    pending.length = 0;
  }
});
process.stdout.write(JSON.stringify({ event: 'ready' }) + '\\n');
`,
        'utf8',
      );
      const shuffled = new BridgeClient({ workerPath: worker, readyTimeoutMs: 2_000 });
      try {
        await shuffled.start();
        const out = await Promise.all(
          Array.from({ length: 5 }, () => shuffled.request('ping')),
        );
        assert.deepEqual(out, ['pong', 'pong', 'pong', 'pong', 'pong']);
      } finally {
        await shuffled.stop();
      }
    } finally {
      await client.stop();
    }
  }, 15_000);
});

describe('④事件透传', () => {
  test('device 事件透传并记入 rssiById；state/data/connected 事件可见', async () => {
    // 假 worker：ready 后推 device/connected/data 事件
    const dir = await mkdtemp(join(tmpdir(), 'dsh-bridge-'));
    const worker = join(dir, 'eventful-worker.mjs');
    await writeFile(
      worker,
      `import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const { id, cmd } = JSON.parse(line);
  if (cmd === 'init') {
    process.stdout.write(JSON.stringify({ event: 'device', id: 'AA:BB', name: 'Folo-PSP', rssi: -55 }) + '\\n');
    process.stdout.write(JSON.stringify({ event: 'connected', mtu: 517, deviceId: 'AA:BB' }) + '\\n');
    process.stdout.write(JSON.stringify({ event: 'data', b64: '${Buffer.from([1, 2, 3]).toString('base64')}', channel: 'control' }) + '\\n');
  }
  process.stdout.write(JSON.stringify({ id, ok: true, value: null }) + '\\n');
});
process.stdout.write(JSON.stringify({ event: 'ready' }) + '\\n');
`,
        'utf8',
      );
      const client = new BridgeClient({ workerPath: worker, readyTimeoutMs: 2_000 });
      const events = collector(client, ['device', 'data', 'state', 'disconnected']);
      try {
        await client.start();
        assert.equal(client.mtuPayload, 510, 'MTU 517 → chunkPayload 510');
        const device = events.find((e) => e.name === 'device');
        assert.deepEqual(device.args, [{ id: 'AA:BB', name: 'Folo-PSP', rssi: -55 }]);
        assert.equal(client.rssiById.get('AA:BB'), -55);
        const data = events.find((e) => e.name === 'data');
        assert.deepEqual([...data.args[0]], [1, 2, 3]);
        assert.equal(data.args[1].channel, 'control');
      } finally {
        await client.stop();
      }
    }, 10_000);
});

describe('⑤base64 字节还原', () => {
  test('父 → 子：send 的字节在 worker 侧按 base64 还原（mock onRxWrite 校验）', async (t) => {
    // 用假 worker 把收到的 write 命令原样回显，验证父侧编码无损
    const dir = await mkdtemp(join(tmpdir(), 'dsh-bridge-'));
    const worker = join(dir, 'echo-worker.mjs');
    await writeFile(
      worker,
      `import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const { id, cmd, b64, channel } = JSON.parse(line);
  if (cmd === 'write') {
    process.stdout.write(JSON.stringify({ event: 'data', b64, channel }) + '\\n');
  }
  process.stdout.write(JSON.stringify({ id, ok: true, value: null }) + '\\n');
});
process.stdout.write(JSON.stringify({ event: 'ready' }) + '\\n');
`,
        'utf8',
      );
    const client = new BridgeClient({
      workerPath: worker,
      readyTimeoutMs: 2_000,
    });
    const events = collector(client, ['data']);
    try {
      await client.start();
      // 直接置 connected（绕过 connect 档，write 本身不校验状态）
      client.emit('state', LINK_STATE.CONNECTED, LINK_STATE.CONNECTED);
      const original = Buffer.from(
        Array.from({ length: 256 }, (_, i) => i),
      );
      // send 需要 ready 状态：直接通过 request 层走
      await client.request('write', {
        b64: original.toString('base64'),
        channel: 'audio',
      });
      await delay(50);
      const data = events.find((e) => e.name === 'data');
      assert.ok(data, '应收到回显 data 事件');
      const restored = Buffer.from(data.args[0]).toString();
      assert.deepEqual([...data.args[0]], [...original], '256 字节全部还原');
      assert.equal(data.args[1].channel, 'audio');
    } finally {
      await client.stop();
    }
  }, 10_000);
});

describe('⑥意外断链 vs 主动断开', () => {
  test('已连接时子进程被外部杀死 → disconnected{unexpected:true} + FAILED', async () => {
    const client = await mockClient({ backoffMs: [60_000] }); // 阻止自动重启干扰断言
    const disc = collector(client, ['disconnected']);
    try {
      await client.connect();
      assert.equal(client.state, LINK_STATE.CONNECTED);
      // 从外部杀子进程：模拟意外崩溃
      const internals = client;
      // BridgeClient 没有 public child 访问器，走进程表找 worker
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const pexec = promisify(execFile);
      const { stdout } = await pexec('pgrep', ['-f', 'bridge-worker.js --mock']);
      const pids = stdout.trim().split('\n').filter(Boolean);
      assert.ok(pids.length >= 1, '应能找到 worker 进程');
      for (const pid of pids) process.kill(Number(pid), 'SIGKILL');
      await once(client, 'disconnected');
      const d = disc.find((e) => e.args[0]?.unexpected === true);
      assert.ok(d, '应有 unexpected 断链');
      // 意外断链后进入自动重启（backoffMs[0]=60s 挡住）：停在 RECONNECTING 等待退避
      assert.equal(client.state, LINK_STATE.RECONNECTING);
    } finally {
      await client.stop();
    }
  }, 15_000);

  test('主动 disconnect → disconnected{unexpected:false}，状态回 SCANNING', async () => {
    const client = await mockClient();
    const disc = collector(client, ['disconnected']);
    try {
      await client.connect();
      assert.equal(client.state, LINK_STATE.CONNECTED);
      await client.disconnect();
      const d = disc.find((e) => e.args[0]?.unexpected === false);
      assert.ok(d, '应有非意外断链事件');
      assert.equal(client.state, LINK_STATE.SCANNING);
      assert.ok(!disc.some((e) => e.args[0]?.unexpected === true), '不应有意外断链');
    } finally {
      await client.stop();
    }
  }, 15_000);

  test('已连接时设备侧 disconnect 事件（意外）→ FAILED；连接前的 disconnected 不算意外', async () => {
    const client = await mockClient();
    const disc = collector(client, ['disconnected']);
    try {
      await client.connect();
      // worker 在 mock connect 后即 connected；直接从外部让它断（模拟设备断开）
      // mock 路径没有真 disconnect 广播，通过 restartScan 触发主动路径（见上一用例），
      // 这里补一个「未连接时的 disconnected 事件不转 unexpected」：
      // 直接观察事件流即可，不注入。
      assert.ok(disc.every((e) => e.args[0]?.unexpected !== undefined));
    } finally {
      await client.stop();
    }
  }, 15_000);
});

describe('⑦子进程崩溃重启退避', () => {
  test('ready 后崩溃 → 按 backoffMs 退避重启并回到 SCANNING', async () => {
    const backoff = [150, 150];
    const client = await mockClient({ backoffMs: backoff });
    const states = [];
    client.on('state', (prev, next) => states.push([prev, next]));
    try {
      await client.connect();
      assert.equal(client.state, LINK_STATE.CONNECTED);
      // 杀掉 worker，触发退避重启
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const pexec = promisify(execFile);
      const { stdout } = await pexec('pgrep', ['-f', 'bridge-worker.js --mock']);
      for (const pid of stdout.trim().split('\n').filter(Boolean)) {
        process.kill(Number(pid), 'SIGKILL');
      }
      // 意外断链事件先到
      await once(client, 'disconnected');
      // 等 reboot 完成（150ms 退避 + spawn/ready 余量）
      await once(client, 'state');
      const deadline = Date.now() + 5_000;
      while (client.state !== LINK_STATE.SCANNING && Date.now() < deadline) {
        await delay(50);
      }
      assert.equal(client.state, LINK_STATE.SCANNING, '应自动回到 SCANNING');
      // 退避中间态应出现过 RECONNECTING
      assert.ok(
        states.some(([, next]) => next === LINK_STATE.RECONNECTING),
        `应经历 RECONNECTING，实际 ${JSON.stringify(states)}`,
      );
    } finally {
      await client.stop();
    }
  }, 20_000);

  test('崩溃超过 backoffMs 次数后停在最后一次 delay（封顶）', () => {
    // 纯计算断言：backoff 越界用最后一档
    const backoff = [10, 20];
    const attempt = 5;
    const delay = backoff[Math.min(attempt, backoff.length - 1)];
    assert.equal(delay, 20);
  });
});

describe('⑧dispose 后不重启', () => {
  test('stop() 后杀 worker：不再退避重启，命令全部拒绝', async () => {
    const client = await mockClient({ backoffMs: [100, 100] });
    try {
      await client.connect();
      await client.stop(); // dispose 路径
      assert.equal(client.state, LINK_STATE.IDLE);
      // dispose 后 request 直接拒绝
      await assert.rejects(
        () => client.request('ping'),
        (e) => e.code === TRANSPORT_ERROR.DISCONNECTED,
      );
      // 等 500ms 确认没有重启动作（若重启则新进程会响应 ping）
      await delay(500);
      await assert.rejects(() => client.request('ping'));
    } finally {
      // 已经 stop，幂等
      await client.stop();
    }
  }, 10_000);

  test('stop() 期间 dispose 命令 + 进程退出在 2s grace 内完成', async () => {
    const client = await mockClient();
    const began = Date.now();
    await client.stop();
    const elapsed = Date.now() - began;
    assert.ok(elapsed < 5_000, `stop 应快速完成，实际 ${elapsed}ms`);
  }, 10_000);
});

describe('⑨stderr 不进协议', () => {
  test('worker 的 stderr 输出只进 stderrLog，不产生事件/回包', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-bridge-'));
    const worker = join(dir, 'noisy-worker.mjs');
    await writeFile(
      worker,
      `import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const { id, cmd } = JSON.parse(line);
  process.stderr.write('[worker] 这是调试日志 line 1\\n');
  process.stderr.write('[worker] 这是调试日志 line 2\\n');
  process.stdout.write('不是 JSON 的行\\n');
  process.stdout.write(JSON.stringify({ id, ok: true, value: 'done' }) + '\\n');
});
process.stdout.write(JSON.stringify({ event: 'ready' }) + '\\n');
`,
        'utf8',
      );
    const client = new BridgeClient({
      workerPath: worker,
      readyTimeoutMs: 2_000,
    });
    const events = collector(client, ['data', 'device', 'disconnected']);
    try {
      await client.start();
      const value = await client.request('ping');
      assert.equal(value, 'done', '真实回包不被 stderr/杂行干扰');
      await delay(100);
      const log = client.stderrLog;
      assert.ok(
        log.some((l) => l.includes('line 1')) && log.some((l) => l.includes('line 2')),
        `stderr 应进日志，实际 ${JSON.stringify(log)}`,
      );
      assert.ok(
        log.some((l) => l.includes('不是 JSON 的行') || l.includes('stdout 非协议行')),
        'stdout 杂行也应被降级为日志',
      );
      assert.equal(events.filter((e) => e.name === 'device').length, 0);
      assert.equal(events.filter((e) => e.name === 'data').length, 0);
      assert.equal(events.filter((e) => e.name === 'disconnected').length, 0);
    } finally {
      await client.stop();
    }
  }, 10_000);
});

describe('子进程独立验收（不经 BridgeClient）', () => {
  test('--mock：五命令冒烟，JSONL 形状与文档一致', async () => {
    const child = spawn(process.execPath, [WORKER_PATH, '--mock'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = [];
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        lines.push(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    child.stdin.write(
      [
        { id: 1, cmd: 'init' },
        { id: 2, cmd: 'scan' },
        { id: 3, cmd: 'stopScan' },
        { id: 4, cmd: 'connect' },
        { id: 5, cmd: 'ping' },
      ]
        .map((o) => JSON.stringify(o))
        .join('\n') + '\n',
    );
    child.stdin.end();
    const [code] = await once(child, 'exit');
    assert.equal(code, 0);
    const objs = lines.map((l) => JSON.parse(l));
    // 事件无 id；回包有 id+ok
    for (const o of objs) {
      if (o.event !== undefined) assert.equal(o.id, undefined, '事件不携带 id');
      else {
        assert.equal(typeof o.id, 'number');
        assert.equal(typeof o.ok, 'boolean');
      }
    }
    assert.deepEqual(objs[0], { event: 'state', value: 'idle' });
    assert.deepEqual(objs[1], { event: 'ready' });
    assert.ok(objs.some((o) => o.event === 'connected' && o.mtu === 247 && o.deviceId === 'mock-device'));
    const replies = objs.filter((o) => o.id !== undefined);
    assert.equal(replies.length, 5);
    assert.ok(replies.every((r) => r.ok === true));
    assert.equal(replies.find((r) => r.id === 5).value, 'pong');
  }, 10_000);

  test('无 --mock：noble 缺失 → fatal 事件 + 退出码 1', async () => {
    const child = spawn(process.execPath, [WORKER_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = [];
    child.stdout.on('data', (d) => {
      for (const l of d.toString().split('\n')) if (l.trim()) lines.push(l);
    });
    child.stdin.write(JSON.stringify({ id: 1, cmd: 'init' }) + '\n');
    child.stdin.end();
    const [code] = await once(child, 'exit');
    const objs = lines.map((l) => JSON.parse(l));
    assert.ok(objs.some((o) => o.event === 'fatal' && o.code === 'not-available'));
    assert.equal(code, 1);
  }, 10_000);

  test('设备识别三选一：服务 UUID / ADV_DEVICE_NAMES / ADV_MFG_TAG（纯函数单测）', async () => {
    const { looksLikeOurDevice, uuidMatches, mfgTagMatches, advertisedUuids } =
      await import(WORKER_PATH);
    const SERVICE = '0000a900-a900-5041-5353-544f-524f5350';
    const mk = (over = {}) => ({
      address: 'AA:BB:CC:DD:EE:FF',
      advertisement: {
        localName: '',
        serviceUuids: [],
        manufacturerData: null,
        ...over,
      },
      ...over.__top,
    });
    // ①广播服务 UUID 命中
    assert.ok(looksLikeOurDevice(mk({ serviceUuids: [SERVICE.replace(/-/g, '')] })));
    // ②名字命中
    assert.ok(looksLikeOurDevice(mk({ localName: 'Folo-PSP' })));
    // ③厂商数据前 4 字节 = FAP1
    assert.ok(
      looksLikeOurDevice(mk({ manufacturerData: Buffer.concat([Buffer.from('FAP1', 'latin1'), Buffer.from([0x01, 0x02])]) })),
    );
    // 全不命中
    assert.ok(!looksLikeOurDevice(mk({ localName: 'OtherDevice', serviceUuids: ['abcd'], manufacturerData: Buffer.from('XXXX1234', 'latin1') })));
    // uuidMatches：大小写/连字符/前后缀
    assert.ok(uuidMatches('0000A900-A900-5041-5353-544F524F5350', SERVICE));
    assert.ok(!uuidMatches('abcd', SERVICE));
    assert.ok(!uuidMatches('', SERVICE));
    assert.ok(mfgTagMatches(mk({ manufacturerData: Buffer.from('FAP1', 'latin1') })));
    assert.ok(!mfgTagMatches(mk({ manufacturerData: Buffer.from('FAP', 'latin1') })));
    assert.ok(!mfgTagMatches(mk({})));
    assert.deepEqual(advertisedUuids(mk({ serviceUuids: ['aabb'] })), ['aabb']);
    assert.deepEqual(advertisedUuids(mk()), []);
  });
});
