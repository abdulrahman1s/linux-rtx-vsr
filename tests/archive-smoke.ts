// A release must install and run outside the checkout with a disposable profile.
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const gpu = process.argv.includes('--gpu');
const version = (
  Bun.TOML.parse(await Bun.file('Cargo.toml').text()) as { package: { version: string } }
).package.version;
const name = `linux-rtx-vsr-v${version}-x86_64-unknown-linux-gnu`;
const archive = path.resolve('dist', `${name}.tar.gz`);
const contents = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
assert.ok(
  contents.every((name) => !path.basename(name).includes('.so')),
  'Proprietary library in release',
);
assert.ok(
  contents.every((name) => !/\.(py|pyc)$/.test(name)),
  'Obsolete Python tooling in release',
);
assert.ok(
  contents.every((file) => file.startsWith(name + '/') && !file.split('/').includes('..')),
  'Unsafe release path',
);
const root = await mkdtemp(path.join(tmpdir(), 'rtx-archive-'));
const env = {
  ...process.env,
  LINUX_RTX_VSR_PREFIX: path.join(root, 'install prefix'),
  XDG_CONFIG_HOME: path.join(root, 'config'),
  XDG_STATE_HOME: path.join(root, 'state'),
  XDG_DATA_HOME: path.join(root, 'data'),
};
const binary = path.join(root, 'install prefix/bin/linux-rtx-vsr');
const cli = (...args: string[]) => execFileSync(binary, args, { cwd: root, env, encoding: 'utf8' });
try {
  execFileSync('tar', ['-xzf', archive, '-C', root]);
  execFileSync('sh', [path.join(root, name, 'scripts/install.sh')], { cwd: root, env });
  assert.equal(cli('--version').trim(), `linux-rtx-vsr ${version}`);
  const manifestDir = path.join(root, 'browser profile/NativeMessagingHosts');
  cli('integration', 'install', '--manifest-dir', manifestDir);
  const manifest = path.join(
    manifestDir,
    (await readdir(manifestDir)).find((n) => n.endsWith('.json'))!,
  );
  const native = await Bun.file(manifest).json();
  const payload = Buffer.from(JSON.stringify({ op: 'grant' })),
    header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length);
  const result = execFileSync(native.path, [native.allowed_origins[0]], {
    input: Buffer.concat([header, payload]),
    cwd: root,
    env,
  });
  const reply = JSON.parse(result.subarray(4, 4 + result.readUInt32LE()).toString());
  assert.equal(reply.token.length, 64);
  assert.equal(reply.protocol, 2);
  assert.equal(JSON.parse(cli('status')).running, true);
  assert.equal(JSON.parse(cli('status')).gpu_loaded, false);
  cli('config', 'set', 'quality', '4');
  assert.equal(JSON.parse(cli('config', 'show')).quality, 4);
  const exported = path.join(root, 'data/linux-rtx-vsr/extension');
  assert.equal((await Bun.file(path.join(exported, 'manifest.json')).json()).version, version);
  await access(path.join(exported, 'licenses/linux-nvidia-vsr-MIT.txt'));
  assert.ok(
    !(await readdir(exported)).includes('src'),
    'Only compiled browser assets are installed',
  );
  if (gpu) cli('doctor', '--gpu');
  cli('integration', 'remove', '--manifest-dir', manifestDir);
  assert.equal(
    await access(manifest).then(
      () => true,
      () => false,
    ),
    false,
  );
} finally {
  try {
    cli('stop');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const zip = path.resolve('dist', `linux-rtx-vsr-extension-v${version}.zip`);
const entries = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).trim().split('\n');
assert.equal(
  JSON.parse(execFileSync('unzip', ['-p', zip, 'manifest.json'], { encoding: 'utf8' })).version,
  version,
);
assert.ok(entries.includes('licenses/linux-nvidia-vsr-MIT.txt'));
assert.equal(new Set(entries).size, entries.length);
console.log(
  'Archive smoke passed: isolated install, compiled assets/notices, native startup, persistence, removal' +
    (gpu ? ', real GPU inference' : ''),
);
