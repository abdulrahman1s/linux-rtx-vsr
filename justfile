set shell := ["bash", "-euo", "pipefail", "-c"]

# Show available tasks.
default:
    @just --list

# Install exactly the development dependencies recorded in bun.lock.
install:
    bun install --frozen-lockfile --ignore-scripts

# Format Rust, TypeScript, browser assets, documentation and Nix.
fmt: fmt-rust fmt-ts fmt-nix
    just --fmt

fmt-rust:
    cargo fmt

fmt-ts:
    bun run format

fmt-nix:
    nix fmt -- flake.nix nix/*.nix

fmt-check:
    cargo fmt --check
    bun run format:check
    nix fmt -- --check flake.nix nix/*.nix
    just --fmt --check

# Build browser assets and the native application (Cargo also embeds fresh assets).
build: build-ts build-rust

build-ts:
    bun run build

build-rust:
    cargo build --locked

release: build-ts
    cargo build --locked --release

# CPU-only static checks and tests; GPU and browser tests are separate tasks.
check: fmt-check
    cargo clippy --locked --all-targets -- -D warnings
    bun run check
    just test

test: test-rust test-ts

test-rust:
    cargo test --locked

test-ts:
    bun test

typecheck:
    bun run typecheck

test-browser: build-rust
    bun run test:browser

# Requires a configured, licensed NVIDIA runtime and an RTX GPU.
test-gpu: build-rust
    VSR_GPU_TEST=1 bun run test:browser

# Real NVIDIA transport throughput without browser capture/decode/presentation.
benchmark-transport *args: release
    bun scripts/measure-transport.ts {{ args }}

# Offline browser waveform continuity; no microphone or physical audio device.
benchmark-audio *args:
    bun scripts/measure-audio.ts {{ args }}

check-nix:
    nix flake check --print-build-logs

package: release
    bun scripts/package.ts
    bun tests/archive-smoke.ts

# Update the Nix artifact list after intentionally changing Bun dependencies.
sync-deps:
    bun scripts/sync-bun-deps.ts
