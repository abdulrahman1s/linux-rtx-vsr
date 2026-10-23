#!/bin/sh
# Install an extracted release for the current user. No network or root required.
set -eu

die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<'EOF'
Usage: sh scripts/install.sh [--prefix DIRECTORY] [--browser BROWSER] [--add-to-path]

Install the application and documentation without downloading NVIDIA software.
  --prefix DIRECTORY  Absolute install prefix (default: $HOME/.local).
                      LINUX_RTX_VSR_PREFIX also sets this default.
  --browser BROWSER   Register only this browser instead of detecting browsers.
                      Default: auto (all supported browsers found on PATH).
                      See the README for browser names.
  --add-to-path       Add the installed bin directory to your shell startup file.
                      Supports Bash, Zsh, Fish and POSIX sh; uses $SHELL.
  -h, --help          Show this help.

Run as your normal user. Existing runtime, configuration and state are retained.
EOF
}

install_prefix=${LINUX_RTX_VSR_PREFIX:-"${HOME:?HOME must be set}/.local"}
browser=auto
add_to_path=false
shell_name=${SHELL:-sh}
shell_name=${shell_name##*/}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix|--browser)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        die "$1 requires a value"
      fi
      case "$1" in --prefix) install_prefix=$2 ;; --browser) browser=$2 ;; esac
      shift 2 ;;
    --add-to-path) add_to_path=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1 (use --help)" ;;
  esac
done
case "$install_prefix" in /*) ;; *) die '--prefix must be an absolute path' ;; esac
case "$browser" in
  auto|chromium|chrome|chrome-beta|chrome-dev|brave|brave-beta|brave-nightly|brave-origin|brave-origin-nightly|edge|edge-beta|edge-dev|vivaldi|vivaldi-snapshot|helium) ;;
  *) die "Unsupported browser: $browser (use --help)" ;;
esac
# Detect executables without launching browsers or inferring installation from
# profile directories, which can remain after a browser has been uninstalled.
browser_installed() {
  shift # The first field is the integration name; the rest are executable aliases.
  for candidate do
    executable=$(command -v "$candidate" 2>/dev/null) || continue
    case "$executable" in /snap/*|/var/lib/snapd/snap/bin/*) continue ;; esac
    [ -f "$executable" ] && [ -x "$executable" ] && return 0
  done
  return 1
}
browsers=$browser
if [ "$browser" = auto ]; then
  browsers=
  while read -r name aliases; do
    # Alias fields below are fixed executable names, never user input.
    # shellcheck disable=SC2086
    if browser_installed "$name" $aliases; then
      browsers="${browsers:+$browsers }$name"
    fi
  done <<'EOF'
chromium chromium chromium-browser ungoogled-chromium
chrome google-chrome google-chrome-stable
chrome-beta google-chrome-beta
chrome-dev google-chrome-unstable google-chrome-dev
brave brave brave-browser brave-browser-stable
brave-beta brave-beta brave-browser-beta
brave-nightly brave-nightly brave-browser-nightly
brave-origin brave-origin brave-origin-browser
brave-origin-nightly brave-origin-nightly brave-origin-browser-nightly
edge microsoft-edge microsoft-edge-stable
edge-beta microsoft-edge-beta
edge-dev microsoft-edge-dev
vivaldi vivaldi vivaldi-stable
vivaldi-snapshot vivaldi-snapshot
helium helium helium-browser
EOF
fi
for tool in dirname mkdir mktemp install cp mv rm; do
  command -v "$tool" >/dev/null 2>&1 || die "Required command not found: $tool"
done
if [ "$add_to_path" = true ]; then
  for tool in sed grep; do
    command -v "$tool" >/dev/null 2>&1 || die "Required command not found: $tool"
  done
  case "$install_prefix" in
    *:*|*'
'*) die '--add-to-path requires a prefix without colons or newlines' ;;
  esac
  case "$shell_name" in
    bash) startup="$HOME/.bashrc" ;;
    zsh) startup="${ZDOTDIR:-$HOME}/.zshrc" ;;
    fish) startup="${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/linux-rtx-vsr.fish" ;;
    sh|dash|'') startup="$HOME/.profile" ;;
    *) die "--add-to-path does not support $SHELL; use Bash, Zsh, Fish or sh" ;;
  esac
  [ ! -e "$startup" ] || [ -w "$startup" ] || die "Shell startup file is not writable: $startup"
fi
archive_root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
[ -f "$archive_root/linux-rtx-vsr" ] || die 'Use an extracted release archive. Source builds: cargo install --locked --path .'
for entry in README.md LICENSE THIRD_PARTY.md docs licenses extension scripts; do
  [ -e "$archive_root/$entry" ] || die "Incomplete release archive: missing $entry"
done

mkdir -p "$install_prefix/bin" "$install_prefix/share/linux-rtx-vsr"
binary="$install_prefix/bin/linux-rtx-vsr"
data="$install_prefix/share/linux-rtx-vsr"
staging=
binary_tmp=
cleanup() {
  [ -z "$staging" ] || rm -rf -- "$staging"
  [ -z "$binary_tmp" ] || rm -f -- "$binary_tmp"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
staging=$(mktemp -d "$install_prefix/share/.linux-rtx-vsr.XXXXXX")
binary_tmp=$(mktemp "$install_prefix/bin/.linux-rtx-vsr.XXXXXX")
install -m755 "$archive_root/linux-rtx-vsr" "$binary_tmp"
# Detect an incompatible binary/libc before changing an existing installation.
"$binary_tmp" --version
for entry in README.md LICENSE THIRD_PARTY.md docs licenses extension scripts; do
  cp -R -- "$archive_root/$entry" "$staging/$entry"
done
if [ -x "$binary" ]; then
  "$binary" stop
fi
# Replace only release-owned entries; the runtime and user data may share data.
for entry in README.md LICENSE THIRD_PARTY.md docs licenses extension scripts; do
  rm -rf -- "${data:?}/${entry:?}"
  mv -- "$staging/$entry" "$data/$entry"
done
mv -f -- "$binary_tmp" "$binary"
binary_tmp=
printf '\nInstalled %s\nDocumentation: %s/README.md\n' "$binary" "$data"
if [ "$add_to_path" = true ]; then
  if [ "$shell_name" = fish ]; then
    escaped_bin=$(printf '%s' "$install_prefix/bin" | sed 's/[\\"$]/\\&/g')
    path_line="fish_add_path --path \"$escaped_bin\" # linux-rtx-vsr PATH"
  else
    escaped_bin=$(printf '%s' "$install_prefix/bin" | sed 's/[\\"$`]/\\&/g')
    path_line="case \":\$PATH:\" in *\":$escaped_bin:\"*) ;; *) export PATH=\"$escaped_bin:\$PATH\" ;; esac # linux-rtx-vsr PATH"
  fi
  mkdir -p -- "$(dirname -- "$startup")"
  if [ ! -f "$startup" ] || ! grep -Fqx -- "$path_line" "$startup"; then
    printf '\n%s\n' "$path_line" >> "$startup"
  fi
  printf 'PATH configured in %s. Open a new terminal to use linux-rtx-vsr by name.\n' "$startup"
fi
if [ -n "$browsers" ]; then
  printf '\nRegistering browser integration: %s\n' "$browsers"
  for selected_browser in $browsers; do
    "$binary" integration install --browser "$selected_browser"
  done
else
  printf '\nNo supported browsers detected on PATH. After installing a browser, rerun this installer\nor register it with: "%s" integration install --browser BROWSER\n' "$binary"
fi
printf 'Runtime setup: sh "%s/scripts/install-runtime.sh" --binary "%s" --accept-nvidia-license\n' "$data" "$binary"
case ":${PATH:-}:" in
  *":$install_prefix/bin:"*) ;;
  *)
    if [ "$add_to_path" = false ]; then
      printf 'Use --add-to-path to add %s/bin to your shell startup file.\n' "$install_prefix"
    fi ;;
esac
