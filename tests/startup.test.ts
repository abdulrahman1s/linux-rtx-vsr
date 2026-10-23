import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { StartupWatchdog } from '../extension/src/startup-watchdog.ts';

test('cold NVIDIA startup can exceed 15 seconds before synchronizing', () => {
  const startup = new StartupWatchdog(0);
  startup.progress('capture', 1000);
  startup.progress('engine', 1100);
  assert.equal(startup.error(16000), null);
  assert.equal(startup.error(31000), null);
  startup.progress('sync', 31500);
  assert.equal(startup.error(40000), null);
  startup.progress('active', 40100);
  assert.equal(startup.error(100000), null);
});

test('stalled startup reports the stage and repeated events cannot extend deadlines', () => {
  const bridge = new StartupWatchdog(1000);
  assert.match(bridge.error(16000)!, /Extension frame/);
  const capture = new StartupWatchdog(1000);
  capture.progress('capture', 2000);
  assert.match(capture.error(17000)!, /No video frame/);
  const engine = new StartupWatchdog(1000);
  engine.progress('engine', 2000);
  engine.progress('engine', 36000);
  engine.progress('capture', 36500);
  assert.match(engine.error(37000)!, /No decoded NVIDIA output/);
  const sync = new StartupWatchdog(1000);
  sync.progress('sync', 2000);
  sync.progress('sync', 16000);
  assert.match(sync.error(17000)!, /did not synchronize/);
});
