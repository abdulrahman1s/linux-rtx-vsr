import {
  chromium,
  type BrowserContext,
  type LaunchOptions,
  type ConnectOverCDPTransport,
} from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

// Both launch modes own a disposable profile/process. CDP is useful when a
// branded browser stalls during Playwright's pipe-based startup handshake.
export interface FixtureBrowser {
  context: BrowserContext;
  close(): Promise<void>;
}
export async function launchFixtureBrowser(
  profile: string,
  options: LaunchOptions,
  cdp: boolean,
): Promise<FixtureBrowser> {
  if (!cdp) {
    const context = await chromium.launchPersistentContext(profile, options);
    return { context, close: () => context.close() };
  }
  if (!options.executablePath) throw new Error('CDP fixture requires CHROMIUM_PATH');
  fs.mkdirSync(profile, { recursive: true });
  const portFile = path.join(profile, 'DevToolsActivePort');
  fs.rmSync(portFile, { force: true });
  const child = Bun.spawn(
    [
      options.executablePath,
      `--user-data-dir=${profile}`,
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
      '--no-first-run',
      '--no-default-browser-check',
      '--password-store=basic',
      ...(options.headless ? ['--headless=new'] : []),
      ...(options.args || []),
      'about:blank',
    ],
    {
      env: options.env,
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: Bun.file(path.join(profile, 'browser.log')),
    },
  );
  let exited = false;
  void child.exited.then(() => {
    exited = true;
  });
  async function stop() {
    if (!exited) child.kill('SIGTERM');
    // Only the owned process is signalled, never a PID read from a file.
    const timeout = setTimeout(() => {
      if (!exited) child.kill('SIGKILL');
    }, 5000);
    try {
      await child.exited;
    } finally {
      clearTimeout(timeout);
    }
  }
  try {
    const deadline = Date.now() + (options.timeout || 30000);
    while (!fs.existsSync(portFile)) {
      if (exited || Date.now() >= deadline)
        throw new Error(`Fixture browser did not start; inspect ${profile}/browser.log`);
      await Bun.sleep(50);
    }
    const [port, endpoint] = fs.readFileSync(portFile, 'utf8').trim().split('\n');
    if (!/^\d+$/.test(port) || !endpoint?.startsWith('/devtools/browser/'))
      throw new Error('Invalid disposable browser debugging endpoint');
    // Use Bun's native WebSocket instead of Playwright's Node ws adapter,
    // whose handshake can stall under the pinned Bun on branded Chromium.
    const socket = new WebSocket(`ws://127.0.0.1:${port}${endpoint}`);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error('Disposable CDP socket timed out'));
      }, options.timeout || 30000);
      socket.onopen = () => {
        clearTimeout(timeout);
        resolve();
      };
      socket.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('Disposable CDP socket failed'));
      };
    });
    const transport: ConnectOverCDPTransport = {
      send: (message) => socket.send(JSON.stringify(message)),
      close: () => socket.close(),
    };
    socket.onmessage = (event) => transport.onmessage?.(JSON.parse(String(event.data)));
    socket.onclose = (event) => transport.onclose?.(event.reason);
    const browser = await chromium.connectOverCDP(transport, {
      timeout: options.timeout,
      // Match ordinary browser focus/media behavior in hardware trials.
      noDefaults: true,
    });
    const context = browser.contexts()[0];
    if (!context) throw new Error('Fixture browser has no context');
    return {
      context,
      async close() {
        // Close gracefully so saved rules reach disk before restart.
        try {
          await browser.close();
        } finally {
          await stop();
        }
      },
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
