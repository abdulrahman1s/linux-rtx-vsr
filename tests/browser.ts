import type { BrowserContext, LaunchOptions } from 'playwright-core';
import type { AddressInfo } from 'node:net';
import type { PlaybackStatus, Settings } from '../extension/src/protocol.ts';
// Isolated Chromium profile only. Never attaches to a personal browser.
// VSR_GPU_TEST=1 exercises actual native startup, inference and presentation.
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { observeMedia } from './media-observer.ts';
const gpu = process.env.VSR_GPU_TEST === '1';
const extraBrowserArgs: unknown = JSON.parse(process.env.VSR_BROWSER_ARGS || '[]');
if (!Array.isArray(extraBrowserArgs) || !extraBrowserArgs.every((arg) => typeof arg === 'string'))
  throw new Error('VSR_BROWSER_ARGS must be a JSON array of browser flags');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-rtx-vsr-browser-'));
const env = {
  ...process.env,
  XDG_CONFIG_HOME: `${root}/config`,
  XDG_STATE_HOME: `${root}/state`,
  XDG_DATA_HOME: `${root}/data`,
};
const bin = path.resolve(process.env.VSR_BIN || 'target/debug/linux-rtx-vsr');
const cli = (...args: string[]) => execFileSync(bin, args, { env, encoding: 'utf8' });
const id = 'pdobgdmlfcnimbnndkchfocncchfoadm';
const extension = path.resolve('build/extension');
const fixtureSize = process.env.VSR_FIXTURE_SIZE || '640x360';
const fixtureFps = Number(process.env.VSR_FIXTURE_FPS || 30);
if (!/^\d+x\d+$/.test(fixtureSize) || ![24, 30, 60].includes(fixtureFps))
  throw new Error('Use VSR_FIXTURE_SIZE=WIDTHxHEIGHT and VSR_FIXTURE_FPS=24/30/60');
fs.mkdirSync('test-results', { recursive: true });
const video = `${root}/fixture.webm`;
execFileSync('ffmpeg', [
  '-hide_banner',
  '-loglevel',
  'error',
  '-f',
  'lavfi',
  '-i',
  `testsrc2=size=${fixtureSize}:rate=${fixtureFps}`,
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=880:sample_rate=48000',
  '-t',
  String(Math.max(12, Number(process.env.VSR_MEASURE_SECONDS || 0) + 8)),
  '-c:v',
  'libvpx-vp9',
  '-deadline',
  'realtime',
  '-cpu-used',
  '8',
  '-c:a',
  'libopus',
  video,
]);
const server = http.createServer((req, res) => {
  const route = new URL(req.url || '/', 'http://localhost').pathname;
  const file =
    route === '/fixture.webm'
      ? video
      : route === '/player.js'
        ? 'build/fixtures/player.js'
        : 'tests/fixtures/player.html';
  res.setHeader(
    'Content-Type',
    file.endsWith('.webm') ? 'video/webm' : file.endsWith('.js') ? 'text/javascript' : 'text/html',
  );
  if (file === video) {
    const size = fs.statSync(file).size;
    res.setHeader('Accept-Ranges', 'bytes');
    if (req.headers.range) {
      const [, first, last] = /bytes=(\d+)-(\d*)/.exec(req.headers.range) || [];
      if (first === undefined) {
        res.writeHead(416);
        res.end();
        return;
      }
      const start = Number(first),
        end = last ? Math.min(Number(last), size - 1) : size - 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': end - start + 1,
      });
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.setHeader('Content-Length', size);
  }
  fs.createReadStream(file).pipe(res);
});
await Bun.build({
  entrypoints: ['tests/fixtures/player.ts'],
  outdir: 'build/fixtures',
  target: 'browser',
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
let context: BrowserContext | undefined,
  launchOptions: LaunchOptions,
  gpuWorkerPids: string[] = [];
try {
  if (gpu) {
    if (process.env.VSR_TEST_SDK_DIR) cli('config', 'set', 'sdk_dir', process.env.VSR_TEST_SDK_DIR);
    cli('integration', 'install', '--manifest-dir', `${root}/profile/NativeMessagingHosts`);
    // Branded Chromium builds may resolve native hosts from their fixed XDG
    // product directory instead of --user-data-dir. All paths stay disposable.
    for (const product of ['Brave-Browser', 'Brave-Origin', 'Brave-Origin-Nightly'])
      cli(
        'integration',
        'install',
        '--manifest-dir',
        `${root}/config/BraveSoftware/${product}/NativeMessagingHosts`,
      );
  }
  launchOptions = {
    timeout: 30000,
    executablePath: process.env.CHROMIUM_PATH || chromium.executablePath(),
    headless: process.env.VSR_HEADED !== '1',
    env,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      ...extraBrowserArgs,
    ],
  };
  context = await chromium.launchPersistentContext(`${root}/profile`, launchOptions);
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent('serviceworker', { timeout: 15000 }));
  assert.equal(new URL(worker.url()).host, id);
  // Default YouTube automation must have real browser permission and a
  // persisted content-script registration, without opening a remote video.
  assert.equal(
    await worker.evaluate(() =>
      chrome.permissions.contains({ origins: ['https://www.youtube.com/*'] }),
    ),
    true,
  );
  for (let retry = 0; ; retry++) {
    const scripts = await worker.evaluate(() => chrome.scripting.getRegisteredContentScripts());
    if (scripts.some((script) => script.matches?.includes('https://www.youtube.com/*'))) break;
    assert.ok(retry < 30, 'YouTube automatic content script must register on install');
    await Bun.sleep(50);
  }
  // Small lifecycle fixture uses 720p; performance runs explicitly select 4K.
  const target = Number(process.env.VSR_TEST_TARGET || 720);
  await worker.evaluate(async (target) => {
    await chrome.storage.local.set({ settings: { enabled: true, sites: {}, quality: 3, target } });
  }, target);
  const page = context.pages()[0];
  const media = gpu ? await observeMedia(context, page) : () => undefined;
  page.on('pageerror', (e) => console.log('Page error:', e.message));
  if (process.env.VSR_DEBUG) page.on('console', (m) => console.log('Browser:', m.text()));
  await page.goto(origin);
  await page.click('#play');
  const tabId = await worker.evaluate(
    async (url) => (await chrome.tabs.query({})).find((t) => t.url === url + '/')!.id!,
    origin,
  );
  await worker.evaluate(
    async ({ tabId, origin }) => {
      await chrome.storage.session.set({ [`override:${tabId}`]: { origin, enabled: true } });
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    },
    { tabId, origin },
  );
  const state = () =>
    worker.evaluate(
      async (tabId) =>
        (
          await chrome.storage.session.get<Record<string, PlaybackStatus | undefined>>(
            `state:${tabId}`,
          )
        )[`state:${tabId}`],
      tabId,
    );
  async function waitState(
    predicate: (state: PlaybackStatus | undefined) => boolean,
    timeout = 20000,
  ) {
    const end = Date.now() + timeout;
    let value, previous;
    while (Date.now() < end) {
      value = await state();
      if (value?.state !== previous) {
        console.log('State:', value?.state, value?.message);
        previous = value?.state;
      }
      if (predicate(value)) return value;
      await new Promise((r) => setTimeout(r, 100));
    }
    console.log(
      'Video:',
      await page.locator('#main').evaluate((v: HTMLVideoElement) => ({
        paused: v.paused,
        readyState: v.readyState,
        time: v.currentTime,
        seeking: v.seeking,
        error: v.error?.message,
      })),
    );
    console.log('Profile:', root);
    await page.screenshot({ path: 'test-results/failure.png' });
    throw new Error(`State timeout: ${JSON.stringify(value)}`);
  }
  const result = await waitState((v) => (gpu ? v?.state === 'active' : v?.state === 'error'));
  console.log('Initial playback state:', JSON.stringify(result));
  if (gpu) {
    assert.ok(result?.output && result.output.includes(String((target * 16) / 9)));
    assert.equal(result?.timings && 'codec' in result.timings, true);
    assert.ok(result!.presentedAt! > Date.now() - 1000);
    assert.ok(result!.presented! > 0);
    await page.screenshot({ path: 'test-results/enhancing.png' });
    fs.writeFileSync('test-results/decoders.json', JSON.stringify(media(), null, 2));
    assert.ok(
      await page
        .locator('.player iframe')
        .evaluate(
          (e) =>
            Number(getComputedStyle(e).zIndex) >
            (parseInt(getComputedStyle(document.querySelector('#main')!).zIndex, 10) || 0),
        ),
    );
    assert.equal(
      await page.locator('.player iframe').evaluate((e) => getComputedStyle(e).pointerEvents),
      'none',
    );
    if (process.env.VSR_MEASURE_SECONDS) {
      const duration = Math.min(60, Math.max(1, Number(process.env.VSR_MEASURE_SECONDS))) * 1000;
      const samples = [],
        at = Date.now();
      while (Date.now() - at < duration) {
        samples.push({ at: Date.now(), ...(await state()) });
        await new Promise((r) => setTimeout(r, 200));
      }
      fs.writeFileSync(
        'test-results/browser-metrics.json',
        JSON.stringify(
          {
            browser: await context.browser()!.version(),
            fixture: `${fixtureSize} ${fixtureFps}fps VP9/Opus FFmpeg testsrc2`,
            target,
            decoders: media(),
            mode: process.env.VSR_HEADED === '1' ? 'visible window' : 'headless',
            browserFlags: extraBrowserArgs,
            fixtureSha256: new Bun.CryptoHasher('sha256')
              .update(await Bun.file(video).arrayBuffer())
              .digest('hex'),
            playback: await page.locator('#main').evaluate((v: HTMLVideoElement) => ({
              totalVideoFrames: v.getVideoPlaybackQuality().totalVideoFrames,
              droppedVideoFrames: v.getVideoPlaybackQuality().droppedVideoFrames,
              width: v.videoWidth,
              height: v.videoHeight,
            })),
            samples,
          },
          null,
          2,
        ),
      );
      assert.ok(
        samples.some((s) => (s.presented ?? 0) > 20),
        'Sustained presentation must advance',
      );
      const enhanced = media()?.players.filter(
        (player) =>
          player.target.includes('frame-worker.js') &&
          /"codec":"av1"/.test(player.properties.kVideoTracks || ''),
      );
      if (process.env.VSR_REQUIRE_HW_DECODE === '1')
        assert.ok(
          enhanced?.some((player) => player.properties.kIsPlatformVideoDecoder === 'true'),
          'Enhanced AV1 stream must have platform hardware decoder evidence',
        );
    }
    await page.click('#play');
    await waitState((v) => v?.state === 'paused');
    assert.equal(await page.locator('.player iframe').count(), 0);
    await page.click('#play');
    await waitState((v) => v?.state === 'active');
    await page.click('#seek');
    await waitState((v) => v?.state === 'active');
    await page.click('#replace');
    await waitState((v) => v?.state === 'active');
    await page.click('#spa');
    await waitState((v) => v?.state === 'active');
    await page.evaluate(() => document.querySelector('.player')!.requestFullscreen());
    await waitState((v) => v?.state === 'active');
    await page.evaluate(() => document.exitFullscreen());
    await page.evaluate(() =>
      document.querySelector<HTMLVideoElement>('#main')!.requestFullscreen(),
    );
    await waitState((v) => v?.state === 'bypassed' && /fullscreen/.test(v?.message || ''));
    assert.equal(await page.locator('.player iframe').count(), 0);
    await page.evaluate(() => document.exitFullscreen());
    await waitState((v) => v?.state === 'active');
    await page.evaluate(() => {
      const t = document
        .querySelector<HTMLVideoElement>('#main')!
        .addTextTrack('captions', 'Native fixture');
      t.mode = 'showing';
    });
    await waitState((v) => v?.state === 'bypassed' && /captions/.test(v?.message || ''));
    await page.evaluate(() => {
      for (const t of document.querySelector<HTMLVideoElement>('#main')!.textTracks)
        t.mode = 'disabled';
    });
    await waitState((v) => v?.state === 'active');
    // Playwright enables focus emulation, which keeps background pages visible.
    // Turn it off for this real Page Visibility lifecycle check.
    const lifecycle = await context.newCDPSession(page);
    await lifecycle.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    const hiddenBy = await context.newPage();
    await hiddenBy.goto('about:blank');
    await hiddenBy.bringToFront();
    const emulateVisibility = !(await page.evaluate(() => document.hidden));
    if (emulateVisibility) {
      console.log(
        'Visibility cleanup: emulated hidden state because headless Chromium kept the page visible',
      );
      await worker.evaluate(
        (tabId) =>
          chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
              Object.defineProperty(document, 'hidden', { configurable: true, value: true });
              document.dispatchEvent(new Event('visibilitychange'));
            },
          }),
        tabId,
      );
    }
    await waitState((v) => v?.state === 'paused' && /hidden/.test(v?.message || ''));
    assert.equal(await page.locator('.player iframe').count(), 0);
    await hiddenBy.close();
    await page.bringToFront();
    if (emulateVisibility)
      await worker.evaluate(
        (tabId) =>
          chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
              Reflect.deleteProperty(document, 'hidden');
              document.dispatchEvent(new Event('visibilitychange'));
            },
          }),
        tabId,
      );
    await waitState((v) => v?.state === 'active');
    // Backend failure must reveal the original immediately, then permit retry.
    cli('stop');
    await waitState((v) => ['error', 'bypassed'].includes(v?.state || ''));
    assert.equal(await page.locator('.player iframe').count(), 0);
    await worker.evaluate(
      (tabId) => chrome.tabs.sendMessage(tabId, { type: 'policy-changed' }),
      tabId,
    );
    await waitState((v) => v?.state === 'active');
    const backend = JSON.parse(cli('status'));
    gpuWorkerPids = [
      ...new Set(
        fs
          .readdirSync(`/proc/${backend.pid}/task`)
          .flatMap((task) =>
            fs
              .readFileSync(`/proc/${backend.pid}/task/${task}/children`, 'utf8')
              .trim()
              .split(/\s+/)
              .filter(Boolean),
          ),
      ),
    ];
    assert.ok(
      gpuWorkerPids.length > 0,
      'A real supervised GPU child must exist during active enhancement',
    );
  } else {
    assert.match(result!.message, /native|host|not found/i);
    assert.equal(await page.locator('.player iframe').count(), 0);
  }
  await worker.evaluate(async (tabId) => {
    await chrome.storage.local.set({
      settings: { enabled: false, sites: {}, quality: 3, target: 720 },
    });
    await chrome.tabs.sendMessage(tabId, { type: 'policy-changed' });
  }, tabId);
  await waitState((v) => v?.state === 'disabled');
  assert.equal(await page.locator('.player iframe').count(), 0);
  assert.ok(
    await page.locator('#main').evaluate((v: HTMLVideoElement) => !v.paused && v.currentTime > 0),
    'Original playback must continue',
  );
  if (gpu) {
    await new Promise((resolve) => setTimeout(resolve, 6000));
    const idle = JSON.parse(cli('status'));
    assert.equal(idle.gpu_loaded, false, 'Idle timeout must destroy the GPU engine');
    const allocations = execFileSync(
      'nvidia-smi',
      ['--query-compute-apps=pid,used_gpu_memory', '--format=csv,noheader,nounits'],
      { encoding: 'utf8' },
    );
    const ownedPids = [String(idle.pid), ...gpuWorkerPids];
    const remaining = allocations
      .split('\n')
      .find((line) => ownedPids.includes(line.split(',')[0].trim()));
    console.log(
      'Idle GPU allocation:',
      remaining || 'Backend absent from NVIDIA compute allocations',
    );
    assert.ok(
      gpuWorkerPids.every((pid) => !fs.existsSync(`/proc/${pid}`)),
      'Idle GPU child must be reaped, not just unreported by the daemon',
    );
    assert.ok(
      !remaining || Number(remaining.split(',')[1]) <= 16,
      'Idle engine must release its large GPU allocations',
    );
  }
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.screenshot({ path: 'test-results/popup.png' });
  const saved = await popup.evaluate(
    (tabId) => chrome.runtime.sendMessage({ type: 'automatic', tabId, enabled: true }),
    tabId,
  );
  assert.ok(!saved.error, JSON.stringify(saved));
  assert.ok(
    (await worker.evaluate(() => chrome.scripting.getRegisteredContentScripts())).length > 0,
  );
  await context.close();
  context = await chromium.launchPersistentContext(`${root}/profile`, launchOptions);
  const restarted =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent('serviceworker', { timeout: 15000 }));
  const stored = await restarted.evaluate(() =>
    chrome.storage.local.get<{ settings: Settings }>('settings'),
  );
  assert.equal(
    stored.settings.sites[origin],
    true,
    'Site rule must survive a real browser restart',
  );
  assert.equal(stored.settings.enabled, false, 'Global disable must persist across restart');
  console.log(
    `${gpu ? 'GPU' : 'CPU'} browser checks passed (${await context.browser()!.version()}). Profile: ${root}`,
  );
} finally {
  await context?.close();
  server.close();
  try {
    cli('stop');
  } catch {}
  if (!process.env.VSR_KEEP_TEST_PROFILE) fs.rmSync(root, { recursive: true, force: true });
}
