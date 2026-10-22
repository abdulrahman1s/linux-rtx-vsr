import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, rm, readFile, access, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { bumpKind, plan } from '../scripts/release-plan.ts';
import { sha256 } from '../scripts/archive.ts';

// Exercise the same shell extractor used by release users, with local fixtures.
async function extractRuntime(file: string, out: string, digest: string) {
  execFileSync(
    'sh',
    [
      '-eu',
      '-c',
      '. "$1"; extract_runtime_archive "$2" "$3" "$4"',
      'runtime-extraction-test',
      path.resolve('scripts/runtime-archive.sh'),
      file,
      out,
      digest,
    ],
    { stdio: 'pipe' },
  );
}

test('release versions move together without changing dependency resolutions', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rtx-release-'));
  try {
    await mkdir(path.join(root, 'extension'));
    for (const file of [
      'Cargo.toml',
      'Cargo.lock',
      'package.json',
      'bun.lock',
      'extension/manifest.json',
    ])
      await cp(file, path.join(root, file));
    const script = path.resolve('scripts/set-version.ts');
    execFileSync(process.execPath, [script, '1.2.3'], { cwd: root });
    assert.equal(
      (
        Bun.TOML.parse(await readFile(path.join(root, 'Cargo.toml'), 'utf8')) as {
          package: { version: string };
        }
      ).package.version,
      '1.2.3',
    );
    const before = Bun.TOML.parse(await readFile('Cargo.lock', 'utf8')) as {
      package: { name: string }[];
    };
    const after = Bun.TOML.parse(
      await readFile(path.join(root, 'Cargo.lock'), 'utf8'),
    ) as typeof before;
    assert.deepEqual(
      before.package.filter((p) => p.name !== 'linux-rtx-vsr'),
      after.package.filter((p) => p.name !== 'linux-rtx-vsr'),
    );
    assert.equal(
      await readFile(path.join(root, 'bun.lock'), 'utf8'),
      await readFile('bun.lock', 'utf8'),
    );
    for (const file of ['package.json', 'extension/manifest.json'])
      assert.equal((await Bun.file(path.join(root, file)).json()).version, '1.2.3');
    assert.throws(() =>
      execFileSync(process.execPath, [script, '70000.0.0'], { cwd: root, stdio: 'pipe' }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('conventional commit precedence', () => {
  assert.equal(bumpKind('fix(ui): timeout\nfeat: site rules'), 'minor');
  assert.equal(bumpKind('feat: rules\nfix!: changed'), 'major');
  assert.equal(bumpKind('perf(worker): reduce copies'), 'patch');
  assert.equal(bumpKind('fix: repair\n\nBREAKING CHANGE: renamed'), 'major');
  assert.equal(bumpKind('docs: clarify'), null);
});
test('release policy gates PRs, branches, skip markers and manual opt-in', () => {
  const context = {
    current: '0.1.0',
    head: 'feat: rules',
    tags: [],
    messages: 'feat: rules',
    env: { GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'push' },
  };
  assert.deepEqual(plan(context), { version: '0.2.0', release: true, commit: true });
  for (const changes of [
    { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_REF: 'refs/heads/topic' },
    { GITHUB_EVENT_NAME: 'workflow_dispatch', INPUT_RELEASE: 'false' },
  ])
    assert.equal(plan({ ...context, env: { ...context.env, ...changes } }).release, false);
  for (const head of ['chore: release v0.1.0', 'feat: rules [skip release]'])
    assert.equal(plan({ ...context, head }).release, false);
  const manual = {
    GITHUB_REF: 'refs/heads/topic',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    INPUT_RELEASE: 'true',
    INPUT_VERSION: 'v1.2.3',
  };
  assert.deepEqual(plan({ ...context, env: manual }), {
    version: '1.2.3',
    release: true,
    commit: true,
  });
  assert.throws(() => plan({ ...context, env: { ...manual, INPUT_VERSION: '0.1.0' } }), /increase/);
  assert.throws(
    () => plan({ ...context, env: { ...manual, INPUT_VERSION: '70000.0.0' } }),
    /compatible/,
  );
  assert.deepEqual(plan({ ...context, env: { GITHUB_REF: 'refs/tags/v0.1.0' } }), {
    version: '0.1.0',
    release: true,
    commit: false,
  });
  assert.throws(() => plan({ ...context, env: { GITHUB_REF: 'refs/tags/v1.0.0' } }), /match/);
});
// Tiny stored ZIP fixture: crafted names test traversal before extraction.
function zip(entries: Record<string, string>): Buffer {
  const local: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const filename = Buffer.from(name),
      data = Buffer.from(value);
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, data);
    const index = Buffer.alloc(46);
    index.writeUInt32LE(0x02014b50);
    index.writeUInt16LE(20, 4);
    index.writeUInt16LE(20, 6);
    index.writeUInt32LE(crc, 16);
    index.writeUInt32LE(data.length, 20);
    index.writeUInt32LE(data.length, 24);
    index.writeUInt16LE(filename.length, 28);
    index.writeUInt32LE(offset, 42);
    central.push(index, filename);
    offset += header.length + filename.length + data.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
test('runtime verifies digest and retains only allowed paths', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rtx-extract-'));
  try {
    const file = path.join(root, 'runtime.zip'),
      out = path.join(root, 'out');
    await Bun.write(
      file,
      zip({
        'nvvfx/libs/test.so': 'runtime',
        'nvvfx/libs/test[1]?.so': 'literal pattern',
        'nvidia_vfx.libs/dependency.so': 'dependency',
        'nvidia_vfx-0.2.0.0.dist-info/licenses/LICENSE': 'retained license',
        'nvvfx/__init__.py': 'skip',
      }),
    );
    await assert.rejects(extractRuntime(file, out, '0'.repeat(64)), /SHA-256/);
    assert.equal(
      await access(out).then(
        () => true,
        () => false,
      ),
      false,
    );
    await extractRuntime(file, out, await sha256(file));
    assert.equal(await readFile(path.join(out, 'nvvfx/libs/test.so'), 'utf8'), 'runtime');
    assert.equal(
      await readFile(path.join(out, 'nvvfx/libs/test[1]?.so'), 'utf8'),
      'literal pattern',
    );
    assert.equal(
      await readFile(path.join(out, 'nvidia_vfx.libs/dependency.so'), 'utf8'),
      'dependency',
    );
    assert.equal(
      await readFile(path.join(out, 'nvidia_vfx-0.2.0.0.dist-info/licenses/LICENSE'), 'utf8'),
      'retained license',
    );
    assert.equal(
      await access(path.join(out, 'nvvfx/__init__.py')).then(
        () => true,
        () => false,
      ),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('runtime rejects traversal and preexisting symlink parents', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rtx-unsafe-'));
  try {
    const file = path.join(root, 'runtime.zip'),
      out = path.join(root, 'out');
    await Bun.write(file, zip({ 'nvvfx/libs/../../../escape': 'bad' }));
    await assert.rejects(extractRuntime(file, out, await sha256(file)), /Unsafe/);
    await mkdir(out);
    await symlink(root, path.join(out, 'nvvfx'));
    await Bun.write(file, zip({ 'nvvfx/libs/test.so': 'bad' }));
    await assert.rejects(extractRuntime(file, out, await sha256(file)), /already exists/);
    assert.equal(await Bun.file(path.join(root, 'libs/test.so')).exists(), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
