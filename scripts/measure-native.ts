// Sample native resources without changing host configuration.
import { readFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { platform, release, arch } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
const { values } = parseArgs({
  options: {
    binary: { type: 'string', default: 'target/release/linux-rtx-vsr' },
    frames: { type: 'string', default: '2000' },
    output: { type: 'string', default: 'test-results/native-resources.json' },
  },
});
if (!/^\d+$/.test(values.frames!) || Number(values.frames) < 1)
  throw new Error('--frames must be a positive integer');
const command = [
  values.binary!,
  'benchmark',
  '--frames',
  values.frames!,
  '--width',
  '1920',
  '--height',
  '1080',
];
const smi = () =>
  execFileSync(
    'nvidia-smi',
    [
      '--query-gpu=name,driver_version,utilization.gpu,memory.used,power.draw',
      '--format=csv,noheader,nounits',
    ],
    { encoding: 'utf8' },
  ).trim();
const baseline = smi(),
  started = performance.now();
const child = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe' });
// Drain both pipes immediately so long output cannot stall the benchmark.
const stdout = new Response(child.stdout).text(),
  stderr = new Response(child.stderr).text();
const samples: { seconds: number; rss_kib: number; cpu_ticks: number; device: string }[] = [];
try {
  while (child.exitCode === null) {
    try {
      const status = await readFile(`/proc/${child.pid}/status`, 'utf8');
      const stat = (await readFile(`/proc/${child.pid}/stat`, 'utf8'))
        .split(') ')[1]!
        .trim()
        .split(/\s+/);
      samples.push({
        seconds: (performance.now() - started) / 1000,
        rss_kib: Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] || 0),
        cpu_ticks: Number(stat[11]) + Number(stat[12]),
        device: smi(),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await Promise.race([child.exited, Bun.sleep(200)]);
  }
  if ((await child.exited) !== 0) throw new Error(await stderr);
} finally {
  if (child.exitCode === null) {
    child.kill();
    await child.exited;
  }
}
const result = {
  command,
  host: `${platform()} ${release()} ${arch()}`,
  cpu: /^model name\s*:\s*(.*)$/m.exec(await readFile('/proc/cpuinfo', 'utf8'))?.[1] || 'unknown',
  device_fields: ['name', 'driver_version', 'gpu_percent', 'device_memory_mib', 'watts'],
  baseline_device: baseline,
  elapsed_seconds: (performance.now() - started) / 1000,
  clock_ticks_per_second: Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim()),
  max_sampled_rss_kib: Math.max(0, ...samples.map((s) => s.rss_kib)),
  native: JSON.parse(await stdout),
  samples,
  notes:
    'Device totals include other active desktop workloads. Sampling does not measure browser resources or audible A/V sync.',
};
await mkdir(path.dirname(values.output!), { recursive: true });
await Bun.write(values.output!, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ ...result, samples: undefined }, null, 2));
