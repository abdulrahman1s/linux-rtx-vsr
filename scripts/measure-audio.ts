// Offline Web Audio continuity measurement, not a physical A/V sync test.
import { chromium } from 'playwright-core';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { launchFixtureBrowser } from '../tests/browser-launch.ts';
const { values } = parseArgs({
  options: {
    'legacy-ref': { type: 'string' },
    output: { type: 'string', default: 'test-results/audio-continuity.json' },
  },
});
const ref = values['legacy-ref'];
if (ref && !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(ref)) throw new Error('Invalid Git reference');
const previous = ref
  ? execFileSync('git', ['show', `${ref}:extension/src/audio-sync.ts`], { encoding: 'utf8' })
  : undefined;
const root = mkdtempSync(path.join(tmpdir(), 'vsr-audio-probe-'));
let browser: Awaited<ReturnType<typeof launchFixtureBrowser>> | undefined;
try {
  browser = await launchFixtureBrowser(
    path.join(root, 'profile'),
    {
      executablePath: process.env.CHROMIUM_PATH || chromium.executablePath(),
      headless: true,
    },
    false,
  );
  const results = [];
  for (const legacy of previous ? [true, false] : [false]) {
    const build = await Bun.build({
      entrypoints: ['tests/fixtures/audio.ts'],
      target: 'browser',
      format: 'iife',
      plugins: legacy
        ? [
            {
              name: 'legacy-audio',
              setup(build) {
                build.onLoad({ filter: /extension\/src\/audio-sync\.ts$/ }, () => ({
                  loader: 'ts',
                  contents: previous!,
                }));
              },
            },
          ]
        : [],
    });
    if (!build.success) throw new Error(String(build.logs));
    const page = await browser.context.newPage();
    await page.addScriptTag({ content: await build.outputs[0].text() });
    results.push({
      version: legacy ? ref : 'working tree',
      ...(await page.evaluate((legacy) => globalThis.vsrAudioProbe(legacy), legacy)),
    });
    await page.close();
  }
  const result = {
    browser: await browser.context.browser()!.version(),
    source:
      '4 seconds, 880 Hz sine, amplitude 0.2, 48000 Hz; 200–206 ms decode age; interrupted fades, repeated bypass, reattach',
    results,
    notes:
      'Actual OfflineAudioContext nodes/automation with a scheduled control clock. Undelayed reference rendered simultaneously. Excludes physical audio devices, underruns and audible A/V synchronization. --legacy-ref supports the single-delay graph in v0.3.2 and earlier.',
  };
  mkdirSync(path.dirname(values.output!), { recursive: true });
  await Bun.write(values.output!, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally {
  try {
    await browser?.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
