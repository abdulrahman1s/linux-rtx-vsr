# Development instructions

Prefix every shell command in agent sessions with `rtk`; use `rtk proxy` when
the command is not supported or unfiltered output is required.

Keep NVIDIA FFI in `src/gpu.rs`, validate frames before GPU access, and never
introduce a fake-success or substitute-scaler production path. Preserve the
third-party MIT notices with adapted timing code.

Use the ordinary checks in `docs/development.md` for changes. GPU/browser and
audible synchronization checks are separate: report exactly what ran. Keep
application, extension, and package versions synchronized through the release
version script. Do not include proprietary NVIDIA binaries or models in release
archives.
