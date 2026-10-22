// Copyright (c) 2026 maxiarat1 and contributors
// Adapted under the MIT license; see licenses/linux-nvidia-vsr-MIT.txt.
// One graph per element: browsers do not allow detaching/recreating a
// MediaElementAudioSourceNode. Bypass fades to an undelayed path, rather than
// sweeping a live delay buffer rapidly through unrelated audio samples.
export interface AudioGraph {
  context: AudioContext;
  source: MediaElementAudioSourceNode;
  delay: DelayNode;
  dry: GainNode;
  wet: GainNode;
  video: HTMLVideoElement;
}
async function createBrowserGraph(video: HTMLVideoElement): Promise<AudioGraph> {
  // Check actual origin cleanliness before irreversibly routing audio.
  // A CORS-restricted MediaElementAudioSourceNode would output silence.
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(video, 0, 0, 1, 1);
  ctx.getImageData(0, 0, 1, 1);
  const context = new AudioContext({ latencyHint: 'interactive' });
  try {
    // Automatic rules can run before Web Audio has playback permission.
    // Resume before attaching the irreversible source node to avoid silence.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        context.resume(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Play the video, then enable VSR again.')),
            2000,
          );
        }),
      ]);
      if (context.state !== 'running') throw new Error('Audio needs a playback gesture.');
    } finally {
      clearTimeout(timer);
    }
    const source = context.createMediaElementSource(video);
    const delay = context.createDelay(1);
    const dry = context.createGain(),
      wet = context.createGain();
    wet.gain.value = 0;
    source.connect(dry).connect(context.destination);
    source.connect(delay).connect(wet).connect(context.destination);
    return { context, source, delay, dry, wet, video };
  } catch (error) {
    await context.close();
    throw error;
  }
}
export class VsrAudioSync {
  private graphs: WeakMap<HTMLVideoElement, Promise<AudioGraph>>;
  private graph: AudioGraph | null;
  private samples: number[];
  private latencySamples: number[];
  private latency: number | null;
  private latencySampledAt: number;
  private target = 0;
  private active = false;
  private bypassUntil = 0;
  private sampledAt: number | null = null;
  private adjustedAt = 0;
  private generation = 0;
  private mixes = new WeakMap<AudioGraph, { at: number; from: number; to: number }>();
  constructor(private readonly createGraph = createBrowserGraph) {
    this.graphs = new WeakMap();
    this.graph = null;
    this.samples = [];
    this.latencySamples = [];
    this.latency = null;
    this.latencySampledAt = -Infinity;
  }
  async attach(video: HTMLVideoElement) {
    this.bypass();
    const generation = this.generation;
    let pending = this.graphs.get(video);
    if (!pending) {
      pending = this.createGraph(video);
      this.graphs.set(video, pending);
      pending.catch(() => this.graphs.delete(video));
    }
    const graph = await pending;
    if (generation !== this.generation) return;
    if (this.graph !== graph) {
      this.latencySamples = [];
      this.latency = null;
      this.latencySampledAt = -Infinity;
      this.bypassUntil = 0;
    }
    this.graph = graph;
    this.samples = [];
    this.sampledAt = null;
    await graph.context.resume();
    if (graph.context.state !== 'running') throw new Error('Audio needs a playback gesture.');
  }
  update(mediaAgeMs: number) {
    const g = this.graph;
    if (!g || !Number.isFinite(mediaAgeMs)) return;
    if (
      this.latency === null &&
      !(g.context.outputLatency > 0) &&
      !g.context.getOutputTimestamp?.().contextTime
    )
      return;
    this.samples.push(Math.max(0, Math.min(500, mediaAgeMs)));
    if (this.samples.length > 45) this.samples.shift();
    const sorted = [...this.samples].sort((a, b) => a - b);
    const now = g.context.currentTime;
    this.sampledAt ??= now;
    // Model/decoder startup and a single delayed callback must not retune
    // audible audio. Calibrate with a short window while the dry path plays.
    if (this.samples.length < 12 || now - this.sampledAt < 0.4 || now < this.bypassUntil) return;
    // The media element's clock is at the graph input. Account for the
    // graph/device output latency before adding any further audio delay.
    const target = Math.max(
      0,
      sorted[Math.floor(sorted.length * 0.9)] / 1000 + 0.008 - this.outputLatency(),
    );
    if (!this.active) {
      this.target = target;
      g.delay.delayTime.cancelScheduledValues(now);
      g.delay.delayTime.setValueAtTime(target, now);
      this.mix(true, now);
      this.active = true;
      this.adjustedAt = now;
    } else if (now - this.adjustedAt >= 0.1 && Math.abs(target - this.target) > 0.008) {
      // At most 0.5% clock slew, with an 8 ms deadband. The old 80 ms
      // exponential adjustment could sweep hundreds of ms during startup.
      const duration = Math.min(0.1, now - this.adjustedAt);
      // The preceding <=100 ms ramp has completed before this update. Track
      // its endpoint rather than reading a render-quantum-lagged AudioParam.
      const current = this.target;
      this.target =
        current + Math.max(-duration * 0.005, Math.min(duration * 0.005, target - current));
      g.delay.delayTime.cancelAndHoldAtTime(now);
      g.delay.delayTime.setValueAtTime(current, now);
      g.delay.delayTime.linearRampToValueAtTime(this.target, now + duration);
      this.adjustedAt = now;
    }
  }
  outputLatency(): number {
    const c = this.graph?.context;
    if (!c) return 0;
    // Chromium initially reports zero until the device clock is available.
    // Do not turn that missing estimate into a long, slowly corrected bias.
    if (!(c.outputLatency > 0)) return this.latency ?? c.baseLatency;
    const measured = c.baseLatency + (c.outputLatency || 0),
      now = performance.now();
    if (now - this.latencySampledAt < 10) return this.latency ?? c.baseLatency;
    const elapsed = (now - this.latencySampledAt) / 1000;
    this.latencySampledAt = now;
    if (this.latency === null || Math.abs(measured - this.latency) > 0.08) {
      this.latency = measured;
      this.latencySamples = [];
    }
    this.latencySamples.push(measured);
    if (this.latencySamples.length > 31) this.latencySamples.shift();
    const sorted = [...this.latencySamples].sort((a, b) => a - b),
      target = sorted[Math.floor(sorted.length / 2)];
    // Device estimates can move by an audio block. Follow drift rather than
    // moving video deadlines back and forth with each individual estimate.
    const step = elapsed * 0.005;
    this.latency += Math.max(-step, Math.min(step, target - this.latency));
    return this.latency ?? c.baseLatency;
  }
  audibleTime(video: HTMLVideoElement, mediaTime = video.currentTime) {
    return (
      mediaTime -
      (this.outputLatency() + (this.active ? this.graph?.delay.delayTime.value || 0 : 0)) *
        video.playbackRate
    );
  }
  bypass() {
    this.generation++;
    if (this.graph && this.active) {
      const { context, delay } = this.graph;
      const now = context.currentTime;
      this.mix(false, now);
      // Keep the old read position during the fade; reset only when inaudible.
      delay.delayTime.cancelAndHoldAtTime(now);
      delay.delayTime.setValueAtTime(0, now + 0.02);
      this.bypassUntil = now + 0.02;
    }
    this.active = false;
    this.target = 0;
    this.samples = [];
    this.sampledAt = null;
  }
  private mix(enhanced: boolean, now: number) {
    const g = this.graph!;
    const previous = this.mixes.get(g);
    const progress = previous ? Math.max(0, Math.min(1, (now - previous.at) / 0.02)) : 1;
    const wet = previous ? previous.from + (previous.to - previous.from) * progress : 0;
    this.mixes.set(g, { at: now, from: wet, to: enhanced ? 1 : 0 });
    for (const [param, value] of [
      [g.dry.gain, enhanced ? 0 : 1],
      [g.wet.gain, enhanced ? 1 : 0],
    ] as const) {
      param.cancelAndHoldAtTime(now);
      // Explicit start anchors matter: with no prior event, a bare ramp can
      // start at context time zero and make a supposedly muted delay audible.
      param.setValueAtTime(param === g.wet.gain ? wet : 1 - wet, now);
      param.linearRampToValueAtTime(value, now + 0.02);
    }
  }
  stats() {
    const g = this.graph;
    return g
      ? {
          state: g.context.state,
          mode: this.active ? 'synchronized' : 'bypass',
          delay_ms: this.active ? g.delay.delayTime.value * 1000 : 0,
          target_ms: (this.target || 0) * 1000,
          base_latency_ms: g.context.baseLatency * 1000,
          output_latency_ms: (g.context.outputLatency || 0) * 1000,
          filtered_output_path_ms: this.outputLatency() * 1000,
        }
      : { state: 'unattached', delay_ms: 0 };
  }
}
