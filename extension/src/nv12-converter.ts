import { MAX_IN_FLIGHT } from './frame-budget.ts';
// Chromium commonly exposes decoded <video> pictures as BGRX VideoFrames, even
// with hardware decoding. RGBA copies are 8 MiB per 1080p frame, ~500 MB/s at
// 60 fps across the page/extension and WebSocket hops; that bandwidth, not the
// GPU, stalled playback. Convert on the page's GPU to limited-range BT.709 NV12
// (2.7× smaller). The RGB input is the same sRGB-encoded picture copyTo would
// return, so the native side keeps the sRGB transfer (format 4). This changes
// only the pixel encoding; it never scales or substitutes the enhancement.
export const CONVERTED_NV12 = 4;
const VERTEX = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;
// One RGBA8 output texel packs four Y bytes, or two interleaved UV pairs.
// Rows [0, height) are luma and rows [height, 1.5 height) chroma, so a single
// readPixels returns a tightly packed NV12 picture when width % 4 == 0.
const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D source;
uniform int height;
out vec4 color;
const vec3 KY = vec3(0.2126, 0.7152, 0.0722);
vec3 rgb(ivec2 p) { return texelFetch(source, p, 0).rgb; }
float luma(ivec2 p) { return (16.0 + 219.0 * dot(rgb(p), KY)) / 255.0; }
// One 2×2 block averaged before the matrix, as a box chroma downsample.
vec2 chroma(ivec2 p) {
  vec3 c = 0.25 * (rgb(p) + rgb(p + ivec2(1, 0)) + rgb(p + ivec2(0, 1)) + rgb(p + ivec2(1, 1)));
  float l = dot(c, KY);
  return (128.0 + 224.0 * vec2((c.b - l) / 1.8556, (c.r - l) / 1.5748)) / 255.0;
}
void main() {
  // GLSL ES forbids non-constant indexing of outputs, so samples are unrolled.
  ivec2 at = ivec2(gl_FragCoord.xy);
  int x = at.x * 4;
  if (at.y < height) {
    color = vec4(
      luma(ivec2(x, at.y)), luma(ivec2(x + 1, at.y)),
      luma(ivec2(x + 2, at.y)), luma(ivec2(x + 3, at.y)));
  } else {
    int y = (at.y - height) * 2;
    color = vec4(chroma(ivec2(x, y)), chroma(ivec2(x + 2, y)));
  }
}`;
export interface Nv12Converter {
  supports(frame: VideoFrame): boolean;
  // Uploads synchronously; the caller may close the frame once this returns.
  convert(frame: VideoFrame, target: Uint8Array): Promise<void>;
  close(): void;
}
export function createNv12Converter(): Nv12Converter | null {
  if (typeof OffscreenCanvas === 'undefined') return null;
  const gl = new OffscreenCanvas(1, 1).getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: 'high-performance',
  });
  if (!gl) return null;
  const shader = (type: number, text: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, text);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
      throw new Error(`NV12 shader: ${gl.getShaderInfoLog(s)}`);
    return s;
  };
  const program = gl.createProgram()!;
  try {
    gl.attachShader(program, shader(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error(`NV12 program: ${gl.getProgramInfoLog(program)}`);
  } catch {
    return null;
  }
  const height = gl.getUniformLocation(program, 'height'),
    sampler = gl.getUniformLocation(program, 'source');
  const source = gl.createTexture()!,
    output = gl.createTexture()!,
    framebuffer = gl.createFramebuffer()!;
  for (const texture of [source, output]) {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }
  const maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  // Readbacks stay in flight while the next frame converts; one buffer each.
  const idle: WebGLBuffer[] = [];
  let outputSize = '',
    closed = false;
  return {
    supports(frame) {
      const w = frame.displayWidth,
        h = frame.displayHeight;
      return (
        !closed &&
        !gl.isContextLost() &&
        w % 4 === 0 &&
        h % 2 === 0 &&
        w <= maxSize &&
        (h * 3) / 2 <= maxSize &&
        // copyTo and texture uploads disagree on non-square pixel sizes.
        frame.visibleRect?.width === w &&
        frame.visibleRect?.height === h
      );
    },
    convert(frame, target) {
      const w = frame.displayWidth,
        h = frame.displayHeight,
        columns = w / 4,
        rows = (h * 3) / 2;
      if (target.byteLength !== w * rows) throw new Error('NV12 target size mismatch');
      gl.bindTexture(gl.TEXTURE_2D, source);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, frame);
      gl.bindTexture(gl.TEXTURE_2D, output);
      if (outputSize !== `${columns}x${rows}`) {
        outputSize = `${columns}x${rows}`;
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA8,
          columns,
          rows,
          0,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          null,
        );
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, output, 0);
      gl.viewport(0, 0, columns, rows);
      gl.useProgram(program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, source);
      gl.uniform1i(sampler, 0);
      gl.uniform1i(height, h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const pixels = idle.pop() || gl.createBuffer()!;
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pixels);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, target.byteLength, gl.STREAM_READ);
      gl.readPixels(0, 0, columns, rows, gl.RGBA, gl.UNSIGNED_BYTE, 0);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)!;
      gl.flush();
      // Never block the page's main thread on the GPU: poll the fence.
      return new Promise<void>((resolve, reject) => {
        const poll = () => {
          if (closed || gl.isContextLost()) {
            gl.deleteSync(fence);
            reject(new Error('NV12 conversion context was lost'));
            return;
          }
          const status = gl.clientWaitSync(fence, 0, 0);
          if (status === gl.TIMEOUT_EXPIRED) {
            setTimeout(poll, 1);
            return;
          }
          gl.deleteSync(fence);
          if (status === gl.WAIT_FAILED) {
            reject(new Error('NV12 conversion failed on the GPU'));
            return;
          }
          gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pixels);
          gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, target);
          gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
          if (idle.length < MAX_IN_FLIGHT) idle.push(pixels);
          else gl.deleteBuffer(pixels);
          resolve();
        };
        poll();
      });
    },
    close() {
      closed = true;
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}
