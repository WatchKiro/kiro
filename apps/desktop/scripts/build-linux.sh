#!/usr/bin/env bash
# Builds the Linux release: an AppImage and a .deb, with native playback
# through the bundled LGPL libmpv (scripts/build-libmpv-linux.sh, built first
# if needed). x86_64; build on Ubuntu 22.04 so the result runs on every
# supported distribution. With the updater's key (TAURI_SIGNING_PRIVATE_KEY),
# the AppImage is signed for updates too (its .sig). See docs/releasing.md.
set -euo pipefail

DESKTOP="$(cd "$(dirname "$0")/.." && pwd)"
"$DESKTOP/scripts/build-libmpv-linux.sh"

cd "$DESKTOP"
export KIRO_LIBMPV_DIR="$DESKTOP/.libmpv/dist/lib"
# The AppImage bundler (linuxdeploy) copies libmpv in from here, with the
# libraries it links that a desktop may lack. Not VA-API's: the host's own
# libva must load the host's VA drivers, which an older bundled copy can't.
export LD_LIBRARY_PATH="$KIRO_LIBMPV_DIR${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export LINUXDEPLOY_EXCLUDED_LIBRARIES="libva.so*;libva-drm.so*;libva-wayland.so*;libva-x11.so*"
configs=(--config src-tauri/tauri.release.conf.json --config src-tauri/tauri.release.linux.conf.json)
if [[ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  configs+=(--config src-tauri/tauri.updater.conf.json)
fi
pnpm exec tauri build \
  --features libmpv \
  "${configs[@]}" \
  --bundles appimage,deb \
  "$@"
