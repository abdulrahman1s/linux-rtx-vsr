import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { startFrameSession } from '../extension/src/frame-session.ts';
import { captureCapacity } from '../extension/src/frame-budget.ts';
import type { FrameMessage, CaptureMessage } from '../extension/src/protocol.ts';
function fixture(decode?: (data: ArrayBuffer) => Promise<VideoFrame>) {
  const messages: FrameMessage[] = [],
    sent: unknown[] = [];
  let callback = () => {},
    time = 1000,
    draws = 0,
    cancelled = 0,
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
        return () => {
          cancelled++;
        };
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
    cancelled: () => cancelled,
  };
}
test('session holds backpressure through metadata and reports active only after fresh drawing', async () => {
  const f = fixture();
  f.socket.onopen();
  await f.socket.onmessage({ data: JSON.stringify({ type: 'ready', protocol: 3 }) });
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
test('pause holds the canvas without stale reports, discards pending pictures, and resumes the same stream', async () => {
  const f = fixture();
  await f.socket.onmessage({ data: JSON.stringify({ type: 'ready', protocol: 3 }) });
  async function frame(sequence: number, timestamp: number) {
    f.input({ type: 'capture', buffer: new ArrayBuffer(48), sequence, captureMs: 1, epoch: 0 });
    await f.socket.onmessage({
      data: JSON.stringify({
        type: 'frame',
        sequence,
        epoch: 0,
        timestamp,
        width: 1280,
        height: 720,
      }),
    });
    await f.socket.onmessage({ data: new ArrayBuffer(4) });
  }
  f.input({ type: 'clock', epoch: 0, media: 1, input: 1, at: 1000, rate: 1 });
  await frame(1, 1);
  f.tick();
  assert.equal(f.draws(), 1);
  f.input({ type: 'clock', epoch: 0, media: 1, input: 1, at: 1000, rate: 0 });
  await frame(2, 1.01);
  f.advance(1700);
  f.tick();
  assert.equal(f.draws(), 1);
  assert.equal(f.closed(), 2, 'Pending paused output must release its GPU surface');
  assert.ok(!f.messages.some((m) => m.type === 'stale'));
  f.input({ type: 'clock', epoch: 0, media: 1, input: 1, at: 1700, rate: 1 });
  await frame(3, 1);
  f.tick();
  assert.equal(f.draws(), 2);
  assert.equal(f.messages.filter((m) => m.type === 'presented').length, 2);
  f.stop();
});
test('presentation reporting is coalesced without skipping draws or delaying recovery', async () => {
  const f = fixture();
  await f.socket.onmessage({ data: JSON.stringify({ type: 'ready', protocol: 3 }) });
  async function frame(sequence: number, time: number) {
    f.advance(time);
    f.input({ type: 'clock', epoch: 0, input: time / 1000, media: time / 1000, at: time, rate: 1 });
    f.input({ type: 'capture', buffer: new ArrayBuffer(48), sequence, captureMs: 1, epoch: 0 });
    await f.socket.onmessage({
      data: JSON.stringify({
        type: 'frame',
        sequence,
        epoch: 0,
        timestamp: time / 1000,
        width: 1280,
        height: 720,
      }),
    });
    await f.socket.onmessage({ data: new ArrayBuffer(4) });
    f.tick();
  }
  for (let i = 0; i < 7; i++) await frame(i + 1, 1000 + i * 20);
  assert.equal(f.draws(), 7);
  assert.equal(f.messages.filter((m) => m.type === 'presented').length, 2);
  f.advance(1350);
  f.tick();
  assert.equal(f.messages.at(-1)?.type, 'stale');
  await frame(8, 1351);
  const recovered = f.messages.filter((m) => m.type === 'presented').at(-1);
  assert.ok(recovered?.type === 'presented');
  assert.equal(recovered.presented, 8);
  assert.equal(recovered.presentedAt, 1351);
  f.stop();
});
test('session bounds overlapping requests and retains matching capture timings', async () => {
  const f = fixture();
  await f.socket.onmessage({ data: JSON.stringify({ type: 'ready', protocol: 3 }) });
  f.input({ type: 'clock', epoch: 0, media: 1, input: 1, at: 1000, rate: 1 });
  for (const sequence of [1, 2, 3, 4, 5])
    f.input({
      type: 'capture',
      buffer: new ArrayBuffer(48),
      sequence,
      captureMs: sequence * 2,
      epoch: 0,
    });
  assert.equal(f.sent.length, 4, 'A fifth raw frame must never queue on the socket');
  assert.equal(
    f.messages.filter((m) => m.type === 'recycle').length,
    5,
    'Rejected frames must also return their reusable storage',
  );
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
  f.input({ type: 'capture', buffer: new ArrayBuffer(48), sequence: 6, captureMs: 8, epoch: 0 });
  assert.equal(f.sent.length, 5, 'Decoded output must release exactly one slot');
  f.stop();
});
test('input budget allows overlap at 1080p and bounds large raw pictures', () => {
  assert.equal(captureCapacity(32 + 1920 * 1080 * 4), 4);
  assert.equal(captureCapacity(32 + 3840 * 2160 * 4), 1);
  assert.equal(captureCapacity(32 + 7680 * 4320 * 1.5), 1);
});
test('live source clocks recover a suspended animation callback and cancellation stops it', async () => {
  const f = fixture();
  await f.socket.onmessage({ data: JSON.stringify({ type: 'ready', protocol: 3 }) });
  f.input({ type: 'capture', buffer: new ArrayBuffer(48), sequence: 1, captureMs: 1, epoch: 0 });
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
  // Never execute the scheduled RAF: an unpainted iframe can suspend it.
  f.advance(1150);
  f.input({ type: 'clock', epoch: 0, media: 1, input: 1, at: 1150, rate: 1 });
  assert.equal(f.draws(), 1);
  assert.ok(f.messages.some((m) => m.type === 'presented'));
  assert.ok(f.cancelled() > 0);
  f.stop();
  const cancelled = f.cancelled();
  f.advance(1500);
  f.input({ type: 'clock', epoch: 0, media: 2, input: 2, at: 1500, rate: 1 });
  f.tick();
  assert.equal(f.draws(), 1);
  assert.equal(f.cancelled(), cancelled);
});
test('out-of-order captures cannot hide a picture behind a future deadline', async () => {
  const f = fixture();
  await f.socket.onmessage({ data: JSON.stringify({ type: 'ready', protocol: 3 }) });
  f.input({ type: 'clock', epoch: 0, media: 1, input: 1, at: 1000, rate: 1 });
  for (const [sequence, timestamp] of [
    [1, 1.05],
    [2, 1],
  ]) {
    f.input({ type: 'capture', buffer: new ArrayBuffer(48), sequence, captureMs: 1, epoch: 0 });
    await f.socket.onmessage({
      data: JSON.stringify({
        type: 'frame',
        sequence,
        epoch: 0,
        timestamp,
        width: 1280,
        height: 720,
      }),
    });
    await f.socket.onmessage({ data: new ArrayBuffer(4) });
  }
  f.tick();
  const first = f.messages.find((m) => m.type === 'presented');
  assert.ok(first?.type === 'presented');
  assert.equal(first.stats.sequence, 2);
  f.advance(1050);
  f.tick();
  assert.equal(f.draws(), 2);
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
  await f.socket.onmessage({ data: JSON.stringify({ type: 'ready', protocol: 3 }) });
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
  await f.socket.onmessage({ data: JSON.stringify({ type: 'ready', protocol: 3 }) });
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
