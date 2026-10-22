# Validation record — 2026-10-22

This records development checks, not a certification for other systems. The initial implementation sections below describe the **historical JPEG path**; current AV1 results are recorded at the end. See [benchmark procedure](benchmark.md) for a broader, repeatable matrix.

## Environment

- NVIDIA GeForce RTX 5090, 32,607 MiB reported VRAM, driver 595.104.02, compute capability 12.0.
- AMD Ryzen 7 5700X3D, Linux 7.2.8-cachyos, NixOS 26.11 (20261020), host glibc 2.44.
- VFX 1.3, obtained as NVIDIA `nvidia-vfx` 0.2.0.0 runtime; no Python inference.
- Native resource measurement used nvJPEG 13.1.0.59. The optional Nix wrapper was also validated with its pinned nixpkgs nvJPEG 12.4.0.76.
- Chromium 155.0.8059.84, isolated persistent profiles, Playwright Core 1.64.1, headless. Browser tests use the actual extension and native host.
- AI High (3), 2× scale, JPEG quality 94 unless a check specifies otherwise.
- Native resource measurements used Cargo release mode. Stored browser samples used the debug Rust backend; separate correctness trials also exercised optimized Nix packages.

## Checks

| Check                                                                                                                  | Result / scope                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust formatting, locked Clippy with warnings denied, locked tests, release compilation                                 | Passed                                                                                                                                                      |
| Config validation/persistence/private permissions                                                                      | Passed                                                                                                                                                      |
| Daemon idempotent startup, clean stop, idle exit, private grants, origin rejection, replay rejection, competing stream | Passed without GPU                                                                                                                                          |
| Extension syntax/assets/versions/minimal declared permissions                                                          | Passed                                                                                                                                                      |
| JS site precedence, serialized rules, stale-active state, clock/audio bypass, worker sequencing/presentation           | Seven tests passed                                                                                                                                          |
| Release bump/version synchronization and locked dependencies; runtime hash/path extraction safety                      | Four Python tests passed                                                                                                                                    |
| GitHub workflow syntax and installer shell checks                                                                      | actionlint and ShellCheck passed                                                                                                                            |
| Release archive installation outside checkout                                                                          | Passed in temporary directories, including a prefix containing spaces, bundled notices, native startup, config persistence, removal, and real GPU inference |
| CPU-only Chromium missing-host recovery and continued original playback                                                | Passed                                                                                                                                                      |
| Real Rust VideoSuperRes → nvJPEG output                                                                                | Passed; image output visually inspected and non-black                                                                                                       |
| NV12 limited BT.709 / BT.601 and full-range BT.709                                                                     | Real inference passed for all three formats; grayscale output inspected                                                                                     |
| AI Low, Medium, High, Ultra with 1.5× scale                                                                            | All four ran successfully on generated 640×360 RGBA input                                                                                                   |
| Chromium real GPU presentation, pause/resume, seek, replacement, SPA changes                                           | Passed                                                                                                                                                      |
| Nested overlay layering, pointer transparency, DOM caption/control visibility                                          | Assertions passed; screenshot inspected                                                                                                                     |
| Container fullscreen and direct-video fullscreen bypass/recovery                                                       | Passed in headless Chromium                                                                                                                                 |
| Native-caption bypass/recovery                                                                                         | Passed in headless Chromium                                                                                                                                 |
| Hidden-state cleanup/recovery                                                                                          | Passed with explicit visibility emulation; headless Chromium did not expose a real hidden transition                                                        |
| Backend shutdown/restart, original-picture restoration, global disable                                                 | Passed                                                                                                                                                      |
| GPU idle cleanup                                                                                                       | After six idle seconds the supervised GPU process was absent from NVIDIA compute allocations; the control daemon remained available                         |
| Saved site rule and global disable after a real browser restart                                                        | Passed                                                                                                                                                      |
| Free Nix package/checks and opt-in runtime package                                                                     | Built; runtime wrapper passed real inference and browser startup; `nix develop` provided Rust/Cargo 1.95 and Bun 1.3.13+.15                                 |

## Measurements

Raw [native resource samples](benchmarks/2026-10-22-native-resources.json) describe **2,000 repetitions of one generated 1920×1080 RGBA pattern**, enhanced to 3840×2160. This is an isolated SDK path, not browser video throughput or a natural-video quality assessment.

| Native-only metric                            | Observed                      |
| --------------------------------------------- | ----------------------------- |
| Runtime load                                  | 151.5 ms                      |
| First processing call (includes effect setup) | 262.9 ms                      |
| Warm p50 / p95 service time                   | 2.56 / 3.51 ms                |
| Overall throughput including startup          | 343.2 frames/s                |
| Mean JPEG packet                              | 1,032,537 bytes               |
| Peak sampled native RSS                       | 273,984 KiB (about 267.6 MiB) |
| Sampled process CPU                           | About 98% of one CPU core     |
| Whole-device utilization range                | 7–95%                         |
| Whole-device VRAM range                       | 3,645–4,798 MiB               |

GPU totals include the running desktop and other applications. The 27 samples span about six seconds; resource sampling itself has overhead. These are single-run observations, not multi-trial performance promises. Driver allocation release and browser resource use must be considered separately.

Raw [browser samples](benchmarks/2026-10-22-browser-metrics.json) cover a short 640×360, 30 fps VP9/Opus FFmpeg test pattern enhanced to 1280×720 using the supervised GPU process. In a 7.906-second sampled interval, presented count advanced from 1 to 210: **26.4 presented frames/s**. The session recorded seven dropped decoded pictures; intentionally skipped source callbacks are not included in that counter. Median native service time in these browser samples was 0.685 ms, first enhanced presentation was about 877 ms after worker initialization, and audible-clock lateness is only an estimate. No audible A/V offset was measured. These observations do not establish browser 4K60 capability.

An earlier object-only teardown retained about 500 MiB despite freeing SDK objects. The final backend uses a supervised Rust child and terminates it on idle/error, which cleared those process-global allocations in the hardware test. That isolation adds a local pipe copy, absent from the native-only benchmark. Browser performance needs longer controlled trials before claiming a benefit over the reference pipeline.

## Declarative Nix integration

The NixOS and Home Manager modules were evaluated against the locked nixpkgs and matching Home Manager release. `nix build .#checks.x86_64-linux.modules --no-link` passed: disabled/enabled integrations and browser entries, all browser manifest paths and package overrides, Chromium/Brave package defaults, registration without package installation, fixed extension origin, optional native settings, rejected invalid quality/idle settings, and executable native launchers. A free runtime fixture verified persistent SDK/nvJPEG/executable paths and a driver path containing spaces without downloading NVIDIA binaries. The real opt-in runtime wrapper also evaluated successfully with explicit unfree acceptance.

Rust tests passed the managed-config symlink protection check alongside the existing lifecycle/protocol checks. Formatting, Clippy, extension checks, Bun tests and `nix flake check` passed. This change did not activate a NixOS/Home Manager configuration or rerun GPU/browser/audible validation; the hardware results above are from the earlier application validation. Module activation, migration from an existing personal installation, browser extension updates through the module path, and rollback still need end-to-end checks on a disposable host/profile.

## Bun and TypeScript migration

The extension, all repository scripts and the former Python release tests were migrated to strict TypeScript. Bun 1.3.13 is pinned in CI and supplied by the locked Nix development environment. Formatting, Clippy, four ordinary Rust unit tests, the Rust lifecycle test, thirteen Bun tests, strict type checking, compiled extension validation and Nix checks passed. The NVIDIA unit test remains explicitly ignored in ordinary checks. Release tests cover conventional commits, release gating/version limits, unchanged dependency resolutions, checksums, selective ZIP extraction, traversal and symlink rejection. Native dependency license collection retained notices for 67 locked dependencies.

`just package` produced local archives and passed the isolated installation/native-host/configuration/removal smoke test. The archive excludes TypeScript extension sources, obsolete Python files and proprietary NVIDIA libraries. The new TypeScript resource sampler also completed a 30-frame real NVIDIA run and wrote local diagnostic JSON; this was a functional check, not a new throughput claim. No new runtime download/install or remote GitHub Actions run was performed.

Both CPU-only and GPU browser tests passed with Bun and headless Chromium **148.0.7778.178**, using disposable profiles on the same RTX 5090/595.104.02 host. Real 640×360 VP9/Opus video was enhanced to 1280×720. Checks included fresh-frame status, layering, pause/resume, seeking, replacement, SPA navigation, fullscreen/caption bypass, backend failure/retry, persisted site rules/global disable and idle GPU child/allocation release. The enhanced fixture screenshot was inspected. Hidden-tab state was emulated because headless Chromium kept the page visible. Physical audible synchronization was not tested. These results supplement the earlier Chromium 155 record above.

## Not validated

- Audible flash/beep or lip-sync against physical audio output; headphone/Bluetooth/USB device latency and device changes.
- A real headed-tab/window visibility transition (the headless lifecycle path was emulated explicitly).
- Sustained 4K browser enhancement, browser CPU/RSS traces, multi-trial controlled performance, low-VRAM behavior, driver hangs, natural-video quality comparisons.
- Real third-party sites (including YouTube), arbitrary player stacking/layouts, embedded players, shadow-root videos, and native-controls hover behavior across browsers.
- Live protected/DRM, HDR, or cross-origin restricted media rejection on representative sites; the project intentionally does not support these inputs.
- Picture-in-picture behavior on a real desktop, persistent-profile updates between two published extension releases, and alternative codecs/GPU architectures.
- Conventional Ubuntu/Debian installation and direct NVIDIA download access there; the Nix runtime path is what was exercised on this host.
- Remote GitHub Actions execution, publication, download of a published release, and cross-distribution release ABI validation. The workflow and local packaging are provided; no remote repository or release was published by this task.

Until those checks are completed, describe the application as **experimental** and report this exact tested configuration. The implementation fails back to the original picture; it does not quietly switch to another enhancement model or declare an enabled backend to be active presentation.

## AV1 transport and resolution targets, 2026-10-22

The Rust backend now uses actual CUDA VideoSuperRes → GPU BT.709 NV12 → NVENC AV1 independent keyframes. The extension worker decodes to VideoFrame and draws directly. No nvJPEG is loaded. Targets are 720p, 1080p, 1440p, 4K (default), and experimental 8K, fitted to landscape/portrait bounds.

- Cold NV12 inference/AV1 encoding passed for limited BT.709, limited BT.601 and full-range BT.709 on RTX 5090 / driver 595.104.02 / NixOS / VFX 1.3. AV1 was decoded with FFmpeg; the grayscale ramp was visually inspected.
- Native 1920×1080 → 7680×4320 inference and AV1 encoding passed. A ten-frame development trial observed about 10 ms warm processing, excluding all browser stages; its small sample is not a performance guarantee. The decoded color pattern was inspected.
- Visible Brave Origin 1.97.59 / Chromium 155.0.8059.85 passed real 1080p → 4K and 360p → 720p lifecycle checks: fresh-only status, pause/resume, seeks, replacement, SPA, container/direct-video fullscreen, native captions, error/retry, settings persistence, and GPU child/VRAM release. A rapid fullscreen-restart lease race was reproduced and corrected with a bounded wait for the closing stream; competing active tabs are still rejected.
- The Media trace identified **VaapiVideoDecoder, platform=true, AV1, 3840×2160, extension frame-worker.js**. This verifies the enhanced decoder for this setup, rather than relying on a preference flag or observing only the original VP9 decoder.
- Visible Chromium 148.0.7778.178 also presented actual **7680×4320 AV1** with platform decoder evidence and passed the same lifecycle checks. The screenshot was inspected. The source exposed RGBA, causing larger input transfers. This is experimental 8K correctness evidence, not an 8K realtime claim. The saved [8K trace](benchmarks/2026-10-22-av1-8k.json) notes a temporary network experiment in that binary.
- The browser fixture verifies YouTube permission and automatic content-script registration on a fresh profile. Additional Chromium 148 checks intercept a YouTube URL locally and verify video detection despite missing registration, popup recovery of an already-open unattached tab, and global re-enable. These do not validate the live YouTube DOM. Pure tests verify default rules, saved false opt-outs, global priority, exact-origin matching and target calculations, including portrait/8K and already-at-target bypass. No live YouTube page or personal browser profile was modified.
- After the automatic-attachment repair, ordinary checks and the CPU browser fixture passed. A headed Chromium 148 GPU fixture also passed actual 360p → 720p AV1 presentation, pause/resume, seek, replacement, SPA/fullscreen, captions bypass, backend failure/retry, original recovery, persisted rules and idle GPU release. Hidden state required emulation; audible synchronization was not measured. The repaired doctor passed against the installed NixOS extension and custom sandbox registry on this host; it explicitly does not certify visibility from inside Brave's sandbox.
- Headless Chromium without decoding flags rejected the hardware-preferred AV1 configuration clearly. Later repeated Brave launches timed out on this host in both Wayland and X11; Chromium testing continued successfully. Branded browser startup and hardware decoding configuration remain environment-dependent.

### Short visible-window 4K measurement

[Raw AV1 samples and decoder evidence](benchmarks/2026-10-22-av1-4k.json) record generated 1920×1080 60fps VP9/Opus testsrc2, output 3840×2160, AI High, QP14, two bounded processing slots, optimized Rust build, visible Brave window, on the GPU/driver above. Other desktop workloads were active. After excluding the first three sampled seconds, presented count advanced 74 → 176 over 4.781 seconds: **21.33 presented FPS**, with four additional decoded-picture drops. This does **not** establish 4K60 or parity with the original Python pipeline. No controlled Python/JPEG comparison or repeated-trial claim is made.

| Stage                                             | Sample p50 | Sample p95 |
| ------------------------------------------------- | ---------- | ---------- |
| Browser capture/copy                              | 8.70 ms    | 9.40 ms    |
| Worker send → complete native receive             | 50.38 ms   | 53.29 ms   |
| Native dispatch, including worker pipe round trip | 6.58 ms    | 7.92 ms    |
| GPU upload/conversion                             | 0.31 ms    | 0.51 ms    |
| VideoSuperRes inference                           | 1.62 ms    | 1.77 ms    |
| GPU output conversion + NVENC + packet copy       | 2.45 ms    | 2.76 ms    |
| Native completion → browser response event        | 1.94 ms    | 2.69 ms    |
| AV1 decoding                                      | 1.80 ms    | 2.10 ms    |
| Canvas draw submission                            | 0.20 ms    | 0.20 ms    |

Stages overlap/nest and must not be added together. Request/response splits compare clocks on the same machine and are diagnostic estimates. The large request interval includes browser socket scheduling/copying, loopback transfer, time behind an earlier request, and native receive/unmask; those individual costs have **not** been isolated. Native inference is not the dominant measured interval. Restoring AV1 removes the JPEG stage but has not by itself solved the remaining raw-input throughput bottleneck.

Hidden state was emulated where automation kept the page visible. Physical audible synchronization, physical display latency, long-run memory/CPU behavior, low-VRAM failure, other GPUs, natural-video quality, and sustained 8K performance remain unvalidated.

## Shared-memory transport and capture overlap

The optimization retains direct NVIDIA FFI in Rust and the supervised GPU process. Raw input now uses one reusable anonymous shared-memory slot instead of a cloned WebSocket payload, kernel pipe transfer and freshly allocated child buffer. The child reads the sealed-size mapping read-only; command/reply ordering prevents overwrite during GPU access. Capture reuses a bounded buffer pool and allows up to four outstanding frames, reduced for large inputs by a 32 MiB budget. Decoding uses the same maximum; presentation sorts overlapping completions by source timestamp. Live source clocks recover a worker RAF suspended by a transparent iframe, and stop cancels it.

[Raw comparison and method](benchmarks/2026-10-22-shared-memory.json) preserve three short visible-window trials per version on RTX 5090 / 595.104.02 / NixOS, VFX 1.3, Brave Origin 1.97.59 / Chromium 155.0.8059.85. Both versions used the identical 24-second 1080p60 VP9/Opus fixture, exposed NV12, AI High, QP14 and a 4K output. Disposable profiles used matching extensions/native binaries and identical direct-CDP launch flags. Repeat trials settled four seconds after a seek, then sampled counters every 200 ms for twelve seconds. The initial optimized trial used an already warm session. No build or other benchmark ran during these browser samples; normal desktop applications remained open.

| Observation                                 | v0.3.1        | Optimized working tree |
| ------------------------------------------- | ------------- | ---------------------- |
| Presented FPS, median of three short trials | 54.29         | 59.87                  |
| Presented FPS, trial range                  | 50.85–54.29   | 59.32–59.87            |
| Native dispatch p50, including GPU worker   | 6.01 ms       | 4.85 ms                |
| WebSocket request/response round trip p50   | 12.20 ms      | 11.20 ms               |
| Inference p50                               | 1.60 ms       | 1.60 ms                |
| Shared-input copy p50                       | Not available | 0.13 ms                |

This is about **10% higher median presented throughput** for this synthetic setup, near its 60 FPS source ceiling. It is not evidence of faster AI inference, universal 4K60, or parity with the upstream Python application. Each trial lost zero or one decoded picture; capture backpressure skips are separate and source playback-quality counters were not collected in this comparison. The enhanced 4K screenshot was inspected: the output was visible and controls/captions remained above it. A fresh independent Media hardware-decoder trace and physical A/V synchronization were not measured in these trials.

A separate single native-transport pair sent 180 deterministic 1080p NV12 ramp frames through the real loopback/GPU-process path, with two outstanding requests and the first thirty completions excluded. It observed 90.77 → 99.92 completions/s; this excludes browser capture/decode/presentation. The different ramp produces much larger AV1 packets than the browser fixture, so the two throughput numbers are not interchangeable.

The earlier approximately 21 FPS Playwright/pipe baseline was reproduced before editing, but it used a different browser launch mode and is **not** used to calculate this speedup. Subsequent Brave automation launches stalled at startup. Direct debugging revealed Brave Origin's startup page; the matching comparison above used separate direct-CDP sessions. Chromium 148's RGBA/software-decoder 1080p→4K control stalled and failed sustained presentation; it is not supported performance evidence. Its headed 360p→720p GPU lifecycle fixture passed, including original recovery, pause, seek, replacement, SPA/fullscreen/caption bypass, backend retry, settings persistence and idle VRAM release; hidden state required emulation.

Ordinary regression checks cover shared-memory bounds, resize seals, reuse, malformed input before GPU access, four-request admission, decoder cancellation, suspended RAF recovery and timestamp-order presentation. The final timestamp-ordering guard was added after the stored performance samples and checked separately. These short trials do not establish long-run memory use, CPU use, performance on other GPUs, audible synchronization, or 8K throughput.

## Predictive AV1 and audio continuity — 2026-10-23

The encoder now uses a 120-picture IP-only GOP, with no B frames/lookahead and a forced IDR for each new connection/configuration. NVENC reports actual picture types; the browser decodes all packets before discarding any stale presentation pictures. Protocol 3 rejects earlier extensions. Presentation reports are coalesced to 10 Hz while every due picture is still drawn; original draw timestamps prevent delayed messages from becoming falsely active.

The [raw native trials and audio measurements](benchmarks/2026-10-23-predictive-audio.json) record the same RTX 5090 / 595.104.02 / VFX 1.3 host. Both native binaries used Rust 1.95 release mode, AI High, QP14, 1080p NV12 input and 4K output. Each input had three interleaved baseline/candidate pairs of 600 frames, two requests outstanding, with thirty warm-up completions excluded. The moving input cycles two seconds of the earlier FFmpeg fixture and retains its SHA-256. No build/browser fixture/other benchmark ran concurrently; ordinary desktop applications remained open. CPU/RSS and whole-device utilization were not sampled in this comparison.

| Native transport observation, median of three trials | v0.3.2    | Predictive AV1 |
| ---------------------------------------------------- | --------- | -------------- |
| Moving pattern completions/s                         | 191.21    | 192.59         |
| Moving pattern mean packet bytes                     | 419,036   | 356,504        |
| Repeated static ramp completions/s                   | 96.61     | 234.13         |
| Repeated static ramp mean packet bytes               | 2,569,055 | 101,264        |

Moving-video throughput is essentially unchanged, with about **15% fewer encoded bytes**. The static ramp strongly favors prediction: about 2.4× native throughput and 96% fewer encoded bytes. Neither result establishes browser FPS. FFprobe decoded all 60 static and 180 moving 4K pictures, including a periodic keyframe; a six-picture 720p chain with a forced same-size restart also decoded completely. The real GPU unit test covered all three supported NV12 color formats and the restart chain.

The audio controller calibrates while an undelayed path plays, crossfades over 20 ms, limits steady delay slew and resets the delay buffer only after fading it out. Repeated bypass is idempotent and cancelled attachment cannot replace the current graph. A real Chromium 148 OfflineAudioContext rendered a 4-second, 880 Hz, amplitude-0.2 tone through jitter, interrupted fades, repeated bypass and reattachment. Peak adjacent-sample change fell from **0.39698 to 0.02312**, consistent with an uninterrupted tone; bypass output exactly matched a simultaneous undelayed reference. This verifies automation continuity, not a physical listening test, device underruns or audible A/V offset.

Formatting, locked Clippy, eight ordinary Rust units, the Rust lifecycle/security/idle test, strict TypeScript/assets/version checks and all **25 Bun tests** passed. The GPU unit remains ignored in ordinary CI and was run separately on this host. CPU browser recovery and the offline waveform check passed. Final headed Chromium 148 360p→720p sustained-presentation/lifecycle checks passed, including pause/resume, seek, replacement, SPA, fullscreen/caption bypass, backend retry, settings persistence and idle process/VRAM release; hidden state required emulation.

Visible Brave 155/CDP exercised real 4K output, hardware AV1 decoding and lifecycle recovery successfully, but one presentation observation was only about 12 FPS. A later pinned-Bun/native-CDP trial connected and presented initially but failed sustained presentation. Baseline trials were also inconsistent, including epoch changes; they do not support a before/after browser speedup. The cause remains unresolved. A native Bun WebSocket adapter fixes the pinned runner's CDP handshake timeout; it does not certify browser presentation performance. The earlier matching v0.3.1/shared-memory comparison above remains a separate observation. Natural-video quality, long-run resource use, 8K throughput and physical audible synchronization still need validation.

The final `nix flake check` passed module evaluation, Rust formatting, extension formatting/types/tests and the locked release build/Rust tests. No proprietary runtime components were added to release artifacts.
