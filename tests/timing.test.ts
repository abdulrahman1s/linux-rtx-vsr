import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { VsrPresentationClock } from '../extension/src/presentation-clock.ts';
import { VsrAudioSync, type AudioGraph } from '../extension/src/audio-sync.ts';
test('presentation clock follows media input, resets rate and seek discontinuities', () => {
  const clock = new VsrPresentationClock();
  clock.observe({ expectedDisplayTime: 9000 }, 1, 1, 1000);
  assert.equal(clock.mediaTime(1050), 1.05);
  clock.observe({}, 2, 2, 1500);
  assert.equal(clock.mediaTime(1600), 2.2);
  clock.observe({}, 1, 100, 2000);
  assert.equal(clock.mediaTime(2050), 100.05);
  clock.reset();
  assert.equal(clock.mediaTime(3000), null);
});
test('audio bypass restores zero delay and graph creation is reused', async () => {
  const calls: number[][] = [];
  let created = 0;
  const video = { currentTime: 1, playbackRate: 1 } as HTMLVideoElement;
  // Hardware adapter: only the Web Audio methods exercised by this test exist.
  const graph = {
    context: {
      state: 'running',
      currentTime: 1,
      outputLatency: 0,
      baseLatency: 0.01,
      resume: async () => {},
    },
    delay: {
      delayTime: {
        value: 0.1,
        cancelScheduledValues: (t: number) => calls.push([t]),
        setTargetAtTime: (...args: number[]) => calls.push(args),
      },
    },
    video,
  } as unknown as AudioGraph;
  const audio = new VsrAudioSync(async () => {
    created++;
    return graph;
  });
  await audio.attach(video);
  audio.update(100);
  assert.equal(audio.stats().target_ms, 0, 'Unknown latency must not add audio delay');
  assert.equal(audio.outputLatency(), 0.01);
  audio.bypass();
  assert.equal(calls.length, 0, 'An already bypassed graph must not restart automation');
  await audio.attach(video);
  assert.equal(created, 1);
});

test('audio calibrates inaudibly, bounds clock slew and fades to dry before resetting delay', async () => {
  let time = 0;
  const calls: { node: string; method: string; value: number; at: number }[] = [];
  function parameter(node: string, value: number) {
    return {
      value,
      cancelScheduledValues(at: number) {
        calls.push({ node, method: 'cancel', value: this.value, at });
      },
      cancelAndHoldAtTime(at: number) {
        calls.push({ node, method: 'hold', value: this.value, at });
      },
      setValueAtTime(value: number, at: number) {
        this.value = value;
        calls.push({ node, method: 'set', value, at });
      },
      linearRampToValueAtTime(value: number, at: number) {
        this.value = value;
        calls.push({ node, method: 'ramp', value, at });
      },
    };
  }
  const graph = {
    context: {
      get currentTime() {
        return time;
      },
      state: 'running',
      outputLatency: 0.02,
      baseLatency: 0.01,
      resume: async () => {},
    },
    delay: { delayTime: parameter('delay', 0) },
    dry: { gain: parameter('dry', 1) },
    wet: { gain: parameter('wet', 0) },
  } as unknown as AudioGraph;
  const audio = new VsrAudioSync(async () => graph);
  await audio.attach({ currentTime: 1, playbackRate: 1 } as HTMLVideoElement);
  for (let n = 0; n < 24; n++) {
    time = n / 60;
    audio.update(100);
  }
  assert.equal(calls.length, 0, 'Startup samples must not modulate live audio');
  time = 0.5;
  audio.update(100);
  assert.equal(audio.stats().mode, 'synchronized');
  assert.ok(Math.abs(graph.delay.delayTime.value - 0.078) < 1e-6);
  const calibrated = calls.length;
  audio.pause();
  assert.equal(
    calls.length,
    calibrated,
    'Pause must hold the calibrated gain/delay without automation',
  );
  assert.equal(audio.stats().mode, 'synchronized');
  for (let n = 0; n < 30; n++) {
    time = 0.6 + n / 30;
    audio.update(300);
  }
  const ramps = calls.filter((call) => call.node === 'delay' && call.method === 'ramp');
  assert.ok(ramps.length > 0);
  let previous = 0.078;
  for (const ramp of ramps) {
    assert.ok(ramp.value - previous <= 0.000501);
    previous = ramp.value;
  }
  time = 2;
  audio.bypass();
  assert.deepEqual(calls.at(-1), { node: 'delay', method: 'set', value: 0, at: 2.02 });
  assert.ok(
    calls.some(
      (call) =>
        call.node === 'wet' && call.method === 'ramp' && call.value === 0 && call.at === 2.02,
    ),
  );
  const count = calls.length;
  audio.bypass();
  assert.equal(calls.length, count, 'Repeated stale/stop events cannot restart the fade');
  assert.equal(audio.audibleTime({ currentTime: 1, playbackRate: 1 } as HTMLVideoElement), 0.97);
});

test('cancelled attachment cannot replace the current audio graph', async () => {
  let resolve!: (graph: AudioGraph) => void;
  const audio = new VsrAudioSync(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const attaching = audio.attach({} as HTMLVideoElement);
  audio.bypass();
  resolve({} as AudioGraph);
  await attaching;
  assert.equal(audio.stats().state, 'unattached');
});
