import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { captureFormat } from '../extension/src/capture-format.ts';

test('native NV12 preserves known Rec.709 transfer and range; other SDR is color-managed to sRGB', () => {
  // TS 5.9's DOM declarations predate Chromium's HDR transfer values.
  const frame = (
    color: Omit<VideoColorSpaceInit, 'transfer'> & { transfer?: string | null },
    format: VideoPixelFormat = 'NV12',
    width = 640,
  ) => ({
    format,
    displayWidth: width,
    displayHeight: 360,
    colorSpace: { toJSON: () => color, ...color } as VideoColorSpace,
  });
  const hd: VideoColorSpaceInit = {
    primaries: 'bt709',
    transfer: 'bt709',
    matrix: 'bt709',
    fullRange: false,
  };
  assert.equal(captureFormat(frame(hd)), 1);
  assert.equal(captureFormat(frame({ ...hd, fullRange: true })), 3);
  assert.equal(captureFormat(frame({ ...hd, matrix: 'smpte170m' })), 2);
  for (const color of [
    { ...hd, transfer: 'iec61966-2-1' as const },
    { ...hd, primaries: 'smpte170m' as const, matrix: 'smpte170m' as const },
    { ...hd, matrix: 'smpte170m' as const, fullRange: true },
    {},
  ])
    assert.equal(captureFormat(frame(color)), 0);
  assert.equal(captureFormat(frame(hd, 'I420')), 0);
  assert.equal(captureFormat(frame(hd, 'RGBA')), 0);
  assert.equal(captureFormat(frame(hd, 'NV12', 641)), 0);
  for (const transfer of ['smpte2084', 'arib-std-b67'] as const)
    assert.throws(() => captureFormat(frame({ ...hd, transfer })), /HDR/);
});
