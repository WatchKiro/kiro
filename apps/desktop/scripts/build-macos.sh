#!/usr/bin/env bash
# Builds the macOS release: Kiro.app and a .dmg, with native playback through
# the bundled LGPL libmpv (scripts/build-libmpv.sh, built first if needed).
#
# Signed ad hoc unless APPLE_SIGNING_IDENTITY names a Developer ID
# certificate; set APPLE_ID, APPLE_PASSWORD and APPLE_TEAM_ID as well to
# notarise. See docs/releasing.md.
set -euo pipefail

DESKTOP="$(cd "$(dirname "$0")/.." && pwd)"
"$DESKTOP/scripts/build-libmpv.sh"

configs=(--config src-tauri/tauri.release.conf.json)
if [[ -z "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  # Ad hoc signatures carry no Team ID, so the hardened runtime's library
  # validation would refuse to load libmpv. Notarisation needs the hardened
  # runtime, but an ad hoc build can't be notarised anyway.
  echo "build-macos: no APPLE_SIGNING_IDENTITY, signing ad hoc (runs on this Mac; others need right-click > Open)"
  configs+=(--config '{"bundle":{"macOS":{"hardenedRuntime":false}}}')
fi

cd "$DESKTOP"
KIRO_LIBMPV_DIR="$DESKTOP/.libmpv/dist/lib" pnpm exec tauri build \
  --features libmpv \
  "${configs[@]}" \
  --bundles app,dmg \
  "$@"
