#!/usr/bin/env bash
# Builds the LGPL libmpv that ships inside the macOS app.
#
# Everything is compiled from pinned source releases (checksums verified)
# into one self-contained `libmpv.2.dylib` that links only system libraries
# and frameworks: FFmpeg, libplacebo, libass and the rest are linked into it
# statically. Nothing GPL or non-free is enabled:
#
# - mpv is configured with `-Dgpl=false`;
# - FFmpeg is built without `--enable-gpl`, `--enable-version3` or
#   `--enable-nonfree`, and with `--disable-autodetect`, so nothing optional
#   is picked up from the machine;
# - pkg-config only sees this build's own prefix, never Homebrew.
#
# The result is LGPL-2.1-or-later. The checks at the end fail the build if it
# isn't. Output: apps/desktop/.libmpv/dist (lib/libmpv.2.dylib, include/,
# licenses/). Re-running reuses finished steps; delete .libmpv to start over.
#
# Requires Xcode command line tools, meson, ninja and pkg-config
# (`brew install meson ninja pkg-config`). Apple Silicon only for now.
set -euo pipefail

if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  echo "build-libmpv: Apple Silicon macOS only" >&2
  exit 1
fi
for tool in meson ninja pkg-config curl shasum; do
  command -v "$tool" > /dev/null || { echo "build-libmpv: $tool is required" >&2; exit 1; }
done

DESKTOP="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$DESKTOP/.libmpv"
SRC="$ROOT/src"
PREFIX="$ROOT/prefix" # static dependencies and headers, build-time only
DIST="$ROOT/dist"     # what the app links against and bundles
mkdir -p "$ROOT/downloads" "$SRC" "$PREFIX" "$DIST"

# A finished, verified build of this exact script (CI restores one from its
# cache) is used as it is.
BUILD_ID="$(shasum -a 256 "$0" | cut -d' ' -f1)"
if [[ -f "$DIST/lib/libmpv.2.dylib" && "$(cat "$DIST/.build-id" 2> /dev/null)" == "$BUILD_ID" ]]; then
  echo "==> libmpv is up to date: $DIST/lib/libmpv.2.dylib"
  exit 0
fi

# Matches tauri.conf.json `bundle.macOS.minimumSystemVersion`.
export MACOSX_DEPLOYMENT_TARGET=12.0
export PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig"
export PKG_CONFIG_PATH=""
export CFLAGS="-O2 -mmacosx-version-min=$MACOSX_DEPLOYMENT_TARGET"
export CXXFLAGS="$CFLAGS"
export LDFLAGS="-mmacosx-version-min=$MACOSX_DEPLOYMENT_TARGET"
JOBS="$(sysctl -n hw.ncpu)"

# name|version|url|sha256|licence
SOURCES=(
  "ffmpeg|9.0.2|https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz|8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e|LGPL-2.1-or-later"
  "mpv|0.41.0|https://github.com/mpv-player/mpv/archive/refs/tags/v0.41.0.tar.gz|ee21092a5ee427353392360929dc64645c54479aefdb5babc5cfbb5fad626209|LGPL-2.1-or-later (-Dgpl=false)"
  "libplacebo|7.360.1|https://code.videolan.org/videolan/libplacebo/-/archive/v7.360.1/libplacebo-v7.360.1.tar.bz2|937aa5eeea596798b3274d362de2e3bd32bc537a66d149dd85043349c74dffb6|LGPL-2.1-or-later"
  "libass|0.17.5|https://github.com/libass/libass/releases/download/0.17.5/libass-0.17.5.tar.xz|2dca25c0e0c837ddf00b52011b3f82cac1e4ddd3ad018227806b0c2288864acc|ISC"
  "freetype|2.15.0|https://downloads.sourceforge.net/project/freetype/freetype2/2.15.0/freetype-2.15.0.tar.xz|93cd47eb719c325107f2d3cf087d06299e944c3b48a40b55537302304dea1dd5|FTL"
  "fribidi|1.0.17|https://github.com/fribidi/fribidi/releases/download/v1.0.17/fribidi-1.0.17.tar.xz|6949dcde27d41cebad1fd741fcafc36d55a1020d2d872d4a6eb3914caabbada2|LGPL-2.1-or-later"
  "harfbuzz|14.6.0|https://github.com/harfbuzz/harfbuzz/releases/download/14.6.0/harfbuzz-14.6.0.tar.xz|d07a007327277708a2a73ae437887cdbaf282937f6d03ca5467723e9099af586|MIT"
  "dav1d|1.5.4|https://code.videolan.org/videolan/dav1d/-/archive/1.5.4/dav1d-1.5.4.tar.bz2|2abfb0c89212e6e4733a54e0ae509ec00a5b845a6360946f918806e14aedb011|BSD-2-Clause"
  # libplacebo build-time only: headers (its Vulkan stubs need the types even
  # with Vulkan off), a header-only parser and code generators.
  "vulkan-headers|1.4.363.0|https://github.com/KhronosGroup/Vulkan-Headers/archive/refs/tags/vulkan-sdk-1.4.363.0.tar.gz|4a078be12bef21cfebc09d878b77a63cff9d68f899254a0b00d0e37ef73e7f7e|Apache-2.0 (headers)"
  "fast_float|8.3.2|https://github.com/fastfloat/fast_float/archive/refs/tags/v8.3.2.tar.gz|71bb9e865b888df01351558db5a39586d13ea97ada162156b3a07784d8c1b26b|MIT"
  "glad2|2.0.8|https://files.pythonhosted.org/packages/6e/5a/d62b24fe1c7c2f34e15c2aa4418a5327a8550fdc272999a59e0dddebc3ee/glad2-2.0.8.tar.gz|b84079b9fa404f37171b961bdd1d8da21370e6c818defb8481c5b3fe3d6436da|MIT (build tool)"
  "jinja2|3.1.6|https://files.pythonhosted.org/packages/df/bf/f7da0350254c0ed7c72f3e33cef02e048281fec7ecec5f032d4aac52226b/jinja2-3.1.6.tar.gz|0137fb05990d35f1275a587e9aee6d56da821fc83491a0fb838183be43f66d6d|BSD-3-Clause (build tool)"
  "markupsafe|3.0.3|https://files.pythonhosted.org/packages/7e/99/7690b6d4034fffd95959cbe0c02de8deb3098cc577c67bb6a24fe5d7caa7/markupsafe-3.0.3.tar.gz|722695808f4b6457b320fdc131280796bdceb04ab50fe1795cd540799ebe1698|BSD-3-Clause (build tool)"
)

field() { # field <name> <index>
  local entry
  for entry in "${SOURCES[@]}"; do
    [[ "${entry%%|*}" == "$1" ]] && { cut -d'|' -f"$2" <<< "$entry"; return; }
  done
  return 1
}

# Downloads, verifies and unpacks a source into $SRC/<name>.
fetch() {
  local name="$1" url sha archive
  url="$(field "$name" 3)"
  sha="$(field "$name" 4)"
  archive="$ROOT/downloads/$name-$(field "$name" 2).${url##*.}"
  [[ -d "$SRC/$name" ]] && return
  if [[ ! -f "$archive" ]]; then
    echo "==> downloading $name"
    curl -fsSL --retry 3 -o "$archive.part" "$url"
    mv "$archive.part" "$archive"
  fi
  echo "$sha  $archive" | shasum -a 256 -c --quiet - || {
    echo "build-libmpv: checksum mismatch for $name" >&2
    rm -f "$archive"
    exit 1
  }
  mkdir -p "$SRC/$name.part"
  tar -xf "$archive" -C "$SRC/$name.part" --strip-components 1
  mv "$SRC/$name.part" "$SRC/$name"
}

# Runs a step once; a stamp file records completion.
step() {
  local name="$1"
  shift
  [[ -f "$ROOT/stamps/$name" ]] && return
  echo "==> building $name"
  "$@"
  mkdir -p "$ROOT/stamps"
  touch "$ROOT/stamps/$name"
}

meson_build() { # meson_build <name> [options...]
  local name="$1"
  shift
  rm -rf "$SRC/$name/_build"
  meson setup "$SRC/$name/_build" "$SRC/$name" \
    --prefix="$PREFIX" --libdir=lib --buildtype=release \
    -Ddefault_library=static -Dprefer_static=true -Db_ndebug=true "$@"
  meson compile -C "$SRC/$name/_build" -j "$JOBS"
  meson install -C "$SRC/$name/_build" --quiet
}

build_dav1d() {
  meson_build dav1d -Denable_tools=false -Denable_tests=false -Denable_examples=false
}

build_freetype() {
  meson_build freetype -Dzlib=disabled -Dpng=disabled -Dbzip2=disabled \
    -Dbrotli=disabled -Dharfbuzz=disabled -Dtests=disabled
}

build_fribidi() {
  meson_build fribidi -Ddocs=false -Dbin=false -Dtests=false
}

build_harfbuzz() {
  meson_build harfbuzz -Dfreetype=enabled -Dcoretext=enabled -Dglib=disabled \
    -Dgobject=disabled -Dcairo=disabled -Dicu=disabled -Dchafa=disabled \
    -Dtests=disabled -Ddocs=disabled -Dutilities=disabled -Dintrospection=disabled
}

build_libass() {
  meson_build libass -Dfontconfig=disabled -Dcoretext=enabled -Ddirectwrite=disabled \
    -Dlibunibreak=disabled -Dtest=disabled -Dprofile=disabled -Dfuzz=disabled \
    -Dcheckasm=disabled
}

build_ffmpeg() {
  (
    cd "$SRC/ffmpeg"
    ./configure \
      --prefix="$PREFIX" \
      --cc=clang \
      --extra-cflags="$CFLAGS" \
      --extra-ldflags="$LDFLAGS" \
      --enable-static --disable-shared --enable-pic \
      --disable-autodetect \
      --disable-programs --disable-doc --disable-debug \
      --disable-encoders --disable-muxers --disable-indevs --disable-outdevs \
      --enable-indev=lavfi \
      --enable-muxer=spdif \
      --enable-encoder=mjpeg \
      --enable-zlib --enable-bzlib --enable-iconv \
      --enable-videotoolbox --enable-audiotoolbox --enable-securetransport \
      --enable-libdav1d
    make -j "$JOBS"
    make install
  )
}

build_libplacebo() {
  local third="$SRC/libplacebo/3rdparty"
  rm -rf "$third/glad" "$third/jinja" "$third/markupsafe" "$third/fast_float" \
    "$third/Vulkan-Headers"
  cp -R "$SRC/vulkan-headers" "$third/Vulkan-Headers"
  cp -R "$SRC/glad2" "$third/glad"
  cp -R "$SRC/jinja2" "$third/jinja"
  cp -R "$SRC/markupsafe" "$third/markupsafe"
  cp -R "$SRC/fast_float" "$third/fast_float"
  meson_build libplacebo -Dvulkan=disabled -Dshaderc=disabled -Dglslang=disabled \
    -Dlcms=disabled -Dopengl=enabled -Dd3d11=disabled -Ddovi=enabled \
    -Dlibdovi=disabled -Dunwind=disabled -Dxxhash=disabled \
    -Ddemos=false -Dtests=false -Dbench=false -Dfuzz=false
}

build_mpv() {
  # Audio: Core Audio first, with AVFoundation (AVSampleBufferAudioRenderer)
  # as mpv's fallback when Core Audio can't open the output device. Without
  # the fallback such Macs get no sound at all, and mpv drops the audio track.
  rm -rf "$SRC/mpv/_build"
  meson setup "$SRC/mpv/_build" "$SRC/mpv" \
    --prefix="$DIST" --libdir=lib --buildtype=release \
    -Ddefault_library=shared -Dprefer_static=true -Db_ndebug=true \
    -Dgpl=false -Dlibmpv=true -Dcplayer=false -Dbuild-date=false \
    -Dlua=disabled -Djavascript=disabled -Dlibarchive=disabled -Duchardet=disabled \
    -Dlibbluray=disabled -Ddvdnav=disabled -Dcdda=disabled -Drubberband=disabled \
    -Dzimg=disabled -Dlcms2=disabled -Dvapoursynth=disabled -Djpeg=disabled \
    -Dsdl2-audio=disabled -Dsdl2-video=disabled -Dsdl2-gamepad=disabled \
    -Dvulkan=disabled -Dshaderc=disabled -Dspirv-cross=disabled \
    -Dswift-build=enabled -Dswift-flags="-target arm64-apple-macos$MACOSX_DEPLOYMENT_TARGET" \
    -Dmacos-cocoa-cb=disabled -Dmacos-media-player=disabled \
    -Dmacos-touchbar=disabled -Dcocoa=enabled -Dgl=enabled -Dgl-cocoa=enabled \
    -Dvideotoolbox-gl=enabled -Dcoreaudio=enabled -Daudiounit=disabled \
    -Davfoundation=enabled -Dmanpage-build=disabled -Dhtml-build=disabled \
    -Dpdf-build=disabled
  meson compile -C "$SRC/mpv/_build" -j "$JOBS"
  meson install -C "$SRC/mpv/_build" --quiet
  # The app finds it in Contents/Frameworks through its rpath.
  install_name_tool -id @rpath/libmpv.2.dylib "$DIST/lib/libmpv.2.dylib"
  codesign --force --sign - "$DIST/lib/libmpv.2.dylib"
}

# Licence texts and a manifest of exactly what went into the build. Bundled
# into the app and published with each release, with the sources.
collect_licenses() {
  local out="$DIST/licenses" entry name file
  rm -rf "$out"
  mkdir -p "$out"
  for entry in "${SOURCES[@]}"; do
    name="${entry%%|*}"
    mkdir -p "$out/$name"
    for file in COPYING COPYING.LGPLv2.1 LICENSE LICENSE.LGPL LICENSE.md LICENSE.txt \
      LICENSE-MIT LICENSE.rst Copyright.txt docs/FTL.TXT docs/LICENSE.TXT; do
      [[ -f "$SRC/$name/$file" ]] && cp "$SRC/$name/$file" "$out/$name/"
    done
  done
  {
    echo "Kiro bundles libmpv (Contents/Frameworks/libmpv.2.dylib), built from these"
    echo "unmodified source releases by apps/desktop/scripts/build-libmpv.sh in the"
    echo "Kiro repository. Each component's licence text is in its folder here."
    echo "The library can be replaced with your own build of the same mpv version."
    echo
    printf '%-12s %-10s %-34s %s\n' Component Version Licence Source
    for entry in "${SOURCES[@]}"; do
      IFS='|' read -r name version url sha licence <<< "$entry"
      printf '%-12s %-10s %-34s %s\n' "$name" "$version" "$licence" "$url"
      printf '%-12s %-10s %-34s sha256 %s\n' "" "" "" "$sha"
    done
  } > "$out/README.txt"
}

# Fails unless the result is LGPL and self-contained.
verify() {
  local dylib="$DIST/lib/libmpv.2.dylib" config="$SRC/mpv/_build/config.h"
  grep -q '^#define HAVE_GPL 0' "$config" || { echo "verify: mpv was built with GPL code" >&2; exit 1; }
  for output in COREAUDIO AVFOUNDATION; do
    grep -q "^#define HAVE_$output 1" "$config" \
      || { echo "verify: mpv was built without its $output audio output" >&2; exit 1; }
  done
  grep -Eq '^#define CONFIG_(GPL|NONFREE|VERSION3) 1' "$SRC/ffmpeg/config.h" \
    && { echo "verify: FFmpeg was built with GPL, v3 or non-free code" >&2; exit 1; }
  grep -q 'FFMPEG_LICENSE "LGPL version 2.1 or later"' "$SRC/ffmpeg/config.h" \
    || { echo "verify: unexpected FFmpeg licence" >&2; exit 1; }
  # Audio passthrough: mpv packs AC-3, E-AC-3, DTS and TrueHD for the
  # receiver with FFmpeg's spdif muxer, the only muxer the build keeps.
  grep -q '^#define CONFIG_SPDIF_MUXER 1' "$SRC/ffmpeg/config_components.h" \
    || { echo "verify: FFmpeg was built without the spdif muxer (audio passthrough)" >&2; exit 1; }
  # Seek-bar previews are JPEGs written by mpv through FFmpeg's mjpeg encoder,
  # the only encoder the build keeps (mpv is built without libjpeg).
  grep -q '^#define CONFIG_MJPEG_ENCODER 1' "$SRC/ffmpeg/config_components.h" \
    || { echo "verify: FFmpeg was built without the mjpeg encoder (seek-bar previews)" >&2; exit 1; }
  if otool -L "$dylib" | tail -n +2 | grep -Ev '^\s+(/usr/lib/|/System/Library/|@rpath/libmpv)'; then
    echo "verify: libmpv links libraries outside macOS (listed above)" >&2
    exit 1
  fi
  echo "==> libmpv is LGPL-2.1-or-later and self-contained: $dylib"
}

for entry in "${SOURCES[@]}"; do fetch "${entry%%|*}"; done
step dav1d build_dav1d
step freetype build_freetype
step fribidi build_fribidi
step harfbuzz build_harfbuzz
step libass build_libass
step ffmpeg build_ffmpeg
step libplacebo build_libplacebo
step mpv build_mpv
collect_licenses
verify
echo "$BUILD_ID" > "$DIST/.build-id"
