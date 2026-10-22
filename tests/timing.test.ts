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
  assert.equal(calls.at(-1)![0], 0);
  await audio.attach(video);
  assert.equal(created, 1);
});
