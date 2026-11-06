// Sends evenly spaced source frames at a rate the transport sustains.
// Capturing whenever a slot frees overruns a bandwidth-bound link: frames then
// leave in bursts, arrive in bursts, and the presenter drops every picture
// that becomes due in the same refresh as a newer one, so upload bandwidth is
// spent on frames nobody sees. A steady 1-in-N stride presents each frame it
// sends, at constant latency. A full pipeline at a due frame means the stride
// is too short; a periodic probe recovers the rate when the link frees up.
// 1 in 4 keeps a 24 fps source under the presenter's 200 ms stale limit.
const MAX_STRIDE = 4;
const SETTLE_MS = 1000;
const FIRST_PROBE_MS = 4000;
const MAX_PROBE_MS = 64000;
export class CapturePacer {
  stride = 1;
  missed = 0;
  private last = -Infinity;
  private changedAt = -Infinity;
  private probedAt = -Infinity;
  private probeMs = FIRST_PROBE_MS;
  private started = false;
  // Cold model loading fills the pipeline without saying anything about the
  // link; judge congestion only once results flow.
  start(now: number) {
    if (this.started) return;
    this.started = true;
    this.changedAt = now;
  }
  // frame: the source's presented-frame counter; room: a capture slot is free.
  due(frame: number, room: boolean, now: number): boolean {
    if (frame < this.last) this.last = -Infinity; // Seek or counter reset.
    if (frame - this.last < this.stride) return false;
    // Consume a missed slot so later captures keep their spacing.
    this.last = frame;
    if (!room) {
      this.missed++;
      this.congested(now);
      return false;
    }
    if (this.stride > 1 && now - this.changedAt >= this.probeMs) {
      this.stride--;
      this.changedAt = this.probedAt = now;
    }
    return true;
  }
  private congested(now: number) {
    // The queue built before a change takes a moment to drain.
    if (!this.started || now - this.changedAt < SETTLE_MS) return;
    // Back off exponentially when the last faster probe failed straight away.
    if (now - this.probedAt < this.probeMs) this.probeMs = Math.min(MAX_PROBE_MS, this.probeMs * 2);
    this.stride = Math.min(MAX_STRIDE, this.stride + 1);
    this.changedAt = now;
  }
}
