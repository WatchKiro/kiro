#!/usr/bin/env bash
# Assembles a release's assets from the build artifacts (release.yml):
#
# - the installers, named as the website expects (apps/web/src/lib/releases.ts):
#   Kiro_<v>_aarch64.dmg, Kiro_<v>_x64-setup.exe, Kiro_<v>_amd64.AppImage and
#   Kiro_<v>_amd64.deb;
# - the update bundles and their signatures (the macOS .app.tar.gz; the
#   Windows installer and the AppImage update themselves as they are);
# - latest.json, the manifest Kiro's updater reads;
# - an LGPL source archive of libmpv per platform, packed with a neutral
#   owner so it names no one;
# - SHA256SUMS of all of them.
#
# Usage: release-assets.sh <version> <tag> <artifacts dir> <output dir>
# Needs jq and bsdtar (libarchive-tools). GITHUB_REPOSITORY names the repository.
set -euo pipefail

version="$1"
tag="$2"
artifacts="$3"
out="$4"
repo="${GITHUB_REPOSITORY:?}"
mkdir -p "$out"

# The one file in `artifacts/<artifact>` matching `pattern`.
one() {
  local artifact="$1" pattern="$2" found=()
  mapfile -t found < <(find "$artifacts/$artifact" -type f -name "$pattern")
  if [[ ${#found[@]} != 1 ]]; then
    echo "release-assets: expected one $pattern in $artifact, found ${#found[@]}: ${found[*]}" >&2
    exit 1
  fi
  echo "${found[0]}"
}

place() { # place <artifact> <pattern> <asset name>
  local file
  file="$(one "$1" "$2")"
  cp "$file" "$out/$3"
}

place kiro-macos '*.dmg' "Kiro_${version}_aarch64.dmg"
place kiro-macos '*.app.tar.gz' "Kiro_${version}_aarch64.app.tar.gz"
place kiro-macos '*.app.tar.gz.sig' "Kiro_${version}_aarch64.app.tar.gz.sig"
place kiro-windows-installer '*-setup.exe' "Kiro_${version}_x64-setup.exe"
place kiro-windows-installer '*-setup.exe.sig' "Kiro_${version}_x64-setup.exe.sig"
place kiro-linux-x86_64 '*.AppImage' "Kiro_${version}_amd64.AppImage"
place kiro-linux-x86_64 '*.AppImage.sig' "Kiro_${version}_amd64.AppImage.sig"
place kiro-linux-x86_64 '*.deb' "Kiro_${version}_amd64.deb"

# LGPL: each platform's libmpv sources, build script and licences. The owner
# recorded for every file is kiro (0), not whoever ran the build.
for platform in macos windows linux; do
  name="kiro-${version}-libmpv-${platform}-sources"
  [[ -d "$artifacts/libmpv-${platform}-sources" ]] || {
    echo "release-assets: no libmpv-${platform}-sources artifact" >&2
    exit 1
  }
  stage="$(mktemp -d)"
  cp -R "$artifacts/libmpv-${platform}-sources" "$stage/$name"
  bsdtar --uid 0 --gid 0 --uname kiro --gname kiro --no-xattrs --no-acls --no-fflags \
    -czf "$out/$name.tar.gz" -C "$stage" "$name"
  rm -rf "$stage"
done

# The updater's manifest. Each platform's entry is its update bundle and the
# signature made with the updater key; Kiro checks that signature against the
# public key it ships with before installing anything.
download="https://github.com/$repo/releases/download/$tag"
signature() { tr -d '\n' < "$out/$1.sig"; }
jq -n \
  --arg version "$version" \
  --arg notes "https://github.com/$repo/releases/tag/$tag" \
  --arg date "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg mac "Kiro_${version}_aarch64.app.tar.gz" --arg mac_sig "$(signature "Kiro_${version}_aarch64.app.tar.gz")" \
  --arg win "Kiro_${version}_x64-setup.exe" --arg win_sig "$(signature "Kiro_${version}_x64-setup.exe")" \
  --arg linux "Kiro_${version}_amd64.AppImage" --arg linux_sig "$(signature "Kiro_${version}_amd64.AppImage")" \
  --arg download "$download" \
  '{
    version: $version,
    notes: $notes,
    pub_date: $date,
    platforms: {
      "darwin-aarch64": { url: "\($download)/\($mac)", signature: $mac_sig },
      "windows-x86_64": { url: "\($download)/\($win)", signature: $win_sig },
      "linux-x86_64": { url: "\($download)/\($linux)", signature: $linux_sig }
    }
  }' > "$out/latest.json"

(cd "$out" && sha256sum -- * > "$out/SHA256SUMS.tmp" && mv "$out/SHA256SUMS.tmp" "$out/SHA256SUMS")
ls -l "$out"
cat "$out/latest.json"
