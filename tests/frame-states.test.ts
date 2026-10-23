import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { FrameStates } from '../extension/src/frame-states.ts';

test('embedded playback survives parent reports and expires after frame removal', () => {
  const frames = new FrameStates();
  frames.update(7, { state: 'active', message: 'Embedded', presentedAt: 1000 }, 1000);
  assert.equal(frames.update(0, { state: 'ready', message: 'Parent' }, 1100).state, 'active');
  assert.equal(frames.update(0, { state: 'ready', message: 'Parent' }, 1800).state, 'bypassed');
  assert.equal(frames.update(0, { state: 'ready', message: 'Parent' }, 2600).state, 'ready');
});

test('frame reports replace previous status on disable and navigation', () => {
  const frames = new FrameStates();
  frames.update(7, { state: 'error', message: 'Backend failure' }, 1000);
  assert.equal(frames.update(0, { state: 'ready', message: 'Parent' }, 1100).state, 'error');
  assert.equal(frames.update(7, { state: 'disabled', message: 'Off' }, 1200).state, 'ready');
  frames.update(7, { state: 'paused', message: 'New document' }, 1300);
  assert.equal(frames.update(0, { state: 'ready', message: 'Parent' }, 1400).state, 'paused');
});
