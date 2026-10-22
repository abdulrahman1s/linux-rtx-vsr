import { errorMessage } from './errors.ts';
import type { RuntimeRequest, Settings, TabOverride, PlaybackStatus } from './protocol.ts';
import { settingsWithDefaults, shouldEnhance, originOf, STATES, freshState } from './policy.ts';
const HOST = 'io.github.abdulrahman1s.linux_rtx_vsr';
const SCRIPTS = ['content.js'];
const claims = new Map<string, { tab: number; at: number }>();
const freshnessTimers = new Map<number, ReturnType<typeof setTimeout>>();
async function settings(): Promise<Settings> {
  return settingsWithDefaults(
    (await chrome.storage.local.get<{ settings?: Settings }>('settings')).settings,
  );
}
async function override(tabId: number): Promise<TabOverride | undefined> {
  return (
    await chrome.storage.session.get<Record<string, TabOverride | undefined>>(`override:${tabId}`)
  )[`override:${tabId}`];
}
async function policy(tabId: number, url: string | undefined) {
  const config = await settings();
  return { ...config, wanted: shouldEnhance(config, await override(tabId), url) };
}
async function inject(tabId: number) {
  await chrome.scripting.executeScript({ target: { tabId }, files: SCRIPTS });
}
async function show(tabId: number, value?: PlaybackStatus) {
  const state = freshState(value),
    style = STATES[state.state] || STATES.error;
  await chrome.action.setBadgeText({ tabId, text: style.badge });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: style.color });
  await chrome.action.setTitle({
    tabId,
    title: `Linux RTX VSR — ${style.label}: ${state.message || ''}`,
  });
}
async function notifyTabs() {
  for (const tab of await chrome.tabs.query({})) {
    if (!tab.id) continue;
    chrome.tabs.sendMessage(tab.id!, { type: 'policy-changed' }).catch(() => {});
    if (!(await settings()).enabled)
      await show(tab.id!, { state: 'disabled', message: 'Globally disabled' });
  }
}
async function syncSites() {
  const config = await settings();
  const registered = await chrome.scripting.getRegisteredContentScripts();
  if (registered.length)
    await chrome.scripting.unregisterContentScripts({ ids: registered.map((x) => x.id) });
  const matches = [];
  for (const [origin, enabled] of Object.entries(config.sites)) {
    if (
      enabled &&
      originOf(origin) === origin &&
      (await chrome.permissions.contains({ origins: [`${origin}/*`] }))
    )
      matches.push(`${origin}/*`);
  }
  if (matches.length)
    await chrome.scripting.registerContentScripts([
      {
        id: 'vsr-sites',
        matches,
        js: SCRIPTS,
        runAt: 'document_idle',
        allFrames: false,
        persistAcrossSessions: true,
      },
    ]);
}
async function route(message: RuntimeRequest, sender: chrome.runtime.MessageSender) {
  const ownPage =
    sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL(''));
  const content = sender.tab?.id !== undefined && sender.frameId === 0 && !ownPage;
  if (message.type === 'policy' && content) return policy(sender.tab!.id!, sender.url);
  if (message.type === 'state' && content) {
    let value = freshState(message.value);
    if (value.state === 'active' && !(await policy(sender.tab!.id!, sender.url)).wanted)
      value = { state: 'disabled', message: 'Enhancement disabled' };
    if (!STATES[value.state]) throw new Error('Unknown playback state');
    await chrome.storage.session.set({ [`state:${sender.tab!.id!}`]: value });
    await show(sender.tab!.id!, value);
    clearTimeout(freshnessTimers.get(sender.tab!.id!));
    if (value.state === 'active')
      freshnessTimers.set(
        sender.tab!.id!,
        setTimeout(async () => {
          const current = (
            await chrome.storage.session.get<Record<string, PlaybackStatus | undefined>>(
              `state:${sender.tab!.id!}`,
            )
          )[`state:${sender.tab!.id!}`];
          await show(sender.tab!.id!, current).catch(() => {});
        }, 800),
      );
    return {};
  }
  if (message.type === 'authorize' && content) {
    if (!(await policy(sender.tab!.id!, sender.url)).wanted)
      throw new Error('Enhancement is disabled');
    for (const [key, value] of claims) if (Date.now() - value.at > 15000) claims.delete(key);
    if (claims.size >= 32) throw new Error('Too many requests; wait 15 seconds');
    const grant = crypto.randomUUID();
    claims.set(grant, { tab: sender.tab!.id!, at: Date.now() });
    return { grant };
  }
  if (message.type === 'claim' && ownPage && sender.url === chrome.runtime.getURL('bridge.html')) {
    const grant = claims.get(message.grant);
    claims.delete(message.grant);
    if (!grant || grant.tab !== sender.tab?.id || Date.now() - grant.at > 15000)
      throw new Error('Playback authorization expired; enable again');
    // Only the extension-owned bridge sees native session credentials.
    const reply = await chrome.runtime.sendNativeMessage(HOST, { op: 'grant' });
    if (reply.error) throw new Error(reply.error);
    return reply;
  }
  if (!ownPage || !sender.url?.startsWith(chrome.runtime.getURL('popup.html')))
    throw new Error('Unsupported extension request');
  if (message.type === 'snapshot') {
    const tab = await chrome.tabs.get(message.tabId);
    const tabPolicy = await policy(tab.id!, tab.url);
    const state = freshState(
      (
        await chrome.storage.session.get<Record<string, PlaybackStatus | undefined>>(
          `state:${tab.id}`,
        )
      )[`state:${tab.id}`] || {
        state: tabPolicy.wanted ? 'ready' : 'disabled',
        message: tabPolicy.enabled
          ? 'Enable enhancement for this tab or site'
          : 'Globally disabled',
      },
    );
    await show(tab.id!, state);
    return {
      settings: await settings(),
      override: await override(tab.id!),
      state,
      origin: originOf(tab.url),
      policy: tabPolicy,
    };
  }
  if (message.type === 'manual') {
    const tab = await chrome.tabs.get(message.tabId),
      origin = originOf(tab.url);
    if (!origin) throw new Error('Open an HTTP or HTTPS video page first');
    await chrome.storage.session.set({
      [`override:${tab.id}`]: { origin, enabled: message.enabled },
    });
    await inject(tab.id!);
    await notifyTabs();
    return {};
  }
  if (message.type === 'automatic') {
    const tab = await chrome.tabs.get(message.tabId),
      origin = originOf(tab.url);
    if (!origin) throw new Error('Open an HTTP or HTTPS video page first');
    if (message.enabled && !(await chrome.permissions.contains({ origins: [`${origin}/*`] })))
      throw new Error('Site permission was not granted');
    const config = await settings();
    config.sites = { ...config.sites };
    // Persist false, so a default YouTube rule never resurrects an opt-out.
    config.sites[origin] = message.enabled;
    await chrome.storage.local.set({ settings: config });
    await chrome.storage.session.remove(`override:${tab.id}`);
    await syncSites();
    await inject(tab.id!);
    await notifyTabs();
    return {};
  }
  if (message.type === 'settings') {
    const config = await settings();
    if (typeof message.enabled === 'boolean') config.enabled = message.enabled;
    if ([1, 2, 3, 4].includes(message.quality ?? 0))
      config.quality = message.quality as Settings['quality'];
    if ([720, 1080, 1440, 2160, 4320].includes(message.target ?? 0))
      config.target = message.target as Settings['target'];
    await chrome.storage.local.set({ settings: config });
    await notifyTabs();
    return {};
  }
  if (message.type === 'reset-override') {
    await chrome.storage.session.remove(`override:${message.tabId}`);
    await inject(message.tabId);
    await notifyTabs();
    return {};
  }
  if (message.type === 'backend') return chrome.runtime.sendNativeMessage(HOST, { op: 'status' });
  throw new Error('Unknown request');
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  route(message, sender).then(respond, (error) => respond({ error: errorMessage(error) }));
  return true;
});
chrome.runtime.onInstalled.addListener(() => syncSites().catch(console.error));
chrome.runtime.onStartup.addListener(() => syncSites().catch(console.error));
chrome.permissions.onRemoved.addListener(() => syncSites().catch(console.error));
chrome.tabs.onRemoved.addListener((tabId) =>
  chrome.storage.session.remove([`override:${tabId}`, `state:${tabId}`]),
);
chrome.tabs.onUpdated.addListener(async (tabId, change, tab) => {
  if (change.status === 'loading') {
    chrome.storage.session.remove(`state:${tabId}`);
    const wanted = (await policy(tabId, tab.url)).wanted;
    show(tabId, {
      state: wanted ? 'ready' : 'disabled',
      message: wanted ? 'Waiting for a video on this page' : 'Enhancement disabled for this page',
    }).catch(() => {});
  }
});
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const v = (
    await chrome.storage.session.get<Record<string, PlaybackStatus | undefined>>(`state:${tabId}`)
  )[`state:${tabId}`];
  await show(tabId, v);
});
