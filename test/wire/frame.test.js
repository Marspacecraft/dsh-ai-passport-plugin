import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  encodeHeader,
  decodeHeader,
  encodeFrames,
  frameBody,
  chunkCount,
  chunkPayloadForMtu,
} from '../../src/wire/frame.js';
import {
  PROTOCOL_VERSION,
  FLAG_FIRST,
  FLAG_LAST,
  FLAG_ACK_REQ,
  CHANNEL_CONTROL,
  CHANNEL_AUDIO,
  CHANNEL_HEARTBEAT,
  MAX_CHUNKS,
} from '../../src/wire/constants.js';
import { WireError, ERR } from '../../src/wire/errors.js';

/** 把 Uint8Array 打印成协议文档里的写法，便于失败信息可读。 */
const hex = (bytes) => [...bytes].map((b) => `0x${b.toString(16).toUpperCase().padStart(2, '0')}`).join(' ');

describe('帧头编解码', () => {
  test('协议 §12 示例：session.state 两片，msgId=0x0A5', () => {
    // 文档原文逐字节给定，这里是权威断言
    const f0 = encodeHeader({
      flags: FLAG_FIRST | FLAG_ACK_REQ,
      channel: CHANNEL_CONTROL,
      msgId: 0x0a5,
      frag: 0,
    });
    assert.equal(hex(f0), '0x25 0x00 0x0A 0x50', `帧 0 应为 [0x25][0x00][0x0A][0x50]，实际 ${hex(f0)}`);

    const f1 = encodeHeader({
      flags: FLAG_LAST | FLAG_ACK_REQ,
      channel: CHANNEL_CONTROL,
      msgId: 0x0a5,
      frag: 1,
    });
    assert.equal(hex(f1), '0x26 0x00 0x0A 0x51', `帧 1 应为 [0x26][0x00][0x0A][0x51]，实际 ${hex(f1)}`);
  });

  test('协议 §12 示例：ack 帧 flags=0', () => {
    const ack = encodeHeader({ flags: 0, channel: CHANNEL_CONTROL, msgId: 0x0a5, frag: 0 });
    assert.equal(hex(ack), '0x20 0x00 0x0A 0x50', `ack 应为 [0x20][0x00][0x0A][0x50]，实际 ${hex(ack)}`);
  });

  test('文档 §12 的逐字节推演表逐项成立', () => {
    const decoded = decodeHeader(
      encodeHeader({ flags: FLAG_LAST | FLAG_ACK_REQ, channel: CHANNEL_CONTROL, msgId: 0x0a5, frag: 1 }),
    );
    assert.equal(decoded.version, 2, '第 0 字节高半字节 = version 2');
    assert.equal(decoded.flags, 0x6, '第 0 字节低半字节 = LAST|ACK_REQ = 0x6');
    assert.equal(decoded.channel, 0, '第 1 字节 = channel 0');
    assert.equal(decoded.msgId, 0x0a5, 'msgId 由第 2 字节与第 3 字节高半字节拼成');
    assert.equal(decoded.frag, 1, '第 3 字节低半字节 = frag 1');
  });

  test('encode → decode 往返不丢信息（全 msgId 空间抽样）', () => {
    const samples = [0, 1, 15, 16, 255, 256, 0x0a5, 0x7ff, 0xfff, 4095];
    for (const msgId of samples) {
      for (const frag of [0, 1, 7, 15]) {
        for (const flags of [0, FLAG_FIRST, FLAG_LAST, FLAG_FIRST | FLAG_LAST, FLAG_ACK_REQ | FLAG_FIRST]) {
          for (const channel of [CHANNEL_CONTROL, CHANNEL_AUDIO, CHANNEL_HEARTBEAT, 255]) {
            const head = { flags, channel, msgId, frag };
            assert.deepEqual(decodeHeader(encodeHeader(head)), { ...head, version: PROTOCOL_VERSION });
          }
        }
      }
    }
  });

  test('msgId 边界 0 与 4095 都能往返', () => {
    for (const msgId of [0, 4095]) {
      const d = decodeHeader(encodeHeader({ flags: 0, channel: 0, msgId, frag: 0 }));
      assert.equal(d.msgId, msgId);
    }
  });

  test('msgId 越界被拒，不静默截断', () => {
    for (const bad of [-1, 4096, 5000, 1.5, NaN]) {
      assert.throws(
        () => encodeHeader({ flags: 0, channel: 0, msgId: bad, frag: 0 }),
        (e) => e instanceof WireError && e.code === ERR.BAD_PAYLOAD,
        `msgId=${bad} 应被拒绝`,
      );
    }
  });

  test('flags / frag / channel 越界被拒', () => {
    assert.throws(() => encodeHeader({ flags: 16, channel: 0, msgId: 0, frag: 0 }), WireError);
    assert.throws(() => encodeHeader({ flags: 0, channel: -1, msgId: 0, frag: 0 }), WireError);
    assert.throws(() => encodeHeader({ flags: 0, channel: 256, msgId: 0, frag: 0 }), WireError);
    assert.throws(() => encodeHeader({ flags: 0, channel: 0, msgId: 0, frag: 16 }), WireError);
  });

  test('version 越界被拒（4 位上限）', () => {
    assert.throws(
      () => encodeHeader({ version: 16, flags: 0, channel: 0, msgId: 0, frag: 0 }),
      (e) => e instanceof WireError && e.code === ERR.PROTO_MISMATCH,
    );
  });

  test('decodeHeader 对短于 4 字节的输入抛错而非静默返回垃圾', () => {
    for (const bad of [new Uint8Array(0), new Uint8Array(3), null, undefined, 'abcd']) {
      assert.throws(() => decodeHeader(bad), (e) => e instanceof WireError && e.code === ERR.BAD_PAYLOAD);
    }
  });

  test('decodeHeader 接受恰好 4 字节的完整帧头', () => {
    const d = decodeHeader(new Uint8Array([0x20, 0x00, 0x0a, 0x50]));
    assert.equal(d.version, 2);
    assert.equal(d.msgId, 0x0a5);
  });

  test('decodeHeader 也接受带数据的完整帧（只取前 4 字节）', () => {
    const frame = new Uint8Array([0x25, 0x02, 0x12, 0x34, 0xff, 0xee, 0xdd]);
    const d = decodeHeader(frame);
    assert.equal(d.flags, FLAG_FIRST | FLAG_ACK_REQ);
    assert.equal(d.channel, 2);
    assert.equal(d.msgId, 0x123);
    assert.equal(d.frag, 4);
  });
});

describe('分片', () => {
  test('chunkCount：空载荷也产生 1 片', () => {
    assert.equal(chunkCount(0, 240), 1);
    assert.equal(chunkCount(1, 240), 1);
    assert.equal(chunkCount(240, 240), 1);
    assert.equal(chunkCount(241, 240), 2);
    assert.equal(chunkCount(480, 240), 2);
    assert.equal(chunkCount(481, 240), 3);
  });

  test('encodeFrames：单帧消息同时置 FIRST|LAST', () => {
    const payload = new TextEncoder().encode('hi');
    const frames = encodeFrames({ msgId: 1, payload, chunkPayload: 240 });
    assert.equal(frames.length, 1);
    const head = decodeHeader(frames[0]);
    assert.equal(head.flags, FLAG_FIRST | FLAG_LAST);
    assert.equal(head.frag, 0);
    assert.deepEqual([...frameBody(frames[0])], [...payload]);
  });

  test('encodeFrames：多片时首片 FIRST、末片 LAST，中间片两者皆无', () => {
    const payload = new Uint8Array(240 * 3);
    const frames = encodeFrames({ msgId: 7, payload, chunkPayload: 240 });
    assert.equal(frames.length, 3);
    assert.equal(decodeHeader(frames[0]).flags, FLAG_FIRST);
    assert.equal(decodeHeader(frames[1]).flags, 0);
    assert.equal(decodeHeader(frames[2]).flags, FLAG_LAST);
  });

  test('encodeFrames：ackRequired 时每一片都带 ACK_REQ（协议 §2.5）', () => {
    const payload = new Uint8Array(240 * 2 + 10);
    const frames = encodeFrames({ msgId: 9, payload, chunkPayload: 240, ackRequired: true });
    assert.equal(frames.length, 3);
    for (const [i, f] of frames.entries()) {
      assert.equal(decodeHeader(f).flags & FLAG_ACK_REQ, FLAG_ACK_REQ, `第 ${i} 片缺 ACK_REQ`);
    }
  });

  test('encodeFrames：拼回的数据与原载荷逐字节一致', () => {
    const payload = new Uint8Array(1000);
    for (let i = 0; i < payload.length; i += 1) payload[i] = i % 251;

    const frames = encodeFrames({ msgId: 42, payload, chunkPayload: 240 });
    const merged = new Uint8Array(payload.length);
    let offset = 0;
    for (const f of frames) {
      const body = frameBody(f);
      merged.set(body, offset);
      offset += body.length;
    }
    assert.equal(offset, payload.length);
    assert.deepEqual([...merged], [...payload]);
  });

  test('encodeFrames：总片数超 16 抛 PAYLOAD_TOO_LARGE', () => {
    const payload = new Uint8Array(240 * 16 + 1);
    assert.throws(
      () => encodeFrames({ msgId: 1, payload, chunkPayload: 240 }),
      (e) => e instanceof WireError && e.code === ERR.PAYLOAD_TOO_LARGE,
    );
  });

  test('encodeFrames：恰好 16 片（上限）不抛错', () => {
    const payload = new Uint8Array(240 * MAX_CHUNKS);
    const frames = encodeFrames({ msgId: 1, payload, chunkPayload: 240 });
    assert.equal(frames.length, MAX_CHUNKS);
  });

  test('encodeFrames：空载荷产生 1 个仅含帧头的帧', () => {
    const frames = encodeFrames({ msgId: 3, payload: new Uint8Array(0), chunkPayload: 240 });
    assert.equal(frames.length, 1);
    assert.equal(frames[0].length, 4);
    assert.equal(frameBody(frames[0]).length, 0);
  });

  test('encodeFrames：payload 不是 Uint8Array 时拒绝', () => {
    for (const bad of ['str', [1, 2, 3], null, { length: 3 }]) {
      assert.throws(
        () => encodeFrames({ msgId: 1, payload: bad, chunkPayload: 240 }),
        (e) => e instanceof WireError && e.code === ERR.BAD_PAYLOAD,
      );
    }
  });

  test('frameBody 返回视图而非副本（文档化的契约）', () => {
    const frame = new Uint8Array([0x20, 0x00, 0x00, 0x00, 1, 2, 3]);
    const body = frameBody(frame);
    body[0] = 99;
    assert.equal(frame[4], 99, 'frameBody 应返回共享底层缓冲的视图');
  });

  test('frameBody 对短帧抛错', () => {
    assert.throws(() => frameBody(new Uint8Array(3)), WireError);
  });
});

describe('MTU → chunkPayload（协议 §1.4 四档表）', () => {
  test('文档四档实测值', () => {
    assert.equal(chunkPayloadForMtu(517), 510, 'MTU 517 → 510');
    assert.equal(chunkPayloadForMtu(247), 240, 'MTU 247 → 240（兜底档）');
    assert.equal(chunkPayloadForMtu(244), 237, 'MTU 244 → 237');
    assert.equal(chunkPayloadForMtu(23), 16, 'MTU 23 → 16（BLE 最小值）');
  });

  test('低于 BLE 最小 MTU 时夹到 16，不产生 0 或负数', () => {
    for (const mtu of [0, 1, 10, 22]) {
      assert.equal(chunkPayloadForMtu(mtu), 16, `MTU ${mtu} 应夹到 16`);
    }
  });

  test('MTU 越大片载荷越大（单调不减）', () => {
    let prev = 0;
    for (let mtu = 0; mtu <= 600; mtu += 1) {
      const cur = chunkPayloadForMtu(mtu);
      assert.ok(cur >= prev, `MTU ${mtu} 处出现回退：${prev} → ${cur}`);
      prev = cur;
    }
  });

  test('MTU 非法输入抛错', () => {
    for (const bad of [-1, 1.5, NaN, '247']) {
      assert.throws(() => chunkPayloadForMtu(bad), WireError);
    }
  });

  test('16 片 × 兜底档片载荷 = 3840，与协议声明的 maxMessageBytes 一致', () => {
    assert.equal(MAX_CHUNKS * chunkPayloadForMtu(247), 3840);
  });
});
