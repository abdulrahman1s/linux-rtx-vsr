import { startFrameSession } from './frame-session.ts';
import type { WorkerInit } from './protocol.ts';
let stop: (() => void) | undefined;
self.onmessage = (event: MessageEvent<WorkerInit>) => {
  if (event.data.type !== 'init') return;
  stop?.();
  try {
    stop = startFrameSession(event.data);
  } catch (error) {
    event.data.port.postMessage({ type: 'error', message: String(error) });
  }
};
