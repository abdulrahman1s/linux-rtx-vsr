# Third-party notices

The project's original Rust, JavaScript, packaging, and documentation are MIT-licensed (Copyright © 2026 Abdulrahman Salah). NVIDIA runtime software and models have separate terms and are not included in Git or release archives.

## linux-nvidia-vsr

Source: <https://github.com/maxiarat1/linux-nvidia-vsr>, inspected commit `5766a6e56a4eb1b134c6d00cbf363c592ad48c61`.

`extension/src/audio-sync.ts`, `extension/src/presentation-clock.ts`, and `src/av1.rs` are adapted from that project's MIT-licensed timing code. The architecture also applies its published lessons about audible timing, bounded queues, visible iframe ownership, cold CUDA initialization, and stacking order. Copyright (c) 2026 maxiarat1 and contributors. The complete license is retained in `licenses/linux-nvidia-vsr-MIT.txt`. The AV1 parser adapts upstream `vsr_service/av1.py`. The NVENC adapter is independently implemented against the public C interface, preserving upstream’s no-extra-queue, independent-keyframe design.

## qsh

Source: <https://github.com/abdulrahman1s/qsh>, inspected commit `2ec0cb0b9c03ba7ec8e2f30f16764fa01a363cd3`.

The build/release workflow and flake design adapt its conventional-commit versioning, skip markers, manual release inputs, Rust checks/caching, archive naming, and generated release notes. Its nixpkgs lock pin is reused. Copyright (c) 2026 Abdulrahman Salah; license retained in `licenses/qsh-MIT.txt`. This implementation gates version commits, tags, and publication on successful Rust, browser, extension, and Nix checks.

## NVIDIA public API declarations

The `NvCVImage` C ABI layout in `src/gpu.rs` follows the public MIT-licensed `nvCVImage.h` from <https://github.com/NVIDIA-Maxine/Maxine-VFX-SDK>, inspected commit `f12bd18929e9065cff4f24cb93ac5f4202dc1c4a`. Copyright (c) 2021 NVIDIA Corporation; full notice in `licenses/NVIDIA-Maxine-MIT.txt`. Function declarations describe public C ABIs. No SDK implementation, proprietary binding source, Python extension, model, or signed binary is copied into this repository.

## Separately installed NVIDIA runtime

VFX 1.3 (distributed in NVIDIA's `nvidia-vfx` 0.2.0.0 archive), CUDA dependencies, NVENC drivers, and models retain their own licenses. The runtime installer verifies pinned downloads and retains their license files. The VFX Python module is not extracted or executed. Download availability does not establish your entitlement or redistribution rights. See NVIDIA's [VFX catalog](https://catalog.ngc.nvidia.com/orgs/nvidia/maxine/collections/maxine_vfx_sdk), [VSR collection](https://catalog.ngc.nvidia.com/orgs/nvidia/maxine/collections/nvvfxvideosuperres), and the agreements shipped in those archives.

Do not publish optional unfree Nix runtime closures to a binary cache without separately establishing redistribution rights. Signed `libnvidia-ngx-*` files must never be stripped or patched; changing RPATHs invalidates their signatures. The optional Nix runtime explicitly excludes these files from ELF patching.

Rust and development dependencies retain their respective upstream licenses. `Cargo.lock` and `bun.lock` record exact versions. Native release/Nix packages collect the actual locked Rust dependency license and notice files into `licenses/rust-dependencies.txt`; the extension has its own bundled notices. Development-only Playwright is not included in the application/extension archives. Browser fixtures are generated locally with FFmpeg; no third-party video is distributed.

## NVIDIA NVENC declarations

`native/nvEncodeAPI.h` is unmodified from [nv-codec-headers n13.0.19.0](https://github.com/FFmpeg/nv-codec-headers/blob/n13.0.19.0/include/ffnvcodec/nvEncodeAPI.h), Copyright (c) 2010–2024 NVIDIA Corporation, MIT. Its notice remains in the header and `licenses/NVIDIA-NVENC-MIT.txt` in binary packages. This header does not contain a proprietary encoder implementation. `native/nvenc.c` compiles into the Rust executable; the actual `libnvidia-encode.so.1` must be installed separately with the NVIDIA driver.
