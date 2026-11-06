// One upload-only socket on its own thread. Chromium bounds WebSocket upload
// per worker thread (~127 MB/s measured), below 1080p60 NV12, so the frame
// session spreads frames over several of these. Results never come back here.
import type { UplinkMessage } from './protocol.ts';
let ws: WebSocket | undefined;
self.onmessage = ({ data }: MessageEvent<UplinkMessage>) => {
  if (data.type === 'frame') ws?.send(data.buffer);
  else if (!ws) {
    ws = new WebSocket(data.url);
    ws.onopen = () => {
      ws!.send(JSON.stringify(data.hello));
      postMessage('open');
    };
    ws.onerror = ws.onclose = () => postMessage('closed');
  }
};
