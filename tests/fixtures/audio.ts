import { VsrAudioSync, type AudioGraph } from '../../extension/src/audio-sync.ts';

declare global {
  var vsrAudioProbe: (
    legacy?: boolean,
  ) => Promise<{ maximum_step: number; dry_error: number; peak_at: number }>;
}
// Render actual browser AudioParams/DelayNodes offline. No microphone, audio
// device or personal playback is touched. A 200 ms buffer sweep on an 880 Hz
// tone exposes discontinuities that mocked scheduling assertions cannot catch.
globalThis.vsrAudioProbe = async (legacy = false) => {
  const rate = 48000,
    duration = 4;
  const render = new OfflineAudioContext(2, rate * duration, rate);
  const output = render.createChannelMerger(2);
  output.connect(render.destination);
  const source = render.createOscillator(),
    level = render.createGain();
  source.frequency.value = 880;
  level.gain.value = 0.2;
  source.connect(level);
  level.connect(output, 0, 1); // Simultaneous undelayed reference, same oscillator.
  const delay = render.createDelay(1),
    dry = render.createGain(),
    wet = render.createGain();
  wet.gain.value = 0;
  if (legacy) level.connect(delay).connect(output, 0, 0);
  else {
    level.connect(dry).connect(output, 0, 0);
    level.connect(delay).connect(wet).connect(output, 0, 0);
  }
  let time = 0;
  const context = {
    get currentTime() {
      return time;
    },
    state: 'running',
    outputLatency: 0.02,
    baseLatency: 0.01,
    resume: async () => {},
  } as unknown as AudioContext;
  const video = { currentTime: 1, playbackRate: 1 } as HTMLVideoElement;
  const audio = new VsrAudioSync(
    async () => ({ context, source, delay, dry, wet, video }) as unknown as AudioGraph,
  );
  await audio.attach(video);
  // Schedule on a browser audio timeline, including noisy latency, a stale
  // interval with repeated bypass, and a same-element reattachment.
  for (let n = 0; n < duration * 60; n++) {
    time = n / 60;
    if (n === 25) audio.bypass(); // Interrupt the first 20 ms fade mid-transition.
    if (n === 120) await audio.attach(video);
    if ((n >= 90 && n < 120) || n >= 180) audio.bypass();
    else audio.update(200 + (n % 3) * 3);
  }
  source.start();
  source.stop(duration);
  const rendered = await render.startRendering();
  const data = rendered.getChannelData(0),
    reference = rendered.getChannelData(1);
  let maximum_step = 0,
    dry_error = 0,
    peak_at = 0;
  for (let n = 1; n < data.length; n++) {
    const step = Math.abs(data[n] - data[n - 1]);
    if (step > maximum_step) {
      maximum_step = step;
      peak_at = n / rate;
    }
  }
  for (let n = Math.floor(rate * 3.2); n < data.length; n++)
    dry_error = Math.max(dry_error, Math.abs(data[n] - reference[n]));
  return { maximum_step, dry_error, peak_at };
};
