import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { DEFAULTS, shouldEnhance, freshState, originOf } from '../extension/src/policy.ts';
test('global off wins over both positive site rule and positive override', () => {
  const s = { ...DEFAULTS, enabled: false, sites: { 'https://example.com': true } };
  assert.equal(
    shouldEnhance(s, { origin: 'https://example.com', enabled: true }, 'https://example.com/video'),
    false,
  );
});
test('temporary overrides beat exact-origin rules and cannot cross origins', () => {
  const s = { ...DEFAULTS, sites: { 'https://example.com': true } };
  assert.equal(
    shouldEnhance(
      s,
      { origin: 'https://example.com', enabled: false },
      'https://example.com/video',
    ),
    false,
  );
  assert.equal(
    shouldEnhance(s, { origin: 'https://other.com', enabled: true }, 'https://example.com/video'),
    true,
  );
  assert.equal(
    shouldEnhance(s, { origin: 'https://example.com', enabled: true }, 'https://other.com/video'),
    false,
  );
  assert.equal(shouldEnhance(s, null, 'https://sub.example.com/video'), false);
  assert.equal(shouldEnhance(s, null, 'http://example.com/video'), false);
});
test('settings and site rules survive serialization', () => {
  const saved = JSON.parse(
    JSON.stringify({ ...DEFAULTS, sites: { 'https://example.com': true }, quality: 4 }),
  );
  assert.equal(shouldEnhance(saved, null, 'https://example.com/next'), true);
  assert.equal(saved.quality, 4);
  assert.equal(shouldEnhance(saved, null, 'chrome://extensions'), false);
  assert.equal(originOf('not a url'), null);
});
test('active means fresh presented frames, never just an enabled setting', () => {
  assert.equal(freshState({ message: '', state: 'starting' }, 1000).state, 'starting');
  assert.equal(freshState({ message: '', state: 'active' }, 1000).state, 'bypassed');
  assert.equal(
    freshState({ message: '', state: 'active', presentedAt: 999 }, 1000).state,
    'active',
  );
  assert.equal(
    freshState({ message: '', state: 'active', presentedAt: 100 }, 1000).state,
    'bypassed',
  );
  assert.equal(freshState({ message: '', state: 'paused' }, 1000).state, 'paused');
});
