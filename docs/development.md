# Development and validation

The repository is standalone. Build-time requirements are Rust 1.88+, Bun 1.3.13+, and a C linker. `tar`, `zip`, `unzip`, FFmpeg, and Chromium support packaging/development/tests. Bun is required only when building or developing; installed applications do not need it. The default Nix development shell supplies them.

```sh
nix develop
just install
just fmt-check
just build
just check
just check-nix
```

`just` lists individual Rust/TypeScript formatting, build and test tasks. `just fmt` writes formatting; `just fmt-check` verifies it. Prettier uses two spaces, single quotes, semicolons, trailing commas and a 100-column target. Rust uses rustfmt and Nix uses nixfmt. To run checks directly:

```sh
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
bun install --frozen-lockfile --ignore-scripts
bun run check
bun test
nix flake check
```

Use the pinned Bun 1.3.13 from `nix develop` when updating dependencies, so the lockfile remains readable by both CI and Nix. Newer Bun versions can run the current scripts, but may emit a newer lockfile format when changing dependencies. `just package` requires `tar`, `zip` and `unzip`; the development shell supplies them. All repository scripts and release tests are TypeScript; Python is not required. `node:` imports use Bun's built-in compatibility modules and do not launch Node.js.

## Repository map

```text
src/                Rust CLI, private control socket, supervised GPU process, protocol/FFI
extension/src/      Strict TypeScript: policy, messages, capture, frame session, timing
extension/          Manifest, popup/bridge HTML, CSS, icons and notices
build/extension/    Generated, loadable extension (ignored; never edit)
tests/              Rust lifecycle, TypeScript policies/session/timing, browser fixture, release tests
scripts/            Install/runtime acquisition, release planning, versioning, archive creation
nix/                Runtime packaging, NixOS/Home Manager modules and evaluation tests
.github/workflows/  Checked builds and gated releases
docs/               Architecture, runtime/Nix setup, benchmarks, validation, releases
licenses/           Preserved upstream MIT notices
```

## CPU-only browser test

Use a **disposable Chromium profile**; the test never attaches to a personal browser or modifies its integration. It generates its own VP9/Opus fixture, starts a local HTTP server, and removes the temporary profile on exit.

```sh
cargo build --locked
bun install --frozen-lockfile --ignore-scripts
sudo apt-get install --yes ffmpeg zip unzip  # Debian/Ubuntu; also installed explicitly in CI
bun node_modules/playwright-core/cli.js install --with-deps chromium  # conventional Linux / CI
bun run test:browser
```

On NixOS, `nix develop` supplies `CHROMIUM_PATH`. Otherwise set it to an installed Chromium binary. Branded browsers may reject command-line extension side loading; use Chromium for automation. `VSR_HEADED=1` requests a visible isolated browser for manual audio/visual inspection.

The CPU-only browser test deliberately omits native integration and checks understandable errors, iframe removal, continued original playback, and disable. Ordinary CI also tests site-rule precedence, serialization, stale-active expiration, worker metadata/binary sequencing, fresh-frame-only presentation, clock reset, audio-delay bypass, malformed frames, single-use expiring credentials, origin rejection, daemon idempotency and idle exit. Rust lifecycle tests bind only loopback/temporary Unix sockets and require no GPU.

## GPU and full browser path

Install a compatible NVIDIA runtime and driver, then:

```sh
cargo build --locked
VSR_GPU_TEST=1 \
VSR_TEST_SDK_DIR=/absolute/path/to/nvvfx/libs \
VSR_TEST_JPEG_LIBRARY=/absolute/path/to/libnvjpeg.so \
bun run test:browser
```

To separately exercise tightly packed NV12 and color-range conversions with a real GPU:

```sh
cargo test --locked nvidia_nv12_inference -- --ignored --nocapture
```

This uses your native configuration, writes three grayscale JPEGs under `test-results/`, and must be visually inspected. It is ignored in ordinary CI.

The test installs native messaging only inside the disposable browser's custom user-data directory. It validates real VFX output, fresh presentation, nested stacking and pointer transparency, pause/resume, seeking, dynamic replacement, SPA navigation, container/direct-video fullscreen, native-caption bypass, hidden-state suspension, backend failure/retry, and return to original playback. Both browser modes restart their profile and verify persisted site rules/global state. It writes screenshots under `test-results/`; inspect them. `VSR_KEEP_TEST_PROFILE=1` preserves temporary artifacts for debugging; otherwise they are removed. `VSR_BIN` selects an absolute application executable (including a Nix runtime wrapper), and `VSR_DEBUG=1` forwards browser console messages. `VSR_MEASURE_SECONDS=8` records raw browser state samples for a short throughput observation.

Headless Chromium may keep every page visible despite tab activation. The visibility check then explicitly emulates `document.hidden` in the extension isolated world and dispatches its event; the test prints this fact. Real window/tab visibility still needs a headed browser check.

The test's synthetic media and headless audio clock do not validate audible lip-sync or every site's DOM. Before declaring a GPU/browser/distro combination supported, perform the [benchmark and hardware matrix](benchmark.md), including fullscreen, visibility, DRM/CORS rejection, device audio latency, captions, and persistent-profile extension updates. Record failures honestly in the validation document.

## Runtime boundary

Keep the unsafe surface in `src/gpu.rs`. API selectors/layouts are documented there and in architecture notes. Any API/ABI change requires a cold inference test with visible image output. Do not add a dummy success backend or a substitute scaler to make a GPU test pass.

Release versions must move together. Use `bun scripts/set-version.ts MAJOR.MINOR.PATCH`, which edits the application version, Cargo lockfile root entry, extension manifest, and package metadata without updating dependency resolutions. `bun.lock` records dependencies only and stays byte-for-byte unchanged. After intentional dependency upgrades, run `just sync-deps` to update the integrity-checked Nix artifact list. A native process never rewrites extension identity during startup. Reload the exported extension after updates; refresh existing content scripts to prevent mixed versions.
