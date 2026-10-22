import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { planOutput } from '../extension/src/resolution.ts';
test('target output computes source-dependent scale and preserves portrait bounds', () => {
  assert.deepEqual(planOutput(1920, 1080, 2160), {
    width: 3840,
    height: 2160,
    scale: 2,
    bypass: false,
  });
  assert.deepEqual(planOutput(640, 360, 2160), {
    width: 3840,
    height: 2160,
    scale: 6,
    bypass: false,
  });
  assert.deepEqual(planOutput(1920, 1080, 4320), {
    width: 7680,
    height: 4320,
    scale: 4,
    bypass: false,
  });
  assert.deepEqual(planOutput(1080, 1920, 4320), {
    width: 4320,
    height: 7680,
    scale: 4,
    bypass: false,
  });
  assert.deepEqual(planOutput(1080, 1920, 2160), {
    width: 2160,
    height: 3840,
    scale: 2,
    bypass: false,
  });
  const cinema = planOutput(1920, 800, 1440);
  assert.equal(cinema.width, 2560);
  assert.equal(cinema.height, 1064);
  assert.equal(cinema.bypass, false);
  assert.equal(planOutput(1920, 1080, 1080).bypass, true);
  assert.equal(planOutput(3840, 2160, 1440).bypass, true);
  for (const width of [NaN, Infinity, 0, 32]) assert.throws(() => planOutput(width, 1080, 2160));
});
