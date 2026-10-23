#!/bin/sh
# Acquisition only: no root, package installation, Python, Bun or ELF patching.
set -eu

die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<'EOF'
Usage: sh scripts/install-runtime.sh --accept-nvidia-license [OPTIONS]

Download, verify and configure the pinned NVIDIA VFX 1.3 runtime.
Read docs/runtime.md and NVIDIA's terms before accepting the licenses.
  --accept-nvidia-license  Explicitly accept NVIDIA's separate runtime terms.
  --vfx-archive FILE      Use an already downloaded, SHA-256-matching wheel.
  --binary FILE          Application executable (default: linux-rtx-vsr on PATH).
  -h, --help             Show this help.

Requires unzip, sha256sum and curl or wget (downloads only). No sudo needed.
NixOS: use docs/nix.md instead of this installer.
EOF
}
accepted=false
vfx_archive=
binary=linux-rtx-vsr
while [ "$#" -gt 0 ]; do
  case "$1" in
    --accept-nvidia-license) accepted=true; shift ;;
    --vfx-archive|--binary)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        die "$1 requires a value"
      fi
      case "$1" in --vfx-archive) vfx_archive=$2 ;; --binary) binary=$2 ;; esac
      shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1 (use --help)" ;;
  esac
done
[ "$accepted" = true ] || die "Review NVIDIA's terms in docs/runtime.md, then pass --accept-nvidia-license"
case "$(uname -s)/$(uname -m)" in Linux/x86_64) ;; *) die 'The pinned runtime requires Linux x86-64' ;; esac
for tool in dirname mkdir mktemp rm mv ln sha256sum unzip sed; do
  command -v "$tool" >/dev/null 2>&1 || die "Required command not found: $tool"
done
# --add-to-path affects new terminals; allow setup to continue in this one.
if [ "$binary" = linux-rtx-vsr ] && ! command -v "$binary" >/dev/null 2>&1; then
  candidate="${LINUX_RTX_VSR_PREFIX:-"${HOME:?HOME must be set}/.local"}/bin/linux-rtx-vsr"
  [ ! -x "$candidate" ] || binary=$candidate
fi
command -v "$binary" >/dev/null 2>&1 || die "Application not found: $binary. Install it first or pass --binary /absolute/path/linux-rtx-vsr"
# Fail before a large download if the application/configuration is unusable.
"$binary" config show >/dev/null
if [ -n "$vfx_archive" ]; then
  [ -f "$vfx_archive" ] || die "Archive not found: $vfx_archive"
  case "$vfx_archive" in /*) ;; *) vfx_archive="$PWD/$vfx_archive" ;; esac
elif command -v curl >/dev/null 2>&1; then
  downloader=curl
elif command -v wget >/dev/null 2>&1; then
  downloader=wget
else
  die 'Install curl or wget, or provide --vfx-archive FILE'
fi
root="${XDG_DATA_HOME:-"${HOME:?HOME must be set}/.local/share"}/linux-rtx-vsr"
case "$root" in /*) ;; *) die 'XDG_DATA_HOME must be an absolute path' ;; esac
runtime="$root/runtime"
if [ -e "$runtime" ] || [ -L "$runtime" ]; then
  die "$runtime already exists. To use it: \"$binary\" config set sdk_dir \"$runtime/nvvfx/libs\". To replace it, stop the backend and move the runtime aside first."
fi
script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=scripts/runtime-archive.sh
. "$script_dir/runtime-archive.sh"
mkdir -p -- "$root"
staging=
cleanup() { [ -z "$staging" ] || rm -rf -- "$staging"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
staging=$(mktemp -d "$root/.runtime.XXXXXX")
url='https://pypi.nvidia.com/nvidia-vfx/nvidia_vfx-0.2.0.0-cp312-abi3-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl'
digest='0252866a7b798a6f92c8543443d88f716e8c5bbc6a7ddd77a2754728dada9fa8'
if [ -z "$vfx_archive" ]; then
  vfx_archive="$staging/vfx.whl"
  printf 'Downloading NVIDIA VFX 1.3 (this may take several minutes)…\n'
  case "$downloader" in
    curl) curl --fail --location --proto '=https' --proto-redir '=https' --retry 3 --connect-timeout 30 --max-time 2700 --output "$vfx_archive" "$url" ;;
    wget) wget --https-only --tries=3 --timeout=30 --output-document="$vfx_archive" "$url" ;;
  esac
fi
printf 'Verifying SHA-256 and extracting runtime…\n'
extract_runtime_archive "$vfx_archive" "$staging/extracted" "$digest"
libs="$staging/extracted/nvvfx/libs"
[ -d "$libs" ] || die 'Verified archive is missing nvvfx/libs'
for file in "$libs/"*.so.*; do
  [ -f "$file" ] || continue
  name=${file##*/}
  alias="$libs/${name%%.so.*}.so"
  if [ ! -e "$alias" ] && [ ! -L "$alias" ]; then
    ln -s -- "$name" "$alias"
  fi
done
# -T refuses to nest the runtime in a concurrently created destination.
mv -T -- "$staging/extracted" "$runtime"
if ! "$binary" config set sdk_dir "$runtime/nvvfx/libs"; then
  die "Runtime files are installed at $runtime, but configuration failed. Fix the reported error, then run: \"$binary\" config set sdk_dir \"$runtime/nvvfx/libs\""
fi
printf 'Runtime installed: %s\nNVIDIA license files are retained in this directory.\n' "$runtime"
printf 'Next: "%s" doctor --gpu\n' "$binary"
