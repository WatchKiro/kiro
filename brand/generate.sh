#!/usr/bin/env bash
# Regenerates every derived brand asset from the master artwork, brand/kiro-icon.webp.
#
#   bash brand/generate.sh
#
# Requires librsvg (`rsvg-convert`), libwebp (`dwebp`, `cwebp`) and the repo's
# dependencies installed (for `tauri icon`).
#   macOS:  brew install librsvg webp
#   Debian: sudo apt install librsvg2-bin webp
set -euo pipefail

cd "$(dirname "$0")/.."

MASTER=brand/kiro-icon.webp
SIZE=1254            # master is SIZE x SIZE
BG='#843cfb'         # master background colour
# Square crop around the mascot so it stays legible at small sizes.
CROP=1000
CROP_X=116
CROP_Y=126

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

dwebp -quiet "$MASTER" -o "$tmp/master.png"
href="data:image/png;base64,$(base64 < "$tmp/master.png" | tr -d '\n')"

# Cropped artwork, scaled to fill a WxH box at (X, Y).
artwork() { # $1 x, $2 y, $3 box size
  awk -v x="$1" -v y="$2" -v box="$3" -v crop=$CROP -v cx=$CROP_X -v cy=$CROP_Y -v size=$SIZE -v href="$href" 'BEGIN {
    s = box / crop
    printf "<image x=\"%.3f\" y=\"%.3f\" width=\"%.3f\" height=\"%.3f\" href=\"%s\"/>", x - cx * s, y - cy * s, size * s, size * s, href
  }'
}

render() { # $1 svg file, $2 output png
  rsvg-convert "$1" -o "$2"
}

# 1. Desktop app icon source: macOS icon grid (824px rounded body on a 1024px
#    canvas with a soft shadow). Tauri derives every platform icon from it.
cat > "$tmp/app-icon.svg" <<SVG
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <clipPath id="body"><rect x="100" y="100" width="824" height="824" rx="185"/></clipPath>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="12" stdDeviation="14" flood-color="#000" flood-opacity="0.28"/>
    </filter>
  </defs>
  <rect x="100" y="100" width="824" height="824" rx="185" fill="$BG" filter="url(#shadow)"/>
  <g clip-path="url(#body)">$(artwork 100 100 824)</g>
</svg>
SVG
render "$tmp/app-icon.svg" apps/desktop/app-icon.png

# 2. UI mark (square; components round the corners with CSS).
cat > "$tmp/mark.svg" <<SVG
<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">$(artwork 0 0 256)</svg>
SVG
render "$tmp/mark.svg" "$tmp/mark.png"
cwebp -quiet -q 90 "$tmp/mark.png" -o apps/desktop/public/brand/kiro-mark.webp
cp apps/desktop/public/brand/kiro-mark.webp apps/web/public/brand/kiro-mark.webp

# 3. Website favicon (rounded, transparent corners) and Apple touch icon
#    (full-bleed; iOS applies its own mask).
cat > "$tmp/favicon.svg" <<SVG
<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <defs><clipPath id="r"><rect width="256" height="256" rx="58"/></clipPath></defs>
  <g clip-path="url(#r)">$(artwork 0 0 256)</g>
</svg>
SVG
render "$tmp/favicon.svg" apps/web/src/app/icon.png

cat > "$tmp/apple.svg" <<SVG
<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180" viewBox="0 0 180 180">$(artwork 0 0 180)</svg>
SVG
render "$tmp/apple.svg" apps/web/src/app/apple-icon.png

# 4. Platform icons for the desktop bundle. Mobile and Store icons are pruned
#    until those targets exist.
pnpm --filter @kiro/desktop exec tauri icon app-icon.png > /dev/null 2>&1
rm -rf apps/desktop/src-tauri/icons/{android,ios} \
  apps/desktop/src-tauri/icons/Square*Logo.png \
  apps/desktop/src-tauri/icons/StoreLogo.png \
  apps/desktop/src-tauri/icons/64x64.png

echo "Brand assets regenerated from $MASTER"
