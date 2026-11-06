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
  // Matches the native alignment: 854 × (3840 / 854) is 3839.999…, not 3832.
  const align = (n: number) => Math.floor((n * scale) / 8 + 1e-6) * 8;
  return {
    width: align(width),
    height: align(height),
    scale,
    bypass: scale <= 1,
  };
}
