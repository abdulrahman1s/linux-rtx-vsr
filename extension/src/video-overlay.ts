// Owns picture layout and parent positioning across overlapping handoffs.
// A paused picture and its replacement share one positioning lease, so either
// can close first without moving the other or reloading a live iframe.
const positions = new WeakMap<HTMLElement, { users: number; previous: string; changed: boolean }>();
export interface VideoOverlay {
  element: HTMLIFrameElement;
  position(): void;
  close(): void;
}
export function createVideoOverlay(video: HTMLVideoElement, url: string): VideoOverlay {
  const parent = video.closest<HTMLElement>('.html5-video-player') || video.parentElement;
  if (!parent || (parent === document.body && getComputedStyle(parent).position === 'static'))
    throw new Error('Unsupported player layout; wrap the video in a positioned container');
  let lease = positions.get(parent);
  if (!lease) {
    lease = {
      users: 0,
      previous: parent.style.position,
      changed: getComputedStyle(parent).position === 'static',
    };
    positions.set(parent, lease);
    if (lease.changed) parent.style.position = 'relative';
  }
  lease.users++;
  let branch: HTMLElement = video;
  while (branch.parentElement && branch.parentElement !== parent) branch = branch.parentElement;
  const z = parseInt(getComputedStyle(branch).zIndex, 10) || 0;
  const element = document.createElement('iframe');
  element.title = 'NVIDIA enhanced video picture';
  element.tabIndex = -1;
  element.setAttribute('aria-hidden', 'true');
  element.style.cssText = `position:absolute;pointer-events:none;border:0;margin:0;padding:0;opacity:0;z-index:${z + 1};background:transparent;`;
  element.src = url;
  parent.append(element);
  let closed = false;
  return {
    element,
    position() {
      if (closed || !element.isConnected || !video.isConnected) return;
      const v = video.getBoundingClientRect(),
        p = parent.getBoundingClientRect();
      Object.assign(element.style, {
        left: `${v.left - p.left + parent.scrollLeft - parent.clientLeft}px`,
        top: `${v.top - p.top + parent.scrollTop - parent.clientTop}px`,
        width: `${v.width}px`,
        height: `${v.height}px`,
      });
    },
    close() {
      if (closed) return;
      closed = true;
      element.remove();
      if (--lease.users === 0) {
        if (lease.changed && parent.style.position === 'relative')
          parent.style.position = lease.previous;
        positions.delete(parent);
      }
    },
  };
}
