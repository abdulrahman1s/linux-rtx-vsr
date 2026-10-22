import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

// No development packages are imported here: Cargo/Nix can build browser assets
// with Bun alone. The output is also the sole input to extension release ZIPs.
export async function buildExtension(outdir = 'build/extension') {
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });
  for (const item of await readdir('extension', { withFileTypes: true })) {
    if (item.name !== 'src')
      await cp(`extension/${item.name}`, path.join(outdir, item.name), {
        recursive: true,
      });
  }
  for (const entry of ['background', 'content', 'bridge', 'frame-worker', 'popup']) {
    const result = await Bun.build({
      entrypoints: [`extension/src/${entry}.ts`],
      outdir,
      target: 'browser',
      format: entry === 'content' ? 'iife' : 'esm',
      naming: `${entry}.js`,
      banner:
        entry === 'content'
          ? '// Copyright (c) 2026 maxiarat1 and contributors. MIT; see licenses/linux-nvidia-vsr-MIT.txt.'
          : undefined,
    });
    if (!result.success) throw new AggregateError(result.logs, `Cannot build ${entry}`);
  }
}

if (import.meta.main) await buildExtension(process.argv[2]);
