import { errorMessage } from './errors.ts';
// Capture, JPEG decoding and presentation stay off the page's main thread.
import type {
  WorkerInit,
  ClockMessage,
  FrameMetadata,
  FrameMessage,
  CaptureMessage,
} from './protocol.ts';
export interface FrameEnvironment {
  now(): number;
  schedule(callback: () => void): void;
  connect(url: string): WebSocket;
  decode(data: ArrayBuffer): Promise<ImageBitmap>;
}
const browser: FrameEnvironment = {
  now: () => performance.timeOrigin + performance.now(),
  schedule: (callback) =>
    typeof requestAnimationFrame === 'function'
      ? void requestAnimationFrame(callback)
      : void setTimeout(callback, 8),
  connect: (url) => new WebSocket(url),
  decode: (data) => createImageBitmap(new Blob([data], { type: 'image/jpeg' })),
};
// Owns transport, bounded decode queue, fresh presentation and cancellation.
// The worker and tests cross the same seam; browser facilities vary via env.
export function startFrameSession(init: WorkerInit, env: FrameEnvironment = browser): () => void {
  const { port, canvas, auth, quality, scale } = init;
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
  if (!ctx) throw new Error('Browser cannot create the presentation canvas');
  let ws: WebSocket,
    inFlight = false,
    ready = false,
    epoch = 0;
  let clock: ClockMessage | null = null,
    pending: FrameMetadata | null = null;
  let queue: { bitmap: ImageBitmap; meta: FrameMetadata }[] = [],
    stopped = false;
  let presented = 0,
    dropped = 0,
    lastPresented = 0,
    startupMs: number | null = null;
  const { now } = env;
  const started = now();
  function send(value: FrameMessage) {
    port?.postMessage(value);
  }
  function fail(message: string) {
    if (!stopped) send({ type: 'error', message });
    closeAll();
  }
  function flush() {
    for (const item of queue) item.bitmap.close();
    queue = [];
  }
  function closeAll() {
    stopped = true;
    ready = false;
    flush();
    ws?.close();
  }
  port.onmessage = receive;
  port.start();
  ws = env.connect(`ws://127.0.0.1:${auth.port}/v1/stream`);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => ws.send(JSON.stringify({ token: auth.token, quality, scale }));
  ws.onerror = () => fail('Cannot connect to the local engine. Run linux-rtx-vsr doctor.');
  ws.onclose = () => {
    if (!stopped)
      fail('Engine disconnected. The original video is playing; enable again to retry.');
  };
  ws.onmessage = async (event) => {
    if (typeof event.data === 'string') {
      try {
        const value = JSON.parse(event.data);
        if (value.type === 'ready') {
          ready = true;
          send({ type: 'ready' });
        } else if (value.type === 'error') fail(value.message);
        else if (value.type === 'frame') pending = value;
      } catch (error) {
        fail(errorMessage(error));
      }
      return;
    }
    try {
      const meta = pending;
      pending = null;
      if (!meta || !inFlight)
        throw new Error('Frame protocol mismatch; update the extension and application together');
      const bitmap = await env.decode(event.data);
      if (stopped || meta.epoch !== epoch) {
        bitmap.close();
        return;
      }
      if (queue.length >= 8) {
        queue.shift()!.bitmap.close();
        dropped++;
      }
      queue.push({ bitmap, meta });
      const mediaNow = clock
        ? clock.input + ((now() - clock.at) * clock.rate) / 1000
        : meta.timestamp;
      send({
        type: 'decoded',
        ageMs: Math.max(0, ((mediaNow - meta.timestamp) * 1000) / (clock?.rate || 1)),
      });
    } catch (error) {
      fail(errorMessage(error));
    } finally {
      inFlight = false;
      send({ type: 'available' });
    }
  };
  tick();
  return closeAll;
  async function receive(event: MessageEvent<CaptureMessage>) {
    const value = event.data;
    if (value.type === 'clock') {
      clock = value;
      if (epoch !== value.epoch) {
        epoch = value.epoch;
        flush();
      }
      return;
    }
    if (value.type === 'stop') {
      closeAll();
      return;
    }
    if (value.type !== 'capture') return;
    if (!ready || inFlight || stopped || value.epoch !== epoch) {
      send({ type: 'available' });
      return;
    }
    inFlight = true;
    try {
      ws.send(value.buffer);
      sendRecycle(value.buffer);
    } catch (error) {
      inFlight = false;
      fail(`Cannot capture this video: ${errorMessage(error)}`);
    }
  }
  function sendRecycle(buffer: ArrayBuffer) {
    port.postMessage({ type: 'recycle', buffer }, [buffer]);
  }
  function tick() {
    if (stopped) return;
    const time = now();
    if (clock && time - clock.at < 500) {
      const audible = clock.media + ((time - clock.at) * clock.rate) / 1000;
      // Keep future frames; discard old pictures instead of accumulating delay.
      let selected = null;
      while (queue.length && queue[0].meta.timestamp <= audible + 0.008 * clock.rate) {
        if (selected) {
          selected.bitmap.close();
          dropped++;
        }
        selected = queue.shift()!;
      }
      if (selected) {
        const lateness = (audible - selected.meta.timestamp) / clock.rate;
        if (lateness <= 0.08) {
          const { bitmap, meta } = selected;
          if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
          }
          ctx!.drawImage(bitmap, 0, 0);
          lastPresented = time;
          presented++;
          startupMs ??= time - started;
          send({
            type: 'presented',
            epoch,
            presented,
            dropped,
            fps: (presented * 1000) / (time - started),
            latenessMs: lateness * 1000,
            stats: meta,
            startupMs,
          });
        } else {
          dropped++;
        }
        selected.bitmap.close();
      }
    }
    if (lastPresented && time - lastPresented > 200) {
      send({
        type: 'stale',
        message: 'Waiting for a fresh synchronized frame',
      });
      lastPresented = 0;
    }
    env.schedule(tick);
  }
}
