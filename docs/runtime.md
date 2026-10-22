# NVIDIA runtime setup

The application uses the **VFX 1.3 C API** (`VideoSuperRes`, `QualityLevel`, `SrcImage0`, `DstImage0`) and nvJPEG. It does not import Python, use DLPack, launch the original project, call a web service, or substitute a non-AI scaler.

Requirements:

- Linux x86-64 and a supported NVIDIA GPU with Tensor Cores. Start with an RTX desktop GPU; only RTX 5090 was available for testing.
- The proprietary NVIDIA driver, including a discoverable `libcuda.so.1`. VSR's documented Linux minimums are branch-specific: 570.190+, 580.82+, or 590.44+. See NVIDIA's [VSR requirements](https://docs.nvidia.com/maxine/vfx/latest/Filters/VideoSuperResolution.html).
- VFX 1.3 core, VideoSuperRes feature/model libraries for the GPU, and their CUDA/NPP dependencies. The pinned NVIDIA `nvidia-vfx` 0.2.0.0 archive includes these runtime components; no Python installation of the wheel is needed.
- CUDA nvJPEG (tested: 13.1.0.59). No NVENC or Video Codec SDK headers are required by this implementation.
- Chromium 140+ with WebCodecs `VideoFrame.copyTo`, OffscreenCanvas, native messaging, and Web Audio. Readable SDR video in a top-level document is required.

NVIDIA [documents](https://docs.nvidia.com/maxine/vfx/latest/LinuxVFXSDK/GetStartedonLinux.html) a server-side support scope for its Linux SDK. Our desktop browser integration is experimental and is not supported by NVIDIA. Check NVIDIA's current terms, [VSR collection](https://catalog.ngc.nvidia.com/orgs/nvidia/maxine/collections/nvvfxvideosuperres), software license, AI product-specific terms, and model agreements before downloading. Download access may depend on your account or entitlement.

## Conventional Linux

The release/source tree includes a TypeScript **acquisition script** run with Bun 1.3.13+ and `unzip`:

```sh
bun scripts/install-runtime.ts --accept-nvidia-license
linux-rtx-vsr doctor --gpu
```

It downloads pinned VFX/nvJPEG archives over HTTPS, verifies SHA-256 before extraction, retains license files, and configures absolute runtime paths. It never uses pip, root access, or ELF patching. It refuses to replace an existing runtime directory. A failed download can be retried; a partially extracted runtime is never installed. It can reuse a previously downloaded exact VFX wheel:

```sh
bun scripts/install-runtime.ts --accept-nvidia-license --vfx-archive /path/to/nvidia_vfx-0.2.0.0-cp312-abi3-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl
```

The SDK archive is separate from the tiny `nvidia-vfx` package on the default PyPI index. The installer uses NVIDIA's index URL, not that placeholder source distribution. Do not extract an arbitrary newer SDK over the pinned runtime and assume ABI compatibility.

For an existing licensed installation:

```sh
linux-rtx-vsr config set sdk_dir /absolute/path/to/nvvfx/libs
linux-rtx-vsr config set jpeg_library /absolute/path/to/libnvjpeg.so
# Optional only when the SDK distribution uses a separate model directory:
linux-rtx-vsr config set model_dir /absolute/path/to/models
linux-rtx-vsr doctor --gpu
```

The loader explicitly preloads required SDK dependencies by absolute path with global symbol visibility. Their own transitive dependencies still need to resolve normally. Keep the archive's `nvvfx/libs` and sibling `nvidia_vfx.libs` layout. On conventional systems, install the distribution's C++ runtime and NVIDIA driver normally. Never patch, strip, or copy-over NVIDIA's signed NGX libraries. See [Nix instructions](nix.md) for NixOS.

Environment overrides `LINUX_RTX_VSR_SDK_DIR` and `LINUX_RTX_VSR_JPEG_LIBRARY` take precedence over the config file. Optional `LINUX_RTX_VSR_EXECUTABLE` tells native integration to invoke a stable wrapper path, useful for Nix packages. Otherwise the current executable's absolute path is recorded. Keep that path installed while browser integration is enabled.

## Runtime updates

Stop the backend first. Preserve the old runtime for rollback, install a separately verified new pinned version, and run the cold GPU test. Do not rewrite signed libraries. Updating the application does not automatically download or update NVIDIA software. For Nix, pin a new flake input and explicitly select the unfree output again.

## Useful diagnostics

```sh
nvidia-smi
linux-rtx-vsr doctor
linux-rtx-vsr doctor --gpu
linux-rtx-vsr benchmark --frames 300 --width 1920 --height 1080 --output enhanced.jpg
```

`doctor --gpu` uses actual inference and writes timings. Inspect image output from `benchmark --output` to catch black-image regressions; successful API return codes alone do not prove meaningful pixels. The driver/runtime may reject unsupported hardware or model configurations. Such errors leave the original browser video playing.
