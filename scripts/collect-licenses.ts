import { execFileSync } from 'node:child_process';
import { readdir, stat, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
interface CargoPackage {
  name: string;
  version: string;
  source: string | null;
  manifest_path: string;
  license?: string;
  license_file?: string;
  repository?: string;
}
export async function collectLicenses(output: string, offline = false) {
  const args = [
    'metadata',
    '--locked',
    '--format-version',
    '1',
    '--filter-platform',
    'x86_64-unknown-linux-gnu',
  ];
  if (offline) args.push('--offline');
  const metadata = JSON.parse(
    execFileSync('cargo', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }),
  ) as { packages: CargoPackage[] };
  const packages = metadata.packages
    .filter((p) => p.source)
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  const sections = [
    'Third-party Rust dependency notices\n\nGenerated from locked dependency sources. These notices retain their upstream terms.\n',
  ];
  for (const pkg of packages) {
    const root = path.dirname(pkg.manifest_path),
      files = new Set<string>();
    for (const item of await readdir(root, { withFileTypes: true })) {
      if (item.isFile() && /^(license|licence|copying|notice)/i.test(item.name))
        files.add(path.join(root, item.name));
    }
    for (const name of ['licenses', 'LICENSES']) {
      const folder = path.join(root, name);
      if (!(await stat(folder).catch(() => null))?.isDirectory()) continue;
      for (const item of await readdir(folder, { recursive: true })) {
        const file = path.join(folder, item);
        if ((await stat(file)).isFile()) files.add(file);
      }
    }
    if (pkg.license_file) files.add(path.resolve(root, pkg.license_file));
    if (!files.size)
      throw new Error(
        `No license files for ${pkg.name} ${pkg.version}; inspect before distributing`,
      );
    sections.push(
      `\n${'='.repeat(72)}\n${pkg.name} ${pkg.version}\nSPDX: ${pkg.license || 'See license files'}\n${pkg.repository || ''}\n`,
    );
    for (const file of [...files].sort())
      sections.push(`\n--- ${path.relative(root, file)} ---\n${await readFile(file, 'utf8')}\n`);
  }
  await mkdir(path.dirname(output), { recursive: true });
  await Bun.write(output, sections.join('\n'));
  console.log(`Retained license files for ${packages.length} locked Rust dependencies`);
}
if (import.meta.main) {
  const { values } = parseArgs({
    options: { offline: { type: 'boolean' }, output: { type: 'string' } },
  });
  if (!values.output)
    throw new Error('Usage: bun scripts/collect-licenses.ts [--offline] --output FILE');
  await collectLicenses(values.output, values.offline);
}
