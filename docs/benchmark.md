# Repeatable benchmark procedure

Measure each layer separately. Report limitations and raw results; do not infer browser fps from a native-only benchmark.

## Record the environment

```sh
mkdir -p test-results
date -u > test-results/environment.txt
uname -a >> test-results/environment.txt
cat /etc/os-release >> test-results/environment.txt
lscpu >> test-results/environment.txt
nvidia-smi >> test-results/environment.txt
chromium --version >> test-results/environment.txt
linux-rtx-vsr --version >> test-results/environment.txt
linux-rtx-vsr config show > test-results/native-config.json
```

Also record runtime version, display refresh/resolution, scaling, X11/Wayland, power profile, browser flags, audio device, source file hash/codec/bit depth/resolution/fps, and extension settings. Close unrelated GPU work or explicitly record it. Distinguish a cold process from warm runs; alternate enhanced/original trials with the same source/settings.

## Native-only inference

```sh
linux-rtx-vsr stop
linux-rtx-vsr benchmark --frames 300 --width 1920 --height 1080 \
  --target 2160 --output test-results/enhanced.obu > test-results/native-1080p.json
```

This generates a deterministic RGBA SDR gradient/check pattern in Rust. It measures runtime loading, cold first-frame time, warm p50/p95 processing time, overall throughput, and mean compressed bytes. It includes image upload, real inference, color conversion, NVENC AV1 encoding and compressed packet download. It excludes browser transport and presentation. Decode with `ffmpeg -i test-results/enhanced.obu -frames:v 1 test-results/enhanced.png` and inspect the PNG for non-black meaningful output and expected dimensions. Native input is fixed across the run, so these numbers are not quality or temporal-consistency measurements on natural video.

Repeat for Low/Medium/High/Ultra and 720p/1080p/1440p/4K targets with sources 640×360, 1280×720 and 1920×1080; test experimental 8K separately where the GPU/runtime permits. Use at least three cold trials and five warm trials. Keep raw JSON. `overall_fps` includes cold startup; warm time quantiles exclude the first frame.

For a repeatable sampled native CPU/RSS/device-resource run:

```sh
bun scripts/measure-native.ts --binary /absolute/path/to/linux-rtx-vsr --frames 2000
```

It samples `/proc` and `nvidia-smi` into `test-results/native-resources.json`. Sampling has overhead and records whole-device totals, including other workloads. Supply runtime paths through normal configuration or the Nix wrapper.

## Browser throughput and latency

To isolate WebSocket and GPU-process transport from browser capture/presentation:

```sh
just benchmark-transport --sdk-dir /absolute/path/to/nvvfx/libs --window 2 --frames 180
```

This uses a temporary private configuration/backend, sends deterministic 1080p NV12 through the authenticated loopback interface, and requires real 4K NVIDIA VSR/NVENC output. It stops only its own backend. The first 30 completions are excluded from warm statistics. Test `--window 1`, `2` and `4`, retaining separate `--output` JSON files. `--binary` selects an installed release for comparison. A runtime wrapper can provide the SDK path instead of `--sdk-dir`; the driver still must be available. This is a native transport result, never browser FPS. Do not run it alongside the browser measurement or other GPU benchmarks.

The repeated static ramp strongly favors prediction. Also test moving inputs before drawing conclusions about videos:

```sh
ffmpeg -i test-results/perf-source.webm -t 2 -an -pix_fmt nv12 -f rawvideo test-results/moving.nv12
just benchmark-transport --input test-results/moving.nv12 --frames 600 --output test-results/moving.json
```

`--input` accepts whole 1920×1080 NV12 frames up to 512 MiB, cycles them, and records their SHA-256. Use `--protocol 2` with a v0.3.2-or-earlier baseline; current streaming is protocol 3. Keep compiler/profile and driver/settings equal and interleave at least three baseline/candidate trials. `--save-stream PATH.obu` retains concatenated NVENC output for `ffprobe -count_frames`; measure saving separately because disk writes affect timings. Decode complete GOPs, including a periodic keyframe, and check fresh-decoder recovery after a connection restart. Never discard encoded delta packets while retaining later references; drop decoded presentation pictures instead.

For an audio automation regression check independent of a GPU or audio device:

```sh
just benchmark-audio --legacy-ref v0.3.2
```

This renders a continuous 880 Hz tone through the real browser delay/gain nodes and a simultaneous undelayed reference. It exercises jitter, interrupted fades, repeated bypass and reattachment; output includes peak adjacent-sample step and bypass error. The optional local Git reference must contain the earlier single-delay graph. A successful offline test does not certify physical-device underruns or audible synchronization; perform the listening/device matrix below too.

Run the real browser test described in [development](development.md). For a sustained measurement, keep the generated fixture running for at least 60 seconds, then repeat with a legally obtained representative SDR source, including fast motion and high detail. Document the file hash and codec. The supplied test fixture defaults to 640×360, 30 fps VP9/Opus, generated by FFmpeg; `VSR_FIXTURE_SIZE=1920x1080 VSR_FIXTURE_FPS=60` selects a larger comparison fixture; it is a correctness test, not representative 4K playback.

Capture popup/native state samples once per second from the extension service worker with DevTools. `state:<tabId>` in `chrome.storage.session` contains presented count, dropped decoded pictures, startup time, processing time, inference time, lateness, and audio delay/device estimates. Presented fps is a session average including startup; use differences in presented counts over a measured steady-state interval for throughput. Dropped decoded pictures exclude source callbacks intentionally skipped by backpressure; report both `video.getVideoPlaybackQuality()` counters and presented counts relative to source fps. There is no unmeasured end-to-end latency claim: `latencyMs` is native service time, while `latenessMs` compares a drawn frame to the estimated audible clock.

Use a browser performance trace to measure capture cost, page responsiveness, decode/draw scheduling, and source-callback drops. For visible correctness, take screenshots with the overlay enabled, disabled, and deliberately occluded. Verify that the enhanced picture covers the original while higher player controls and captions remain readable. A worker's draw counter alone cannot establish visible output on an arbitrary website.

## CPU, GPU and memory

Run parallel samplers during original and enhanced trials (tools such as `pidstat` come from your distro or `sysstat`):

```sh
nvidia-smi --query-gpu=timestamp,name,utilization.gpu,utilization.memory,memory.used,power.draw \
  --format=csv -lms 200 > test-results/gpu.csv
# In another terminal; substitute the backend PID reported by status:
pidstat -rud -p BACKEND_PID 1 60 > test-results/backend-resources.txt
```

Record the browser process tree separately; the native RSS does not include extension/browser buffers. Include baseline and enhanced median/peak CPU, GPU utilization, VRAM, native RSS, browser RSS, startup time, steady presented fps and drops. Avoid drawing GPU-process conclusions from whole-device totals if other workloads are active. Disable/pause enhancement, wait five seconds and confirm the context/VRAM is released, then wait sixty seconds and confirm the daemon exits. Repeated start/stop cycles should not grow memory. Tests check the lifecycle logic, but GPU allocation release should also be observed with `nvidia-smi`.

## Audible synchronization

Generate a flash/beep fixture locally, for example:

```sh
ffmpeg -f lavfi -i "color=black:s=640x360:r=60,drawbox=color=white:t=fill:enable='lt(mod(t,1),0.05)'" \
  -f lavfi -i "aevalsrc=if(lt(mod(t\,1)\,0.05)\,0.5*sin(2*PI*1000*t)\,0):s=48000" \
  -t 30 -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -c:a libopus flash-beep.webm
```

Play it in the same fixture player using the normal audio device. Record display flashes and speaker/loopback audio against a common clock with a high-frame-rate camera or synchronized screen/audio capture. Compare the distribution of flash/beep offsets before and after enabling. Report the recording method, device latency, sample rate, refresh interval, p50/p95 absolute offset and sign (picture early/late). Estimated worker lateness and DelayNode values are diagnostic inputs, not measured audible sync. Do not claim correct lip-sync from headless tests alone.

## Required behavior matrix

Test pause/resume, rapid forward/back seeks, 0.5×/1×/2× playback, buffering, source changes, video replacement, SPA/full navigation, tab visibility, two competing tabs, player-container and direct-video fullscreen, PiP, DOM/native captions, controls, CORS rejection, DRM rejection, HDR rejection, backend crash/restart, low VRAM, and browser restart/update with persisted site rules. Record observed state, whether original playback resumes, startup/recovery latency, and any required user gesture. Mark unavailable hardware or media as **not run**, never passed.

## AV1 transport stage accounting

Compare the old JPEG commit and the AV1 commit using the same visible-window fixture, display, runtime, source, output target and warm-up period. Record the commit and transport for every result; never compare JPEG native-only throughput with AV1 browser throughput. Avoid offscreen/occluded windows: desktop throttling can dominate measurements.

`state.timings` exposes capture copy time, capture-to-worker handoff, loopback/worker round trip, worker command/output round trip, shared-input copy, upload/conversion, native inference, NVENC conversion/encode/download, WebCodecs decode, draw submission and intentional presentation wait. `shared_copy_ms` measures the single WebSocket-buffer-to-memfd copy; `worker_round_trip_ms` includes it and GPU work. Round-trip fields include nested native costs: do not sum overlapping stages. Capture-to-decode media age also includes source scheduling/clock uncertainty. Draw submission is not physical display latency. Browser Media properties such as `kVideoDecoderName` and `kIsPlatformVideoDecoder` must identify the enhanced AV1 decoder in the extension worker before claiming hardware decoding; recording the original VP9 decoder alone is insufficient.

For before/after browser comparisons, `VSR_BIN` selects the executable and `VSR_EXTENSION_DIR` selects a separately exported extension. Keep their versions paired and use the same browser, flags, visibility, source file and warm-up. The default still builds and loads `build/extension`. Do not compare Playwright/pipe and direct-CDP measurements as if only application code changed; this host's Brave Origin startup and launch configuration materially affected throughput. The [shared-memory validation record](validation.md#shared-memory-transport-and-capture-overlap) preserves the matching comparison and its limits.
