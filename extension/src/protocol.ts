// Shared wire contracts. Types do not grant trust: privileged requests still
// require sender checks, and native frames are validated by the Rust backend.
export type Quality = 1 | 2 | 3 | 4;
export type TargetResolution = 720 | 1080 | 1440 | 2160 | 4320;
export interface Settings {
  enabled: boolean;
  sites: Record<string, boolean>;
  quality: Quality;
  target: TargetResolution;
}
export interface TabOverride {
  origin: string;
  enabled: boolean;
}
export interface Policy extends Settings {
  wanted: boolean;
}
export type PlaybackState =
  'disabled' | 'ready' | 'starting' | 'active' | 'paused' | 'bypassed' | 'error' | 'unsupported';
export interface PlaybackStatus {
  state: PlaybackState;
  message: string;
  presentedAt?: number;
  epoch?: number;
  source?: string;
  output?: string;
  fps?: number;
  latencyMs?: number;
  inferenceMs?: number;
  dropped?: number;
  presented?: number;
  latenessMs?: number;
  startupMs?: number;
  audio?: object;
  timings?: FrameTimings;
}
export interface FrameTimings {
  capture_ms?: number;
  round_trip_ms?: number;
  worker_round_trip_ms?: number;
  upload_ms?: number;
  encode_ms?: number;
  decode_ms?: number;
  draw_ms?: number;
  presentation_wait_ms?: number;
  request_ms?: number;
  response_ms?: number;
  received_wall_ms?: number;
  completed_wall_ms?: number;
}
export interface Snapshot {
  settings: Settings;
  override?: TabOverride;
  state: PlaybackStatus;
  origin: string | null;
  policy: Policy;
}
export interface Authorization {
  port: number;
  token: string;
}
export interface BackendStatus {
  running: boolean;
  gpu_loaded?: boolean;
}
export type RuntimeRequest =
  | { type: 'policy' }
  | { type: 'state'; value: PlaybackStatus }
  | { type: 'authorize' }
  | { type: 'claim'; grant: string }
  | { type: 'snapshot'; tabId: number }
  | { type: 'manual' | 'automatic'; tabId: number; enabled: boolean }
  | { type: 'settings'; enabled?: boolean; quality?: number; target?: number }
  | { type: 'reset-override'; tabId: number }
  | { type: 'backend' };
export type RuntimeReply<T extends RuntimeRequest> = T extends { type: 'policy' }
  ? Policy
  : T extends { type: 'snapshot' }
    ? Snapshot
    : T extends { type: 'authorize' }
      ? { grant: string }
      : T extends { type: 'claim' }
        ? Authorization
        : T extends { type: 'backend' }
          ? BackendStatus
          : Record<string, never>;
export interface ClockMessage {
  type: 'clock';
  epoch: number;
  input: number;
  media: number;
  at: number;
  rate: number;
}
export interface FrameMetadata extends FrameTimings {
  type: 'frame';
  sequence: number;
  epoch: number;
  timestamp: number;
  source_width: number;
  source_height: number;
  width: number;
  height: number;
  service_ms: number;
  inference_ms: number;
  format: 'av1';
  codec: string;
  keyframe: true;
}
export type CaptureMessage =
  | ClockMessage
  | { type: 'stop' }
  | { type: 'capture'; epoch: number; sequence: number; captureMs: number; buffer: ArrayBuffer };
export type FrameMessage =
  | { type: 'ready' | 'available' }
  | { type: 'error' | 'stale'; message: string }
  | { type: 'recycle'; buffer: ArrayBuffer }
  | { type: 'decoded'; ageMs: number }
  | {
      type: 'presented';
      epoch: number;
      presented: number;
      dropped: number;
      fps: number;
      latenessMs: number;
      stats: FrameMetadata;
      startupMs: number;
    };
export interface WorkerInit {
  type: 'init';
  port: MessagePort;
  canvas: OffscreenCanvas;
  auth: Authorization;
  quality: Quality;
  scale: number;
}
