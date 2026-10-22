# NVIDIA runtime setup

The application uses the **VFX 1.3 C API** (`VideoSuperRes`, `QualityLevel`, `SrcImage0`, `DstImage0`) and driver-provided NVENC AV1. It does not import Python, use DLPack, launch the original project, call a web service, or substitute a non-AI scaler.

Requirements:

- Linux x86-64 and a supported NVIDIA GPU with Tensor Cores and AV1 NVENC (RTX Ada/Blackwell). Start with an RTX desktop GPU; only RTX 5090 was available for testing.
- The proprietary NVIDIA driver, including discoverable `libcuda.so.1` and `libnvidia-encode.so.1`. VSR's documented Linux minimums are branch-specific: 570.190+, 580.82+, or 590.44+. See NVIDIA's [VSR requirements](https://docs.nvidia.com/maxine/vfx/latest/Filters/VideoSuperResolution.html).
- VFX 1.3 core, VideoSuperRes feature/model libraries for the GPU, and their CUDA/NPP dependencies. The pinned NVIDIA `nvidia-vfx` 0.2.0.0 archive includes these runtime components; no Python installation of the wheel is needed.
- NVENC API 13 support in the NVIDIA driver (570+); the VFX branch-specific minimum still applies. The MIT NVENC header is vendored; no CUDA toolkit, nvJPEG, separately downloaded codec SDK or encoder helper build is needed. Older RTX Turing/Ampere GPUs cannot use this AV1 path.
- Chromium 140+ with WebCodecs `VideoFrame.copyTo`, AV1 `VideoDecoder`, OffscreenCanvas, native messaging, and Web Audio. Readable SDR video in a top-level document is required.

NVIDIA [documents](https://docs.nvidia.com/maxine/vfx/latest/LinuxVFXSDK/GetStartedonLinux.html) a server-side support scope for its Linux SDK. Our desktop browser integration is experimental and is not supported by NVIDIA. Check NVIDIA's current terms, [VSR collection](https://catalog.ngc.nvidia.com/orgs/nvidia/maxine/collections/nvvfxvideosuperres), software license, AI product-specific terms, and model agreements before downloading. Download access may depend on your account or entitlement.

## Conventional Linux

Install the application first and ensure `linux-rtx-vsr` is on PATH. The runtime installer needs `unzip`, `sha256sum`, standard GNU utilities, and either `curl` or `wget` for downloading. On Debian/Ubuntu, install missing tools with `sudo apt-get install curl unzip coreutils`.

```sh
sh scripts/install-runtime.sh --accept-nvidia-license
linux-rtx-vsr doctor --gpu
```

It downloads the pinned VFX archive over HTTPS, verifies SHA-256 before extraction, retains license files, and configures absolute runtime paths. It never uses pip, root access, or ELF patching. It refuses to replace an existing runtime directory. A failed download can be retried; a partially extracted runtime is never installed. It can reuse a previously downloaded exact VFX wheel:

```sh
sh scripts/install-runtime.sh --accept-nvidia-license \
  --vfx-archive /path/to/nvidia_vfx-0.2.0.0-cp312-abi3-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl
```

Use `--binary /absolute/path/to/linux-rtx-vsr` if the app is outside PATH. The installer checks the application/configuration before downloading. If configuration fails after extraction, it retains the verified runtime and prints the exact `config set sdk_dir` command to finish setup. An existing runtime is never replaced silently.

After deleting the extracted release folder, the installed script is still available:

```sh
sh "$HOME/.local/share/linux-rtx-vsr/scripts/install-runtime.sh" --help
```

Adjust this path for a custom application prefix. Runtime files themselves go under `${XDG_DATA_HOME:-$HOME/.local/share}/linux-rtx-vsr/runtime` independently of that prefix. NixOS requires the [Nix runtime wrapper](nix.md), rather than this conventional Linux installer.

The SDK archive is separate from the tiny `nvidia-vfx` package on the default PyPI index. The installer uses NVIDIA's index URL, not that placeholder source distribution. Do not extract an arbitrary newer SDK over the pinned runtime and assume ABI compatibility.

## Use an existing SDK

For an existing licensed installation, skip the download and configure its libraries:

```sh
linux-rtx-vsr config set sdk_dir /absolute/path/to/nvvfx/libs
# Optional only when the SDK distribution uses a separate model directory:
linux-rtx-vsr config set model_dir /absolute/path/to/models
linux-rtx-vsr doctor --gpu
```

The loader explicitly preloads required SDK dependencies by absolute path with global symbol visibility. Their own transitive dependencies still need to resolve normally. Keep the archive's `nvvfx/libs` and sibling `nvidia_vfx.libs` layout. On conventional systems, install the distribution's C++ runtime and NVIDIA driver normally. Never patch, strip, or copy-over NVIDIA's signed NGX libraries. See [Nix instructions](nix.md) for NixOS.

Environment override `LINUX_RTX_VSR_SDK_DIR` takes precedence over the config file. Old `jpeg_library`/`jpeg_quality` fields are accepted but ignored; nvJPEG is no longer loaded. Optional `LINUX_RTX_VSR_EXECUTABLE` tells native integration to invoke a stable wrapper path, useful for Nix packages. Otherwise the current executable's absolute path is recorded. Keep that path installed while browser integration is enabled.

## Runtime updates

Stop the backend first with `linux-rtx-vsr stop`. Move the existing `runtime` directory to a backup path, run the new release's `scripts/install-runtime.sh --accept-nvidia-license`, and run `linux-rtx-vsr doctor --gpu`. Keep the backup until inference succeeds. To roll back, stop the backend, move the failed runtime aside and restore the backup to its original path. Do not rewrite signed libraries. Updating the application does not automatically download or update NVIDIA software. For Nix, pin a new flake input and explicitly select the unfree output again.

## Useful diagnostics

```sh
nvidia-smi
linux-rtx-vsr doctor
linux-rtx-vsr doctor --gpu
linux-rtx-vsr benchmark --frames 300 --width 1920 --height 1080 --target 2160 --output enhanced.obu
```

`doctor --gpu` uses actual inference and writes timings. Decode `benchmark --output enhanced.obu` with `ffmpeg -i enhanced.obu -frames:v 1 enhanced.png` and inspect it to catch black-image regressions; successful API return codes alone do not prove meaningful pixels. The driver/runtime may reject unsupported hardware or model configurations. Such errors leave the original browser video playing.

`benchmark --target 4320` requests 8K; hardware limits and VRAM may reject it. This is experimental and is not an 8K realtime claim. The browser defaults to a 4K target. `encode_qp` defaults to 14 (0–51 supported; lower means higher quality/more bandwidth). JPEG quality no longer applies.
