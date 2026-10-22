import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { createPacketDecoder } from '../extension/src/video-decoder.ts';
import type { FrameMetadata } from '../extension/src/protocol.ts';

test('decoder accepts four overlapping packets, bounds the fifth and cancels pending outputs', async () => {
  const originalDecoder = globalThis.VideoDecoder;
  const originalChunk = globalThis.EncodedVideoChunk;
  const chunks: EncodedVideoChunkInit[] = [];
  let submitted = 0,
    closed = false;
  // Only the platform adapter is replaced; exercise the real packet decoder's
  // negotiation, admission and cancellation through its public interface.
  class Decoder {
    static async isConfigSupported() {
      return { supported: true };
    }
    configure() {}
    decode() {
      submitted++;
    }
    close() {
      closed = true;
    }
  }
  globalThis.VideoDecoder = Decoder as unknown as typeof VideoDecoder;
  globalThis.EncodedVideoChunk = class {
    constructor(init: EncodedVideoChunkInit) {
      chunks.push(init);
    }
  } as unknown as typeof EncodedVideoChunk;
  const decoder = createPacketDecoder();
  const meta: FrameMetadata = {
    type: 'frame',
    format: 'av1',
    codec: 'av01.0.13M.08',
    keyframe: true,
    sequence: 1,
    epoch: 1,
    timestamp: 0,
    source_width: 1920,
    source_height: 1080,
    width: 3840,
    height: 2160,
    service_ms: 5,
    inference_ms: 2,
  };
  try {
    await assert.rejects(
      decoder.decode(new ArrayBuffer(4), { ...meta, keyframe: false }),
      /start with a keyframe/,
    );
    const pending = Array.from({ length: 4 }, (_, index) =>
      decoder.decode(new ArrayBuffer(4), { ...meta, keyframe: index === 0 }),
    );
    const results = Promise.allSettled(pending);
    await Bun.sleep(0);
    assert.equal(submitted, 4);
    assert.deepEqual(
      chunks.map((chunk) => chunk.type),
      ['key', 'delta', 'delta', 'delta'],
    );
    await assert.rejects(decoder.decode(new ArrayBuffer(4), meta), /bounded queue/);
    // A resolution change creates a new prediction chain even if the old
    // decoder still has pending pictures. A delta cannot initialize it.
    await assert.rejects(
      decoder.decode(new ArrayBuffer(4), { ...meta, width: 1920, height: 1080, keyframe: false }),
      /start with a keyframe/,
    );
    decoder.close();
    assert.equal(closed, true);
    assert.ok((await results).every((result) => result.status === 'rejected'));
  } finally {
    decoder.close();
    globalThis.VideoDecoder = originalDecoder;
    globalThis.EncodedVideoChunk = originalChunk;
  }
});
