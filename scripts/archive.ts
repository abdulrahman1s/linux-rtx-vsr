import { createReadStream } from 'node:fs';

export async function sha256(file: string): Promise<string> {
  const hash = new Bun.CryptoHasher('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
