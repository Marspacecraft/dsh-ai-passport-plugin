import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { Reassembler } from '../../src/wire/reassembler.js';
import { encodeFrames, decodeHeader } from '../../src/wire/frame.js';
import {
  CHANNEL_CONTROL,
  CHANNEL_AUDIO,
  CHANNEL_HEARTBEAT,
  FLAG_FIRST,
  FLAG_LAST,
  FLAG_ACK_REQ,
} from '../../src/wire/constants.js';
import { WireError, ERR } from '../../src/wire/errors.js';

/** 造一条消息的全部分片，可选覆盖 flags。 */
function framesOf({ msgId = 1, payload, chunkPayload = 240, channel = CHANNEL_CONTROL, ack = true }) {
  return encodeFrames({ msgId, payload, chunkPayload, channel, ackRequired: ack });
}

/** 手工造一帧，用于畸形用例。 */
function rawFrame({ version = 2, flags = 0, channel = 0, msgId = 1, frag = 0, body = [] }) {
  return new Uint8Array([
    ((version & 0x0f) << 4) | (flags & 0x0f),
    channel,
    (msgId >> 4) & 0xff,
    ((msgId & 0x0f) << 4) | (frag & 0x0f),
    ...body,
  ]);
}

describe('重组：正常路径', () => {
  test('单帧消息立即完成', () => {
    const r = new Reassembler();
    const [f] = framesOf({ payload: new TextEncoder().encode('hello') });
    const out = r.push(f);
    assert.equal(out.kind, 'message');
    assert.equal(new TextDecoder().decode(out.payload), 'hello');
    assert.equal(r.size, 0);
  });

  test('两片消息：先返回 pending，再返回 message', () => {
    const r = new Reassembler();
    const payload = new Uint8Array(300).fill(7);
    const frames = framesOf({ msgId: 100, payload, chunkPayload: 240 });
    assert.equal(frames.length, 2);

    assert.equal(r.push(frames[0]).kind, 'pending');
    const out = r.push(frames[1]);
    assert.equal(out.kind, 'message');
    assert.equal(out.msgId, 100);
    assert.deepEqual([...out.payload], [...payload]);
  });

  test('16 片（上限）完整消息能拼回', () => {
    const r = new Reassembler({ maxMessageBytes: 100_000 });
    const payload = new Uint8Array(240 * 16);
    for (let i = 0; i < payload.length; i += 1) payload[i] = i % 256;
    const frames = framesOf({ msgId: 5, payload, chunkPayload: 240 });
    assert.equal(frames.length, 16);
    let out;
    for (const f of frames) out = r.push(f);
    assert.equal(out.kind, 'message');
    assert.deepEqual([...out.payload], [...payload]);
  });

  test('空载荷单帧产生 1 字节空消息', () => {
    const r = new Reassembler();
    const [f] = framesOf({ msgId: 9, payload: new Uint8Array(0) });
    const out = r.push(f);
    assert.equal(out.kind, 'message');
    assert.equal(out.payload.length, 0);
  });

  test('不同 channel 的同号消息互不干扰', () => {
    const r = new Reassembler();
    // CONTROL:0 与 HEARTBEAT:0 各自独立重组
    const a = rawFrame({ channel: CHANNEL_CONTROL, msgId: 0, frag: 0, flags: FLAG_FIRST, body: [1] });
    const b = rawFrame({ channel: CHANNEL_HEARTBEAT, msgId: 0, frag: 0, flags: FLAG_FIRST, body: [2] });
    assert.equal(r.push(a).kind, 'pending');
    assert.equal(r.push(b).kind, 'pending');
    assert.equal(r.size, 2, '两个 channel 应各自占一条缓冲');

    const a2 = rawFrame({ channel: CHANNEL_CONTROL, msgId: 0, frag: 1, flags: FLAG_LAST, body: [3] });
    const outA = r.push(a2);
    assert.equal(outA.kind, 'message');
    assert.deepEqual([...outA.payload], [1, 3]);
    assert.equal(r.size, 1, 'HEARTBEAT:0 仍在途');
  });

  test('同一 msgId 被不同 channel 复用时按 key 区分（协议 key 设计）', () => {
    const r = new Reassembler();
    r.push(rawFrame({ channel: 0, msgId: 7, frag: 0, flags: FLAG_FIRST, body: [0xaa] }));
    const out = r.push(rawFrame({ channel: 2, msgId: 7, frag: 0, flags: FLAG_FIRST | FLAG_LAST, body: [0xbb] }));
    assert.equal(out.kind, 'message');
    assert.deepEqual([...out.payload], [0xbb]);
  });
});

describe('重组：FIRST 替换残留', () => {
  test('重传的一轮是权威内容：新 FIRST 覆盖旧缓冲', () => {
    const r = new Reassembler();
    r.push(rawFrame({ msgId: 3, frag: 0, flags: FLAG_FIRST, body: [1, 1] }));
    r.push(rawFrame({ msgId: 3, frag: 1, flags: 0, body: [1, 1] }));
    assert.equal(r.size, 1);

    // 发送方重传，第一片重新到达
    r.push(rawFrame({ msgId: 3, frag: 0, flags: FLAG_FIRST, body: [2, 2] }));
    const out = r.push(rawFrame({ msgId: 3, frag: 1, flags: FLAG_LAST, body: [2, 2] }));
    assert.equal(out.kind, 'message');
    assert.deepEqual([...out.payload], [2, 2, 2, 2], '应采用重传轮的内容');
  });
});

describe('重组：gap', () => {
  test('缺片：整条丢弃并报 gap，missing 精确列出', () => {
    const r = new Reassembler();
    r.push(rawFrame({ msgId: 11, frag: 0, flags: FLAG_FIRST, body: [1] }));
    // 直接跳到 frag 3（2、3 之间缺 1、2）
    const out = r.push(rawFrame({ msgId: 11, frag: 3, flags: FLAG_LAST, body: [4] }));
    assert.equal(out.kind, 'gap');
    assert.equal(out.expectedFrag, 1);
    assert.equal(out.gotFrag, 3);
    assert.deepEqual(out.missing, [1, 2]);
    assert.equal(r.size, 0, 'gap 后缓冲应被丢弃');
    assert.equal(r.stats.gaps, 1);
  });

  test('gap 后同一 msgId 的新 FIRST 能重新开始', () => {
    const r = new Reassembler();
    r.push(rawFrame({ msgId: 12, frag: 0, flags: FLAG_FIRST, body: [1] }));
    assert.equal(r.push(rawFrame({ msgId: 12, frag: 5, flags: FLAG_LAST, body: [6] })).kind, 'gap');

    r.push(rawFrame({ msgId: 12, frag: 0, flags: FLAG_FIRST, body: [9] }));
    const out = r.push(rawFrame({ msgId: 12, frag: 1, flags: FLAG_LAST, body: [9] }));
    assert.equal(out.kind, 'message');
    assert.deepEqual([...out.payload], [9, 9]);
  });

  test('漏掉首片（无 FIRST）→ stale，不建缓冲', () => {
    const r = new Reassembler();
    const out = r.push(rawFrame({ msgId: 13, frag: 1, flags: FLAG_LAST, body: [1] }));
    assert.equal(out.kind, 'stale');
    assert.equal(r.size, 0);
    assert.equal(r.stats.stale, 1);
  });

  test('从未见过的 msgId 中间片 → stale', () => {
    const r = new Reassembler();
    assert.equal(r.push(rawFrame({ msgId: 999, frag: 0, flags: 0, body: [1] })).kind, 'stale');
  });
});

describe('重组：重复片与乱序', () => {
  test('重复片被忽略，不影响最终结果', () => {
    const r = new Reassembler();
    const payload = new Uint8Array(500).fill(1); // 3 片
    const frames = framesOf({ msgId: 21, payload, chunkPayload: 240 });
    assert.equal(frames.length, 3);

    r.push(frames[0]);
    r.push(frames[1]);
    assert.equal(r.push(frames[1]).kind, 'pending', '重复的中间片应被忽略');
    assert.equal(r.stats.duplicates, 1);

    const out = r.push(frames[2]);
    assert.equal(out.kind, 'message');
    assert.deepEqual([...out.payload], [...payload]);
  });

  test('重复的 FIRST 按"新的一轮"处理（协议 §2.4：重传轮才是权威内容）', () => {
    const r = new Reassembler();
    const frames = framesOf({ msgId: 23, payload: new Uint8Array(500).fill(1), chunkPayload: 240 });
    r.push(frames[0]);
    r.push(frames[1]);
    // FIRST 再来一次：丢弃残留、重建缓冲，而不是当作重复片
    assert.equal(r.push(frames[0]).kind, 'pending');
    assert.equal(r.stats.duplicates, 0, 'FIRST 不走重复片分支');
    assert.equal(r.push(frames[2]).kind, 'gap', '重建后只剩 frag0，frag2 是缺口');
  });

  test('LAST 先于中间片到达：等中间片补齐后才完成', () => {
    const r = new Reassembler();
    // 手工构造：先 frag0(FIRST)，再 frag2(LAST)，最后 frag1
    const f0 = rawFrame({ msgId: 22, frag: 0, flags: FLAG_FIRST, body: [0] });
    const f2 = rawFrame({ msgId: 22, frag: 2, flags: FLAG_LAST, body: [2] });
    const f1 = rawFrame({ msgId: 22, frag: 1, flags: 0, body: [1] });

    assert.equal(r.push(f0).kind, 'pending');
    // frag2 紧跟 frag0 → 片号不连续，应报 gap
    const gap = r.push(f2);
    assert.equal(gap.kind, 'gap');
  });
});

describe('重组：overflow', () => {
  test('累积字节超上限 → 丢弃整条并报 overflow', () => {
    const r = new Reassembler({ maxMessageBytes: 500 });
    const payload = new Uint8Array(240 * 5); // 1200 字节，5 片，第 3 片就会破 500
    const frames = framesOf({ msgId: 31, payload, chunkPayload: 240 });
    let out;
    for (const f of frames) {
      out = r.push(f);
      if (out.kind === 'overflow') break;
    }
    assert.equal(out.kind, 'overflow');
    assert.ok(out.bytes > 500, `越界字节数应大于 500，实际 ${out.bytes}`);
    assert.equal(r.size, 0, 'overflow 后缓冲应被丢弃');
    assert.equal(r.stats.overflow, 1);
  });

  test('恰好等于上限不触发 overflow', () => {
    const r = new Reassembler({ maxMessageBytes: 480 });
    const payload = new Uint8Array(480);
    const frames = framesOf({ msgId: 32, payload, chunkPayload: 240 });
    let out;
    for (const f of frames) out = r.push(f);
    assert.equal(out.kind, 'message');
    assert.equal(out.payload.length, 480);
  });
});

describe('重组：结构性防护', () => {
  test('AUDIO 通道进入重组器直接抛错（C6 的结构性保证）', () => {
    const r = new Reassembler();
    const f = rawFrame({ channel: CHANNEL_AUDIO, msgId: 1, frag: 0, flags: FLAG_FIRST | FLAG_LAST, body: [1, 2] });
    assert.throws(
      () => r.push(f),
      (e) => e instanceof WireError && e.code === ERR.BAD_PAYLOAD && /AUDIO/.test(e.message),
    );
  });

  test('版本不符的帧被拒绝', () => {
    const r = new Reassembler();
    const f = rawFrame({ version: 1, msgId: 1, frag: 0, flags: FLAG_FIRST | FLAG_LAST });
    assert.throws(
      () => r.push(f),
      (e) => e instanceof WireError && e.code === ERR.PROTO_MISMATCH,
    );
  });

  test('短于帧头的输入被拒', () => {
    const r = new Reassembler();
    assert.throws(() => r.push(new Uint8Array(3)), WireError);
    assert.throws(() => r.push(null), WireError);
  });

  test('maxMessageBytes 非法时拒绝构造', () => {
    for (const bad of [0, -1, NaN]) {
      assert.throws(() => new Reassembler({ maxMessageBytes: bad }), WireError);
    }
  });

  test('push 复制片数据：调用方复用底层缓冲不破坏已收内容', () => {
    const r = new Reassembler();
    const buf = new Uint8Array(5);
    buf.set([1, 1, 1, 1, 1]);
    const f0 = rawFrame({ msgId: 41, frag: 0, flags: FLAG_FIRST, body: [] });
    // 手工把 buf 内容接到帧头后面
    const full0 = new Uint8Array(4 + buf.length);
    full0.set(f0.subarray(0, 4), 0);
    full0.set(buf, 4);
    r.push(full0);

    // 模拟 noble 复用同一块内存
    buf.set([9, 9, 9, 9, 9]);

    const tail = new Uint8Array([7, 7]);
    const full1 = new Uint8Array(4 + tail.length);
    full1.set(rawFrame({ msgId: 41, frag: 1, flags: FLAG_LAST }));
    full1.set(tail, 4);
    const out = r.push(full1);

    assert.equal(out.kind, 'message');
    assert.deepEqual([...out.payload], [1, 1, 1, 1, 1, 7, 7], '首片内容必须是收下时的快照，不能跟着外部缓冲变');
  });
});

describe('重组：清理', () => {
  test('sweep 清掉超时条目，保留新鲜的', () => {
    let t = 1000;
    const r = new Reassembler({ now: () => t });
    r.push(rawFrame({ msgId: 1, frag: 0, flags: FLAG_FIRST, body: [1] }));
    t = 5000;
    r.push(rawFrame({ msgId: 2, frag: 0, flags: FLAG_FIRST, body: [2] }));

    t = 8000;
    const dropped = r.sweep(5000); // 丢掉 lastAt <= 3000 的
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0].msgId, 1);
    assert.equal(r.size, 1, 'msgId 2 还在 5 秒窗口内');
  });

  test('clear 清空全部并返回数量', () => {
    const r = new Reassembler();
    r.push(rawFrame({ msgId: 1, frag: 0, flags: FLAG_FIRST, body: [1] }));
    r.push(rawFrame({ msgId: 2, frag: 0, flags: FLAG_FIRST, body: [1] }));
    assert.equal(r.clear(), 2);
    assert.equal(r.size, 0);
    assert.equal(r.clear(), 0);
  });

  test('snapshot 暴露统计', () => {
    const r = new Reassembler();
    r.push(rawFrame({ msgId: 1, frag: 0, flags: FLAG_FIRST | FLAG_LAST, body: [1] }));
    r.push(rawFrame({ msgId: 2, frag: 1, flags: 0, body: [1] })); // stale
    const s = r.snapshot();
    assert.equal(s.messages, 1);
    assert.equal(s.stale, 1);
    assert.equal(s.pending, 0);
    assert.equal(s.maxChunks, 16);
  });
});

describe('重组：encode→push 端到端', () => {
  test('任意长度载荷经 encodeFrames 后能被 Reassembler 还原', () => {
    for (const len of [0, 1, 239, 240, 241, 480, 1000, 3840]) {
      const payload = new Uint8Array(len);
      for (let i = 0; i < len; i += 1) payload[i] = (i * 31) & 0xff;
      const frames = framesOf({ msgId: 77, payload, chunkPayload: 240 });
      const r = new Reassembler({ maxMessageBytes: 1_000_000 });
      let out;
      for (const f of frames) out = r.push(f);
      assert.equal(out.kind, 'message', `长度 ${len} 应能重组完成`);
      assert.deepEqual([...out.payload], [...payload], `长度 ${len} 内容不一致`);
    }
  });

  test('ACK_REQ 标志不影响重组（重组只看 FIRST/LAST）', () => {
    const payload = new Uint8Array(500).fill(3);
    for (const ack of [true, false]) {
      const frames = framesOf({ msgId: 88, payload, chunkPayload: 240, ack });
      const r = new Reassembler();
      let out;
      for (const f of frames) out = r.push(f);
      assert.equal(out.kind, 'message');
      assert.deepEqual([...out.payload], [...payload]);
    }
  });
});
