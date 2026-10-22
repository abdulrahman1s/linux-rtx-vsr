import type { RuntimeRequest, RuntimeReply } from './protocol.ts';

// One error convention for every caller; authorization remains in background.ts.
export async function request<T extends RuntimeRequest>(message: T): Promise<RuntimeReply<T>> {
  const result = await chrome.runtime.sendMessage(message);
  if (result?.error) throw new Error(String(result.error));
  return result;
}
