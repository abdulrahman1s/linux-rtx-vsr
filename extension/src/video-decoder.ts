import type { FrameMetadata } from './protocol.ts';
import { MAX_IN_FLIGHT } from './frame-budget.ts';
// Owns codec negotiation, pending output and shutdown. VideoFrames remain in
// the decoding/presentation worker; no ImageBitmap conversion or pixel readback.
export interface PacketDecoder {
  decode(data: ArrayBuffer, meta: FrameMetadata): Promise<VideoFrame>;
  close(): void;
}
export function createPacketDecoder(): PacketDecoder {
  let decoder: VideoDecoder | undefined,
    key = '',
    sequence = 0,
    needsKeyframe = true,
    closed = false;
  let configuring: Promise<void> | undefined;
  const pending = new Map<
    number,
    { resolve(frame: VideoFrame): void; reject(error: Error): void }
  >();
  function rejectAll(error: Error) {
    for (const item of pending.values()) item.reject(error);
    pending.clear();
  }
  return {
    async decode(data, meta) {
      if (closed) throw new Error('Video decoder is closed');
      if (
        meta.format !== 'av1' ||
        !/^av01\.0\.\d{2}[MH]\.08$/.test(meta.codec) ||
        typeof meta.keyframe !== 'boolean'
      )
        throw new Error(
          'Expected NVENC AV1 packets; update the application and extension together',
        );
      if (typeof VideoDecoder === 'undefined')
        throw new Error('This browser does not expose WebCodecs VideoDecoder');
      const nextKey = `${meta.codec}/${meta.width}/${meta.height}`;
      if (key !== nextKey) {
        key = nextKey;
        const previous = configuring;
        configuring = (async () => {
          await previous;
          if (closed) throw new Error('Video decoder is closed');
          decoder?.close();
          rejectAll(new Error('Video decoder configuration changed'));
          const config: VideoDecoderConfig = {
            codec: meta.codec,
            codedWidth: meta.width,
            codedHeight: meta.height,
            hardwareAcceleration: 'prefer-hardware',
            optimizeForLatency: true,
          };
          const support = await VideoDecoder.isConfigSupported(config);
          if (closed) throw new Error('Video decoder is closed');
          if (!support.supported)
            throw new Error(
              'AV1 WebCodecs decoding is unavailable. Enable hardware acceleration and check browser GPU video decoding support.',
            );
          decoder = new VideoDecoder({
            output(frame) {
              const item = pending.get(frame.timestamp);
              pending.delete(frame.timestamp);
              if (item) item.resolve(frame);
              else frame.close();
            },
            error(error) {
              rejectAll(new Error(`AV1 video decoding failed: ${error.message}`));
            },
          });
          decoder.configure(config);
          needsKeyframe = true;
        })();
      }
      await configuring;
      if (closed) throw new Error('Video decoder is closed');
      if (needsKeyframe && !meta.keyframe)
        throw new Error('AV1 stream must start with a keyframe; enable enhancement again');
      if (pending.size >= MAX_IN_FLIGHT) throw new Error('AV1 decoder exceeded its bounded queue');
      const timestamp = ++sequence;
      return new Promise<VideoFrame>((resolve, reject) => {
        pending.set(timestamp, { resolve, reject });
        try {
          decoder!.decode(
            new EncodedVideoChunk({ type: meta.keyframe ? 'key' : 'delta', timestamp, data }),
          );
          needsKeyframe = false;
        } catch (error) {
          pending.delete(timestamp);
          reject(error);
        }
      });
    },
    close() {
      closed = true;
      if (decoder?.state !== 'closed') decoder?.close();
      rejectAll(new Error('Video decoder was stopped'));
    },
  };
}
