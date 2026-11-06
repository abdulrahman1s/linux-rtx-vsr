// Owns picture layout and parent positioning across overlapping handoffs.
// A paused picture and its replacement share one positioning lease, so either
// can close first without moving the other or reloading a live iframe.
const positions = new WeakMap<HTMLElement, { users: number; previous: string; changed: boolean }>();
export interface VideoOverlay {
  element: HTMLIFrameElement;
  position(): void;
  // Split view: the original stays visible left of `at` (0–1 of the width);
  // null shows only the enhanced picture. Dragging the handle reports moves.
  split(at: number | null, moved?: (at: number) => void): void;
  close(): void;
}
// The original video already sits under the transparent overlay, so a clip
// reveals it at no cost. Both layers share the box and object-fit, so the
// halves line up. The shadow root keeps page styles off the divider.
function createDivider(z: number) {
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = `position:absolute;width:0;pointer-events:none;margin:0;padding:0;border:0;display:none;z-index:${z};`;
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>
  :host{all:initial}
  .line{position:absolute;inset:0 auto 0 -1px;width:2px;background:rgba(255,255,255,.85);box-shadow:0 0 3px rgba(0,0,0,.6)}
  .handle{position:absolute;top:50%;left:-14px;width:28px;height:28px;margin-top:-14px;border-radius:50%;background:rgba(255,255,255,.92);box-shadow:0 1px 4px rgba(0,0,0,.5);cursor:ew-resize;pointer-events:auto;touch-action:none}
  .handle::before{content:'\u2039\u203a';position:absolute;inset:0;font:600 15px/27px system-ui,sans-serif;text-align:center;color:#223447}
  .label{position:absolute;top:10px;padding:2px 7px;border-radius:4px;background:rgba(0,0,0,.6);color:#fff;font:600 11px/16px system-ui,sans-serif;white-space:nowrap}
  .original{right:8px}.enhanced{left:8px}
</style><div class="line"></div><span class="label original">Original</span><span class="label enhanced">Enhanced</span><div class="handle"></div>`;
  return { host, handle: root.querySelector<HTMLElement>('.handle')! };
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
  const divider = createDivider(z + 2);
  parent.append(divider.host);
  let closed = false,
    placed = '',
    splitAt: number | null = null,
    onMove: ((at: number) => void) | undefined;
  const place = () => {
    element.style.clipPath = splitAt === null ? '' : `inset(0 0 0 ${splitAt * 100}%)`;
    divider.host.style.transform = `translateX(${(splitAt ?? 0) * element.offsetWidth}px)`;
  };
  // Pointer capture keeps the drag on the handle, and stopping propagation
  // keeps the player from treating the drag as a pause/seek click.
  divider.handle.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    event.stopPropagation();
    divider.handle.setPointerCapture(event.pointerId);
  });
  divider.handle.addEventListener('pointermove', (event) => {
    if (!divider.handle.hasPointerCapture(event.pointerId) || splitAt === null) return;
    const box = element.getBoundingClientRect();
    if (!box.width) return;
    splitAt = Math.min(0.95, Math.max(0.05, (event.clientX - box.left) / box.width));
    place();
    onMove?.(splitAt);
  });
  for (const name of ['click', 'dblclick', 'pointerup', 'mousedown', 'mouseup'])
    divider.handle.addEventListener(name, (event) => event.stopPropagation());
  return {
    element,
    split(at, moved) {
      splitAt = at === null ? null : Math.min(0.95, Math.max(0.05, at));
      onMove = moved;
      place();
    },
    position() {
      if (closed || !element.isConnected || !video.isConnected) return;
      // Follow the enhanced picture: the divider means nothing over the original.
      const display = splitAt !== null && element.style.opacity === '1' ? '' : 'none';
      if (divider.host.style.display !== display) divider.host.style.display = display;
      const v = video.getBoundingClientRect(),
        p = parent.getBoundingClientRect();
      const left = `${v.left - p.left + parent.scrollLeft - parent.clientLeft}px`,
        top = `${v.top - p.top + parent.scrollTop - parent.clientTop}px`,
        width = `${v.width}px`,
        height = `${v.height}px`,
        next = `${left} ${top} ${width} ${height}`;
      // Called ten times per second. Unchanged writes still dirty the page's
      // style and can push layout work into the player's frame deadline.
      if (next === placed) return;
      placed = next;
      Object.assign(element.style, { left, top, width, height });
      Object.assign(divider.host.style, { left, top, height });
      place();
    },
    close() {
      if (closed) return;
      closed = true;
      element.remove();
      divider.host.remove();
      if (--lease.users === 0) {
        if (lease.changed && parent.style.position === 'relative')
          parent.style.position = lease.previous;
        positions.delete(parent);
      }
    },
  };
}
