#!/usr/bin/env bash
# Fails if any release asset, or any file inside one, contains `/Users/`: a
# macOS home folder, which would name whoever built it (docs/releasing.md,
# Build paths). The maintainer publishes anonymously, so release.yml runs
# this on every asset before uploading anything.
#
# Installers and archives are unpacked first (the .dmg and the Windows
# installer with 7-Zip, the AppImage with its own --appimage-extract, the
# .deb with dpkg-deb, tarballs with tar), since their contents are
# compressed. Both 8-bit and UTF-16 (Windows) strings are checked. Archives
# nested inside them, such as the upstream tarballs in the LGPL source
# archives, are third-party code and aren't unpacked.
#
# Usage: scan-release.sh <file or folder>...
# Needs 7-Zip (`7z` or `7zz`) and perl; on Linux also dpkg-deb.
set -euo pipefail

sevenzip="$(command -v 7zz || command -v 7z || true)"
[[ -n "$sevenzip" ]] || { echo "scan-release: 7-Zip (7z or 7zz) is required" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

found=0
scanned=0

# Lists files under `path` that contain /Users/, as text or UTF-16LE.
matches() {
  {
    grep -rlaF -- '/Users/' "$1" || true
    find "$1" -type f -exec perl -0777 -ne 'print "$ARGV\n" if m{/\0U\0s\0e\0r\0s\0/\0}' {} +
  } | sort -u
}

report() { # report <asset> <path inside the unpacked asset or the asset itself>
  echo "::error::$1 contains /Users/ (${2#"$work"/})"
  {
    LC_ALL=C grep -aoE '/Users/[^[:space:][:cntrl:]"]{0,80}' "$2" || true
    perl -0777 -ne 'while (m{(/\0U\0s\0e\0r\0s\0/\0(?:[^\0\s]\0){0,80})}g) { (my $s = $1) =~ s/\0//g; print "$s (UTF-16)\n" }' "$2"
  } | sort -u | head -n 5 | sed 's/^/    /'
  found=1
}

# Unpacks `asset` into `dir`, or returns 1 for files that aren't containers.
unpack() {
  local asset="$1" dir="$2"
  case "$asset" in
    *.dmg | *.exe)
      "$sevenzip" x -y -bd -o"$dir" "$asset" > /dev/null
      # A .dmg unpacks to its partitions' file system images first.
      local image
      while IFS= read -r image; do
        "$sevenzip" x -y -bd -o"$image.d" "$image" > /dev/null && rm -f "$image"
      done < <(find "$dir" -maxdepth 1 -type f \( -name '*.hfs' -o -name '*.hfsx' -o -name '*.apfs' -o -name '*.img' \))
      ;;
    *.AppImage)
      chmod +x "$asset"
      (cd "$dir" && "$asset" --appimage-extract > /dev/null)
      ;;
    *.deb) dpkg-deb -x "$asset" "$dir" ;;
    *.tar.gz | *.tgz) tar -xzf "$asset" -C "$dir" ;;
    *) return 1 ;;
  esac
}

scan_asset() {
  local asset name dir path
  asset="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
  name="$(basename "$asset")"
  scanned=$((scanned + 1))
  while IFS= read -r path; do report "$name" "$path"; done < <(matches "$asset")
  dir="$work/$scanned"
  mkdir -p "$dir"
  if unpack "$asset" "$dir"; then
    local files
    files="$(find "$dir" -type f | wc -l | tr -d ' ')"
    if [[ "$files" == 0 ]]; then
      echo "::error::$name unpacked to nothing; can't check it"
      found=1
      return
    fi
    while IFS= read -r path; do report "$name" "$path"; done < <(matches "$dir")
    echo "checked $name ($files files inside)"
  else
    echo "checked $name"
  fi
  rm -rf "$dir"
}

for target in "$@"; do
  if [[ -d "$target" ]]; then
    while IFS= read -r file; do scan_asset "$file"; done < <(find "$target" -type f | sort)
  else
    scan_asset "$target"
  fi
done

if [[ "$found" != 0 ]]; then
  echo "scan-release: found /Users/ paths (above). Build in a neutral folder; see docs/releasing.md, Build paths." >&2
  exit 1
fi
echo "scan-release: no /Users/ paths in $scanned files"
