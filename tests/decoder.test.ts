import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { createPacketDecoder } from '../extension/src/video-decoder.ts';
import type { FrameMetadata } from '../extension/src/protocol.ts';

test('decoder accepts four overlapping packets, bounds the fifth and cancels pending outputs', async () => {
  const originalDecoder = globalThis.VideoDecoder;
  const originalChunk = globalThis.EncodedVideoChunk;
  const chunks: EncodedVideoChunkInit[] = [];
  const configurations: VideoDecoderConfig[] = [];
  let submitted = 0,
    closed = false;
  // Only the platform adapter is replaced; exercise the real packet decoder's
  // negotiation, admission and cancellation through its public interface.
  class Decoder {
    static async isConfigSupported() {
      return { supported: true };
    }
    configure(config: VideoDecoderConfig) {
      configurations.push(config);
    }
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
    color_space: 'srgb',
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
    assert.deepEqual(configurations[0].colorSpace, {
      primaries: 'bt709',
      transfer: 'iec61966-2-1',
      matrix: 'smpte170m',
      fullRange: false,
    });
    assert.deepEqual(
      chunks.map((chunk) => chunk.type),
      ['key', 'delta', 'delta', 'delta'],
    );
    await assert.rejects(decoder.decode(new ArrayBuffer(4), meta), /bounded queue/);
    // A transfer change creates a new prediction chain even if the old
    // decoder still has pending pictures. A delta cannot initialize it.
    await assert.rejects(
      decoder.decode(new ArrayBuffer(4), { ...meta, color_space: 'bt709', keyframe: false }),
      /start with a keyframe/,
    );
    assert.equal(configurations.at(-1)?.colorSpace?.transfer, 'bt709');
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
