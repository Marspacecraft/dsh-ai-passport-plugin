import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { MsgIdAllocator } from '../../src/wire/msgid.js';
import { MSGID_SPACE } from '../../src/wire/constants.js';
import { WireError, ERR } from '../../src/wire/errors.js';

describe('消息号分配', () => {
  test('初始状态：0 占用、全部可用', () => {
    const a = new MsgIdAllocator();
    assert.equal(a.size, 0);
    assert.equal(a.available, MSGID_SPACE);
    assert.deepEqual(a.snapshot(), { space: 4096, inUse: 0, available: 4096, cursor: 0 });
  });

  test('连续分配得到连续号（便于抓包对照）', () => {
    const a = new MsgIdAllocator();
    assert.equal(a.allocate(), 0);
    assert.equal(a.allocate(), 1);
    assert.equal(a.allocate(), 2);
    assert.equal(a.size, 3);
  });

  test('释放后号可被再次分配', () => {
    const a = new MsgIdAllocator();
    const id0 = a.allocate();
    a.allocate();
    assert.equal(a.release(id0), true);
    assert.equal(a.available, MSGID_SPACE - 1);
    // 环形分配：cursor 已到 2，必须先把 2..4095 分完，环回后才能拿到刚释放的 0
    const got = [];
    for (let i = 0; i < MSGID_SPACE - 1; i += 1) got.push(a.allocate());
    assert.equal(got.length, MSGID_SPACE - 1);
    assert.equal(got.at(-1), id0, `环回后最后拿到的应是释放的 ${id0}，实际 ${got.at(-1)}`);
  });

  test('跳过在途号', () => {
    const a = new MsgIdAllocator({ space: 8 });
    const ids = [];
    for (let i = 0; i < 8; i += 1) ids.push(a.allocate());
    assert.deepEqual(ids, [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.throws(() => a.allocate(), WireError);

    a.release(3);
    assert.equal(a.allocate(), 3, '空出的号应被重新拿到');
  });

  test('环形回绕：cursor 到达 space 后回到 0', () => {
    const a = new MsgIdAllocator({ space: 4 });
    assert.deepEqual([a.allocate(), a.allocate(), a.allocate(), a.allocate()], [0, 1, 2, 3]);
    assert.equal(a.snapshot().cursor, 0, '分满后 cursor 应回绕到 0');
    a.release(0);
    assert.equal(a.allocate(), 0);
  });

  test('耗尽时抛 MSGID_EXHAUSTED 且消息可读', () => {
    const a = new MsgIdAllocator({ space: 4 });
    for (let i = 0; i < 4; i += 1) a.allocate();
    assert.throws(
      () => a.allocate(),
      (e) => {
        assert.ok(e instanceof WireError);
        assert.equal(e.code, ERR.MSGID_EXHAUSTED);
        assert.match(e.message, /消息号耗尽/);
        assert.equal(e.detail.space, 4);
        return true;
      },
    );
  });

  test('真机规模：4096 个号能全部分配出去再全部收回', () => {
    const a = new MsgIdAllocator();
    const ids = new Set();
    for (let i = 0; i < MSGID_SPACE; i += 1) ids.add(a.allocate());
    assert.equal(ids.size, MSGID_SPACE, '分配的号应互不重复');
    assert.equal(a.available, 0);
    assert.throws(() => a.allocate(), (e) => e.code === ERR.MSGID_EXHAUSTED);

    a.releaseAll();
    assert.equal(a.size, 0);
    assert.equal(a.available, MSGID_SPACE);
    assert.equal(typeof a.allocate(), 'number', '清空后应能继续分配');
  });

  test('release 幂等：重复释放不抛错（ACK 与超时放弃会并发调用）', () => {
    const a = new MsgIdAllocator();
    const id = a.allocate();
    assert.equal(a.release(id), true);
    assert.equal(a.release(id), false, '第二次释放应返回 false 而非抛错');
    assert.equal(a.release(9999), false, '释放从未分配的号也不抛错');
  });

  test('releaseAll 返回实际释放的数量', () => {
    const a = new MsgIdAllocator();
    a.allocate();
    a.allocate();
    a.allocate();
    assert.equal(a.releaseAll(), 3, '应返回被清掉的号数量');
    assert.equal(a.releaseAll(), 0, '空表清空返回 0');
  });

  test('has() 反映在途状态', () => {
    const a = new MsgIdAllocator();
    const id = a.allocate();
    assert.equal(a.has(id), true);
    a.release(id);
    assert.equal(a.has(id), false);
  });

  test('分配的号恒在 [0, space) 内', () => {
    const a = new MsgIdAllocator({ space: 100 });
    for (let i = 0; i < 100; i += 1) {
      const id = a.allocate();
      assert.ok(Number.isInteger(id) && id >= 0 && id < 100, `越界号：${id}`);
    }
  });

  test('space 参数非法时拒绝构造', () => {
    for (const bad of [0, -1, 1.5, MSGID_SPACE + 1, NaN]) {
      assert.throws(() => new MsgIdAllocator({ space: bad }), WireError, `space=${bad} 应被拒绝`);
    }
  });

  test('小空间下反复分配/释放 10000 次不漏号（号段泄漏回归，T9）', () => {
    const a = new MsgIdAllocator({ space: 16 });
    for (let i = 0; i < 10000; i += 1) {
      const id = a.allocate();
      a.release(id);
    }
    assert.equal(a.size, 0, '反复分配释放后不应残留占用');
    assert.equal(a.available, 16);
  });

  test('交错分配释放：始终只占住真正在途的号', () => {
    const a = new MsgIdAllocator({ space: 6 });
    const live = [];
    for (let round = 0; round < 200; round += 1) {
      while (live.length < 3) live.push(a.allocate());
      const victim = live.shift();
      a.release(victim);
      assert.equal(a.size, live.length, `第 ${round} 轮占用数应与在途列表一致`);
    }
    // 每轮先补到 3 再弹出 1 个，稳定态就是 2 个在途
    assert.equal(a.size, live.length);
    assert.equal(a.size, 2);
  });
});
