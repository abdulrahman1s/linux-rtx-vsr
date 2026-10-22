// copyTo(RGBA, srgb) changes both primaries and transfer, whereas a native
// NV12 copy preserves them. NvCVImage only applies the YUV matrix/range; it
// does not perform a transfer-function or primary conversion.
export function captureFormat(
  frame: Pick<VideoFrame, 'format' | 'displayWidth' | 'displayHeight' | 'colorSpace'>,
) {
  const color = frame.colorSpace;
  if (['smpte2084', 'arib-std-b67', 'pq', 'hlg'].includes(color?.transfer || ''))
    throw new Error('HDR video is unsupported; use SDR playback');
  const native =
    frame.format === 'NV12' &&
    frame.displayWidth % 2 === 0 &&
    frame.displayHeight % 2 === 0 &&
    color?.primaries === 'bt709' &&
    color.transfer === 'bt709';
  if (native && color.matrix === 'bt709') return color.fullRange ? 3 : 1;
  if (native && !color.fullRange && ['smpte170m', 'bt470bg'].includes(color.matrix || '')) return 2;
  // Let Chromium color-manage other readable SDR sources to sRGB. Never
  // reinterpret wide-gamut/SD primaries or sRGB transfer as Rec.709.
  return 0;
}
