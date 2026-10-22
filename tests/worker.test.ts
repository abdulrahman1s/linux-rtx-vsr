import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { startFrameSession } from '../extension/src/frame-session.ts';
import type { FrameMessage, CaptureMessage } from '../extension/src/protocol.ts';
function fixture(decode?: (data: ArrayBuffer) => Promise<VideoFrame>) {
  const messages: FrameMessage[] = [],
    sent: unknown[] = [];
  let callback = () => {},
    time = 1000,
    draws = 0,
    closed = 0;
  // Browser adapters exercise the public session interface without a VM or
  // access to private queues. Partial platform objects are confined here.
  const port = {
    postMessage: (m: FrameMessage) => {
      messages.push(m);
    },
    start() {},
    onmessage: (_event: MessageEvent<CaptureMessage>) => {},
  };
  const socket = {
    send: (value: unknown) => sent.push(value),
    close() {},
    onopen: () => {},
    onmessage: async (_event: { data: string | ArrayBuffer }) => {},
  };
  const stop = startFrameSession(
    {
      type: 'init',
      port: port as unknown as MessagePort,
      canvas: {
        getContext: () => ({
          drawImage() {
            draws++;
          },
        }),
      } as unknown as OffscreenCanvas,
      auth: { port: 123, token: 'test' },
      quality: 3,
      scale: 2,
    },
    {
      now: () => time,
      schedule: (fn) => {
        callback = fn;
      },
      connect: () => socket as unknown as WebSocket,
      createDecoder: () => ({
        close() {},
        decode:
          decode ||
          (async () =>
            ({
              close() {
                closed++;
              },
            }) as VideoFrame),
      }),
    },
  );
  const input = (data: CaptureMessage) => port.onmessage({ data } as MessageEvent<CaptureMessage>);
  return {
    messages,
    sent,
    socket,
    input,
    stop,
    tick: () => callback(),
    advance: (t: number) => {
      time = t;
    },
    draws: () => draws,
    closed: () => closed,
  };
}
test('session holds backpressure through metadata and reports active only after fresh drawing', async () => {
  const f = fixture();
  f.socket.onopen();
  await f.socket.onmessage({ data: JSON.stringify({ type: 'ready', protocol: 2 }) });
  assert.ok(!f.messages.some((m) => m.type === 'presented'));
  f.input({ type: 'clock', epoch: 1, media: 1, input: 1, at: 1000, rate: 1 });
  f.input({ type: 'capture', buffer: new ArrayBuffer(48), sequence: 1, captureMs: 1, epoch: 1 });
  const before = f.messages.filter((m) => m.type === 'available').length;
  await f.socket.onmessage({
    data: JSON.stringify({
      type: 'frame',
      sequence: 1,
      epoch: 1,
      timestamp: 1,
      width: 1280,
      height: 720,
    }),
  });
  assert.equal(f.messages.filter((m) => m.type === 'available').length, before);
  await f.socket.onmessage({ data: new ArrayBuffer(4) });
  assert.ok(!f.messages.some((m) => m.type === 'presented'));
  f.tick();
  assert.equal(f.draws(), 1);
  assert.equal(f.closed(), 1);
  assert.ok(f.messages.some((m) => m.type === 'presented'));
  f.advance(1300);
  f.tick();
  assert.ok(f.messages.some((m) => m.type === 'stale'));
  f.input({ type: 'stop' });
  assert.equal(f.sent.length, 2);
});
test('old JPEG protocol cannot become ready or active', async () => {
  const f = fixture();
  await f.socket.onmessage({ data: JSON.stringify({ type: 'ready', protocol: 1 }) });
  assert.ok(f.messages.some((m) => m.type === 'error' && /update/.test(m.message)));
  assert.ok(!f.messages.some((m) => m.type === 'ready' || m.type === 'presented'));
});
test('session bounds overlapping requests and retains matching capture timings', async () => {
  const f = fixture();
  await f.socket.onmessage({ data: JSON.stringify({ type: 'ready', protocol: 2 }) });
  f.input({ type: 'clock', epoch: 0, media: 1, input: 1, at: 1000, rate: 1 });
  for (const sequence of [1, 2, 3])
    f.input({
      type: 'capture',
      buffer: new ArrayBuffer(48),
      sequence,
      captureMs: sequence * 2,
      epoch: 0,
    });
  assert.equal(f.sent.length, 2, 'A third raw frame must never queue on the socket');
  await f.socket.onmessage({
    data: JSON.stringify({
      type: 'frame',
      sequence: 1,
      epoch: 0,
      timestamp: 1,
      width: 1280,
      height: 720,
    }),
  });
  await f.socket.onmessage({ data: new ArrayBuffer(4) });
  f.tick();
  const drawn = f.messages.find((m) => m.type === 'presented');
  assert.ok(drawn?.type === 'presented');
  assert.equal(drawn.stats.capture_ms, 2);
  f.input({ type: 'capture', buffer: new ArrayBuffer(48), sequence: 4, captureMs: 8, epoch: 0 });
  assert.equal(f.sent.length, 3, 'Decoded output must release exactly one slot');
  f.stop();
});
test('seek discards decoded output from a previous epoch', async () => {
  let resolve!: (frame: VideoFrame) => void,
    closed = false;
  const f = fixture(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  await f.socket.onmessage({ data: JSON.stringify({ type: 'ready', protocol: 2 }) });
  f.input({ type: 'capture', buffer: new ArrayBuffer(48), sequence: 1, captureMs: 1, epoch: 0 });
  await f.socket.onmessage({
    data: JSON.stringify({ type: 'frame', sequence: 1, epoch: 0, timestamp: 1 }),
  });
  const decoding = f.socket.onmessage({ data: new ArrayBuffer(4) });
  f.input({ type: 'clock', epoch: 1, media: 2, input: 2, at: 1000, rate: 1 });
  resolve({
    close() {
      closed = true;
    },
  } as VideoFrame);
  await decoding;
  f.tick();
  assert.equal(closed, true);
  assert.equal(f.draws(), 0);
  f.stop();
});
test('stop during AV1 decoding closes the result without presenting it', async () => {
  let resolve!: (bitmap: VideoFrame) => void,
    closed = false;
  const f = fixture(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  await f.socket.onmessage({ data: JSON.stringify({ type: 'ready', protocol: 2 }) });
  f.input({ type: 'capture', buffer: new ArrayBuffer(48), sequence: 1, captureMs: 1, epoch: 0 });
  await f.socket.onmessage({
    data: JSON.stringify({ type: 'frame', sequence: 1, epoch: 0, timestamp: 1 }),
  });
  const decoding = f.socket.onmessage({ data: new ArrayBuffer(4) });
  f.stop();
  resolve({
    close() {
      closed = true;
    },
  } as VideoFrame);
  await decoding;
  f.tick();
  assert.equal(f.draws(), 0);
  assert.ok(closed);
});
