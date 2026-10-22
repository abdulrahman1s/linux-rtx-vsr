// Copyright (c) 2026 maxiarat1 and contributors
// Adapted under the MIT license; see licenses/linux-nvidia-vsr-MIT.txt.
// Reconstruct a continuous media-input clock from frame-time observations.
// Reading video.currentTime every display refresh inherits its update jitter.
// Compositor deadlines already include player A/V compensation; using them
// and subtracting Web Audio latency again would delay the picture twice.
export class VsrPresentationClock {
  private phase: number | null = null;
  private samples: number[] = [];
  private rate = 1;
  constructor() {
    this.reset();
  }
  reset() {
    this.phase = null;
    this.samples = [];
    this.rate = 1;
  }
  observe(_metadata: unknown, rate: number, mediaTime: number, now: number) {
    if (!Number.isFinite(mediaTime) || !Number.isFinite(now) || rate <= 0) return;
    if (this.rate !== rate) this.reset();
    this.rate = rate;
    const phase = now - (mediaTime * 1000) / rate;
    if (this.phase === null || Math.abs(phase - this.phase) > 100) {
      this.phase = phase;
      this.samples = [];
    }
    this.samples.push(phase);
    if (this.samples.length > 31) this.samples.shift();
    const sorted = [...this.samples].sort((a, b) => a - b);
    const target = sorted[Math.floor(sorted.length / 2)];
    // Follow long-term source/audio clock drift without moving individual
    // display deadlines back and forth by a refresh interval.
    this.phase =
      this.samples.length < 15
        ? target
        : this.phase + Math.max(-0.25, Math.min(0.25, target - this.phase));
  }
  mediaTime(now: number) {
    return this.phase === null ? null : ((now - this.phase) * this.rate) / 1000;
  }
}
