// Acquisition only. No inference, sudo, package installation or ELF patching.
import { mkdir, mkdtemp, readdir, rename, rm, symlink, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { extractVerifiedZip } from './archive.ts';
export { extractVerifiedZip as extract } from './archive.ts';

const VFX_URL =
  'https://pypi.nvidia.com/nvidia-vfx/nvidia_vfx-0.2.0.0-cp312-abi3-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl';
const VFX_SHA256 = '0252866a7b798a6f92c8543443d88f716e8c5bbc6a7ddd77a2754728dada9fa8';
async function download(url: string, file: string) {
  console.log(`Downloading ${url.split('/').at(-1)}…`);
  const response = await fetch(url, { signal: AbortSignal.timeout(45 * 60 * 1000) });
  if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
  await Bun.write(file, response);
}
async function main() {
  const { values } = parseArgs({
    options: {
      'accept-nvidia-license': { type: 'boolean', default: false },
      'vfx-archive': { type: 'string' },
      binary: { type: 'string', default: 'linux-rtx-vsr' },
    },
  });
  if (!values['accept-nvidia-license'])
    throw new Error(
      "Review NVIDIA's software, product-specific and model terms in docs/runtime.md, then pass --accept-nvidia-license",
    );
  const root = path.join(
    process.env.XDG_DATA_HOME || path.join(homedir(), '.local/share'),
    'linux-rtx-vsr',
  );
  await mkdir(root, { recursive: true });
  const runtime = path.join(root, 'runtime');
  if (
    await access(runtime).then(
      () => true,
      () => false,
    )
  )
    throw new Error(
      `${runtime} already exists; stop the backend and move it aside before replacing it`,
    );
  const staging = await mkdtemp(path.join(root, 'runtime-'));
  try {
    const vfx = values['vfx-archive'] || path.join(staging, 'vfx.whl');
    if (!values['vfx-archive']) await download(VFX_URL, vfx);
    const out = path.join(staging, 'extracted');
    await extractVerifiedZip(vfx, out, VFX_SHA256, [
      'nvvfx/libs/',
      'nvidia_vfx.libs/',
      'nvidia_vfx-0.2.0.0.dist-info/licenses/',
    ]);
    for (const name of await readdir(path.join(out, 'nvvfx/libs'))) {
      if (!name.includes('.so.')) continue;
      const alias = path.join(out, 'nvvfx/libs', name.split('.so.')[0] + '.so');
      if (
        !(await access(alias).then(
          () => true,
          () => false,
        ))
      )
        await symlink(name, alias);
    }
    await rename(out, runtime);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  for (const [key, file] of [['sdk_dir', 'nvvfx/libs']]) {
    execFileSync(values.binary!, ['config', 'set', key!, path.join(runtime, file!)], {
      stdio: 'inherit',
    });
  }
  console.log(
    "Runtime installed. Run linux-rtx-vsr doctor --gpu. NVIDIA's licenses are retained in the runtime directory.",
  );
}
if (import.meta.main) await main();
