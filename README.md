# Linux RTX VSR

Enhance browser video locally with **NVIDIA VideoSuperRes** and a Chromium extension. The extension places an enhanced picture over the original video while keeping its player, controls, and audio. Processing runs on your NVIDIA GPU; video never leaves your computer.

This is an independent, experimental community project, not an NVIDIA product.

## Before you install

- **Linux x86-64** with an NVIDIA RTX **Ada or Blackwell** GPU that supports AV1 encoding. Older RTX Turing/Ampere cards are unsupported.
- A compatible **NVIDIA driver**, including CUDA and NVENC driver libraries. Confirm `nvidia-smi` works. See [driver and runtime requirements](docs/runtime.md#nvidia-runtime-setup).
- **Chromium 140+**, installed outside Flatpak/Snap. Chrome and Brave integration is available, but support varies by build.
- **SDR video** in a top-level page. DRM-protected video and HDR are unsupported.

For installation, have **`curl` (or `wget`) and `unzip`** available alongside your distribution's standard command-line tools. NVIDIA's runtime is downloaded separately after you accept its terms.

**NixOS:** use the [Nix installation guide](docs/nix.md#recommended-declarative-modules). The release archive targets conventional glibc Linux distributions with **glibc 2.39+**; use a [source build](#build-from-source) for older glibc systems.

## Install

### 1. Install the app and browser integration

Download `linux-rtx-vsr-vVERSION-x86_64-unknown-linux-gnu.tar.gz` from [GitHub Releases](https://github.com/abdulrahman1s/linux-rtx-vsr/releases). Open a terminal in the download directory and run these commands with only one release archive present:

```sh
tar -xzf linux-rtx-vsr-v*-x86_64-unknown-linux-gnu.tar.gz &&
  cd linux-rtx-vsr-v*-x86_64-unknown-linux-gnu &&
  sh scripts/install.sh --browser chromium --add-to-path
```

Run the installer as your normal user, without `sudo`. It installs into `~/.local`, prints the extension directory, and adds the command to PATH for new terminals. Bash, Zsh, and Fish are supported. The separate extension ZIP is unnecessary for this install.

For another browser, replace `chromium` with `helium`, `vivaldi`, `edge`, `chrome`, or `brave`. See [all browser options](docs/browsers.md), including beta/dev channels and Brave Origin. To choose a different application location, pass `--prefix /absolute/path`; `--add-to-path` uses that location too.

### 2. Install the NVIDIA runtime

Review [NVIDIA's separate runtime and model terms](docs/runtime.md), then run from the same extracted directory:

```sh
sh scripts/install-runtime.sh --accept-nvidia-license &&
  "$HOME/.local/bin/linux-rtx-vsr" doctor --gpu
```

The script downloads the pinned NVIDIA archive, checks its SHA-256, retains its license files, and configures the app. `doctor --gpu` must succeed before you try enhancement: it checks the driver/runtime and runs real GPU inference. If it fails, follow its diagnostic output and the [runtime guide](docs/runtime.md).

Already have a licensed SDK? [Configure its path instead](docs/runtime.md#use-an-existing-sdk). For offline setup, use `--vfx-archive /absolute/path/to/the/pinned.whl`. For a custom app location, pass `--binary /absolute/path/to/linux-rtx-vsr`. No NVIDIA libraries or models are included in our release archives.

### 3. Load the extension and play a video

1. Open `chrome://extensions` in your chosen browser.
2. Enable **Developer mode**, click **Load unpacked**, and select the **extension directory printed by the installer**. The default is `~/.local/share/linux-rtx-vsr/extension`; use the folder picker to open this path under your home directory.
3. Pin **Linux RTX VSR** to the toolbar.
4. Start an SDR video on YouTube. Enhancement turns on automatically. On another site, click the extension and choose **Enable for this tab**.

The backend starts on demand. The **`ON` badge** means fresh enhanced frames are being displayed. The popup explains errors and shows source/output sizes and performance. Choose an **Output target** of 720p, 1080p, 1440p, 4K (default), or experimental 8K. Aspect ratio is preserved; videos already at or above the target keep their original picture.

Keep the installed executable and exported extension at their installed paths. You can delete the extracted release directory after setup. Branded browsers may use their standard native messaging location even with a custom `--user-data-dir`; the popup's backend check confirms whether integration works. For custom registration paths, see `linux-rtx-vsr integration install --help`.

## Compatibility

The initial target is **Linux x86-64, Chromium 140+, and an NVIDIA RTX GPU** supported by NVIDIA VFX 1.3. An NVIDIA driver and separately installed VFX runtime and the driver’s NVENC AV1 library are required. This is the VideoSuperRes SDK effect, not a Linux driver switch.

| Configuration                                                | Validation                                                                                                                                      |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| RTX 5090, driver 595.104.02, NixOS, VFX 1.3 / wheel 0.2.0.0  | Real Rust GPU inference verified; see [validation record](docs/validation.md) for browser results                                               |
| Chromium 148.0.7778.178; Brave Origin 1.97.59 / Chromium 155 | Visible AV1 playback tested on the host above; see [scope and measurements](docs/validation.md#av1-transport-and-resolution-targets-2026-10-22) |
| Other RTX Ada / Blackwell GPUs with AV1 NVENC                | Expected with compatible VFX/AV1 NVENC; not tested here                                                                                         |
| Helium, Vivaldi, Edge, Chrome, other Brave builds            | Native manifest installers included; playback compatibility unverified                                                                          |
| Other Linux distributions                                    | Expected with glibc 2.39+ for release binaries; source builds can use their host libc; unverified                                               |
| Firefox, ARM, RTX without AV1 encode, protected video, HDR   | Unsupported                                                                                                                                     |

NVIDIA lists branch-specific minimum drivers for VSR (570.190+, 580.82+, or 590.44+) and describes its Linux SDK as server-oriented. Desktop integration is experimental. Review [runtime requirements and terms](docs/runtime.md) before installation.

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

## Build from source

Install Rust 1.88+, Bun 1.3.13+, and a C compiler/linker and ar. No NVIDIA SDK headers, Python application, or original-project checkout is required to build:

```sh
cargo install --locked --path .
export PATH="$HOME/.cargo/bin:$PATH"
linux-rtx-vsr integration install --browser chromium
sh scripts/install-runtime.sh --accept-nvidia-license
linux-rtx-vsr doctor --gpu
```

Then [load the exported extension](#3-load-the-extension-and-play-a-video). Bun is needed to compile the extension during a source build; it is not needed to run the installed app.

For Nix:

```sh
nix build
nix run . -- --help
nix develop
```

For declarative installation, import `nixosModules.default` or `homeManagerModules.default` and set `programs.linux-rtx-vsr.enable = true;` with `runtime.enable = true;` and `browsers.chromium.enable = true;` after accepting NVIDIA's terms. The modules install enabled browser packages (customizable with `browsers.chromium.package = pkgs.chromium;`) and manage matching native manifests and extension assets across rebuilds. Home Manager also supports typed native settings. See the [copy-and-paste module examples](docs/nix.md#recommended-declarative-modules).

The default Nix package contains the free application and extension. Runtime setup is separate; [Nix setup](docs/nix.md) includes an opt-in package that supplies the proprietary runtime without modifying signed libraries.

## Development

`nix develop` includes Bun and Just. `just` lists all tasks:

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

For a release update, download and extract the new archive as above, then run:

```sh
sh scripts/install.sh --browser chromium --add-to-path
```

Use the same prefix and browser as your original installation. The installer stops the old backend, replaces the app and bundled files, and exports matching extension assets. Register each additional browser again with `integration install --browser BROWSER`. Click **Reload** on the extension in `chrome://extensions`, then refresh open video tabs.

Your configuration, site rules, and NVIDIA runtime are retained; do not rerun the runtime installer for an ordinary application update. Source installs use `linux-rtx-vsr stop` followed by `cargo install --locked --path . --force` and `integration install`; Nix installs update their pinned flake input and rebuild. Keep application and extension versions together. See [runtime updates](docs/runtime.md#runtime-updates) for separate NVIDIA updates.

To remove everything installed per user:

```sh
linux-rtx-vsr stop
linux-rtx-vsr integration remove --browser chromium
# Repeat for any other browser or custom --manifest-dir you installed.
```

Remove the extension in `chrome://extensions`, refresh video tabs, then remove the following **project-owned directories** (adjust XDG paths and any custom install prefix):

```sh
rm -f "$HOME/.local/bin/linux-rtx-vsr"
rm -rf "${XDG_DATA_HOME:-$HOME/.local/share}/linux-rtx-vsr" \
  "${XDG_STATE_HOME:-$HOME/.local/state}/linux-rtx-vsr" \
  "${XDG_CONFIG_HOME:-$HOME/.config}/linux-rtx-vsr"
```

With a custom prefix, also remove its `bin/linux-rtx-vsr` and `share/linux-rtx-vsr` paths. Source installs normally place the executable in `~/.cargo/bin`.

If you used `--add-to-path`, remove the line ending in `# linux-rtx-vsr PATH` from the startup file printed by the installer (or remove `fish/conf.d/linux-rtx-vsr.fish` for Fish).

Nix users remove the package from their profile/configuration as well. An externally managed SDK or NVIDIA driver is not removed. No system services are installed.

## Credits

Thanks to **[maxiarat1](https://github.com/maxiarat1)** for [linux-nvidia-vsr](https://github.com/maxiarat1/linux-nvidia-vsr), the original inspiration and timing/presentation investigations. Adapted timing code retains its MIT notice. NVIDIA develops VideoSuperRes; this project is independent and is not an NVIDIA product. See [third-party notices](THIRD_PARTY.md).
