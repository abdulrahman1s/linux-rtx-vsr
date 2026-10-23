// Timing/recovery portions Copyright (c) 2026 maxiarat1 and contributors.
// Adapted under MIT; see licenses/linux-nvidia-vsr-MIT.txt.
import { errorMessage } from './errors.ts';
import { captureCapacity } from './frame-budget.ts';
import { createPacketDecoder, type PacketDecoder } from './video-decoder.ts';
// NVENC AV1 decoding and presentation stay off the page's main thread.
import type {
  WorkerInit,
  ClockMessage,
  FrameMetadata,
  FrameMessage,
  CaptureMessage,
} from './protocol.ts';
export interface FrameEnvironment {
  now(): number;
  schedule(callback: () => void): () => void;
  connect(url: string): WebSocket;
  createDecoder(): PacketDecoder;
}
const browser: FrameEnvironment = {
  now: () => performance.timeOrigin + performance.now(),
  schedule: (callback) => {
    if (typeof requestAnimationFrame === 'function') {
      const handle = requestAnimationFrame(callback);
      return () => cancelAnimationFrame(handle);
    }
    const handle = setTimeout(callback, 8);
    return () => clearTimeout(handle);
  },
  connect: (url) => new WebSocket(url),
  createDecoder: createPacketDecoder,
};
// Owns transport, bounded decode queue, fresh presentation and cancellation.
// The worker and tests cross the same seam; browser facilities vary via env.
export function startFrameSession(init: WorkerInit, env: FrameEnvironment = browser): () => void {
  const { port, canvas, auth, quality, scale } = init;
  const decoder = env.createDecoder();
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
  if (!ctx) throw new Error('Browser cannot create the presentation canvas');
  let ws: WebSocket,
    ready = false,
    epoch = 0;
  let clock: ClockMessage | null = null,
    pending: FrameMetadata | null = null;
  let queue: { bitmap: VideoFrame; meta: FrameMetadata; decodedAt: number }[] = [],
    stopped = false;
  let presented = 0,
    dropped = 0,
    lastPresented = 0,
    lastReport = -Infinity,
    startupMs: number | null = null;
  const { now } = env;
  const inFlight = new Map<number, { sentAt: number; captureMs: number; handoffMs: number }>();
  const started = now();
  let lastTick = started,
    cancelTick = () => {};
  function send(value: FrameMessage) {
    port?.postMessage(value);
  }
  function fail(message: string, retryable = false) {
    if (!stopped) send({ type: 'error', message, retryable });
    closeAll();
  }
  function flush() {
    for (const item of queue) item.bitmap.close();
    queue = [];
  }
  function closeAll() {
    if (stopped) return;
    stopped = true;
    ready = false;
    cancelTick();
    flush();
    inFlight.clear();
    decoder.close();
    ws?.close();
  }
  port.onmessage = receive;
  port.start();
  ws = env.connect(`ws://127.0.0.1:${auth.port}/v1/stream`);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => ws.send(JSON.stringify({ token: auth.token, quality, scale, protocol: 3 }));
  ws.onerror = () => fail('Cannot connect to the local engine. Run linux-rtx-vsr doctor.', true);
  ws.onclose = () => {
    if (!stopped)
      fail('Engine disconnected. The original video is playing; enable again to retry.', true);
  };
  ws.onmessage = async (event) => {
    if (typeof event.data === 'string') {
      try {
        const value = JSON.parse(event.data);
        if (value.type === 'ready') {
          if (value.protocol !== 3)
            throw new Error(
              'Streaming protocol changed; update the native application and extension together',
            );
          ready = true;
          send({ type: 'ready' });
        } else if (value.type === 'error') fail(value.message);
        else if (value.type === 'frame') pending = value;
      } catch (error) {
        fail(errorMessage(error));
      }
      return;
    }
    const meta = pending;
    pending = null;
    try {
      const capture = meta && inFlight.get(meta.sequence);
      if (!meta || !capture)
        throw new Error('Frame protocol mismatch; update the extension and application together');
      const receivedAt = now();
      meta.request_ms =
        meta.received_wall_ms === undefined ? undefined : meta.received_wall_ms - capture.sentAt;
      meta.response_ms =
        meta.completed_wall_ms === undefined ? undefined : receivedAt - meta.completed_wall_ms;
      const bitmap = await decoder.decode(event.data, meta);
      meta.decode_ms = now() - receivedAt;
      meta.round_trip_ms = receivedAt - capture.sentAt;
      meta.capture_ms = capture.captureMs;
      meta.capture_handoff_ms = capture.handoffMs;
      if (stopped || meta.epoch !== epoch || clock?.rate === 0) {
        bitmap.close();
        return;
      }
      // Up to eight GPU pictures, further limited to ~256 MiB of NV12 pixels.
      // Browser decoder surfaces add their own implementation-specific memory.
      const capacity = Math.max(
        1,
        Math.min(8, Math.floor((256 * 1024 * 1024) / (meta.width * meta.height * 1.5))),
      );
      queue.push({ bitmap, meta, decodedAt: now() });
      // Overlapping native staging/decode can complete out of media order.
      // Keep the next audible deadline at the head, as in the upstream renderer.
      queue.sort((a, b) => a.meta.timestamp - b.meta.timestamp);
      if (queue.length > capacity) {
        queue.shift()!.bitmap.close();
        dropped++;
      }
      const mediaNow = clock
        ? clock.input + ((now() - clock.at) * clock.rate) / 1000
        : meta.timestamp;
      send({
        type: 'decoded',
        ageMs: Math.max(0, ((mediaNow - meta.timestamp) * 1000) / (clock?.rate || 1)),
      });
    } catch (error) {
      if (!stopped) fail(errorMessage(error));
    } finally {
      if (meta) inFlight.delete(meta.sequence);
      if (!stopped) send({ type: 'available' });
    }
  };
  tick();
  return closeAll;
  async function receive(event: MessageEvent<CaptureMessage>) {
    const value = event.data;
    if (value.type === 'clock') {
      clock = value;
      if (value.rate === 0) {
        // Hold the last canvas picture. Still decode pending predictive
        // packets, but discard their surfaces and never call it active.
        flush();
        lastPresented = 0;
        lastReport = -Infinity;
      }
      if (epoch !== value.epoch) {
        epoch = value.epoch;
        flush();
      }
      // Adapted from maxiarat1/linux-nvidia-vsr's renderer (MIT). Chromium
      // may suspend a pending worker RAF while the iframe is transparent.
      // Live source clocks recover the lost tick without a permanent timer,
      // and cancel the old callback so resumed RAF cannot fork the loop.
      if (!stopped && now() - lastTick > 100) tick();
      return;
    }
    if (value.type === 'stop') {
      closeAll();
      return;
    }
    if (value.type !== 'capture') return;
    if (
      !ready ||
      inFlight.size >= captureCapacity(value.buffer.byteLength) ||
      stopped ||
      value.epoch !== epoch
    ) {
      sendRecycle(value.buffer);
      send({ type: 'available' });
      return;
    }
    try {
      if (inFlight.has(value.sequence)) throw new Error('Duplicate captured sequence');
      const sentAt = now();
      inFlight.set(value.sequence, {
        sentAt,
        captureMs: value.captureMs,
        handoffMs: value.copiedAt === undefined ? 0 : Math.max(0, sentAt - value.copiedAt),
      });
      ws.send(value.buffer);
      sendRecycle(value.buffer);
    } catch (error) {
      inFlight.delete(value.sequence);
      fail(`Cannot capture this video: ${errorMessage(error)}`);
    }
  }
  function sendRecycle(buffer: ArrayBuffer) {
    port.postMessage({ type: 'recycle', buffer }, [buffer]);
  }
  function tick() {
    if (stopped) return;
    cancelTick();
    const time = now();
    lastTick = time;
    if (clock && clock.rate > 0 && time - clock.at < 500) {
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
          if (canvas.width !== meta.width || canvas.height !== meta.height) {
            canvas.width = meta.width;
            canvas.height = meta.height;
          }
          const drawingAt = now();
          ctx!.drawImage(bitmap, 0, 0);
          meta.draw_ms = now() - drawingAt;
          meta.presentation_wait_ms = time - selected.decodedAt;
          lastPresented = time;
          presented++;
          startupMs ??= time - started;
          // Draw every due picture; reporting at 10 Hz avoids a DOM/layout
          // inspection and a cloned stats object on the page for every frame.
          // First/recovered presentation and stale transitions stay immediate.
          if (time - lastReport >= 100) {
            lastReport = time;
            send({
              type: 'presented',
              presentedAt: time,
              epoch,
              presented,
              dropped,
              fps: (presented * 1000) / (time - started),
              latenessMs: lateness * 1000,
              stats: meta,
              startupMs,
            });
          }
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
      lastReport = -Infinity;
    }
    cancelTick = env.schedule(tick);
  }
}
