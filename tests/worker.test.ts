import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { startFrameSession, type UplinkEvents } from '../extension/src/frame-session.ts';
import { captureCapacity } from '../extension/src/frame-budget.ts';
import type { FrameMessage, CaptureMessage, Generation } from '../extension/src/protocol.ts';
function fixture(
  decode?: (data: ArrayBuffer) => Promise<VideoFrame>,
  withUplinks = false,
  generate?: Generation,
) {
  const uplinks: { hello: unknown; sent: ArrayBuffer[]; events: UplinkEvents; closed: boolean }[] =
    [];
  const messages: FrameMessage[] = [],
    sent: unknown[] = [];
  let callback: (frameTime?: number) => void = () => {},
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
    onclose: () => {},
    onerror: () => {},
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
      generate,
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
      createUplink: withUplinks
        ? (_url, hello, events) => {
            const uplink = { hello, sent: [] as ArrayBuffer[], events, closed: false };
            uplinks.push(uplink);
            return {
              send: (buffer) => uplink.sent.push(buffer),
              close: () => {
                uplink.closed = true;
              },
            };
          }
        : undefined,
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
    uplinks,
    socket,
    input,
    stop,
    tick: (frameTime?: number) => callback(frameTime),
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
test('pictures are chosen for the vsync time, not a delayed callback start', async () => {
  const f = fixture();
  await f.socket.onmessage({ data: JSON.stringify({ type: 'ready', protocol: 3 }) });
  f.input({ type: 'clock', epoch: 0, media: 1, input: 1, at: 1000, rate: 1 });
  for (const [sequence, timestamp] of [
    [1, 1],
    [2, 1 + 1 / 60],
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
  // The callback starts 5 ms after its vsync. Judged by callback time, both
  // pictures look due and the first would be dropped before it was shown.
  f.advance(1013);
  f.tick(1008);
  assert.equal(f.draws(), 1);
  f.advance(1026);
  f.tick(1024.7);
  assert.equal(f.draws(), 2);
  const presented = f.messages.filter((m) => m.type === 'presented').at(-1);
  assert.equal(presented?.type === 'presented' && presented.dropped, 0);
  f.stop();
});
test('old JPEG protocol cannot become ready or active', async () => {
  const f = fixture();
  await f.socket.onmessage({ data: JSON.stringify({ type: 'ready', protocol: 1 }) });
  assert.ok(f.messages.some((m) => m.type === 'error' && /update/.test(m.message)));
  assert.ok(!f.messages.some((m) => m.type === 'ready' || m.type === 'presented'));
});
test('transport failures are retryable, while explicit stop and protocol errors are not', async () => {
  const disconnected = fixture();
  disconnected.socket.onclose();
  disconnected.socket.onerror();
  assert.equal(disconnected.messages.filter((m) => m.type === 'error').length, 1);
  assert.ok(disconnected.messages.some((m) => m.type === 'error' && m.retryable));
  const connecting = fixture();
  connecting.socket.onerror();
  assert.ok(connecting.messages.some((m) => m.type === 'error' && m.retryable));
  const stopped = fixture();
  stopped.stop();
  stopped.socket.onclose();
  assert.ok(!stopped.messages.some((m) => m.type === 'error'));
  const protocol = fixture();
  await protocol.socket.onmessage({ data: JSON.stringify({ type: 'ready', protocol: 1 }) });
  assert.ok(protocol.messages.some((m) => m.type === 'error' && !m.retryable));
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
    f.messages.filter((m) => m.type === 'available').length,
    1,
    'A rejected frame must still release its capture slot',
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
test('frames spread round-robin over uplinks that open before capture starts', async () => {
  const f = fixture(undefined, true);
  f.socket.onopen();
  assert.equal(JSON.parse(f.sent[0] as string).uplinks, 3);
  await f.socket.onmessage({ data: JSON.stringify({ type: 'ready', protocol: 3, uplink: 's' }) });
  assert.deepEqual(
    f.uplinks.map((u) => u.hello),
    [0, 1, 2].map((index) => ({ uplink: 's', index })),
  );
  f.uplinks[0].events.open();
  f.uplinks[1].events.open();
  assert.ok(!f.messages.some((m) => m.type === 'ready'));
  f.uplinks[2].events.open();
  assert.ok(f.messages.some((m) => m.type === 'ready'));
  f.input({ type: 'clock', epoch: 0, media: 1, input: 1, at: 1000, rate: 1 });
  for (let sequence = 1; sequence <= 4; sequence++)
    f.input({ type: 'capture', buffer: new ArrayBuffer(48), sequence, captureMs: 1, epoch: 0 });
  assert.deepEqual(
    f.uplinks.map((u) => u.sent.length),
    [2, 1, 1],
  );
  assert.equal(f.sent.length, 1, 'frames never use the primary socket');
  f.uplinks[1].events.fail();
  assert.ok(f.messages.some((m) => m.type === 'error' && m.retryable));
  assert.ok(f.uplinks.every((u) => u.closed));
});
test('an engine without uplink support keeps frames on the primary socket', async () => {
  const f = fixture(undefined, true);
  f.socket.onopen();
  await f.socket.onmessage({ data: JSON.stringify({ type: 'ready', protocol: 3 }) });
  assert.ok(f.messages.some((m) => m.type === 'ready'));
  f.input({ type: 'clock', epoch: 0, media: 1, input: 1, at: 1000, rate: 1 });
  f.input({ type: 'capture', buffer: new ArrayBuffer(48), sequence: 1, captureMs: 1, epoch: 0 });
  assert.equal(f.uplinks.length, 0);
  assert.equal(f.sent.length, 2);
});
test('generated pictures present between captures and keep the capture slot until its own', async () => {
  const f = fixture(undefined, false, { max: 4, interval: 1 / 60 });
  f.socket.onopen();
  assert.deepEqual(JSON.parse(f.sent[0] as string).generate, { max: 4, interval: 1 / 60 });
  await f.socket.onmessage({ data: JSON.stringify({ type: 'ready', protocol: 3 }) });
  f.input({ type: 'clock', epoch: 0, media: 1, input: 1, at: 1000, rate: 1 });
  const available = () => f.messages.filter((m) => m.type === 'available').length;
  const picture = async (sequence: number, timestamp: number, generated: boolean) => {
    await f.socket.onmessage({
      data: JSON.stringify({
        type: 'frame',
        sequence,
        epoch: 0,
        timestamp,
        width: 1280,
        height: 720,
        generated,
      }),
    });
    await f.socket.onmessage({ data: new ArrayBuffer(4) });
  };
  f.input({ type: 'capture', buffer: new ArrayBuffer(48), sequence: 1, captureMs: 1, epoch: 0 });
  await picture(1, 1, false);
  f.input({ type: 'capture', buffer: new ArrayBuffer(48), sequence: 2, captureMs: 1, epoch: 0 });
  const before = available();
  // A 30 fps capture pair: the engine's in-between picture arrives first.
  await picture(2, 1 + 1 / 60, true);
  assert.equal(available(), before);
  await picture(2, 1 + 2 / 60, false);
  assert.equal(available(), before + 1);
  assert.ok(!f.messages.some((m) => m.type === 'error'));
  for (const [at, draws] of [
    [1000, 1],
    [1000 + 1000 / 60, 2],
    [1000 + 2000 / 60, 3],
  ]) {
    f.advance(at);
    f.tick(at);
    assert.equal(f.draws(), draws);
  }
  const presented = f.messages.filter((m) => m.type === 'presented').at(-1);
  assert.ok(presented?.type === 'presented');
  assert.equal(presented.dropped, 0);
  f.stop();
});
test('a session without frame generation does not request it', () => {
  const f = fixture();
  f.socket.onopen();
  assert.equal(JSON.parse(f.sent[0] as string).generate, undefined);
  f.stop();
});
