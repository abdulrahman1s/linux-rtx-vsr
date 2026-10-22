import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { buildExtension } from './build-extension.ts';
await buildExtension();
const manifest = JSON.parse(fs.readFileSync('build/extension/manifest.json', 'utf8'));
const version = fs.readFileSync('Cargo.toml', 'utf8').match(/^version = "([^"]+)"/m)![1];
assert.equal(manifest.version, version);
assert.equal(JSON.parse(fs.readFileSync('package.json', 'utf8')).version, version);
assert.equal(manifest.manifest_version, 3);
assert.deepEqual(
  manifest.permissions.toSorted(),
  ['activeTab', 'nativeMessaging', 'scripting', 'storage'].toSorted(),
);
assert.deepEqual(manifest.host_permissions, [
  'http://127.0.0.1/*',
  'https://www.youtube.com/*',
  'https://youtube.com/*',
  'https://m.youtube.com/*',
]);
for (const asset of [
  manifest.background.service_worker,
  manifest.action.default_popup,
  ...Object.values(manifest.icons),
  ...manifest.web_accessible_resources[0].resources,
])
  assert.ok(fs.existsSync(`build/extension/${asset}`), asset);
console.log(`Extension ${version}: compiled assets, permissions and release versions OK`);
