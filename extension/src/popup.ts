import { errorMessage } from './errors.ts';
import { request as send } from './messaging.ts';
import type { Snapshot, RuntimeRequest, RuntimeReply } from './protocol.ts';
import { STATES, originOf } from './policy.ts';
type PopupElements = {
  global: HTMLInputElement;
  automatic: HTMLInputElement;
  quality: HTMLSelectElement;
  scale: HTMLSelectElement;
  manual: HTMLButtonElement;
  follow: HTMLButtonElement;
};
function $<K extends string>(
  id: K,
): K extends keyof PopupElements ? PopupElements[K] : HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing popup element: ${id}`);
  return element as K extends keyof PopupElements ? PopupElements[K] : HTMLElement;
}
let tabId: number | undefined,
  snapshot: Snapshot,
  refreshing = false;
type PopupRequest = RuntimeRequest extends infer T
  ? T extends RuntimeRequest
    ? Omit<T, 'tabId'>
    : never
  : never;
async function request<T extends PopupRequest>(
  message: T,
): Promise<RuntimeReply<T & RuntimeRequest>> {
  if (tabId === undefined) throw new Error('Open a browser tab first');
  return send({ ...message, tabId } as T & RuntimeRequest);
}
function error(e: unknown) {
  $('error').textContent = errorMessage(e);
  $('error').hidden = false;
}
async function refresh() {
  if (refreshing || !tabId) return;
  refreshing = true;
  try {
    snapshot = await request({ type: 'snapshot' });
    const { settings, state, policy, origin, override } = snapshot;
    $('global').checked = settings.enabled;
    $('automatic').checked = settings.sites[origin || ''] === true;
    $('automatic').disabled = !origin;
    $('origin').textContent = origin || 'Open an HTTP or HTTPS video page';
    $('quality').value = String(settings.quality);
    $('scale').value = String(settings.scale);
    $('manual').textContent = policy.wanted ? 'Disable for this tab' : 'Enable for this tab';
    $('manual').disabled = !origin || !settings.enabled;
    $('follow').hidden = !override || override.origin !== origin;
    const style = STATES[state.state] || STATES.ready;
    $('state').textContent = style.label;
    $('message').textContent = state.message || '';
    $('lamp').style.backgroundColor = style.color;
    $('source').textContent = state.source || 'Original video';
    $('output').textContent = state.state === 'active' ? `→ ${state.output}` : '';
    for (const [id, value] of [
      ['fps', state.fps],
      ['latency', state.latencyMs],
      ['dropped', state.dropped],
    ] as const)
      $(id).textContent =
        typeof value === 'number' && Number.isFinite(value)
          ? value.toFixed(id === 'dropped' ? 0 : 1)
          : '—';
  } catch (e) {
    error(
      new Error(
        `${errorMessage(e)}. Reload the extension in chrome://extensions and refresh this page.`,
      ),
    );
  } finally {
    refreshing = false;
  }
}
async function act(fn: () => Promise<unknown>) {
  $('error').hidden = true;
  try {
    await fn();
    await refresh();
  } catch (e) {
    error(e);
  }
}
$('manual').onclick = () =>
  act(() => request({ type: 'manual', enabled: !snapshot.policy.wanted }));
$('global').onchange = () => act(() => request({ type: 'settings', enabled: $('global').checked }));
$('quality').onchange = () =>
  act(() => request({ type: 'settings', quality: Number($('quality').value) }));
$('scale').onchange = () =>
  act(() => request({ type: 'settings', scale: Number($('scale').value) }));
$('follow').onclick = () => act(() => request({ type: 'reset-override' }));
$('automatic').onchange = () => {
  const enabled = $('automatic').checked;
  // Request directly during the click gesture; Chrome requires this for
  // optional site permissions. Never request access to every site.
  const permission = enabled
    ? chrome.permissions.request({ origins: [`${snapshot.origin}/*`] })
    : Promise.resolve(true);
  act(async () => {
    if (!(await permission))
      throw new Error('Site access was declined. Manual enhancement is still available.');
    await request({ type: 'automatic', enabled });
  });
};
$('check').onclick = () =>
  act(async () => {
    const result = await request({ type: 'backend' });
    $('backend').textContent = result.running
      ? `Backend running. GPU ${result.gpu_loaded ? 'loaded' : 'idle'}.`
      : 'Backend stopped. It will start when enhancement is requested.';
  });
$('version').textContent = `Version ${chrome.runtime.getManifest().version}`;
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
tabId = tab?.id;
if (!originOf(tab?.url)) $('manual').disabled = true;
await refresh();
setInterval(refresh, 500);
