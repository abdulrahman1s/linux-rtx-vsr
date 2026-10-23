import { freshState } from './policy.ts';
import type { PlaybackState, PlaybackStatus } from './protocol.ts';

// A parent with no video must not overwrite its embedded player's status.
// Content scripts report every 250 ms; expire removed/navigated frames.
const priority: Record<PlaybackState, number> = {
  active: 6,
  starting: 5,
  error: 4,
  unsupported: 4,
  bypassed: 3,
  paused: 2,
  ready: 1,
  disabled: 0,
};
export class FrameStates {
  private frames = new Map<number, { value: PlaybackStatus; at: number }>();

  update(frame: number, value: PlaybackStatus, now = Date.now()): PlaybackStatus {
    this.frames.set(frame, { value, at: now });
    let selected = freshState(value, now);
    for (const [id, entry] of this.frames) {
      if (now - entry.at > 1500) {
        this.frames.delete(id);
        continue;
      }
      const candidate = freshState(entry.value, now);
      if (priority[candidate.state] > priority[selected.state]) selected = candidate;
    }
    return selected;
  }
}
