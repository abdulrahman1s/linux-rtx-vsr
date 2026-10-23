# README image comparisons

These are real NVIDIA VideoSuperRes outputs from Linux RTX VSR **0.3.4**, captured on an **RTX 5090**, driver **595.104.02**, with the pinned VFX 1.3 runtime (`nvidia-vfx` 0.2.0.0). They are controlled still-image examples, not recordings of browser playback or motion/performance benchmarks.

## Settings

| Setting                    | 480p → 1080p                  | 720p → 4K                     |
| -------------------------- | ----------------------------- | ----------------------------- |
| Source artwork             | `bbb-splash.png`, 1920×1080   | `rodents.png`, 1920×1080      |
| Compressed input           | 854×480                       | 1280×720                      |
| Input encoder              | H.264, libx264 medium, CRF 24 | H.264, libx264 medium, CRF 24 |
| Input color                | SDR BT.709, limited, 4:2:0    | SDR BT.709, limited, 4:2:0    |
| AI quality                 | High (3)                      | High (3)                      |
| Requested scale            | 2.25×                         | 3×                            |
| Actual output              | 1920×1080                     | 3840×2160                     |
| VSR transport encoder      | NVENC AV1, QP 14              | NVENC AV1, QP 14              |
| Baseline                   | FFmpeg bilinear               | FFmpeg bilinear               |
| Detail crop at output size | 480×270 at x=480, y=330       | 480×270 at x=1120, y=820      |

The app aligns output dimensions to multiples of eight; 854×480 at 2.25× becomes 1920×1080. The native session used this scale directly. The extension's target-fitting calculation can produce slightly different aligned dimensions for this source.

## Method

1. Download the original gallery PNG. Both originals are 1920×1080; there is no native 4K reference in these examples.
2. Downsample with FFmpeg's Lanczos filter, convert to limited-range BT.709 YUV 4:2:0, and encode one H.264 frame at CRF 24 with the medium preset.
3. Decode that frame once to NV12. Send those exact decoded pixels to both paths: FFmpeg bilinear scaling and the app's real VideoSuperRes → NVENC AV1 pipeline. The app runs with private temporary XDG directories, leaving the user's backend/configuration alone.
4. Decode the AV1 output to RGB with FFmpeg, respecting its signaled color matrix. Convert both full-size results and the compressed input to **lossless WebP**. These are the README's direct raw-image links; they have no labels, crops, or additional sharpening. “Raw” here means the individual image, not a camera RAW format.
5. Make a 1920×1408 comparison sheet. Resize each full frame to 960×540 with ImageMagick's default resize filter. Mark the same detail region on each overview. Enlarge each 480×270 detail crop by 2× with nearest-neighbor sampling, applying the same presentation steps to both sides. Add headings, preset labels, and attribution.

The first example's decoded NV12 SHA-256 is `b15487ae8494851e355fa538de710810730593be47745ca4eb3570acd5e0f2f8`; the second's is `7f47eec02dc09b1694d269cd110cdb828aba98a1bc3d13c5b2276d054b94c6cd`.

## Files and attribution

| Example      | Compressed input         | Bilinear output                   | VSR output                   | Comparison sheet                              |
| ------------ | ------------------------ | --------------------------------- | ---------------------------- | --------------------------------------------- |
| 480p → 1080p | [480p](480p-source.webp) | [1080p](480p-bilinear-1080p.webp) | [1080p](480p-vsr-1080p.webp) | [Side by side](480p-to-1080p-comparison.webp) |
| 720p → 4K    | [720p](720p-source.webp) | [4K](720p-bilinear-4k.webp)       | [4K](720p-vsr-4k.webp)       | [Side by side](720p-to-4k-comparison.webp)    |

All WebP images in this directory derive from _Big Buck Bunny_, © 2008 Blender Foundation / [www.bigbuckbunny.org](https://www.bigbuckbunny.org), under [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). See the [original license statement](https://peach.blender.org/about/) and [media gallery](https://peach.blender.org/media-gallery/).

Original downloads:

- [Bunny](https://peach.blender.org/wp-content/uploads/bbb-splash.png), SHA-256 `e6378fc0368cb38d4ec6554117ce9fda1ad5d71f4cb7ed5a7e242f329aa8bfce`.
- [Rodents](https://peach.blender.org/wp-content/uploads/rodents.png), SHA-256 `f876a31a67fc60fc8496b94e5ae897b74358d3917f944fd69c238a920b7ccd00`.

Changes: downsampling, H.264 compression, bilinear scaling or VideoSuperRes enhancement, conversion to lossless WebP, and cropped/labeled comparison layouts. The artwork keeps its CC BY 3.0 license; it is not covered by the application's MIT license.
