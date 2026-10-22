#!/usr/bin/env bash
# Builds the LGPL libmpv that ships inside the Linux packages (AppImage and
# .deb): the Linux counterpart of build-libmpv.sh.
#
# Everything is compiled from pinned source releases (checksums verified)
# into one `libmpv.so.2`. FFmpeg, libplacebo, libass, fontconfig, FreeType,
# HarfBuzz, OpenSSL and the rest are linked into it statically, and their
# symbols are hidden, so they can't clash with the system's copies that GTK
# and WebKitGTK load into the same process. It links dynamically only to
# libraries every supported distribution has (SYSTEM_LIBS below): glibc,
# libstdc++, EGL, VA-API, libdrm, the Wayland client libraries, xkbcommon,
# PulseAudio and ALSA. Nothing GPL or non-free is enabled:
#
# - mpv is configured with `-Dgpl=false` and every optional feature off
#   unless listed (`-Dauto_features=disabled`);
# - FFmpeg is built without `--enable-gpl`, `--enable-version3` or
#   `--enable-nonfree`, and with `--disable-autodetect`, so nothing optional
#   is picked up from the machine;
# - pkg-config only sees this build's own prefix and the system libraries in
#   SYSTEM_PKGS.
#
# The result is LGPL-2.1-or-later. The checks at the end fail the build if it
# isn't, if it links anything outside SYSTEM_LIBS, if it exports anything but
# mpv's API, or if it needs a newer glibc or system library than the oldest
# supported distribution has. Build on Ubuntu 22.04 (the oldest supported
# base): its system libraries are what the result is checked against.
#
# Output: apps/desktop/.libmpv/dist (lib/libmpv.so.2, include/, licenses/).
# Re-running reuses finished steps; delete .libmpv to start over.
#
# Requires (Ubuntu 22.04): build-essential nasm pkg-config ninja-build curl
# python3 perl libva-dev libdrm-dev libegl-dev libxkbcommon-dev libpulse-dev
# libasound2-dev libffi-dev, and meson >= 1.11 (pip; see
# .github/workflows/linux-packages.yml). x86_64 only for now.
set -euo pipefail

if [[ "$(uname -s)" != Linux || "$(uname -m)" != x86_64 ]]; then
  echo "build-libmpv-linux: x86_64 Linux only" >&2
  exit 1
fi
for tool in meson ninja pkg-config curl sha256sum nasm python3 perl make cc c++ readelf nm objdump ldd; do
  command -v "$tool" > /dev/null || { echo "build-libmpv-linux: $tool is required" >&2; exit 1; }
done

DESKTOP="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$DESKTOP/.libmpv"
SRC="$ROOT/src"
PREFIX="$ROOT/prefix"      # static dependencies and headers, build-time only
DIST="$ROOT/dist"          # what the app links against and bundles
SYSPC="$ROOT/system-pkgconfig" # the system libraries pkg-config may see
mkdir -p "$ROOT/downloads" "$SRC" "$PREFIX" "$DIST"

# A finished, verified build of this exact script (CI restores one from its
# cache) is used as it is.
BUILD_ID="$(sha256sum "$0" | cut -d' ' -f1)"
if [[ -f "$DIST/lib/libmpv.so.2" && "$(cat "$DIST/.build-id" 2> /dev/null)" == "$BUILD_ID" ]]; then
  echo "==> libmpv is up to date: $DIST/lib/libmpv.so.2"
  exit 0
fi

# Ubuntu 22.04's glibc. The result must not need anything newer.
MAX_GLIBC=2.35

# System libraries the build may use (pkg-config names). Linked dynamically.
SYSTEM_PKGS=(libva libva-drm libva-wayland libdrm egl xkbcommon libpulse alsa libffi)

# Shared libraries libmpv.so.2 may link (DT_NEEDED). All present on every
# distribution with WebKitGTK 4.1 (Ubuntu 22.04+, Debian 12+, Fedora, Arch);
# the .deb depends on their packages.
SYSTEM_LIBS=(
  linux-vdso.so.1 ld-linux-x86-64.so.2 libc.so.6 libm.so.6 libpthread.so.0 libdl.so.2 librt.so.1
  libstdc++.so.6 libgcc_s.so.1 # libplacebo has some C++; WebKitGTK needs both too
  libEGL.so.1                  # VA-API interop (dmabuf import into GL)
  libva.so.2 libva-drm.so.2 libva-wayland.so.2 libdrm.so.2
  libwayland-client.so.0 libwayland-cursor.so.0 libxkbcommon.so.0
  libpulse.so.0 libasound.so.2 # audio: PulseAudio (or PipeWire's), then ALSA
)

export PATH="$PREFIX/bin:$PATH"
export PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig:$PREFIX/share/pkgconfig:$SYSPC"
export PKG_CONFIG_PATH=""
export CFLAGS="-O2 -fPIC"
export CXXFLAGS="$CFLAGS"
export LDFLAGS=""
JOBS="$(nproc)"

# name|version|url|sha256|licence
SOURCES=(
  "ffmpeg|9.0.2|https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz|8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e|LGPL-2.1-or-later"
  "mpv|0.41.0|https://github.com/mpv-player/mpv/archive/refs/tags/v0.41.0.tar.gz|ee21092a5ee427353392360929dc64645c54479aefdb5babc5cfbb5fad626209|LGPL-2.1-or-later (-Dgpl=false)"
  "libplacebo|7.360.1|https://code.videolan.org/videolan/libplacebo/-/archive/v7.360.1/libplacebo-v7.360.1.tar.bz2|937aa5eeea596798b3274d362de2e3bd32bc537a66d149dd85043349c74dffb6|LGPL-2.1-or-later"
  "libass|0.17.5|https://github.com/libass/libass/releases/download/0.17.5/libass-0.17.5.tar.xz|2dca25c0e0c837ddf00b52011b3f82cac1e4ddd3ad018227806b0c2288864acc|ISC"
  "freetype|2.15.0|https://downloads.sourceforge.net/project/freetype/freetype2/2.15.0/freetype-2.15.0.tar.xz|93cd47eb719c325107f2d3cf087d06299e944c3b48a40b55537302304dea1dd5|FTL"
  "fribidi|1.0.17|https://github.com/fribidi/fribidi/releases/download/v1.0.17/fribidi-1.0.17.tar.xz|6949dcde27d41cebad1fd741fcafc36d55a1020d2d872d4a6eb3914caabbada2|LGPL-2.1-or-later"
  "harfbuzz|14.6.0|https://github.com/harfbuzz/harfbuzz/releases/download/14.6.0/harfbuzz-14.6.0.tar.xz|d07a007327277708a2a73ae437887cdbaf282937f6d03ca5467723e9099af586|MIT"
  "fontconfig|2.18.3|https://gitlab.freedesktop.org/api/v4/projects/890/packages/generic/fontconfig/2.18.3/fontconfig-2.18.3.tar.xz|4f7b554a38cdf78c033f666c8871f3749e14a094f65a07f630c91ed0b43d35e3|MIT"
  "expat|2.9.0|https://github.com/libexpat/libexpat/releases/download/R_2_9_0/expat-2.9.0.tar.xz|1e6371862cc31999b368c3b89b49994f0677e1bab5f1b2b85ae3741f5d803051|MIT"
  "dav1d|1.5.4|https://code.videolan.org/videolan/dav1d/-/archive/1.5.4/dav1d-1.5.4.tar.bz2|2abfb0c89212e6e4733a54e0ae509ec00a5b845a6360946f918806e14aedb011|BSD-2-Clause"
  "openssl|3.5.9|https://github.com/openssl/openssl/releases/download/openssl-3.5.9/openssl-3.5.9.tar.gz|603f5602e2eef00d77fbd429d34dcd5822bb301757a1bc9cdb24c670f1eb859a|Apache-2.0"
  "zlib|1.3.2|https://github.com/madler/zlib/releases/download/v1.3.2/zlib-1.3.2.tar.gz|bb329a0a2cd0274d05519d61c667c062e06990d72e125ee2dfa8de64f0119d16|Zlib"
  "libdisplay-info|0.2.0|https://gitlab.freedesktop.org/emersion/libdisplay-info/-/releases/0.2.0/downloads/libdisplay-info-0.2.0.tar.xz|5a2f002a16f42dd3540c8846f80a90b8f4bdcd067a94b9d2087bc2feae974176|MIT"
  # Wayland: headers and wayland-scanner, whose generated protocol code is
  # compiled into libmpv. 1.21.0 is the oldest mpv accepts; at run time
  # libmpv uses the system's libwayland-client (Ubuntu 22.04 has 1.20, which
  # the symbol check at the end confirms is enough).
  "wayland|1.21.0|https://gitlab.freedesktop.org/wayland/wayland/-/releases/1.21.0/downloads/wayland-1.21.0.tar.xz|6dc64d7fc16837a693a51cfdb2e568db538bfdc9f457d4656285bb9594ef11ac|MIT"
  "wayland-protocols|1.49|https://gitlab.freedesktop.org/wayland/wayland-protocols/-/releases/1.49/downloads/wayland-protocols-1.49.tar.xz|ec4c8f74942d6dff7ace8b4ce4764f0ef9ff618a935d974ea77edee2ad240b14|MIT"
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
  echo "$sha  $archive" | sha256sum -c --quiet - || {
    echo "build-libmpv-linux: checksum mismatch for $name" >&2
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

# The static libraries' pkg-config files list what they need as "private",
# which only `pkg-config --static` reports. mpv must be linked without
# `--static` (that would pull the system libraries' private dependencies in
# too), so fold each static library's private fields into the public ones.
promote_private() {
  local pc
  for pc in "$PREFIX"/lib/pkgconfig/*.pc; do
    [[ "$(basename "$pc")" == wayland-* ]] && continue # shared, build-time only
    awk '
      /^Requires\.private:/ { sub(/^Requires\.private:/, ""); requires = requires " " $0; next }
      /^Requires:/          { sub(/^Requires:/, "");          requires = requires " " $0; next }
      /^Libs\.private:/     { sub(/^Libs\.private:/, "");     libs = libs " " $0; next }
      /^Libs:/              { sub(/^Libs:/, "");              libs = $0 " " libs; next }
      { print }
      END { print "Requires:" requires; print "Libs:" libs }
    ' "$pc" > "$pc.tmp"
    mv "$pc.tmp" "$pc"
  done
}

meson_build() { # meson_build <name> [options...]
  local name="$1"
  shift
  rm -rf "$SRC/$name/_build"
  meson setup "$SRC/$name/_build" "$SRC/$name" \
    --prefix="$PREFIX" --libdir=lib --buildtype=release \
    -Ddefault_library=static -Dprefer_static=true -Db_ndebug=true -Db_staticpic=true "$@"
  meson compile -C "$SRC/$name/_build" -j "$JOBS"
  meson install -C "$SRC/$name/_build" --quiet
  promote_private
}

# Symlinks the allowed system libraries' pkg-config files where the build
# looks, so nothing else on the machine is found.
system_pkgconfig() {
  local name file
  rm -rf "$SYSPC"
  mkdir -p "$SYSPC"
  for name in "${SYSTEM_PKGS[@]}"; do
    file="$(env -u PKG_CONFIG_LIBDIR -u PKG_CONFIG_PATH pkg-config --variable=pcfiledir "$name" 2> /dev/null || true)"
    [[ -n "$file" && -f "$file/$name.pc" ]] || {
      echo "build-libmpv-linux: system package $name.pc not found (see Requires above)" >&2
      exit 1
    }
    ln -s "$file/$name.pc" "$SYSPC/$name.pc"
  done
}

build_zlib() {
  (
    cd "$SRC/zlib"
    ./configure --prefix="$PREFIX" --static
    make -j "$JOBS"
    make install
  )
  promote_private
}

build_openssl() {
  (
    cd "$SRC/openssl"
    # FFmpeg's HTTPS. `openssldir` is where distributions keep openssl.cnf
    # and certificates (mpv doesn't verify certificates by default).
    ./Configure linux-x86_64 --prefix="$PREFIX" --libdir=lib --openssldir=/etc/ssl \
      no-shared no-module no-tests no-docs no-apps no-legacy -fPIC
    make -j "$JOBS"
    make install_sw
  )
  promote_private
}

build_expat() {
  (
    cd "$SRC/expat"
    ./configure --prefix="$PREFIX" --enable-static --disable-shared --with-pic \
      --without-docbook --without-examples --without-tests --without-xmlwf
    make -j "$JOBS"
    make install
  )
  promote_private
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
  meson_build harfbuzz -Dfreetype=enabled -Dcoretext=disabled -Dglib=disabled \
    -Dgobject=disabled -Dcairo=disabled -Dicu=disabled -Dchafa=disabled \
    -Dtests=disabled -Ddocs=disabled -Dutilities=disabled -Dintrospection=disabled
}

# libass finds system fonts through fontconfig, which reads the system's own
# configuration (/etc/fonts) and caches. Installed through a staging
# directory so nothing is written outside the prefix.
build_fontconfig() {
  local name=fontconfig stage="$ROOT/stage-fontconfig"
  rm -rf "$SRC/$name/_build" "$stage"
  meson setup "$SRC/$name/_build" "$SRC/$name" \
    --prefix="$PREFIX" --libdir=lib --buildtype=release \
    -Ddefault_library=static -Dprefer_static=true -Db_ndebug=true -Db_staticpic=true \
    -Ddoc=disabled -Dnls=disabled -Dtests=disabled -Dtools=disabled -Dcache-build=disabled \
    -Diconv=disabled -Dxml-backend=expat -Dfontations=disabled \
    -Dbaseconfig-dir=/etc/fonts -Dconfig-dir=/etc/fonts/conf.d \
    -Dtemplate-dir=/usr/share/fontconfig/conf.avail -Dxml-dir=/usr/share/xml/fontconfig \
    -Dcache-dir=/var/cache/fontconfig
  meson compile -C "$SRC/$name/_build" -j "$JOBS"
  DESTDIR="$stage" meson install -C "$SRC/$name/_build" --quiet
  cp -R "$stage$PREFIX/." "$PREFIX/"
  rm -rf "$stage"
  promote_private
}

build_libass() {
  meson_build libass -Dfontconfig=enabled -Dcoretext=disabled -Ddirectwrite=disabled \
    -Dlibunibreak=disabled -Dtest=disabled -Dprofile=disabled -Dfuzz=disabled \
    -Dcheckasm=disabled
}

build_ffmpeg() {
  (
    cd "$SRC/ffmpeg"
    ./configure \
      --prefix="$PREFIX" \
      --extra-cflags="$CFLAGS" \
      --extra-ldflags="$LDFLAGS" \
      --enable-static --disable-shared --enable-pic \
      --disable-autodetect \
      --disable-programs --disable-doc --disable-debug \
      --disable-encoders --disable-muxers --disable-indevs --disable-outdevs \
      --enable-indev=lavfi \
      --enable-muxer=spdif \
      --enable-encoder=mjpeg \
      --enable-zlib --enable-iconv --enable-openssl \
      --enable-vaapi --enable-libdrm \
      --enable-libdav1d
    make -j "$JOBS"
    make install
  )
  promote_private
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
  # Some of libplacebo is C++, which its pkg-config file doesn't mention (a
  # shared libplacebo would link libstdc++ itself). mpv links with the C
  # compiler, so name it.
  sed -i 's/^Libs:\(.*\)$/Libs:\1 -lstdc++/' "$PREFIX/lib/pkgconfig/libplacebo.pc"
}

# libdisplay-info (needed by mpv's DRM support, which VA-API's DRM display
# needs) compiles in a table of monitor manufacturer names from hwdata's
# pnp.ids. Only mpv's own DRM output, which Kiro doesn't use, would show
# them, so give it an empty table rather than hwdata's (GPL-2.0+ or X11).
build_libdisplay_info() {
  mkdir -p "$PREFIX/share/hwdata" "$PREFIX/share/pkgconfig"
  : > "$PREFIX/share/hwdata/pnp.ids"
  printf 'pkgdatadir=%s\n\nName: hwdata\nDescription: empty pnp.ids\nVersion: 0\n' \
    "$PREFIX/share/hwdata" > "$PREFIX/share/pkgconfig/hwdata.pc"
  meson_build libdisplay-info
}

build_wayland() {
  rm -rf "$SRC/wayland/_build"
  meson setup "$SRC/wayland/_build" "$SRC/wayland" \
    --prefix="$PREFIX" --libdir=lib --buildtype=release \
    -Ddefault_library=shared -Dlibraries=true -Dscanner=true -Dtests=false \
    -Ddocumentation=false -Ddtd_validation=false
  meson compile -C "$SRC/wayland/_build" -j "$JOBS"
  meson install -C "$SRC/wayland/_build" --quiet
}

build_wayland_protocols() {
  meson_build wayland-protocols -Dtests=false
}

build_mpv() {
  rm -rf "$SRC/mpv/_build"
  # --exclude-libs: the static libraries' symbols stay inside libmpv (mpv's
  # own are hidden already), so GTK's FreeType, HarfBuzz or fontconfig can't
  # resolve to libmpv's copies, or the other way round.
  LDFLAGS="-Wl,--exclude-libs,ALL -Wl,--as-needed -Wl,-z,relro,-z,now" \
    meson setup "$SRC/mpv/_build" "$SRC/mpv" \
    --prefix="$DIST" --libdir=lib --buildtype=release \
    -Ddefault_library=shared -Dprefer_static=false -Db_ndebug=true \
    -Dauto_features=disabled \
    -Dgpl=false -Dlibmpv=true -Dcplayer=false -Dbuild-date=false -Dtests=false \
    -Diconv=enabled -Dzlib=enabled -Dlibavdevice=enabled \
    -Dpulse=enabled -Dalsa=enabled \
    -Dgl=enabled -Dplain-gl=enabled -Degl=enabled \
    -Dwayland=enabled -Ddrm=enabled \
    -Dvaapi=enabled -Dvaapi-drm=enabled -Dvaapi-wayland=enabled \
    -Dmanpage-build=disabled -Dhtml-build=disabled -Dpdf-build=disabled
  meson compile -C "$SRC/mpv/_build" -j "$JOBS"
  meson install -C "$SRC/mpv/_build" --quiet --strip
}

# Licence texts and a manifest of exactly what went into the build. Bundled
# into the packages and published with each release, with the sources.
collect_licenses() {
  local out="$DIST/licenses" entry name file lib
  rm -rf "$out"
  mkdir -p "$out"
  for entry in "${SOURCES[@]}"; do
    name="${entry%%|*}"
    mkdir -p "$out/$name"
    for file in COPYING COPYING.LGPLv2.1 COPYING.LIB LICENSE LICENSE.LGPL LICENSE.md LICENSE.txt \
      LICENSE-MIT LICENSE.rst Copyright.txt docs/FTL.TXT docs/LICENSE.TXT; do
      [[ -f "$SRC/$name/$file" ]] && cp "$SRC/$name/$file" "$out/$name/"
    done
  done
  {
    echo "Kiro bundles libmpv (libmpv.so.2), built from these unmodified source"
    echo "releases by apps/desktop/scripts/build-libmpv-linux.sh in the Kiro"
    echo "repository. Each component's licence text is in its folder here."
    echo "The library can be replaced with your own build of the same mpv version"
    echo "(AppImage: usr/lib/; .deb: /usr/lib/kiro/)."
    echo
    printf '%-18s %-10s %-34s %s\n' Component Version Licence Source
    for entry in "${SOURCES[@]}"; do
      IFS='|' read -r name version url sha licence <<< "$entry"
      printf '%-18s %-10s %-34s %s\n' "$name" "$version" "$licence" "$url"
      printf '%-18s %-10s %-34s sha256 %s\n' "" "" "" "$sha"
    done
    echo
    echo "It links these system libraries dynamically:"
    for lib in $(needed "$DIST/lib/libmpv.so.2"); do echo "  $lib"; done
  } > "$out/README.txt"
}

needed() { readelf -d "$1" | sed -n 's/.*(NEEDED).*\[\(.*\)\]/\1/p'; }

# Fails unless the result is LGPL, links only SYSTEM_LIBS, exports only
# mpv's API and resolves every symbol against this (oldest) system.
verify() {
  local so="$DIST/lib/libmpv.so.2" config="$SRC/mpv/_build/config.h" lib bad=0 glibc
  grep -q '^#define HAVE_GPL 0' "$config" || { echo "verify: mpv was built with GPL code" >&2; exit 1; }
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
  for feature in VAAPI VAAPI_DRM VAAPI_WAYLAND DMABUF_INTEROP_GL GL EGL WAYLAND PULSE ALSA; do
    grep -q "^#define HAVE_$feature 1" "$config" \
      || { echo "verify: mpv was built without $feature" >&2; exit 1; }
  done
  for lib in $(needed "$so"); do
    if [[ " ${SYSTEM_LIBS[*]} " != *" $lib "* ]]; then
      echo "verify: libmpv links $lib, which isn't in SYSTEM_LIBS" >&2
      bad=1
    fi
  done
  [[ "$bad" == 0 ]] || exit 1
  # (Plus the linker's own section markers.)
  if nm -D --defined-only "$so" | awk '{ print $NF }' \
    | grep -Ev '^(mpv_.*|_init|_fini|_edata|_end|__bss_start)$'; then
    echo "verify: libmpv exports symbols besides mpv's API (listed above)" >&2
    exit 1
  fi
  # Every symbol resolves against the system libraries (not the prefix's
  # build-time Wayland), e.g. nothing newer than Ubuntu 22.04's Wayland.
  if LD_LIBRARY_PATH='' ldd -r "$so" 2>&1 | grep -E 'not found|undefined symbol'; then
    echo "verify: libmpv needs symbols this system's libraries don't have (listed above)" >&2
    exit 1
  fi
  glibc="$(objdump -T "$so" | grep -o 'GLIBC_[0-9.]*' | sed 's/GLIBC_//' | sort -V | tail -n 1)"
  if [[ "$(printf '%s\n%s\n' "$glibc" "$MAX_GLIBC" | sort -V | tail -n 1)" != "$MAX_GLIBC" ]]; then
    echo "verify: libmpv needs glibc $glibc, newer than $MAX_GLIBC (build on Ubuntu 22.04)" >&2
    exit 1
  fi
  echo "==> libmpv is LGPL-2.1-or-later, needs glibc $glibc and links only:"
  needed "$so" | sed 's/^/      /'
}

for entry in "${SOURCES[@]}"; do fetch "${entry%%|*}"; done
system_pkgconfig
step zlib build_zlib
step openssl build_openssl
step expat build_expat
step dav1d build_dav1d
step freetype build_freetype
step fribidi build_fribidi
step harfbuzz build_harfbuzz
step fontconfig build_fontconfig
step libass build_libass
step ffmpeg build_ffmpeg
step libplacebo build_libplacebo
step libdisplay-info build_libdisplay_info
step wayland build_wayland
step wayland-protocols build_wayland_protocols
step mpv build_mpv
collect_licenses
verify
echo "$BUILD_ID" > "$DIST/.build-id"
