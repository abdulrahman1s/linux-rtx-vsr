import type { TargetResolution } from './protocol.ts';
export interface OutputPlan {
  width: number;
  height: number;
  scale: number;
  bypass: boolean;
}
// Fit inside the selected landscape/portrait bounds, preserving aspect ratio
// within the SDK's eight-pixel alignment. Never upscale beyond the target.
export function planOutput(width: number, height: number, target: TargetResolution): OutputPlan {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 64 || height < 64)
    throw new Error('Video dimensions must be at least 64 × 64');
  const long = Math.round((target * 16) / 9);
  const [maxWidth, maxHeight] = width >= height ? [long, target] : [target, long];
  const scale = Math.min(maxWidth / width, maxHeight / height);
  return {
    width: Math.floor((width * scale) / 8) * 8,
    height: Math.floor((height * scale) / 8) * 8,
    scale,
    bypass: scale <= 1,
  };
}
