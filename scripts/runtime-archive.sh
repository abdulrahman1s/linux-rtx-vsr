#!/bin/sh
# Sourced by install-runtime.sh. Extract only verified SDK data, never symlinks.
extract_runtime_archive() (
  set -eu
  archive=$1
  destination=$2
  expected=$3
  actual=$(sha256sum -- "$archive")
  actual=${actual%% *}
  [ "$actual" = "$expected" ] || {
    printf 'SHA-256 mismatch: %s; no runtime installed\n' "$archive" >&2
    exit 1
  }
  # A fresh destination ensures there can be no pre-existing symlink parents.
  if [ -e "$destination" ] || [ -L "$destination" ]; then
    printf 'Extraction destination already exists: %s\n' "$destination" >&2
    exit 1
  fi
  entries="${destination}.entries"
  unzip -Z1 "$archive" > "$entries"
  selected="${destination}.selected"
  : > "$selected"
  while IFS= read -r name; do
    case "$name" in
      nvvfx/libs/*|nvidia_vfx.libs/*|nvidia_vfx-0.2.0.0.dist-info/licenses/*)
        case "/$name" in
          */../*|*/./*|*//*|*\\*) printf 'Unsafe archive path: %s\n' "$name" >&2; exit 1 ;;
        esac
        printf '%s\n' "$name" >> "$selected" ;;
    esac
  done < "$entries"
  [ -s "$selected" ] || { printf 'No runtime files in archive\n' >&2; exit 1; }
  mkdir -- "$destination"
  while IFS= read -r name; do
    target="$destination/$name"
    case "$name" in
      */) mkdir -p -- "$target" ;;
      *)
        mkdir -p -- "${target%/*}"
        # unzip treats member names as patterns; quote its glob metacharacters.
        pattern=$(printf '%s' "$name" | sed 's/[][?*]/\\&/g')
        # noclobber rejects duplicate file entries. ZIP symlinks become data.
        (set -C; unzip -p "$archive" "$pattern" > "$target") ;;
    esac
  done < "$selected"
  rm -f -- "$entries" "$selected"
)
