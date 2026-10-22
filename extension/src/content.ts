import { errorMessage } from './errors.ts';
import { VsrAudioSync } from './audio-sync.ts';
import { VsrPresentationClock } from './presentation-clock.ts';
import { DEFAULTS } from './policy.ts';
import { request } from './messaging.ts';
import type { Policy, PlaybackState, PlaybackStatus, FrameMessage } from './protocol.ts';
declare global {
  var __linuxRtxVsr: boolean | undefined;
}
interface Session {
  video: HTMLVideoElement;
  epoch: number;
  key: string;
  busy: boolean;
  sequence: number;
  callback: number;
  created: number;
  lastPresented: number;
  port?: MessagePort;
  iframe?: HTMLIFrameElement;
  parent?: HTMLElement;
  cleanup?: () => void;
  ready?: boolean;
  buffer?: ArrayBuffer | null;
}
(() => {
  if (globalThis.__linuxRtxVsr) return;
  globalThis.__linuxRtxVsr = true;
  let policy: Policy = { ...DEFAULTS, wanted: false };
  let video: HTMLVideoElement | null = null,
    session: Session | null = null,
    generation = 0;
  let failedKey: string | null = null,
    hoverUntil = 0,
    lastUrl = location.href,
    lastState = '',
    lastReport = 0;
  const audio = new VsrAudioSync(),
    clock = new VsrPresentationClock();
  function key(v: HTMLVideoElement | null) {
    return `${v?.currentSrc}|${policy.quality}|${policy.scale}`;
  }
  function state(name: PlaybackState, message: string, extra: Partial<PlaybackStatus> = {}) {
    const value = { state: name, message, ...extra },
      id = `${name}:${message}`,
      now = Date.now();
    if (id === lastState && now - lastReport < 250) return;
    lastState = id;
    lastReport = now;
    request({ type: 'state', value }).catch(() => {});
  }
  function stop() {
    generation++;
    const s = session;
    session = null;
    if (s) {
      s.video.cancelVideoFrameCallback?.(s.callback);
      s.port?.postMessage({ type: 'stop' });
      s.port?.close();
      s.iframe?.remove();
      s.cleanup?.();
    }
    audio.bypass();
    clock.reset();
  }
  function fail(error: string, unsupported = false) {
    failedKey = key(video);
    stop();
    state(unsupported ? 'unsupported' : 'error', error);
  }
  function visible(v: HTMLVideoElement) {
    const rect = v.getBoundingClientRect(),
      style = getComputedStyle(v);
    return (
      rect.width >= 64 &&
      rect.height >= 64 &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < innerHeight &&
      rect.left < innerWidth &&
      style.visibility === 'visible' &&
      style.display !== 'none' &&
      Number(style.opacity) > 0
    );
  }
  function choose() {
    return (
      [...document.querySelectorAll('video')].filter(visible).sort((a, b) => {
        const area = (v: HTMLVideoElement) => {
          const r = v.getBoundingClientRect();
          return (
            Math.max(0, Math.min(r.right, innerWidth) - Math.max(0, r.left)) *
            Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(0, r.top))
          );
        };
        return area(b) - area(a);
      })[0] || null
    );
  }
  function reason(v: HTMLVideoElement): [PlaybackState, string] | null {
    if (document.hidden) return ['paused', 'Tab hidden; GPU processing suspended'];
    if (v.paused || v.ended) return ['paused', 'Playback paused; showing original'];
    if (v.seeking || v.readyState < 3)
      return ['bypassed', 'Seeking or buffering; showing original'];
    if (document.pictureInPictureElement === v)
      return ['unsupported', 'Picture-in-picture shows the original video'];
    if (document.fullscreenElement === v)
      return [
        'bypassed',
        'Native video fullscreen shows original; use player-container fullscreen',
      ];
    if ([...v.textTracks].some((track) => track.mode === 'showing'))
      return ['bypassed', 'Native captions active; showing original to preserve captions'];
    if (v.controls && (Date.now() < hoverUntil || v.matches(':focus')))
      return ['bypassed', 'Original player controls visible'];
    if (v.playbackRate <= 0 || v.playbackRate > 2)
      return ['unsupported', 'Playback rates above 2× are unsupported'];
    if (!v.videoWidth || !v.videoHeight) return ['ready', 'Waiting for video dimensions'];
    if (v.videoWidth * policy.scale > 3840 || v.videoHeight * policy.scale > 2160)
      return [
        'bypassed',
        'Source is above the selected 4K output limit; lower scaling or source resolution',
      ];
    return null;
  }
  function position(s: Session) {
    if (!s.iframe?.isConnected || !s.video.isConnected) return false;
    const v = s.video.getBoundingClientRect(),
      p = s.parent!.getBoundingClientRect();
    Object.assign(s.iframe.style, {
      left: `${v.left - p.left + s.parent!.scrollLeft - s.parent!.clientLeft}px`,
      top: `${v.top - p.top + s.parent!.scrollTop - s.parent!.clientTop}px`,
      width: `${v.width}px`,
      height: `${v.height}px`,
    });
    return true;
  }
  async function begin(v: HTMLVideoElement) {
    if (session) return;
    const seq = ++generation;
    const s: Session = {
      video: v,
      epoch: seq,
      key: key(v),
      busy: false,
      sequence: 0,
      callback: 0,
      created: Date.now(),
      lastPresented: 0,
    };
    session = s;
    state('starting', 'Starting NVIDIA VideoSuperRes…');
    try {
      if (!window.VideoFrame || !v.requestVideoFrameCallback)
        throw new Error('This page needs a secure context and Chromium 140+ with WebCodecs');
      if (v.mediaKeys) {
        fail('Protected / DRM video cannot be enhanced', true);
        return;
      }
      await audio.attach(v);
      if (seq !== generation) return;
      const auth = await request({ type: 'authorize' });
      if (seq !== generation) return;
      if (!auth?.grant) throw new Error('Extension authorization failed; reload the extension');
      // The extension frame owns its visible canvas and worker. Keep its parent
      // stable: moving a live iframe reloads it and invalidates the MessagePort.
      const parent = v.closest<HTMLElement>('.html5-video-player') || v.parentElement;
      if (!parent || (parent === document.body && getComputedStyle(parent).position === 'static'))
        throw new Error('Unsupported player layout; wrap the video in a positioned container');
      const previousPosition = parent.style.position;
      const changedPosition = getComputedStyle(parent).position === 'static';
      if (changedPosition) parent.style.position = 'relative';
      s.cleanup = () => {
        if (changedPosition && parent.style.position === 'relative')
          parent.style.position = previousPosition;
      };
      let branch: HTMLElement = v;
      while (branch.parentElement && branch.parentElement !== parent) branch = branch.parentElement;
      const z = parseInt(getComputedStyle(branch).zIndex, 10) || 0;
      const iframe = document.createElement('iframe');
      s.iframe = iframe;
      s.parent = parent;
      iframe.title = 'NVIDIA enhanced video picture';
      iframe.tabIndex = -1;
      iframe.setAttribute('aria-hidden', 'true');
      iframe.style.cssText = `position:absolute;pointer-events:none;border:0;margin:0;padding:0;opacity:0;z-index:${z + 1};background:transparent;`;
      iframe.src = chrome.runtime.getURL('bridge.html');
      const channel = new MessageChannel();
      s.port = channel.port1;
      s.port.onmessage = (event) => {
        if (seq !== generation) return;
        const data = event.data as FrameMessage;
        if (data.type === 'error') {
          fail(data.message);
          return;
        }
        if (data.type === 'ready') {
          s.ready = true;
          sendClock(s);
          capture(s);
        }
        if (data.type === 'available') s.busy = false;
        if (data.type === 'recycle') s.buffer = data.buffer;
        if (data.type === 'decoded') audio.update(data.ageMs);
        if (data.type === 'stale') {
          iframe.style.opacity = '0';
          audio.bypass();
          state('bypassed', data.message);
        }
        if (data.type === 'presented' && data.epoch === s.epoch && visible(v) && !reason(v)) {
          iframe.style.opacity = '1';
          s.lastPresented = Date.now();
          state('active', 'Fresh enhanced frames are being presented', {
            epoch: s.epoch,
            presentedAt: Date.now(),
            source: `${data.stats.source_width} × ${data.stats.source_height}`,
            output: `${data.stats.width} × ${data.stats.height}`,
            fps: data.fps,
            latencyMs: data.stats.service_ms,
            inferenceMs: data.stats.inference_ms,
            dropped: data.dropped,
            presented: data.presented,
            latenessMs: data.latenessMs,
            startupMs: data.startupMs,
            audio: audio.stats(),
          });
        }
      };
      s.port.onmessageerror = () =>
        fail('Browser frame transport failed; reload the extension and refresh this page');
      s.port.start();
      iframe.addEventListener(
        'load',
        () => {
          if (seq !== generation) return;
          iframe.contentWindow?.postMessage(
            {
              type: 'rtx-vsr-init',
              grant: auth.grant,
              quality: policy.quality,
              scale: policy.scale,
              objectFit: getComputedStyle(v).objectFit,
            },
            chrome.runtime.getURL(''),
            [channel.port2],
          );
        },
        { once: true },
      );
      parent.append(iframe);
      position(s);
    } catch (error) {
      if (seq === generation)
        fail(errorMessage(error), error instanceof DOMException && error.name === 'SecurityError');
    }
  }
  function sendClock(s: Session) {
    const now = performance.now(),
      input = clock.mediaTime(now) ?? s.video.currentTime;
    s.port?.postMessage({
      type: 'clock',
      epoch: s.epoch,
      input,
      media: audio.audibleTime(s.video, input),
      at: performance.timeOrigin + now,
      rate: s.video.playbackRate,
    });
  }
  function capture(s: Session) {
    if (session !== s) return;
    s.callback = s.video.requestVideoFrameCallback((now, metadata) => {
      if (session !== s) return;
      if (reason(s.video)) {
        reconcile();
        return;
      }
      clock.observe(metadata, s.video.playbackRate, s.video.currentTime, now);
      sendClock(s);
      if (!s.busy && s.ready) {
        try {
          const frame = new VideoFrame(s.video, {
            timestamp: Math.round(metadata.mediaTime * 1e6),
          });
          s.busy = true;
          copyFrame(s, frame, metadata.mediaTime);
        } catch (error) {
          fail(
            `Cannot read this video: ${errorMessage(error)}. Protected and cross-origin restricted media are unsupported.`,
            true,
          );
          return;
        }
      }
      capture(s);
    });
  }
  async function copyFrame(s: Session, frame: VideoFrame, timestamp: number) {
    try {
      // Chromium cannot transfer VideoFrame across the page/extension agent
      // clusters. copyTo performs asynchronous native staging; transfer only the
      // resulting ArrayBuffer. Inference, decoding and drawing stay in workers.
      const w = frame.displayWidth,
        h = frame.displayHeight;
      if (['pq', 'hlg'].includes(frame.colorSpace?.transfer || ''))
        throw new Error('HDR video is unsupported; use SDR playback');
      const nv12 = frame.format === 'NV12' && w % 2 === 0 && h % 2 === 0;
      const matrix = frame.colorSpace?.matrix;
      if (nv12 && !['bt709', 'smpte170m', 'bt470bg'].includes(matrix || ''))
        throw new Error(`Unsupported video color matrix: ${matrix || 'unknown'}`);
      if (nv12 && frame.colorSpace?.fullRange && matrix !== 'bt709')
        throw new Error('Full-range SD NV12 is unsupported');
      const format = nv12 ? (frame.colorSpace?.fullRange ? 3 : matrix === 'bt709' ? 1 : 2) : 0;
      const size = nv12 ? (w * h * 3) / 2 : w * h * 4;
      const buffer = s.buffer?.byteLength === 32 + size ? s.buffer : new ArrayBuffer(32 + size);
      s.buffer = null;
      const options: VideoFrameCopyToOptions = nv12
        ? {
            format: 'NV12',
            layout: [
              { offset: 0, stride: w },
              { offset: w * h, stride: w },
            ],
          }
        : { format: 'RGBA', layout: [{ offset: 0, stride: w * 4 }], colorSpace: 'srgb' };
      await frame.copyTo(new Uint8Array(buffer, 32), options);
      if (session !== s) return;
      const header = new DataView(buffer);
      new Uint8Array(buffer, 0, 4).set([82, 86, 83, 49]);
      for (const [offset, number] of [
        [4, w],
        [8, h],
        [12, format],
        [16, ++s.sequence],
        [20, s.epoch],
      ])
        header.setUint32(offset, number, true);
      header.setFloat64(24, timestamp, true);
      s.port!.postMessage({ type: 'capture', buffer, epoch: s.epoch }, [buffer]);
    } catch (error) {
      if (session === s) fail(`Cannot capture this video: ${errorMessage(error)}`, true);
    } finally {
      frame.close();
    }
  }
  function reconcile() {
    if (!policy.wanted) {
      if (session) stop();
      state(
        'disabled',
        policy.enabled === false
          ? 'Globally disabled'
          : 'Off for this tab; enable it here or save a site rule',
      );
      return;
    }
    const next = choose();
    if (next !== video) {
      stop();
      video = next;
      failedKey = null;
    }
    if (!video) {
      state('ready', 'Waiting for a visible top-level video');
      return;
    }
    const bypass = reason(video);
    if (bypass) {
      if (session) stop();
      state(...bypass);
      return;
    }
    if (failedKey === key(video)) return;
    if (session && session.key !== key(video)) stop();
    if (!session) {
      begin(video);
      return;
    }
    if (session.port) sendClock(session);
    position(session);
    if (session.lastPresented && Date.now() - session.lastPresented > 250) {
      session.iframe!.style.opacity = '0';
      audio.bypass();
      state('bypassed', 'No fresh enhanced frames; showing original');
    }
    if (!session.lastPresented && Date.now() - session.created > 15000)
      fail('No synchronized output within 15 seconds. Run doctor --gpu, then enable again.');
  }
  async function refresh() {
    try {
      const next = await request({ type: 'policy' });
      if (policy.quality !== next.quality || policy.scale !== next.scale) stop();
      policy = next;
      failedKey = null;
      reconcile();
    } catch (error) {
      fail(
        `Extension connection lost: ${errorMessage(error)}. Reload the extension and refresh this page.`,
      );
    }
  }
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'policy-changed') refresh();
  });
  document.addEventListener('visibilitychange', reconcile);
  document.addEventListener('fullscreenchange', reconcile);
  document.addEventListener(
    'pointermove',
    (event) => {
      if (
        video?.controls &&
        (event.target === video || video.parentElement?.contains(event.target as Node | null))
      ) {
        hoverUntil = Date.now() + 1800;
        reconcile();
      }
    },
    { passive: true },
  );
  for (const name of [
    'pause',
    'seeking',
    'waiting',
    'emptied',
    'loadstart',
    'ratechange',
    'enterpictureinpicture',
  ]) {
    document.addEventListener(
      name,
      (event) => {
        if (event.target === video) {
          stop();
          reconcile();
        }
      },
      true,
    );
  }
  document.addEventListener('play', reconcile, true);
  window.addEventListener('pagehide', stop);
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      stop();
      refresh();
    } else reconcile();
  }, 100);
  refresh();
})();
