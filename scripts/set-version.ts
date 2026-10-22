import fs from 'node:fs';
const version = process.argv[2];
if (
  !/^\d+\.\d+\.\d+$/.test(version || '') ||
  version.split('.').some((n) => Number(n) > 65535 || String(Number(n)) !== n) ||
  version === '0.0.0'
)
  throw new Error(
    'Version must be MAJOR.MINOR.PATCH with Chromium-compatible components (0–65535)',
  );
const cargo = fs.readFileSync('Cargo.toml', 'utf8');
const old = cargo.match(/^version = "([^"]+)"/m)![1];
fs.writeFileSync('Cargo.toml', cargo.replace(`version = "${old}"`, `version = "${version}"`));
const lock = fs.readFileSync('Cargo.lock', 'utf8');
const next = lock.replace(
  /(name = "linux-rtx-vsr"\nversion = ")[^"]+("\n)/,
  (_, prefix, suffix) => `${prefix}${version}${suffix}`,
);
if (next === lock && old !== version) throw new Error('Cargo.lock root package was not found');
fs.writeFileSync('Cargo.lock', next);
for (const file of ['extension/manifest.json', 'package.json']) {
  const text = fs.readFileSync(file, 'utf8');
  // Preserve Prettier's layout so a CI-planned version also passes formatting.
  fs.writeFileSync(
    file,
    text.replace(
      /("version"\s*:\s*")[^"]+("\s*[,}])/,
      (_, prefix, suffix) => `${prefix}${version}${suffix}`,
    ),
  );
}
console.log(`Version ${old} → ${version}`);
