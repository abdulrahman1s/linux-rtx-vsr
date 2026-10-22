import { errorMessage } from './errors.ts';
import { request } from './messaging.ts';
let claimed = false,
  worker: Worker | undefined;
window.addEventListener('message', async (event) => {
  if (
    claimed ||
    event.source !== parent ||
    event.data?.type !== 'rtx-vsr-init' ||
    event.ports.length !== 1
  )
    return;
  claimed = true;
  const port = event.ports[0];
  try {
    const auth = await request({ type: 'claim', grant: event.data.grant });
    if (!auth?.token) throw new Error('No native authorization; run integration install');
    const element = document.querySelector('canvas')!;
    element.style.objectFit = event.data.objectFit || 'contain';
    const canvas = element.transferControlToOffscreen();
    worker = new Worker(chrome.runtime.getURL('frame-worker.js'), { type: 'module' });
    worker.onerror = (event) =>
      port.postMessage({ type: 'error', message: event.message || 'Frame worker stopped' });
    worker.postMessage(
      { type: 'init', port, canvas, auth, quality: event.data.quality, scale: event.data.scale },
      [port, canvas],
    );
  } catch (error) {
    port.postMessage({ type: 'error', message: errorMessage(error) });
  }
});
window.addEventListener('pagehide', () => worker?.terminate());
