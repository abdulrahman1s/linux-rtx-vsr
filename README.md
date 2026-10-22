# Linux RTX VSR

Enhance browser video locally with **NVIDIA VideoSuperRes**, a Rust application, and a Chromium extension. The extension places an enhanced picture over the original video and keeps its player and audio. This is an independent, experimental community project for `abdulrahman1s/linux-rtx-vsr`.

## Compatibility

The initial target is **Linux x86-64, Chromium 140+, and an NVIDIA RTX GPU** supported by NVIDIA VFX 1.3. An NVIDIA driver and separately installed VFX runtime and the driver’s NVENC AV1 library are required. This is the VideoSuperRes SDK effect, not a Linux driver switch.

| Configuration                                                | Validation                                                                                                                                      |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| RTX 5090, driver 595.104.02, NixOS, VFX 1.3 / wheel 0.2.0.0  | Real Rust GPU inference verified; see [validation record](docs/validation.md) for browser results                                               |
| Chromium 148.0.7778.178; Brave Origin 1.97.59 / Chromium 155 | Visible AV1 playback tested on the host above; see [scope and measurements](docs/validation.md#av1-transport-and-resolution-targets-2026-10-22) |
| Other RTX Ada / Blackwell GPUs with AV1 NVENC                | Expected with compatible VFX/AV1 NVENC; not tested here                                                                                         |
| Google Chrome / other Brave builds                           | Native manifest installers included; playback compatibility unverified                                                                          |
| Other Linux distributions                                    | Expected with glibc 2.39+ for release binaries; source builds can use their host libc; unverified                                               |
| Firefox, ARM, RTX without AV1 encode, protected video, HDR   | Unsupported                                                                                                                                     |

NVIDIA lists branch-specific minimum drivers for VSR (570.190+, 580.82+, or 590.44+) and describes its Linux SDK as server-oriented. Desktop integration is experimental. Review [runtime requirements and terms](docs/runtime.md) before installation.

## Install

For NixOS, use the [Nix instructions](docs/nix.md). For a conventional glibc Linux distribution:

1. Download the Linux archive and `SHA256SUMS` from [Releases](https://github.com/abdulrahman1s/linux-rtx-vsr/releases) into an empty folder. Releases become available after this repository is published and its release workflow succeeds. Verify and extract it:

   ```sh
   sha256sum --ignore-missing --check SHA256SUMS
   tar -xzf linux-rtx-vsr-v*-x86_64-unknown-linux-gnu.tar.gz
   cd linux-rtx-vsr-v*-x86_64-unknown-linux-gnu
   sh scripts/install.sh
   export PATH="$HOME/.local/bin:$PATH"
   ```

2. Install the NVIDIA runtime after reviewing [its separate licenses](docs/runtime.md):

   ```sh
   bun scripts/install-runtime.ts --accept-nvidia-license
   linux-rtx-vsr integration install --browser chromium
   linux-rtx-vsr doctor --gpu
   ```

   Bun 1.3.13+ and `unzip` are used only to download, verify, and extract runtime archives. The application and inference run in Rust. You can instead point configuration at an existing licensed SDK installation. NVENC comes from the installed NVIDIA driver. No nvJPEG or CUDA toolkit is required. No proprietary libraries or models are shipped in our release archives.

## Install the extension and enhance a video

Open `chrome://extensions`, enable **Developer mode**, select **Load unpacked**, and choose the directory printed by `integration install` (normally `~/.local/share/linux-rtx-vsr/extension`). Pin **Linux RTX VSR** to the toolbar. On YouTube, start an SDR video: enhancement is enabled automatically by default. On other sites, start playback, click the toolbar icon and choose **Enable for this tab**. The engine starts on demand. Choose an **Output target** in the popup: 720p, 1080p, 1440p, 4K (default), or experimental 8K. Scaling is calculated for each source, preserving aspect ratio; videos already at or above the target use the original.

Use `--browser chrome`, `--browser brave`, or `--browser brave-origin` for their standard native messaging locations (`brave-origin-nightly` is also available). Branded browsers can use their compiled default location even with a custom `--user-data-dir`; the popup's backend check verifies discovery. Flatpak/Snap browser sandboxes are not supported. Refresh already-open video pages after updating the extension to clear older content scripts.

## Automatically enhance a site

Open the extension on that site and enable **Always enable on this site**. Accept access to that site when Chromium asks. Rules persist across restarts and match the exact scheme and hostname. YouTube (www, bare and mobile HTTPS origins) has access by default; turn its rule off here to opt out permanently. Other sites receive no automatic access. The largest visible top-level video is selected; embedded frames and shadow-root videos are not scanned.

The global switch takes priority. When it is on, a temporary **current-tab override** takes priority over the site rule. Choose **Follow site rule** to remove that override. Overrides last until the tab closes or the browser session ends and apply only to their saved origin. With no override or matching rule, enhancement stays off.

## Toolbar indicators

| Badge       | Meaning                                                                     |
| ----------- | --------------------------------------------------------------------------- |
| Empty       | Disabled for this tab or globally                                           |
| `RDY`       | Ready; waiting for a supported visible video                                |
| `…`         | Starting the native session or waiting for its first picture                |
| `ON`        | Fresh enhanced frames are being drawn for visible playback                  |
| `Ⅱ`         | Paused or hidden; original picture restored                                 |
| `ORG`       | Temporarily bypassed, such as seeking, buffering, or above the output limit |
| `!` / `N/A` | Error or unsupported content; original playback restored                    |

The tooltip and popup explain the state. `ON` requires a recently presented picture, not merely an enabled setting or connected backend. The popup shows source/output size, presented frame rate, processing time, and dropped presentation frames when available. Processing time excludes browser capture and presentation latency.

## Everyday commands

```sh
linux-rtx-vsr status
linux-rtx-vsr start                    # optional; normally automatic
linux-rtx-vsr stop
linux-rtx-vsr doctor                  # prerequisites and integration
linux-rtx-vsr doctor --gpu            # also runs actual inference
linux-rtx-vsr config show
linux-rtx-vsr config set quality 2
linux-rtx-vsr config set scale 1.5
linux-rtx-vsr config path
```

The extension offers AI Low–Ultra and source-independent output targets through 8K, including portrait bounds. Native benchmarks accept `--target 2160` for 4K or `--target 4320` for 8K. The CUDA AI → NVENC AV1 → worker WebCodecs VideoFrame path keeps enhanced pixels on the GPU; browser input still requires host staging. 8K is experimental, hardware-dependent, and may be slow or fail due to VRAM/model/encoder/decoder limits. No substitute scaler is used on failure. Restart the backend after changing native configuration. GPU objects unload after five idle seconds; the daemon exits after sixty. One tab can enhance at a time; other tabs receive a clear busy message.

Configuration uses `$XDG_CONFIG_HOME/linux-rtx-vsr`, state/logs use `$XDG_STATE_HOME/linux-rtx-vsr`, and extension/runtime assets use `$XDG_DATA_HOME/linux-rtx-vsr`. Defaults follow the normal `~/.config`, `~/.local/state`, and `~/.local/share` locations.

Pausing holds the enhanced picture. Quick resume reuses the decoder; longer pauses release processing resources while retaining one frozen picture. A slow cold restart can briefly show original playback. SDR capture, encoding and presentation carry explicit color information to avoid an extra tint when enhancement turns on.

## Source builds and development

Install Rust 1.88+, Bun 1.3.13+, and a C compiler/linker and ar. No NVIDIA SDK headers, Python application, or original-project checkout is required to build:

```sh
cargo build --locked --release
cargo install --locked --path .
linux-rtx-vsr integration install --browser chromium
```

For Nix:

```sh
nix build
nix run . -- --help
nix develop
```

For declarative installation, import `nixosModules.default` or `homeManagerModules.default` and set `programs.linux-rtx-vsr.enable = true;` with `runtime.enable = true;` and `browsers.chromium.enable = true;` after accepting NVIDIA's terms. The modules install enabled browser packages (customizable with `browsers.chromium.package = pkgs.chromium;`) and manage matching native manifests and extension assets across rebuilds. Home Manager also supports typed native settings. See the [copy-and-paste module examples](docs/nix.md#recommended-declarative-modules).

The default Nix package contains the free application and extension. Runtime setup is separate; [Nix setup](docs/nix.md) includes an opt-in package that supplies the proprietary runtime without modifying signed libraries.

For development, `nix develop` includes Bun and Just. `just` lists all tasks:

```sh
just install
just fmt
just build
just check
just test-browser     # disposable Chromium profile, no GPU
just check-nix
```

Equivalent development checks:

```sh
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
bun install --frozen-lockfile --ignore-scripts
bun run check
bun test
nix fmt -- --check flake.nix nix/*.nix
nix flake check
```

See [development and browser tests](docs/development.md), [architecture](docs/architecture.md), [performance measurement](docs/benchmark.md), and [release automation](docs/releases.md).

## Troubleshooting and limitations

- **Native host not found:** run `integration install` for the correct browser/profile. Keep the installed executable at a stable path, then reload the extension.
- **Runtime cannot load / GPU inference fails:** run `doctor --gpu`; check `sdk_dir`, `libcuda.so.1`/`libnvidia-encode.so.1`, driver libraries, GPU support, and available VRAM. See [runtime setup](docs/runtime.md). NixOS must use the Nix instructions.
- **Audio requires a gesture:** play the video and enable again. Browsers can block Web Audio until a playback gesture.
- **Original video remains visible:** inspect the popup reason. Errors, sustained stale output, seeking, hidden tabs, native video fullscreen, and oversized output restore the original. Pause normally holds the last enhanced picture.
- **Video cannot be captured:** DRM, tainted/CORS-restricted video, embedded players, HDR, and unsupported color spaces cannot be processed. There is no protection bypass. Codec support depends on the browser; readable SDR decoded frames are required.
- **Controls and captions:** DOM controls/captions above the video layer are preserved. Native controls temporarily bypass enhancement on hover/focus; native text tracks bypass it while showing. Picture-in-picture and direct video-element fullscreen show the original. Player-container fullscreen can include the overlay. Unusual stacking, transforms, clipping, or player layouts may require site-specific work.
- **Audio synchronization:** a Web Audio delay follows measured processing age; pictures are scheduled against audible time. Device latency reporting and site behavior vary. Audible flash/beep validation on real audio hardware is still required. Once attached, the browser cannot detach a `MediaElementAudioSourceNode`; disabling removes the added delay, and refreshing fully restores the browser's original audio path.
- **Performance:** capture still stages pixels through host memory, while enhanced output uses NVENC AV1 and worker WebCodecs. Achievable frame rate depends on the whole capture/transport/decode/presentation path, not just inference time. See measured and unmeasured items in the [validation record](docs/validation.md).

The native API listens only on loopback with exact extension-origin checking and expiring, single-use credentials. Pages never receive native credentials. There is no remote processing, telemetry, media URL fetching, or listening LAN endpoint. [Security details](docs/architecture.md#security).

## Updates and removal

For an update, stop the backend, verify/extract the new archive, rerun `scripts/install.sh`, and rerun `integration install` to export matching extension assets. Reload the extension and refresh video tabs. Source installs use `cargo install --locked --path . --force`; Nix installs update their pinned flake input. Keep application and extension versions together. Runtime updates are separate and must preserve NVIDIA's signed files.

To remove everything installed per user:

```sh
linux-rtx-vsr stop
linux-rtx-vsr integration remove --browser chromium
# Repeat for any other browser or custom --manifest-dir you installed.
```

Remove the extension in `chrome://extensions`, refresh video tabs, then remove the following **project-owned directories** (adjust XDG paths and any custom install prefix):

```sh
rm -f ~/.local/bin/linux-rtx-vsr
rm -rf ~/.local/share/linux-rtx-vsr ~/.local/state/linux-rtx-vsr ~/.config/linux-rtx-vsr
```

Nix users remove the package from their profile/configuration as well. An externally managed SDK or NVIDIA driver is not removed. No system services are installed.

## Credits

Thanks to **[maxiarat1](https://github.com/maxiarat1)** for [linux-nvidia-vsr](https://github.com/maxiarat1/linux-nvidia-vsr), the original inspiration and timing/presentation investigations. Adapted timing code retains its MIT notice. NVIDIA develops VideoSuperRes; this project is independent and is not an NVIDIA product. See [third-party notices](THIRD_PARTY.md).
