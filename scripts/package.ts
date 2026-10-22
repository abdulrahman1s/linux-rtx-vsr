// Create redistributable archives without proprietary libraries or models.
import { cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildExtension } from './build-extension.ts';
import { collectLicenses } from './collect-licenses.ts';
import { sha256 } from './archive.ts';

const version = (
  Bun.TOML.parse(await Bun.file('Cargo.toml').text()) as { package: { version: string } }
).package.version;
const name = `linux-rtx-vsr-v${version}-x86_64-unknown-linux-gnu`;
await mkdir('dist', { recursive: true });
await buildExtension();
const temporary = await mkdtemp(path.join(tmpdir(), 'rtx-vsr-package-'));
try {
  const root = path.join(temporary, name);
  await mkdir(root);
  await cp('target/release/linux-rtx-vsr', path.join(root, 'linux-rtx-vsr'));
  for (const item of ['README.md', 'LICENSE', 'THIRD_PARTY.md', 'docs', 'licenses', 'scripts'])
    await cp(item, path.join(root, item), {
      recursive: true,
      filter: (source) => !source.split(path.sep).includes('__pycache__'),
    });
  await cp('build/extension', path.join(root, 'extension'), { recursive: true });
  await collectLicenses(path.join(root, 'licenses/rust-dependencies.txt'));
  execFileSync('tar', ['-czf', path.resolve('dist', `${name}.tar.gz`), '-C', temporary, name]);
  const zip = path.resolve('dist', `linux-rtx-vsr-extension-v${version}.zip`);
  await rm(zip, { force: true }); // zip otherwise retains obsolete entries.
  execFileSync('zip', ['-q', '-r', zip, '.'], { cwd: 'build/extension' });
} finally {
  await rm(temporary, { recursive: true, force: true });
}
const checksums: string[] = [];
for (const file of (await readdir('dist')).sort()) {
  if (file.startsWith('linux-rtx-vsr-') && /\.(tar\.gz|zip)$/.test(file))
    checksums.push(`${await sha256(path.join('dist', file))}  ${file}\n`);
}
await Bun.write('dist/SHA256SUMS', checksums.join(''));
console.log(`Packaged ${name}; no NVIDIA libraries or models included`);
