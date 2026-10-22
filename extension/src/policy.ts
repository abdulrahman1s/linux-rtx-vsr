import type { Settings, TabOverride, PlaybackStatus, PlaybackState } from './protocol.ts';
export const DEFAULTS: Readonly<Settings> = Object.freeze({
  enabled: true,
  sites: {},
  quality: 3,
  scale: 2,
});
export function originOf(url: string | undefined) {
  try {
    const u = new URL(url || '');
    return ['http:', 'https:'].includes(u.protocol) ? u.origin : null;
  } catch {
    return null;
  }
}
// Global off > origin-bound temporary tab override > exact-origin rule > off.
export function shouldEnhance(
  settings: Settings,
  override: TabOverride | null | undefined,
  url: string | undefined,
) {
  const origin = originOf(url);
  if (!settings.enabled || !origin) return false;
  if (override?.origin === origin && typeof override.enabled === 'boolean') return override.enabled;
  return settings.sites[origin] === true;
}
export const STATES: Record<PlaybackState, { badge: string; color: string; label: string }> = {
  disabled: { badge: '', color: '#607080', label: 'Disabled' },
  ready: { badge: 'RDY', color: '#446c9d', label: 'Ready' },
  starting: { badge: '…', color: '#8a610f', label: 'Starting' },
  active: { badge: 'ON', color: '#146e66', label: 'Enhancing' },
  paused: { badge: 'Ⅱ', color: '#596777', label: 'Paused / original' },
  bypassed: { badge: 'ORG', color: '#596777', label: 'Bypassed / original' },
  error: { badge: '!', color: '#a13939', label: 'Error / original' },
  unsupported: { badge: 'N/A', color: '#79526f', label: 'Unsupported / original' },
};
export function freshState(
  state: PlaybackStatus | null | undefined,
  now = Date.now(),
): PlaybackStatus {
  if (state?.state === 'active' && (!state.presentedAt || now - state.presentedAt > 750)) {
    return { ...state, state: 'bypassed', message: 'No fresh enhanced frames; showing original' };
  }
  return state || { state: 'ready', message: 'Enable enhancement for this tab or site' };
}
