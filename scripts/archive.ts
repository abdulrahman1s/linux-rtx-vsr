import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { spawn, execFileSync } from 'node:child_process';

export async function sha256(file: string): Promise<string> {
  const hash = new Bun.CryptoHasher('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

// Validate every selected path before writing any bytes. ZIP symlinks are read
// as regular data, never recreated. Existing symlink parents are also rejected.
export async function extractVerifiedZip(
  file: string,
  destination: string,
  digest: string,
  prefixes: string[],
) {
  if ((await sha256(file)) !== digest)
    throw new Error(`SHA-256 mismatch: ${file}; no runtime installed`);
  const entries = execFileSync('unzip', ['-Z1', file], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
    .split('\n')
    .filter((name) => name && prefixes.some((prefix) => name.startsWith(prefix)));
  const root = path.resolve(destination);
  const seen = new Set<string>();
  for (const name of entries) {
    const target = path.resolve(root, name);
    if (
      !target.startsWith(root + path.sep) ||
      name.includes('\\') ||
      name.split('/').includes('..') ||
      seen.has(name)
    ) {
      throw new Error('Unsafe archive path');
    }
    seen.add(name);
    let at = root;
    for (const segment of name.split('/').filter(Boolean)) {
      const info = await lstat(at).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
      if (info?.isSymbolicLink()) throw new Error('Unsafe archive symlink');
      at = path.join(at, segment);
    }
    if ((await lstat(target).catch(() => null))?.isSymbolicLink())
      throw new Error('Unsafe archive symlink');
  }
  for (const name of entries) {
    const target = path.join(root, name);
    if (name.endsWith('/')) {
      await mkdir(target, { recursive: true });
      continue;
    }
    await mkdir(path.dirname(target), { recursive: true });
    const pattern = name.replace(/[\*?\[\]]/g, '\\$&');
    const child = spawn('unzip', ['-p', file, pattern], { stdio: ['ignore', 'pipe', 'inherit'] });
    const exited = new Promise<void>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`unzip failed (${code}) for ${name}`)),
      );
    });
    await Promise.all([
      pipeline(child.stdout!, createWriteStream(target, { flags: 'wx' })),
      exited,
    ]);
  }
}
