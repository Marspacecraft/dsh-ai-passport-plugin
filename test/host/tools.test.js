// Task 38 · host/tools.js 的单元测试。
//
// 没有真实宿主：createTools() 只依赖注入的 link/sessions/questions/balance/log，
// 所以这里直接用假对象构造并执行。工具定义必须保持 defineTool 的形状
// （name/description/parameters/output{Schema,render}/execute）。

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { createTools } from '../../src/host/tools.js';
import { MSG } from '../../src/wire/constants.js';

function makeLog() {
  const warnings = [];
  return {
    warnings,
    debug() {},
    info() {},
    warn: (...args) => warnings.push(args),
    error() {},
  };
}

function makeLink({ ready = true, state = 'connected', info = null, send } = {}) {
  const sent = [];
  return {
    ready,
    state,
    info,
    sent,
    async send(type, payload, options) {
      sent.push({ type, payload, options });
      if (send) return send(type, payload, options);
      return 1;
    },
  };
}

function makeOfflineLink() {
  return {
    ready: false,
    state: 'idle',
    info: null,
    sent: [],
    async send() {
      throw new Error('离线时不应发送');
    },
  };
}

function makeSessions(list = []) {
  return { snapshot: () => ({ sessions: list }) };
}

function makeQuestions(result) {
  const calls = [];
  return {
    calls,
    async handle(request) {
      calls.push(request);
      return typeof result === 'function' ? result(request) : result;
    },
  };
}

function byName(tools, name) {
  const found = tools.find((tool) => tool.name === name);
  assert.ok(found, `缺少工具 ${name}`);
  return found;
}

function makeAll(overrides = {}) {
  const log = overrides.log ?? makeLog();
  const link = overrides.link ?? makeLink();
  const sessions = Object.hasOwn(overrides, 'sessions') ? overrides.sessions : makeSessions();
  const questions = Object.hasOwn(overrides, 'questions')
    ? overrides.questions
    : makeQuestions({ answers: [] });
  const balance = Object.hasOwn(overrides, 'balance')
    ? overrides.balance
    : {
        currency: 'CNY',
        totalBalance: '12.34',
        recharge: '10',
        bonus: '2.34',
      };
  const tools = createTools({ link, sessions, questions, balance, log });
  return { tools, link, sessions, questions, balance, log };
}

describe('host/tools · defineTool 形状与注册入口', () => {
  test('恰好导出 4 个工具，名称与顺序稳定', () => {
    const { tools } = makeAll();
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ['passport_status', 'passport_notify', 'passport_ask', 'passport_balance'],
    );
  });

  test('每个工具都有 description/parameters/output{schema,render} 与 execute', () => {
    const { tools } = makeAll();
    for (const tool of tools) {
      assert.equal(typeof tool.description, 'string');
      assert.ok(tool.description.length > 0, `${tool.name} 缺少描述`);
      assert.equal(typeof tool.parameters, 'object');
      assert.equal(tool.output.schema.type, 'object');
      assert.equal(tool.output.schema.additionalProperties, false);
      assert.equal(tool.output.schema.properties.text.required, true);
      assert.equal(typeof tool.output.render, 'function');
      const rendered = tool.output.render({}, { text: `rendered:${tool.name}` });
      assert.deepEqual(rendered, [{ type: 'text', text: `rendered:${tool.name}` }]);
      assert.equal(typeof tool.execute, 'function');
    }
  });

  test('模块不在顶层 import/调用宿主 API，构造时也没有全局注册副作用', () => {
    const source = readFileSync(new URL('../../src/host/tools.js', import.meta.url), 'utf8');
    const imports = source
      .split('\n')
      .filter((line) => /^\s*import\b/.test(line))
      .join('\n');
    assert.equal(/@deepseek-ai|dsh-tools/.test(imports), false);
    assert.deepEqual(imports.trim().split('\n'), [
      "import { MSG } from '../wire/constants.js';",
    ]);

    const first = makeAll().tools;
    const second = makeAll().tools;
    assert.notEqual(first, second);
    assert.equal(first.length, 4);
  });
});

describe('host/tools · passport_status', () => {
  test('在线：返回设备信息、链路状态与会话数', async () => {
    const link = makeLink({
      info: { name: '护照', firmware: '2.0.0', deviceId: 'dev-42' },
    });
    const sessions = makeSessions([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    const { tools } = makeAll({ link, sessions });

    const value = await byName(tools, 'passport_status').execute({}, {});

    assert.equal(value.connected, true);
    assert.equal(value.state, 'connected');
    assert.equal(value.sessionCount, 3);
    assert.equal(value.deviceName, '护照');
    assert.equal(value.firmware, '2.0.0');
    assert.equal(value.deviceId, 'dev-42');
    assert.equal(value.text, '设备已连接：护照，固件 2.0.0，ID dev-42，3 个会话');
  });

  test('离线：不抛错，回一句可读文案', async () => {
    const { tools } = makeAll({ link: makeOfflineLink(), sessions: makeSessions([{ id: 'a' }]) });

    const value = await byName(tools, 'passport_status').execute({}, {});

    assert.equal(value.connected, false);
    assert.equal(value.sessionCount, 0);
    assert.equal(value.text, '设备未连接（idle），暂时无法获取链路状态');
  });

  test('在线但没有 sessions 依赖：会话数为 0，不抛错', async () => {
    const { tools } = makeAll({ sessions: undefined });

    const value = await byName(tools, 'passport_status').execute();

    assert.equal(value.connected, true);
    assert.equal(value.sessionCount, 0);
    assert.equal(value.text, '设备已连接：未知设备，0 个会话');
  });
});

describe('host/tools · passport_notify', () => {
  test('在线：发 notice，ack=true，带上 urgent/sound', async () => {
    const link = makeLink();
    const { tools } = makeAll({ link });

    const value = await byName(tools, 'passport_notify').execute({
      text: '该休息了',
      urgent: true,
      sound: false,
    });

    assert.equal(value.delivered, true);
    assert.equal(value.text, '已让设备提示：该休息了');
    assert.equal(link.sent.length, 1);
    assert.deepEqual(link.sent[0], {
      type: MSG.NOTICE,
      payload: { text: '该休息了', urgent: true, sound: false },
      options: { ack: true },
    });
  });

  test('离线：不发送、不抛错', async () => {
    const link = makeOfflineLink();
    const { tools } = makeAll({ link });

    const value = await byName(tools, 'passport_notify').execute({ text: '你好' });

    assert.equal(value.delivered, false);
    assert.equal(value.text, '设备未连接（idle），未发送提示');
    assert.equal(link.sent.length, 0);
  });

  test('发送失败：吞掉异常，回可读文案并 warn 一次', async () => {
    const log = makeLog();
    const link = makeLink({
      send() {
        throw new Error('链路忙');
      },
    });
    const { tools } = makeAll({ link, log });

    const value = await byName(tools, 'passport_notify').execute({ text: '你好' });

    assert.equal(value.delivered, false);
    assert.equal(value.text, '提示发送失败：链路忙');
    assert.equal(log.warnings.length, 1);
    assert.match(String(log.warnings[0][0]), /passport_notify 发送失败/);
  });

  test('空文本：不发消息', async () => {
    const link = makeLink();
    const { tools } = makeAll({ link });

    const value = await byName(tools, 'passport_notify').execute({ text: '   ' });

    assert.equal(value.delivered, false);
    assert.equal(value.text, '提示内容不能为空');
    assert.equal(link.sent.length, 0);
  });
});

describe('host/tools · passport_ask', () => {
  test('在线：把问题/选项/有限超时交给 Questions.handle，并格式化回答', async () => {
    const questions = makeQuestions({
      answers: [{ id: 'q1', selected: ['A', 'B'], custom: null }],
    });
    const { tools } = makeAll({ questions });

    const value = await byName(tools, 'passport_ask').execute({
      question: '选哪个？',
      options: ['A', 'B'],
    });

    assert.equal(questions.calls.length, 1);
    const request = questions.calls[0];
    assert.equal(request.kind, 'choice');
    assert.equal(request.deadlineMs, 120_000);
    assert.match(request.callId, /^passport_ask_\d+$/);
    assert.deepEqual(request.questions, [
      { id: 'q1', question: '选哪个？', options: [{ label: 'A' }, { label: 'B' }] },
    ]);
    assert.equal(value.answered, true);
    assert.equal(value.text, '用户回答：q1：A、B');
    assert.deepEqual(value.answers, [{ id: 'q1', selected: ['A', 'B'], custom: null }]);
  });

  test('自定义回答：selected 为空时用 custom', async () => {
    const questions = makeQuestions({
      answers: [{ id: 'q1', selected: [], custom: '第三个方案' }],
    });
    const { tools } = makeAll({ questions });

    const value = await byName(tools, 'passport_ask').execute({ question: '怎么办？' });

    assert.equal(value.answered, true);
    assert.equal(value.text, '用户回答：q1：第三个方案');
  });

  test('调用方传 timeoutMs 时原样使用；0 回落默认值，不会无限等待', async () => {
    const questions = makeQuestions((request) => {
      if (request.deadlineMs === 0) return new Promise(() => {});
      return new Promise((resolve) => {
        setTimeout(() => resolve({ cancelled: true, reason: 'timeout' }), 5);
      });
    });
    const { tools } = makeAll({ questions });
    const ask = byName(tools, 'passport_ask');

    const explicit = await Promise.race([
      ask.execute({ question: '？', timeoutMs: 5000 }),
      new Promise((resolve) => setTimeout(() => resolve('HANG'), 200)),
    ]);
    assert.notEqual(explicit, 'HANG');
    assert.equal(questions.calls[0].deadlineMs, 5000);
    assert.equal(explicit.timedOut, true);
    assert.equal(explicit.text, '设备提问超时（5 秒），未收到回答');

    const zero = await Promise.race([
      ask.execute({ question: '？', timeoutMs: 0 }),
      new Promise((resolve) => setTimeout(() => resolve('HANG'), 200)),
    ]);
    assert.notEqual(zero, 'HANG');
    assert.equal(questions.calls[1].deadlineMs, 120_000);
    assert.equal(zero.timedOut, true);
  });

  test('超时结论明确：timedOut=true，文案含秒数', async () => {
    const questions = makeQuestions({ cancelled: true, reason: 'timeout' });
    const { tools } = makeAll({ questions });

    const value = await byName(tools, 'passport_ask').execute({
      question: '继续吗？',
      timeoutMs: 3000,
    });

    assert.equal(value.answered, false);
    assert.equal(value.timedOut, true);
    assert.equal(value.cancelled, true);
    assert.equal(value.reason, 'timeout');
    assert.equal(value.text, '设备提问超时（3 秒），未收到回答');
  });

  test('断链结论明确：disconnected=true', async () => {
    const questions = makeQuestions({ cancelled: true, reason: 'disconnect' });
    const { tools } = makeAll({ questions });

    const value = await byName(tools, 'passport_ask').execute({ question: '继续吗？' });

    assert.equal(value.answered, false);
    assert.equal(value.disconnected, true);
    assert.equal(value.text, '设备已断开，提问未完成');
  });

  test('用户取消结论明确', async () => {
    const questions = makeQuestions({ cancelled: true, reason: 'cancel' });
    const { tools } = makeAll({ questions });

    const value = await byName(tools, 'passport_ask').execute({ question: '继续吗？' });

    assert.equal(value.answered, false);
    assert.equal(value.cancelled, true);
    assert.equal(value.text, '用户取消了提问');
  });

  test('离线：直接返回可读文案，不调用 Questions.handle', async () => {
    const questions = makeQuestions(() => {
      throw new Error('不应调用');
    });
    const { tools } = makeAll({ link: makeOfflineLink(), questions });

    const value = await byName(tools, 'passport_ask').execute({ question: '继续吗？' });

    assert.equal(value.answered, false);
    assert.equal(value.text, '设备未连接（idle），无法向设备提问');
    assert.equal(questions.calls.length, 0);
  });

  test('空问题与缺少提问服务：都不调用 handle、不抛错', async () => {
    const questions = makeQuestions({ answers: [] });
    const withService = makeAll({ questions });
    const empty = await byName(withService.tools, 'passport_ask').execute({ question: '   ' });
    assert.equal(empty.answered, false);
    assert.equal(empty.text, '问题内容不能为空');
    assert.equal(questions.calls.length, 0);

    const withoutService = makeAll({ questions: undefined });
    const missing = await byName(withoutService.tools, 'passport_ask').execute({ question: '？' });
    assert.equal(missing.answered, false);
    assert.equal(missing.text, '提问服务不可用，无法向设备提问');
  });

  test('Questions.handle 抛错：吞掉异常并回可读文案，warn 一次', async () => {
    const log = makeLog();
    const questions = makeQuestions(() => {
      throw new Error('宿主忙');
    });
    const { tools } = makeAll({ questions, log });

    const value = await byName(tools, 'passport_ask').execute({ question: '？' });

    assert.equal(value.answered, false);
    assert.equal(value.text, '提问失败：宿主忙');
    assert.equal(log.warnings.length, 1);
    assert.match(String(log.warnings[0][0]), /passport_ask 提问失败/);
  });
});

describe('host/tools · passport_balance', () => {
  test('成功：对象 provider 的三个金额字段原样返回', async () => {
    const { tools } = makeAll({
      balance: { currency: 'USD', totalBalance: 42.5, recharge: '40', bonus: 2.5 },
    });

    const value = await byName(tools, 'passport_balance').execute();

    assert.equal(value.ok, true);
    assert.equal(value.currency, 'USD');
    assert.equal(value.totalBalance, '42.5');
    assert.equal(value.recharge, '40');
    assert.equal(value.bonus, '2.5');
    assert.equal(value.text, '余额 USD 42.5（充值 40，赠送 2.5）');
    assert.equal(Object.hasOwn(value, 'notice'), false);
  });

  test('成功：函数 provider 也支持，缺省货币为 CNY', async () => {
    const { tools } = makeAll({
      balance: async () => ({ totalBalance: '7', recharge: '5', bonus: '2' }),
    });

    const value = await byName(tools, 'passport_balance').execute();

    assert.equal(value.ok, true);
    assert.equal(value.currency, 'CNY');
    assert.equal(value.text, '余额 CNY 7（充值 5，赠送 2）');
  });

  test('provider 抛错：notice 语义，不伪造 0', async () => {
    const log = makeLog();
    const { tools } = makeAll({
      log,
      balance: async () => {
        throw new Error('网络不通');
      },
    });

    const value = await byName(tools, 'passport_balance').execute();

    assert.equal(value.ok, false);
    assert.equal(value.text, '未获取到余额：网络不通');
    assert.deepEqual(value.notice, { text: '未获取到余额：网络不通' });
    assert.equal(Object.hasOwn(value, 'totalBalance'), false);
    assert.equal(JSON.stringify(value).includes('"0"'), false);
    assert.equal(log.warnings.length, 1);
  });

  test('字段不完整：notice，不补 0', async () => {
    const { tools } = makeAll({
      balance: { totalBalance: '9', recharge: '9' },
    });

    const value = await byName(tools, 'passport_balance').execute();

    assert.equal(value.ok, false);
    assert.equal(value.text, '未获取到余额：余额字段不完整');
    assert.equal(Object.hasOwn(value, 'bonus'), false);
    assert.equal(Object.hasOwn(value, 'totalBalance'), false);
  });

  test('未配置 provider：notice 文案明确', async () => {
    const { tools } = makeAll({ balance: undefined });

    const value = await byName(tools, 'passport_balance').execute();

    assert.equal(value.ok, false);
    assert.equal(value.text, '未配置余额服务，无法查询余额');
    assert.deepEqual(value.notice, { text: '未配置余额服务，无法查询余额' });
  });
});

describe('host/tools · 离线兜底（四个工具）', () => {
  test('链路未连接时四个工具都不抛错，且都回非空文案', async () => {
    const link = makeOfflineLink();
    const questions = makeQuestions(() => {
      throw new Error('离线时不应提问');
    });
    const { tools } = makeAll({
      link,
      questions,
      sessions: makeSessions(),
      balance: { totalBalance: '1', recharge: '1', bonus: '0' },
    });

    const results = [];
    for (const tool of tools) {
      const args = tool.name === 'passport_notify'
        ? { text: '离线' }
        : tool.name === 'passport_ask'
          ? { question: '离线？' }
          : {};
      results.push(await tool.execute(args, {}));
    }

    assert.equal(results.length, 4);
    assert.equal(results[0].text, '设备未连接（idle），暂时无法获取链路状态');
    assert.equal(results[1].text, '设备未连接（idle），未发送提示');
    assert.equal(results[2].text, '设备未连接（idle），无法向设备提问');
    // 余额是宿主侧能力：设备离线也能读到余额（验收只要求不抛错、有文案）。
    assert.equal(results[3].ok, true);
    assert.equal(results[3].text, '余额 CNY 1（充值 1，赠送 0）');
  });
});
