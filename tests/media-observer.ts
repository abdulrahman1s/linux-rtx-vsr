import type { BrowserContext, Page } from 'playwright-core';
// Observe the extension iframe AND dedicated worker. Page-only media events
// can misleadingly prove just the original video's hardware decoder.
export async function observeMedia(context: BrowserContext, page: Page) {
  const root = await context.newCDPSession(page);
  let sequence = 0;
  const players = new Map<string, { target: string; properties: Record<string, string> }>();
  const targets = new Map<string, string>();
  const errors: string[] = [];
  const send = (path: string[], method: string, params: object = {}) => {
    let message = JSON.stringify({ id: ++sequence, method, params });
    for (const sessionId of path.toReversed())
      message = JSON.stringify({
        id: ++sequence,
        method: 'Target.sendMessageToTarget',
        params: { sessionId, message },
      });
    const outer = JSON.parse(message);
    // Nested target commands are carried inside a root CDP command. Responses
    // from child agents are events and do not block media playback.
    return root.send(outer.method, outer.params).catch((error: Error) => {
      errors.push(error.message);
    });
  };
  function properties(
    path: string[],
    event: { playerId: string; properties: { name: string; value: string }[] },
  ) {
    const key = `${path.join('/')}:${event.playerId}`;
    const player = players.get(key) || {
      target: targets.get(path.join('/')) || page.url(),
      properties: {},
    };
    for (const { name, value } of event.properties) player.properties[name] = value;
    players.set(key, player);
  }
  async function attached(
    path: string[],
    event: { sessionId: string; targetInfo: { type: string; url: string } },
  ) {
    const child = [...path, event.sessionId];
    targets.set(child.join('/'), `${event.targetInfo.type} ${event.targetInfo.url}`);
    try {
      await send(child, 'Media.enable');
      await send(child, 'Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: false,
      });
    } finally {
      await send(child, 'Runtime.runIfWaitingForDebugger');
    }
  }
  function received(path: string[], event: { sessionId: string; message: string }) {
    const child = [...path, event.sessionId];
    const value = JSON.parse(event.message);
    if (value.method === 'Target.attachedToTarget') void attached(child, value.params);
    if (value.method === 'Target.receivedMessageFromTarget') received(child, value.params);
    if (value.method === 'Media.playerPropertiesChanged') properties(child, value.params);
    if (value.error) errors.push(value.error.message);
  }
  root.on('Media.playerPropertiesChanged', (event) => properties([], event));
  root.on('Target.attachedToTarget', (event) => void attached([], event));
  root.on('Target.receivedMessageFromTarget', (event) => received([], event));
  await root.send('Media.enable');
  await root.send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: false,
  });
  return () => ({ players: [...players.values()], errors });
}
