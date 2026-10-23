import { errorMessage } from './errors.ts';
import { VsrAudioSync } from './audio-sync.ts';
import { VsrPresentationClock } from './presentation-clock.ts';
import { DEFAULTS } from './policy.ts';
import { request } from './messaging.ts';
import { planOutput } from './resolution.ts';
import { captureCapacity, MAX_IN_FLIGHT } from './frame-budget.ts';
import { captureFormat } from './capture-format.ts';
import { createVideoOverlay, type VideoOverlay } from './video-overlay.ts';
import { StartupWatchdog } from './startup-watchdog.ts';
import type { Policy, PlaybackState, PlaybackStatus, FrameMessage } from './protocol.ts';
// A short decode hiccup should hold the painted picture rather than flashing
// between original/enhanced. Active status still expires after 200 ms.
const PICTURE_GRACE_MS = 350;
declare global {
  var __linuxRtxVsr: boolean | undefined;
}
interface Session {
  video: HTMLVideoElement;
  epoch: number;
  key: string;
  pending: number;
  sequence: number;
  callback: number;
  startup: StartupWatchdog;
  lastPresented: number;
  port?: MessagePort;
  overlay?: VideoOverlay;
  ready?: boolean;
  buffers: ArrayBuffer[];
  pausedAt?: number;
  resumingAt?: number;
}
(() => {
  if (globalThis.__linuxRtxVsr) return;
  globalThis.__linuxRtxVsr = true;
  let policy: Policy = { ...DEFAULTS, wanted: false };
  let held: Pick<Session, 'video' | 'key' | 'overlay'> | null = null;
  let video: HTMLVideoElement | null = null,
    session: Session | null = null,
    generation = 0;
  let failedKey: string | null = null,
    startupRetryKey: string | null = null,
    failureStatus: { name: PlaybackState; message: string } | null = null,
    needsGesture = false,
    hoverUntil = 0,
    lastUrl = location.href,
    lastState = '',
    lastReport = 0,
    retryAfter = 0;
  const audio = new VsrAudioSync(),
    clock = new VsrPresentationClock();
  function key(v: HTMLVideoElement | null) {
    return `${v?.currentSrc}|${v?.videoWidth}x${v?.videoHeight}|${policy.quality}|${policy.target}`;
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
  function releasePicture() {
    held?.overlay?.close();
    held = null;
  }
  function stop(keepPicture = false) {
    generation++;
    const s = session;
    session = null;
    if (s) {
      s.video.cancelVideoFrameCallback?.(s.callback);
      s.port?.postMessage({ type: 'stop' });
      s.port?.close();
      if (keepPicture && s.lastPresented && s.overlay?.element.style.opacity === '1') {
        releasePicture();
        held = { video: s.video, key: s.key, overlay: s.overlay };
      } else {
        s.overlay?.close();
      }
    }
    if (!keepPicture) releasePicture();
    audio.bypass();
    clock.reset();
  }
  function fail(error: string, unsupported = false) {
    failedKey = key(video);
    needsGesture = /playback gesture|Play the video|Audio needs/.test(error);
    failureStatus = { name: unsupported ? 'unsupported' : 'error', message: error };
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
    if (v.ended) return ['paused', 'Playback ended'];
    if (v.seeking || (!v.paused && v.readyState < 3))
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
    if (!v.videoWidth || !v.videoHeight)
      return v.paused ? null : ['ready', 'Waiting for video dimensions'];
    if (planOutput(v.videoWidth, v.videoHeight, policy.target).bypass)
      return ['bypassed', `Source already meets the ${policy.target}p target; showing original`];
    return null;
  }
  async function begin(v: HTMLVideoElement) {
    if (session) return;
    const seq = ++generation;
    const s: Session = {
      video: v,
      epoch: seq,
      key: key(v),
      pending: 0,
      sequence: 0,
      callback: 0,
      startup: new StartupWatchdog(Date.now()),
      lastPresented: 0,
      buffers: [],
    };
    session = s;
    state(
      'starting',
      startupRetryKey === s.key ? 'Retrying NVIDIA startup…' : 'Starting NVIDIA VideoSuperRes…',
    );
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
      s.overlay = createVideoOverlay(v, chrome.runtime.getURL('bridge.html'));
      const iframe = s.overlay.element;
      const channel = new MessageChannel();
      s.port = channel.port1;
      s.port.onmessage = (event) => {
        if (seq !== generation) return;
        const data = event.data as FrameMessage;
        if (data.type === 'error') {
          // A transient backend/socket loss gets the same single retry as a
          // startup timeout. Require actual presentation to reset the budget.
          if (data.retryable && startupRetryKey !== s.key) {
            startupRetryKey = s.key;
            stop();
            // Let the old daemon/stream finish releasing its lock and lease.
            retryAfter = Date.now() + 500;
            reconcile();
            return;
          }
          fail(data.message);
          return;
        }
        if (data.type === 'ready') {
          s.startup.progress('capture', Date.now());
          s.ready = true;
          sendClock(s);
          capture(s);
        }
        if (data.type === 'available') s.pending = Math.max(0, s.pending - 1);
        if (data.type === 'recycle' && s.buffers.length < MAX_IN_FLIGHT)
          s.buffers.push(data.buffer);
        if (data.type === 'decoded' && !v.paused) {
          s.startup.progress('sync', Date.now());
          audio.update(data.ageMs);
        }
        if (data.type === 'stale') {
          if (s.pausedAt !== undefined) return;
          state('bypassed', data.message);
          if (Date.now() - Math.max(s.lastPresented, s.resumingAt || 0) < PICTURE_GRACE_MS) return;
          iframe.style.opacity = '0';
          audio.bypass();
        }
        if (
          data.type === 'presented' &&
          data.epoch === s.epoch &&
          (!s.resumingAt || data.presentedAt >= s.resumingAt) &&
          Date.now() - data.presentedAt <= 200 &&
          visible(v) &&
          !reason(v) &&
          !v.paused
        ) {
          iframe.style.opacity = '1';
          releasePicture();
          s.lastPresented = data.presentedAt;
          s.startup.progress('active', Date.now());
          startupRetryKey = null;
          s.resumingAt = undefined;
          state('active', 'Fresh enhanced frames are being presented', {
            epoch: s.epoch,
            presentedAt: data.presentedAt,
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
            timings: data.stats,
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
              scale: planOutput(v.videoWidth, v.videoHeight, policy.target).scale,
              objectFit: getComputedStyle(v).objectFit,
            },
            chrome.runtime.getURL(''),
            [channel.port2],
          );
        },
        { once: true },
      );
      s.overlay.position();
    } catch (error) {
      if (seq === generation)
        fail(errorMessage(error), error instanceof DOMException && error.name === 'SecurityError');
    }
  }
  function sendClock(s: Session) {
    const now = performance.now(),
      input = s.video.paused ? s.video.currentTime : (clock.mediaTime(now) ?? s.video.currentTime);
    s.port?.postMessage({
      type: 'clock',
      epoch: s.epoch,
      input,
      media: audio.audibleTime(s.video, input),
      at: performance.timeOrigin + now,
      rate: s.video.paused ? 0 : s.video.playbackRate,
    });
  }
  function capture(s: Session) {
    if (session !== s || s.video.paused || s.callback) return;
    s.callback = s.video.requestVideoFrameCallback((now, metadata) => {
      s.callback = 0;
      if (session !== s) return;
      if (s.video.paused || reason(s.video)) {
        reconcile();
        return;
      }
      clock.observe(metadata, s.video.playbackRate, s.video.currentTime, now);
      sendClock(s);
      if (s.pending < MAX_IN_FLIGHT && s.ready) {
        let frame: VideoFrame | undefined;
        try {
          frame = new VideoFrame(s.video, {
            timestamp: Math.round(metadata.mediaTime * 1e6),
          });
          const bytes =
            32 + frame.displayWidth * frame.displayHeight * (captureFormat(frame) === 0 ? 4 : 1.5);
          if (s.pending < captureCapacity(bytes)) {
            s.pending++;
            copyFrame(s, frame, metadata.mediaTime);
          } else frame.close();
        } catch (error) {
          frame?.close();
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
    const copyAt = performance.now();
    const sequence = ++s.sequence;
    try {
      // Chromium cannot transfer VideoFrame across the page/extension agent
      // clusters. copyTo performs asynchronous native staging; transfer only the
      // resulting ArrayBuffer. Inference, decoding and drawing stay in workers.
      const w = frame.displayWidth,
        h = frame.displayHeight;
      const format = captureFormat(frame);
      const nv12 = format !== 0;
      const size = nv12 ? (w * h * 3) / 2 : w * h * 4;
      const recycled = s.buffers.pop();
      const buffer = recycled?.byteLength === 32 + size ? recycled : new ArrayBuffer(32 + size);
      const options: VideoFrameCopyToOptions = nv12
        ? {
            // Already NV12. Brave rejects an explicit non-RGB conversion
            // request even when it matches the source format.
            layout: [
              { offset: 0, stride: w },
              { offset: w * h, stride: w },
            ],
          }
        : { format: 'RGBA', layout: [{ offset: 0, stride: w * 4 }], colorSpace: 'srgb' };
      await frame.copyTo(new Uint8Array(buffer, 32), options);
      if (session !== s) return;
      if (s.video.paused) {
        s.pending = Math.max(0, s.pending - 1);
        return;
      }
      const header = new DataView(buffer);
      new Uint8Array(buffer, 0, 4).set([82, 86, 83, 49]);
      for (const [offset, number] of [
        [4, w],
        [8, h],
        [12, format],
        [16, sequence],
        [20, s.epoch],
      ])
        header.setUint32(offset, number, true);
      header.setFloat64(24, timestamp, true);
      s.startup.progress('engine', Date.now());
      s.port!.postMessage(
        {
          type: 'capture',
          buffer,
          sequence,
          captureMs: performance.now() - copyAt,
          copiedAt: performance.timeOrigin + performance.now(),
          epoch: s.epoch,
        },
        [buffer],
      );
    } catch (error) {
      if (session === s) fail(`Cannot capture this video: ${errorMessage(error)}`, true);
    } finally {
      frame.close();
    }
  }
  function reconcile() {
    if (!policy.wanted) {
      if (session || held) stop();
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
      startupRetryKey = null;
    }
    if (!video) {
      state('ready', 'Waiting for a visible video in this page or permitted player frame');
      return;
    }
    const bypass = reason(video);
    if (bypass) {
      if (session || held) stop();
      state(...bypass);
      return;
    }
    if (held && held.key !== key(video)) releasePicture();
    if (session && session.key !== key(video)) stop();
    if (video.paused) {
      const s = session;
      if (s) {
        if (s.pausedAt === undefined) {
          s.pausedAt = Date.now();
          s.video.cancelVideoFrameCallback(s.callback);
          s.callback = 0;
          audio.pause();
          clock.reset();
          sendClock(s);
        }
        s.overlay?.position();
        // Release the native stream lease/decoder after a short warm pause;
        // keep only the already painted canvas until playback starts again.
        // Release promptly even though the native stream tolerates short stalls.
        if (Date.now() - s.pausedAt >= 1500) stop(true);
      }
      held?.overlay?.position();
      state(
        'paused',
        held || session?.lastPresented
          ? 'Playback paused; holding the enhanced picture'
          : 'Playback paused; showing original',
      );
      return;
    }
    if (failedKey === key(video)) {
      if (failureStatus) state(failureStatus.name, failureStatus.message);
      return;
    }
    if (Date.now() < retryAfter) {
      state('starting', 'Reconnecting to NVIDIA VideoSuperRes…');
      return;
    }
    if (!session) {
      if (held) {
        const picture = held;
        setTimeout(() => {
          if (held === picture && !video?.paused) releasePicture();
        }, PICTURE_GRACE_MS);
      }
      begin(video);
      return;
    }
    if (session.pausedAt !== undefined) {
      session.pausedAt = undefined;
      session.resumingAt = Date.now();
      clock.reset();
      sendClock(session);
      capture(session);
      state('starting', 'Resuming enhanced playback…');
    }
    if (session.port) sendClock(session);
    session.overlay?.position();
    if (
      session.lastPresented &&
      Date.now() - Math.max(session.lastPresented, session.resumingAt || 0) > PICTURE_GRACE_MS
    ) {
      session.overlay!.element.style.opacity = '0';
      audio.bypass();
      state('bypassed', 'No fresh enhanced frames; showing original');
    }
    const startupError = session.startup.error(Date.now());
    if (startupError) {
      if (startupRetryKey !== session.key) {
        startupRetryKey = session.key;
        stop();
        begin(video);
      } else fail(`${startupError}. Automatic retry failed; enable again to retry.`);
    }
  }
  async function refresh() {
    try {
      const next = await request({ type: 'policy' });
      if (policy.quality !== next.quality || policy.target !== next.target) stop();
      policy = next;
      failedKey = null;
      startupRetryKey = null;
      reconcile();
    } catch (error) {
      fail(
        `Extension connection lost: ${errorMessage(error)}. Reload the extension and refresh this page.`,
      );
    }
  }
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message.type === 'probe') respond({ attached: true });
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
  document.addEventListener('pause', reconcile, true);
  document.addEventListener(
    'click',
    () => {
      if (needsGesture && video && !video.paused) {
        needsGesture = false;
        failedKey = null;
        reconcile();
      }
    },
    true,
  );
  window.addEventListener('pagehide', () => stop());
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      stop();
      refresh();
    } else reconcile();
  }, 100);
  refresh();
})();
