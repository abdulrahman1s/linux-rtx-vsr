#!/bin/sh
# Run from an extracted release archive. No root access or network required.
set -eu
archive_root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
install_prefix=${LINUX_RTX_VSR_PREFIX:-"$HOME/.local"}
if [ ! -f "$archive_root/linux-rtx-vsr" ]; then
  echo 'Run this installer from an extracted release archive; source builds use cargo install --locked --path .' >&2
  exit 1
fi
mkdir -p "$install_prefix/bin" "$install_prefix/share/linux-rtx-vsr"
install -m755 "$archive_root/linux-rtx-vsr" "$install_prefix/bin/linux-rtx-vsr.new"
mv "$install_prefix/bin/linux-rtx-vsr.new" "$install_prefix/bin/linux-rtx-vsr"
for entry in README.md LICENSE THIRD_PARTY.md docs licenses extension scripts; do
  cp -R "$archive_root/$entry" "$install_prefix/share/linux-rtx-vsr/"
done
echo "Installed $install_prefix/bin/linux-rtx-vsr"
echo "Add $install_prefix/bin to PATH if necessary."
echo 'Next: install the NVIDIA runtime (docs/runtime.md), then run:'
echo '  linux-rtx-vsr integration install --browser chromium'
