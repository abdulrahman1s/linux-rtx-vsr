import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { CapturePacer } from '../extension/src/capture-pacer.ts';
// One 60 fps source frame per call; `capacity` frames per second fit the link.
function run(pacer: CapturePacer, seconds: number, capacity: number, start = 0) {
  const sent: number[] = [];
  let queued = 0;
  for (let frame = start; frame < start + seconds * 60; frame++) {
    const now = (frame * 1000) / 60;
    queued = Math.max(0, queued - capacity / 60);
    if (pacer.due(frame, queued < 4, now)) {
      queued++;
      sent.push(frame);
    }
  }
  return sent;
}
test('an overloaded link settles on an even stride instead of bursts', () => {
  const pacer = new CapturePacer();
  pacer.start(0);
  const sent = run(pacer, 20, 40);
  assert.equal(pacer.stride, 2);
  // After settling, frames leave every other source frame except brief probes.
  const late = sent.filter((frame) => frame >= 600);
  const gaps = late.slice(1).map((frame, i) => frame - late[i]);
  assert.ok(gaps.filter((gap) => gap === 2).length / gaps.length > 0.9, `${gaps}`);
});
test('a link with headroom keeps every frame', () => {
  const pacer = new CapturePacer();
  pacer.start(0);
  assert.equal(run(pacer, 10, 70).length, 600);
  assert.equal(pacer.stride, 1);
});
test('probes back to the full rate once the link frees up', () => {
  const pacer = new CapturePacer();
  pacer.start(0);
  run(pacer, 10, 40);
  assert.equal(pacer.stride, 2);
  run(pacer, 70, 70, 600);
  assert.equal(pacer.stride, 1);
});
test('cold startup congestion does not lower the rate', () => {
  const pacer = new CapturePacer();
  for (let frame = 0; frame < 300; frame++) pacer.due(frame, false, (frame * 1000) / 60);
  assert.equal(pacer.stride, 1);
});
