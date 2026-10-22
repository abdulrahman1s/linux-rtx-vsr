// Overlap capture/transport/processing without allowing a slow engine to build
// an unbounded raw-frame queue. One large supported frame always fits.
export const MAX_IN_FLIGHT = 4;
export function captureCapacity(bytes: number): number {
  return Math.max(1, Math.min(MAX_IN_FLIGHT, Math.floor((32 * 1024 * 1024) / bytes)));
}
