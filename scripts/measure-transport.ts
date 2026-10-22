// Real GPU transport measurement, isolated from the user's backend/profile.
// Excludes browser capture, AV1 decoding, drawing and audible synchronization.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createConnection } from 'node:net';
import { parseArgs } from 'node:util';
import type { FrameMetadata } from '../extension/src/protocol.ts';
const { values } = parseArgs({
  options: {
    binary: { type: 'string', default: 'target/release/linux-rtx-vsr' },
    frames: { type: 'string', default: '180' },
    window: { type: 'string', default: '2' },
    'sdk-dir': { type: 'string' },
    output: { type: 'string', default: 'test-results/transport.json' },
  },
});
const frames = Number(values.frames),
  window = Number(values.window);
if (!Number.isInteger(frames) || frames < 40 || frames > 10000 || ![1, 2, 4].includes(window))
  throw new Error('Use --frames 40–10000 and --window 1, 2 or 4');
const root = mkdtempSync(path.join(tmpdir(), 'rtx-vsr-transport-'));
const env = {
  ...process.env,
  XDG_CONFIG_HOME: `${root}/config`,
  XDG_STATE_HOME: `${root}/state`,
  XDG_DATA_HOME: `${root}/data`,
};
const binary = path.resolve(values.binary!);
const cli = (...args: string[]) => execFileSync(binary, args, { env, encoding: 'utf8' });
let socket: WebSocket | undefined;
try {
  if (values['sdk-dir']) cli('config', 'set', 'sdk_dir', values['sdk-dir']);
  cli('start');
  const grant = await new Promise<{ port: number; token: string }>((resolve, reject) => {
    const control = createConnection(`${root}/state/linux-rtx-vsr/control.sock`);
    let text = '';
    control.setEncoding('utf8');
    control.setTimeout(5000, () => control.destroy(new Error('Control grant timed out')));
    control.on('error', reject);
    control.on('connect', () => control.write('{"op":"grant"}\n'));
    control.on('data', (chunk) => {
      text += chunk;
    });
    control.on('end', () => {
      try {
        resolve(JSON.parse(text));
      } catch (error) {
        reject(error);
      }
    });
  });
  const frame = new Uint8Array(32 + (1920 * 1080 * 3) / 2);
  frame.set([82, 86, 83, 49]);
  const header = new DataView(frame.buffer);
  header.setUint32(4, 1920, true);
  header.setUint32(8, 1080, true);
  header.setUint32(12, 1, true); // SDR limited BT.709 NV12.
  // Deterministic luma ramp with neutral chroma, no JPEG/scaler path.
  frame.fill(128, 32 + 1920 * 1080);
  for (let i = 32; i < 32 + 1920 * 1080; i++) frame[i] = 16 + (i % 220);
  let sent = 0,
    completed = 0,
    meta: FrameMetadata | undefined;
  const samples: { at: number; round_trip_ms: number; stats: FrameMetadata }[] = [];
  const pending = new Map<number, number>();
  function submit() {
    while (sent < frames && pending.size < window) {
      const sequence = ++sent;
      header.setUint32(16, sequence, true);
      header.setFloat64(24, sequence / 60, true);
      pending.set(sequence, performance.now());
      socket!.send(frame);
    }
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('GPU transport exceeded 60 seconds')), 60000);
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      error ? reject(error) : resolve();
    };
    // DOM declarations hide Bun's additional constructor overload in this
    // shared browser/tooling tsconfig. Keep the runtime adapter typed here.
    const BunWebSocket = WebSocket as unknown as {
      new (url: string, options: Bun.WebSocketOptions): WebSocket;
    };
    socket = new BunWebSocket(`ws://127.0.0.1:${grant.port}/v1/stream`, {
      headers: { Origin: 'chrome-extension://pdobgdmlfcnimbnndkchfocncchfoadm' },
    });
    socket.binaryType = 'arraybuffer';
    socket.onopen = () =>
      socket!.send(JSON.stringify({ ...grant, quality: 3, scale: 2, protocol: 2 }));
    socket.onerror = () => finish(new Error('Transport socket failed'));
    socket.onclose = () => {
      if (completed !== frames) finish(new Error('Transport closed early'));
    };
    socket.onmessage = (event) => {
      try {
        if (typeof event.data === 'string') {
          const value = JSON.parse(event.data);
          if (value.type === 'error') throw new Error(value.message);
          if (value.type === 'ready') submit();
          else if (value.type === 'frame') meta = value;
          return;
        }
        if (!meta || !pending.has(meta.sequence) || !event.data.byteLength)
          throw new Error('Missing real NVENC output');
        const at = performance.now();
        samples.push({ at, round_trip_ms: at - pending.get(meta.sequence)!, stats: meta });
        pending.delete(meta.sequence);
        meta = undefined;
        completed++;
        if (completed === frames) finish();
        else submit();
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };
  });
  const warm = samples.slice(30),
    first = warm[0]!,
    last = warm.at(-1)!;
  const quantile = (values: number[], q: number) =>
    values.sort((a, b) => a - b)[Math.floor((values.length - 1) * q)];
  const result = {
    version: cli('--version').trim(),
    source: '1920x1080 NV12 luma ramp',
    output: '3840x2160 AV1',
    quality: 3,
    window,
    frames,
    warm_fps: ((warm.length - 1) * 1000) / (last.at - first.at),
    warm_round_trip_p50_ms: quantile(
      warm.map((s) => s.round_trip_ms),
      0.5,
    ),
    warm_dispatch_p50_ms: quantile(
      warm.map((s) => s.stats.dispatch_ms!),
      0.5,
    ),
    notes:
      'Real VideoSuperRes + NVENC over Bun loopback WebSocket. Excludes the browser and physical A/V sync; not a browser FPS claim.',
    samples,
  };
  mkdirSync(path.dirname(values.output!), { recursive: true });
  await Bun.write(values.output!, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ ...result, samples: undefined }, null, 2));
} finally {
  socket?.close();
  try {
    cli('stop');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
