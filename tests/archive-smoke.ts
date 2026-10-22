// A release must install and run outside the checkout with a disposable profile.
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, access, mkdir, symlink } from 'node:fs/promises';
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
// Install and launch with only ordinary Linux utilities on PATH: no Bun/Rust.
const toolDir = path.join(root, 'tools');
await mkdir(toolDir);
for (const tool of [
  'sh',
  'cat',
  'dirname',
  'mkdir',
  'mktemp',
  'install',
  'cp',
  'mv',
  'rm',
  'uname',
  'ln',
  'sha256sum',
  'unzip',
  'sed',
  'grep',
]) {
  const executable = Bun.which(tool);
  assert.ok(executable, `Missing test prerequisite: ${tool}`);
  await symlink(executable, path.join(toolDir, tool));
}
const env = {
  ...process.env,
  LINUX_RTX_VSR_PREFIX: path.join(root, 'install prefix'),
  XDG_CONFIG_HOME: path.join(root, 'config'),
  XDG_STATE_HOME: path.join(root, 'state'),
  XDG_DATA_HOME: path.join(root, 'data'),
  HOME: path.join(root, 'home'),
  CHROME_CONFIG_HOME: '',
};
const binary = path.join(root, 'install prefix/bin/linux-rtx-vsr');
const cli = (...args: string[]) => execFileSync(binary, args, { cwd: root, env, encoding: 'utf8' });
const installEnv = { ...env, PATH: toolDir, SHELL: '/bin/bash', ZDOTDIR: '' };
try {
  execFileSync('tar', ['-xzf', archive, '-C', root]);
  const installer = path.join(root, name, 'scripts/install.sh');
  const install = (...args: string[]) =>
    execFileSync('sh', [installer, ...args], {
      cwd: root,
      env: installEnv,
      encoding: 'utf8',
      stdio: 'pipe',
    });
  assert.match(install('--help'), /--browser/);
  for (const args of [
    ['--prefix'],
    ['--prefix', 'relative'],
    ['--browser', 'firefox'],
    ['--unknown'],
  ])
    assert.throws(() => install(...args));
  assert.equal(await Bun.file(binary).exists(), false);
  install('--prefix', env.LINUX_RTX_VSR_PREFIX, '--browser', 'chromium', '--add-to-path');
  const bashrc = path.join(env.HOME, '.bashrc');
  const startup = await Bun.file(bashrc).text();
  assert.ok(startup.includes('# linux-rtx-vsr PATH'));
  const pathFromStartup = execFileSync(
    'sh',
    ['-c', '. "$1"; printf "%s" "$PATH"', 'test', bashrc],
    {
      env: installEnv,
      encoding: 'utf8',
    },
  );
  assert.ok(pathFromStartup.startsWith(`${path.dirname(binary)}:`));
  assert.equal(cli('--version').trim(), `linux-rtx-vsr ${version}`);
  const exported = path.join(root, 'data/linux-rtx-vsr/extension');
  const data = path.join(env.LINUX_RTX_VSR_PREFIX, 'share/linux-rtx-vsr');
  await Bun.write(path.join(data, 'docs/obsolete.txt'), 'old release file');
  await Bun.write(path.join(data, 'runtime/keep.txt'), 'runtime must survive updates');
  cli('config', 'set', 'quality', '4');
  const output = install('--browser', 'chromium', '--add-to-path');
  assert.equal(
    await Bun.file(bashrc).text(),
    startup,
    'Repeated installs must not duplicate PATH entries',
  );
  assert.ok(output.includes(`Extension directory: ${exported}`));
  assert.equal(await Bun.file(path.join(data, 'docs/obsolete.txt')).exists(), false);
  assert.equal(
    await Bun.file(path.join(data, 'runtime/keep.txt')).text(),
    'runtime must survive updates',
  );
  assert.equal(JSON.parse(cli('config', 'show')).quality, 4);
  assert.equal(
    (await readdir(path.dirname(binary))).some((n) => n.startsWith('.linux-rtx-vsr.')),
    false,
  );

  const runtimeScript = path.join(data, 'scripts/install-runtime.sh');
  const runtime = (...args: string[]) =>
    execFileSync('sh', [runtimeScript, ...args], {
      cwd: root,
      env: installEnv,
      encoding: 'utf8',
      stdio: 'pipe',
    });
  assert.match(runtime('--help'), /--vfx-archive/);
  assert.throws(() => runtime(), /accept-nvidia-license/);
  assert.throws(
    () => runtime('--accept-nvidia-license', '--binary', 'missing-linux-rtx-vsr'),
    /Application not found/,
  );
  const corrupt = path.join(root, 'invalid wheel.whl');
  await Bun.write(corrupt, 'not a verified NVIDIA wheel');
  assert.throws(
    // Default discovery also works in the terminal that ran --add-to-path.
    () => runtime('--accept-nvidia-license', '--vfx-archive', corrupt),
    /SHA-256 mismatch/,
  );
  assert.equal(
    (await readdir(path.join(root, 'data/linux-rtx-vsr'))).some((n) => n.startsWith('.runtime.')),
    false,
  );
  assert.equal(await Bun.file(path.join(root, 'data/linux-rtx-vsr/runtime')).exists(), false);
  for (const [shell, startupFile] of [
    ['zsh', path.join(root, 'zsh configuration/.zshrc')],
    ['fish', path.join(env.XDG_CONFIG_HOME, 'fish/conf.d/linux-rtx-vsr.fish')],
    ['sh', path.join(env.HOME, '.profile')],
  ]) {
    // Literal shell metacharacters in prefixes must survive startup parsing.
    const prefix = path.join(root, 'prefix $cash `tick` "quote" \\slash');
    const shellEnv = {
      ...installEnv,
      SHELL: `/bin/${shell}`,
      ZDOTDIR: path.join(root, 'zsh configuration'),
    };
    for (let repeat = 0; repeat < 2; repeat++)
      execFileSync('sh', [installer, '--prefix', prefix, '--add-to-path'], {
        env: shellEnv,
        stdio: 'pipe',
      });
    const contents = await Bun.file(startupFile).text();
    assert.equal(contents.split('# linux-rtx-vsr PATH').length, 2);
    if (shell !== 'fish') {
      assert.equal(
        execFileSync('sh', ['-c', '. "$1"; printf "%s" "$PATH"', 'test', startupFile], {
          env: installEnv,
          encoding: 'utf8',
        }),
        `${prefix}/bin:${toolDir}`,
      );
    } else {
      assert.ok(contents.includes('fish_add_path --path'));
    }
  }
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
  assert.equal(reply.protocol, 3);
  assert.equal(JSON.parse(cli('status')).running, true);
  assert.equal(JSON.parse(cli('status')).gpu_loaded, false);
  cli('config', 'set', 'quality', '4');
  assert.equal(JSON.parse(cli('config', 'show')).quality, 4);
  assert.equal((await Bun.file(path.join(exported, 'manifest.json')).json()).version, version);
  await access(path.join(exported, 'licenses/linux-nvidia-vsr-MIT.txt'));
  assert.ok(
    !(await readdir(exported)).includes('src'),
    'Only compiled browser assets are installed',
  );
  if (gpu) cli('doctor', '--gpu');
  cli('integration', 'remove', '--manifest-dir', manifestDir);
  cli('integration', 'remove', '--browser', 'chromium');
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
  'Archive smoke passed: install/update without Bun, runtime checksum rejection/cleanup, compiled assets/notices, native startup, persistence, removal' +
    (gpu ? ', real GPU inference' : ''),
);
