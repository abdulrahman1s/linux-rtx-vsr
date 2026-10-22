import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { startFrameSession, type FrameEnvironment } from '../extension/src/frame-session.ts';
import type { FrameMessage, CaptureMessage } from '../extension/src/protocol.ts';
function fixture(decode?: FrameEnvironment['decode']) {
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
      decode:
        decode ||
        (async () =>
          ({
            width: 1280,
            height: 720,
            close() {
              closed++;
            },
          }) as ImageBitmap),
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
  await f.socket.onmessage({ data: JSON.stringify({ type: 'ready' }) });
  assert.ok(!f.messages.some((m) => m.type === 'presented'));
  f.input({ type: 'clock', epoch: 1, media: 1, input: 1, at: 1000, rate: 1 });
  f.input({ type: 'capture', buffer: new ArrayBuffer(48), epoch: 1 });
  const before = f.messages.filter((m) => m.type === 'available').length;
  await f.socket.onmessage({
    data: JSON.stringify({ type: 'frame', epoch: 1, timestamp: 1, width: 1280, height: 720 }),
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
test('stop during JPEG decoding closes the result without presenting it', async () => {
  let resolve!: (bitmap: ImageBitmap) => void,
    closed = false;
  const f = fixture(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  await f.socket.onmessage({ data: JSON.stringify({ type: 'ready' }) });
  f.input({ type: 'capture', buffer: new ArrayBuffer(48), epoch: 0 });
  await f.socket.onmessage({ data: JSON.stringify({ type: 'frame', epoch: 0, timestamp: 1 }) });
  const decoding = f.socket.onmessage({ data: new ArrayBuffer(4) });
  f.stop();
  resolve({
    close() {
      closed = true;
    },
  } as ImageBitmap);
  await decoding;
  f.tick();
  assert.equal(f.draws(), 0);
  assert.ok(closed);
});
