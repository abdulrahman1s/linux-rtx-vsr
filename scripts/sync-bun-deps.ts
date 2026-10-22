// Export only the locked registry artifacts needed by Nix. No install scripts or
// package manager network access is used inside sandboxed Nix checks.
import ts from 'typescript';
const parsed = ts.parseConfigFileTextToJson('bun.lock', await Bun.file('bun.lock').text());
if (parsed.error) throw new Error('Invalid bun.lock JSONC');
const lock = parsed.config as { packages: Record<string, [string, string, object, string]> };
import assert from 'node:assert/strict';

const dependencies = Object.entries(lock.packages).map(([key, entry]) => {
  const [specifier, , , hash] = entry;
  const split = specifier.lastIndexOf('@');
  const name = specifier.slice(0, split);
  const version = specifier.slice(split + 1);
  const parent = key.slice(0, key.length - name.length).replace(/\/$/, '');
  return {
    path: parent ? `${parent}/node_modules/${name}` : name,
    url: `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz`,
    hash,
  };
});
const file = 'nix/bun-deps.json';
const value = JSON.stringify(dependencies, null, 2) + '\n';
if (process.argv.includes('--check')) {
  assert.deepEqual(
    await Bun.file(file).json(),
    dependencies,
    'Run bun scripts/sync-bun-deps.ts after dependency updates',
  );
} else {
  await Bun.write(file, value);
}
