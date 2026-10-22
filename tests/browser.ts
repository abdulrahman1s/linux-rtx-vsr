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
import { launchFixtureBrowser, type FixtureBrowser } from './browser-launch.ts';
const gpu = process.env.VSR_GPU_TEST === '1';
const colorTest = process.env.VSR_COLOR_TEST === '1';
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
const extension = path.resolve(process.env.VSR_EXTENSION_DIR || 'build/extension');
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
  `${colorTest ? 'smptehdbars' : 'testsrc2'}=size=${fixtureSize}:rate=${fixtureFps}`,
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
  ...(colorTest
    ? ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709']
    : []),
  '-c:a',
  'libopus',
  video,
]);
const server = http.createServer((req, res) => {
  const route = new URL(req.url || '/', 'http://localhost').pathname;
  const file =
    route === '/fixture.webm'
      ? video
      : route === '/player.js' || route === '/audio.js'
        ? `build/fixtures${route}`
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
  entrypoints: ['tests/fixtures/player.ts', 'tests/fixtures/audio.ts'],
  outdir: 'build/fixtures',
  target: 'browser',
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
let context: BrowserContext | undefined,
  browser: FixtureBrowser | undefined,
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
  browser = await launchFixtureBrowser(
    `${root}/profile`,
    launchOptions,
    process.env.VSR_CDP === '1',
  );
  context = browser.context;
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
  // Exercise the actual default origin without contacting YouTube. Deliberately
  // omit its dynamic registration: the navigation recovery must attach anyway.
  await worker.evaluate(() => chrome.scripting.unregisterContentScripts({ ids: ['vsr-sites'] }));
  const youtube = await context.newPage();
  await youtube.route('https://www.youtube.com/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Automatic attachment fixture</title><video style="width:640px;height:360px"></video>',
    }),
  );
  await youtube.goto('https://www.youtube.com/watch?v=local-fixture');
  const youtubeTab = await worker.evaluate(
    async () => (await chrome.tabs.query({ url: 'https://www.youtube.com/*' }))[0].id!,
  );
  await expectAutomaticAttachment();
  // Open another document while globally disabled, then change the saved policy
  // without notifying it. A popup snapshot must recover this unattached tab.
  await worker.evaluate(() => chrome.storage.local.set({ settings: { enabled: false } }));
  await youtube.goto('https://www.youtube.com/watch?v=existing-document');
  assert.equal(
    await worker.evaluate(
      (tabId) =>
        chrome.tabs.sendMessage(tabId, { type: 'probe' }).then(
          () => true,
          () => false,
        ),
      youtubeTab,
    ),
    false,
    'Disabled page must begin without an injected content script',
  );
  await worker.evaluate(() => chrome.storage.local.set({ settings: { enabled: true } }));
  const attachmentPopup = await context.newPage();
  await attachmentPopup.goto(`chrome-extension://${id}/popup.html`);
  // Popup snapshots probe an existing script without refreshing its policy or
  // repeatedly retrying a failed backend. This must preserve the reported state.
  const snapshot = await attachmentPopup.evaluate(
    (tabId) => chrome.runtime.sendMessage({ type: 'snapshot', tabId }),
    youtubeTab,
  );
  assert.ok(!snapshot.error, JSON.stringify(snapshot));
  await expectAutomaticAttachment();
  const unchanged = await attachmentPopup.evaluate(
    (tabId) => chrome.runtime.sendMessage({ type: 'snapshot', tabId }),
    youtubeTab,
  );
  assert.equal(unchanged.state.state, 'paused');
  // Global re-enable also attaches existing documents without a page refresh.
  await worker.evaluate(() => chrome.storage.local.set({ settings: { enabled: false } }));
  await youtube.goto('https://www.youtube.com/watch?v=global-enable');
  await attachmentPopup.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'settings', enabled: true }),
  );
  await expectAutomaticAttachment();
  await attachmentPopup.close();
  await youtube.close();
  console.log('Automatic attachment passed: YouTube navigation, existing tab, global re-enable');
  async function expectAutomaticAttachment() {
    for (let attempt = 0; attempt < 100; attempt++) {
      const state = await worker.evaluate(
        async (tabId) =>
          (
            await chrome.storage.session.get<Record<string, PlaybackStatus | undefined>>(
              `state:${tabId}`,
            )
          )[`state:${tabId}`],
        youtubeTab,
      );
      if (state?.state === 'paused') return;
      await Bun.sleep(50);
    }
    assert.fail('Enabled YouTube tab must detect its video without manual injection');
  }
  // Small lifecycle fixture uses 720p; performance runs explicitly select 4K.
  const target = Number(process.env.VSR_TEST_TARGET || 720);
  await worker.evaluate(async (target) => {
    await chrome.storage.local.set({ settings: { enabled: true, sites: {}, quality: 3, target } });
  }, target);
  // A branded browser's startup DevTools target may not be a registered tab.
  // Create an owned tab explicitly instead of treating pages()[0] as one.
  const page = await context.newPage();
  await page.bringToFront();
  const media = gpu ? await observeMedia(context, page) : () => undefined;
  page.on('pageerror', (e) => console.log('Page error:', e.message));
  if (process.env.VSR_DEBUG) page.on('console', (m) => console.log('Browser:', m.text()));
  await page.goto(origin);
  await page.addScriptTag({ url: `${origin}/audio.js`, type: 'module' });
  const audioProbe = await page.evaluate(() => globalThis.vsrAudioProbe());
  assert.ok(audioProbe.maximum_step < 0.03, `Audio discontinuity: ${JSON.stringify(audioProbe)}`);
  assert.ok(
    audioProbe.dry_error < 0.0001,
    `Bypass must restore the undelayed waveform: ${JSON.stringify(audioProbe)}`,
  );
  console.log('Offline browser audio continuity:', JSON.stringify(audioProbe));
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
    const overlay = await page.locator('.player iframe').elementHandle();
    assert.ok(overlay);
    assert.equal(await overlay.evaluate((e) => getComputedStyle(e).opacity), '1');
    // Verify both the DOM lifetime and every compositor tick during a quick
    // pause/resume. Recreating the iframe or hiding it caused the old flash.
    await page.waitForTimeout(300);
    if (colorTest) {
      const player = page.locator('.player');
      const enhanced = await player.screenshot({ scale: 'css' });
      await overlay.evaluate((e) => {
        e.style.visibility = 'hidden';
      });
      const original = await player.screenshot({ scale: 'css' });
      await overlay.evaluate((e) => {
        e.style.visibility = '';
      });
      const rgb = (png: Buffer) =>
        execFileSync(
          'ffmpeg',
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-i',
            'pipe:0',
            '-f',
            'rawvideo',
            '-pix_fmt',
            'rgb24',
            'pipe:1',
          ],
          { input: png, maxBuffer: 4 * 1024 * 1024 },
        );
      const a = rgb(original),
        b = rgb(enhanced);
      const width = original.readUInt32BE(16),
        height = original.readUInt32BE(20);
      assert.equal(a.length, width * height * 3);
      assert.equal(b.length, a.length);
      assert.equal(enhanced.readUInt32BE(16), width);
      assert.equal(enhanced.readUInt32BE(20), height);
      // Static, flat SMPTE HD patches avoid motion, model edge sharpening,
      // 4:2:0 chroma boundaries, captions and the player's buttons.
      const samples = [0.15, 0.25, 0.35, 0.5, 0.65, 0.75, 0.85].map((x) => {
        const i = (Math.floor(height / 4) * width + Math.floor(x * width)) * 3;
        return { x, original: [...a.subarray(i, i + 3)], enhanced: [...b.subarray(i, i + 3)] };
      });
      const capture = await page.locator('#main').evaluate(async (video: HTMLVideoElement) => {
        const frame = new VideoFrame(video);
        try {
          const pixels = new Uint8Array(frame.displayWidth * frame.displayHeight * 4);
          await frame.copyTo(pixels, { format: 'RGBA', colorSpace: 'srgb' });
          const canvas = document.createElement('canvas');
          canvas.width = frame.displayWidth;
          canvas.height = frame.displayHeight;
          const ctx = canvas.getContext('2d')!;
          ctx.drawImage(video, 0, 0);
          return {
            format: frame.format,
            color: frame.colorSpace.toJSON(),
            samples: [0.15, 0.25, 0.35, 0.5, 0.65, 0.75, 0.85].map((x) => {
              const px = Math.floor(x * frame.displayWidth),
                py = Math.floor(frame.displayHeight / 4);
              const i = (py * frame.displayWidth + px) * 4;
              return {
                x,
                copy: [...pixels.subarray(i, i + 3)],
                canvas: [...ctx.getImageData(px, py, 1, 1).data].slice(0, 3),
              };
            }),
          };
        } finally {
          frame.close();
        }
      });
      const maxError = Math.max(
        ...samples.flatMap((s) => s.original.map((v, i) => Math.abs(v - s.enhanced[i]))),
      );
      fs.writeFileSync('test-results/color-original.png', original);
      fs.writeFileSync('test-results/color-enhanced.png', enhanced);
      fs.writeFileSync(
        'test-results/color-metrics.json',
        JSON.stringify(
          {
            browser: await context.browser()!.version(),
            source: 'SMPTE HD SDR Rec.709',
            fixture: `${fixtureSize} ${fixtureFps}fps VP9/Opus`,
            target,
            browserFlags: extraBrowserArgs,
            capture,
            samples,
            maxError,
          },
          null,
          2,
        ),
      );
      console.log('Color round trip:', JSON.stringify({ samples, maxError, capture }));
      assert.ok(maxError <= 8, `Color-managed flat patches shifted by ${maxError}/255`);
    }
    await overlay.evaluate((element) => {
      const changes: { at: number; visible: boolean }[] = [];
      (window as unknown as { vsrTransition: typeof changes }).vsrTransition = changes;
      const until = performance.now() + 600;
      function inspect() {
        changes.push({
          at: performance.now(),
          visible: element.isConnected && getComputedStyle(element).opacity === '1',
        });
        if (performance.now() < until) requestAnimationFrame(inspect);
      }
      inspect();
    });
    await page.click('#play');
    await waitState((v) => v?.state === 'active');
    await page.waitForTimeout(650);
    assert.equal(
      await overlay.evaluate((e) => e.isConnected),
      true,
      'Quick resume must reuse the same iframe/decoder',
    );
    const transition = await page.evaluate(
      () =>
        (window as unknown as { vsrTransition: { at: number; visible: boolean }[] }).vsrTransition,
    );
    console.log(
      'Resume visibility:',
      JSON.stringify({
        samples: transition.length,
        hidden: transition.filter((sample) => !sample.visible),
      }),
    );
    assert.ok(
      transition.every((sample) => sample.visible),
      'Quick resume must never hide or replace the painted overlay',
    );
    // Longer pauses release the stream lease but retain one frozen picture;
    // a later session must retire it after its first actual presentation.
    await page.click('#play');
    await waitState((v) => v?.state === 'paused');
    await page.waitForTimeout(5700);
    const paused = {
      state: await state(),
      overlays: await page.locator('.player iframe').evaluateAll((elements) =>
        elements.map((e) => ({
          connected: e.isConnected,
          opacity: getComputedStyle(e).opacity,
        })),
      ),
      status: JSON.parse(cli('status')),
    };
    console.log('Long pause:', JSON.stringify(paused));
    assert.equal(
      await overlay.evaluate((e) => e.isConnected && getComputedStyle(e).opacity === '1'),
      true,
    );
    assert.equal(
      JSON.parse(cli('status')).streaming,
      false,
      'A longer pause must release the native stream lease',
    );
    assert.equal(paused.status.gpu_loaded, false, 'Long pause must allow GPU idle cleanup');
    await page.click('#play');
    await waitState((v) => v?.state === 'active');
    assert.equal(await overlay.evaluate((e) => e.isConnected), false);
    assert.equal(await page.locator('.player iframe').count(), 1);
    fs.writeFileSync(
      'test-results/pause-metrics.json',
      JSON.stringify(
        {
          browser: await context.browser()!.version(),
          fixture: `${fixtureSize} ${fixtureFps}fps VP9/Opus`,
          target,
          quick: transition,
          paused,
        },
        null,
        2,
      ),
    );
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
  await browser.close();
  browser = await launchFixtureBrowser(
    `${root}/profile`,
    launchOptions,
    process.env.VSR_CDP === '1',
  );
  context = browser.context;
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
  try {
    await browser?.close();
  } finally {
    server.close();
    try {
      cli('stop');
    } catch {}
    if (!process.env.VSR_KEEP_TEST_PROFILE) fs.rmSync(root, { recursive: true, force: true });
  }
}
