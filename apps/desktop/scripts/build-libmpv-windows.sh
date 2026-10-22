#!/usr/bin/env bash
# Builds the LGPL libmpv that ships with the Windows app: one self-contained
# `libmpv-2.dll` for x86_64 that imports only Windows system DLLs.
#
# The Windows counterpart of build-libmpv.sh. It cross-compiles from Linux or
# macOS with llvm-mingw (clang, lld, libc++ and the UCRT mingw-w64 runtime in
# one pinned, checksum-verified download), the toolchain mpv's own CI and
# most Windows mpv builds use. Everything else is compiled from pinned source
# releases (checksums verified) and linked into the DLL statically, including
# libc++. Nothing GPL or non-free is enabled:
#
# - mpv is configured with `-Dgpl=false`;
# - FFmpeg is built without `--enable-gpl`, `--enable-version3` or
#   `--enable-nonfree`, and with `--disable-autodetect`, so nothing optional
#   is picked up from the machine;
# - pkg-config only sees this build's own prefix, never the host's.
#
# Video output and hardware decoding use Direct3D 11 (vo=gpu-next, d3d11va).
# mpv's D3D11 renderer translates its shaders with shaderc and SPIRV-Cross,
# which are built here too. HTTPS uses Windows' own TLS (Schannel).
#
# The result is LGPL-2.1-or-later. The checks at the end fail the build if it
# isn't, or if the DLL imports anything that isn't part of Windows. Output:
# apps/desktop/.libmpv-windows/dist (bin/libmpv-2.dll, include/, licenses/).
# Re-running reuses finished steps; delete .libmpv-windows to start over.
#
# Requires meson (>= 1.3), ninja, cmake, nasm, pkg-config, make, python3 and
# curl. On Ubuntu: `apt install meson ninja-build cmake nasm pkg-config`; on
# macOS: `brew install meson ninja cmake nasm pkg-config`.
set -euo pipefail

for tool in meson ninja cmake nasm pkg-config make python3 curl shasum; do
  command -v "$tool" > /dev/null || { echo "build-libmpv-windows: $tool is required" >&2; exit 1; }
done

DESKTOP="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$DESKTOP/.libmpv-windows"
SRC="$ROOT/src"
TOOLCHAIN="$ROOT/llvm-mingw" # the compiler, build-time only
PREFIX="$ROOT/prefix"        # static dependencies and headers, build-time only
DIST="$ROOT/dist"            # what the app bundles
mkdir -p "$ROOT/downloads" "$SRC" "$PREFIX" "$DIST"

HOST=x86_64-w64-mingw32
# Windows 10, the oldest version Tauri's WebView2 runtime supports.
WINNT=0x0A00
case "$(uname -s)" in
  Darwin) JOBS="$(sysctl -n hw.ncpu)" ;;
  *) JOBS="$(nproc)" ;;
esac

# The toolchain, per build machine: name|version|url|sha256
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)
    LLVM_MINGW="llvm-mingw|20260922|https://github.com/mstorsjo/llvm-mingw/releases/download/20260922/llvm-mingw-20260922-ucrt-ubuntu-22.04-x86_64.tar.xz|bb7bb7654b33d5aa8712acb837c963b2e0c56352560c76105270a3268c665c21"
    ;;
  Linux-aarch64)
    LLVM_MINGW="llvm-mingw|20260922|https://github.com/mstorsjo/llvm-mingw/releases/download/20260922/llvm-mingw-20260922-ucrt-ubuntu-22.04-aarch64.tar.xz|07d21263c56bfe9a713db6fdb3f7434bf4c121a005e40397d3b4c0170fb06769"
    ;;
  Darwin-*)
    LLVM_MINGW="llvm-mingw|20260922|https://github.com/mstorsjo/llvm-mingw/releases/download/20260922/llvm-mingw-20260922-ucrt-macos-universal.tar.xz|52e5f5a7b131021d0c39a37a38fa380a1da7885cd04bd61afd0cd4ecfb8bc1f3"
    ;;
  *)
    echo "build-libmpv-windows: build on Linux (x86_64, arm64) or macOS" >&2
    exit 1
    ;;
esac

# name|version|url|sha256|licence
# The first eight match build-libmpv.sh (macOS). zlib and libiconv are part of
# macOS but not Windows; shaderc (with glslang, SPIRV-Tools and SPIRV-Headers
# at the revisions its DEPS file names) and SPIRV-Cross are needed by mpv's
# and libplacebo's Direct3D 11 renderers.
SOURCES=(
  "ffmpeg|9.0.2|https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz|8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e|LGPL-2.1-or-later"
  "mpv|0.41.0|https://github.com/mpv-player/mpv/archive/refs/tags/v0.41.0.tar.gz|ee21092a5ee427353392360929dc64645c54479aefdb5babc5cfbb5fad626209|LGPL-2.1-or-later (-Dgpl=false)"
  "libplacebo|7.360.1|https://code.videolan.org/videolan/libplacebo/-/archive/v7.360.1/libplacebo-v7.360.1.tar.bz2|937aa5eeea596798b3274d362de2e3bd32bc537a66d149dd85043349c74dffb6|LGPL-2.1-or-later"
  "libass|0.17.5|https://github.com/libass/libass/releases/download/0.17.5/libass-0.17.5.tar.xz|2dca25c0e0c837ddf00b52011b3f82cac1e4ddd3ad018227806b0c2288864acc|ISC"
  "freetype|2.15.0|https://downloads.sourceforge.net/project/freetype/freetype2/2.15.0/freetype-2.15.0.tar.xz|93cd47eb719c325107f2d3cf087d06299e944c3b48a40b55537302304dea1dd5|FTL"
  "fribidi|1.0.17|https://github.com/fribidi/fribidi/releases/download/v1.0.17/fribidi-1.0.17.tar.xz|6949dcde27d41cebad1fd741fcafc36d55a1020d2d872d4a6eb3914caabbada2|LGPL-2.1-or-later"
  "harfbuzz|14.6.0|https://github.com/harfbuzz/harfbuzz/releases/download/14.6.0/harfbuzz-14.6.0.tar.xz|d07a007327277708a2a73ae437887cdbaf282937f6d03ca5467723e9099af586|MIT"
  "dav1d|1.5.4|https://code.videolan.org/videolan/dav1d/-/archive/1.5.4/dav1d-1.5.4.tar.bz2|2abfb0c89212e6e4733a54e0ae509ec00a5b845a6360946f918806e14aedb011|BSD-2-Clause"
  "zlib|1.3.2|https://github.com/madler/zlib/releases/download/v1.3.2/zlib-1.3.2.tar.gz|bb329a0a2cd0274d05519d61c667c062e06990d72e125ee2dfa8de64f0119d16|Zlib"
  "libiconv|1.19|https://mirrors.kernel.org/gnu/libiconv/libiconv-1.19.tar.gz|88dd96a8c0464eca144fc791ae60cd31cd8ee78321e67397e25fc095c4a19aa6|LGPL-2.1-or-later (library)"
  "shaderc|2026.4|https://github.com/google/shaderc/archive/refs/tags/v2026.4.tar.gz|f06ce5bcca94e5df7f34e115743597d0ad2e13c5fe9213c67dc8c76031241947|Apache-2.0"
  "glslang|e1b562a8|https://github.com/KhronosGroup/glslang/archive/e1b562a8bed273a02f30b59b66a5d499793cede5.tar.gz|907174a24713c6202c146f164bf81783f1fbc79c8cb821a30f18f159eb980312|BSD-3-Clause, Apache-2.0, MIT (see LICENSE.txt)"
  "spirv-tools|ef96ed76|https://github.com/KhronosGroup/SPIRV-Tools/archive/ef96ed763b43b59b33b31b362f09a02b729fa1c9.tar.gz|82c62146083fd558735a3171cf97cfc47903ca7d368482e87f94bd44883c0f00|Apache-2.0"
  "spirv-headers|04fd3caa|https://github.com/KhronosGroup/SPIRV-Headers/archive/04fd3caa1e8267e4d95c806cad901181728e1006.tar.gz|392f4801409aad9c4f1b77745f179952fd6264e4c8bd0fc1bc45dfa6807bf6d0|MIT (headers)"
  "spirv-cross|1.4.363.0|https://github.com/KhronosGroup/SPIRV-Cross/archive/refs/tags/vulkan-sdk-1.4.363.0.tar.gz|f708982e88b763ef5b0394ed468fc2c3628f68cdab89f2e7a946cd628c04e721|Apache-2.0"
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
  for entry in "$LLVM_MINGW" "${SOURCES[@]}"; do
    [[ "${entry%%|*}" == "$1" ]] && { cut -d'|' -f"$2" <<< "$entry"; return; }
  done
  return 1
}

# Downloads, verifies and unpacks a source into <dir>/<name> ($SRC by default).
fetch() {
  local name="$1" dir="${2:-$SRC}" url sha archive
  url="$(field "$name" 3)"
  sha="$(field "$name" 4)"
  archive="$ROOT/downloads/$name-$(field "$name" 2).${url##*.}"
  [[ -d "$dir/$name" ]] && return
  if [[ ! -f "$archive" ]]; then
    echo "==> downloading $name"
    curl -fsSL --retry 3 -o "$archive.part" "$url"
    mv "$archive.part" "$archive"
  fi
  echo "$sha  $archive" | shasum -a 256 -c --quiet - || {
    echo "build-libmpv-windows: checksum mismatch for $name" >&2
    rm -f "$archive"
    exit 1
  }
  mkdir -p "$dir/$name.part"
  tar -xf "$archive" -C "$dir/$name.part" --strip-components 1
  mv "$dir/$name.part" "$dir/$name"
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

fetch llvm-mingw "$ROOT"
export PATH="$TOOLCHAIN/bin:$PATH"
CC="$HOST-clang"
CXX="$HOST-clang++"
CFLAGS="-O2 -D_WIN32_WINNT=$WINNT -I$PREFIX/include"
LDFLAGS="-L$PREFIX/lib"
export PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig"
export PKG_CONFIG_PATH=""

# Meson and CMake cross files.
cat > "$ROOT/cross.meson" << EOF
[binaries]
c = '$TOOLCHAIN/bin/$CC'
cpp = '$TOOLCHAIN/bin/$CXX'
ar = '$TOOLCHAIN/bin/llvm-ar'
strip = '$TOOLCHAIN/bin/llvm-strip'
windres = '$TOOLCHAIN/bin/$HOST-windres'
pkg-config = '$(command -v pkg-config)'

[properties]
pkg_config_libdir = ['$PREFIX/lib/pkgconfig']

[built-in options]
c_args = ['-O2', '-D_WIN32_WINNT=$WINNT', '-I$PREFIX/include']
cpp_args = ['-O2', '-D_WIN32_WINNT=$WINNT', '-I$PREFIX/include']
c_link_args = ['-L$PREFIX/lib']
cpp_link_args = ['-L$PREFIX/lib']

[host_machine]
system = 'windows'
cpu_family = 'x86_64'
cpu = 'x86_64'
endian = 'little'
EOF
cat > "$ROOT/cross.cmake" << EOF
set(CMAKE_SYSTEM_NAME Windows)
set(CMAKE_SYSTEM_PROCESSOR x86_64)
set(CMAKE_C_COMPILER $TOOLCHAIN/bin/$CC)
set(CMAKE_CXX_COMPILER $TOOLCHAIN/bin/$CXX)
set(CMAKE_RC_COMPILER $TOOLCHAIN/bin/$HOST-windres)
set(CMAKE_AR $TOOLCHAIN/bin/llvm-ar)
set(CMAKE_RANLIB $TOOLCHAIN/bin/llvm-ranlib)
set(CMAKE_FIND_ROOT_PATH $PREFIX $TOOLCHAIN/$HOST)
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)
EOF

meson_build() { # meson_build <name> [options...]
  local name="$1"
  shift
  rm -rf "$SRC/$name/_build"
  meson setup "$SRC/$name/_build" "$SRC/$name" --cross-file "$ROOT/cross.meson" \
    --prefix="$PREFIX" --libdir=lib --buildtype=release \
    -Ddefault_library=static -Dprefer_static=true -Db_ndebug=true "$@"
  meson compile -C "$SRC/$name/_build" -j "$JOBS"
  meson install -C "$SRC/$name/_build" --quiet
}

cmake_build() { # cmake_build <name> [options...]
  local name="$1"
  shift
  rm -rf "$SRC/$name/_build"
  cmake -S "$SRC/$name" -B "$SRC/$name/_build" -G Ninja \
    -DCMAKE_TOOLCHAIN_FILE="$ROOT/cross.cmake" -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX="$PREFIX" -DCMAKE_INSTALL_LIBDIR=lib \
    -DBUILD_SHARED_LIBS=OFF -DCMAKE_C_FLAGS="-D_WIN32_WINNT=$WINNT" \
    -DCMAKE_CXX_FLAGS="-D_WIN32_WINNT=$WINNT" "$@"
  cmake --build "$SRC/$name/_build" -j "$JOBS"
  cmake --install "$SRC/$name/_build"
}

build_zlib() {
  make -C "$SRC/zlib" -f win32/Makefile.gcc -j "$JOBS" libz.a \
    CC="$CC" AR=llvm-ar RC="$HOST-windres" CFLAGS="$CFLAGS"
  install -d "$PREFIX/include" "$PREFIX/lib"
  install -m 644 "$SRC/zlib/zlib.h" "$SRC/zlib/zconf.h" "$PREFIX/include/"
  install -m 644 "$SRC/zlib/libz.a" "$PREFIX/lib/"
}

build_libiconv() {
  (
    cd "$SRC/libiconv"
    ./configure --host="$HOST" --prefix="$PREFIX" --enable-static --disable-shared \
      --disable-nls CC="$CC" AR=llvm-ar RANLIB=llvm-ranlib CFLAGS="$CFLAGS"
    # The library and its header only, not the iconv program.
    make lib/localcharset.h
    make -j "$JOBS" -C lib
    make -C lib install-lib libdir="$PREFIX/lib" includedir="$PREFIX/include"
    install -m 644 include/iconv.h.inst "$PREFIX/include/iconv.h"
  )
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
  meson_build harfbuzz -Dfreetype=enabled -Dgdi=disabled -Ddirectwrite=disabled \
    -Dglib=disabled -Dgobject=disabled -Dcairo=disabled -Dicu=disabled -Dchafa=disabled \
    -Dtests=disabled -Ddocs=disabled -Dutilities=disabled -Dintrospection=disabled
}

build_libass() {
  meson_build libass -Dfontconfig=disabled -Ddirectwrite=enabled -Dcoretext=disabled \
    -Dlibunibreak=disabled -Dtest=disabled -Dprofile=disabled -Dfuzz=disabled \
    -Dcheckasm=disabled
}

# shaderc with glslang and SPIRV-Tools, as one static library
# (libshaderc_combined.a). mpv and libplacebo look for `shaderc`.
build_shaderc() {
  local third="$SRC/shaderc/third_party"
  rm -rf "$third/glslang" "$third/spirv-tools" "$third/spirv-headers"
  cp -R "$SRC/glslang" "$third/glslang"
  cp -R "$SRC/spirv-tools" "$third/spirv-tools"
  cp -R "$SRC/spirv-headers" "$third/spirv-headers"
  cmake_build shaderc -DSHADERC_SKIP_TESTS=ON -DSHADERC_SKIP_EXAMPLES=ON \
    -DSHADERC_SKIP_COPYRIGHT_CHECK=ON -DSHADERC_SKIP_INSTALL=OFF \
    -DENABLE_GLSLANG_BINARIES=OFF -DSPIRV_SKIP_EXECUTABLES=ON -DSPIRV_SKIP_TESTS=ON \
    -DSPIRV_TOOLS_BUILD_STATIC=ON -DSPIRV_WERROR=OFF -DENABLE_OPT=ON
  cp "$PREFIX/lib/pkgconfig/shaderc_combined.pc" "$PREFIX/lib/pkgconfig/shaderc.pc"
  # The static C++ libraries need libc++ when linked into C code.
  sed -i.orig 's/^Libs: \(.*\)$/Libs: \1 -lc++/' "$PREFIX/lib/pkgconfig/shaderc.pc"
  rm "$PREFIX/lib/pkgconfig/shaderc.pc.orig"
}

# SPIRV-Cross's C API, static. mpv and libplacebo look for
# `spirv-cross-c-shared`, so that name points at the static library.
build_spirv_cross() {
  cmake_build spirv-cross -DSPIRV_CROSS_SHARED=OFF -DSPIRV_CROSS_STATIC=ON \
    -DSPIRV_CROSS_CLI=OFF -DSPIRV_CROSS_ENABLE_TESTS=OFF -DSPIRV_CROSS_ENABLE_C_API=ON \
    -DSPIRV_CROSS_ENABLE_GLSL=ON -DSPIRV_CROSS_ENABLE_HLSL=ON \
    -DSPIRV_CROSS_ENABLE_MSL=OFF -DSPIRV_CROSS_ENABLE_CPP=OFF \
    -DSPIRV_CROSS_ENABLE_REFLECT=OFF -DSPIRV_CROSS_ENABLE_UTIL=OFF
  local pc="$PREFIX/lib/pkgconfig"
  sed -e 's/^Libs: .*$/Libs: -L${libdir} -lspirv-cross-c -lspirv-cross-hlsl -lspirv-cross-glsl -lspirv-cross-core -lc++/' \
    "$pc/spirv-cross-c.pc" > "$pc/spirv-cross-c-shared.pc"
}

build_ffmpeg() {
  (
    cd "$SRC/ffmpeg"
    ./configure \
      --prefix="$PREFIX" \
      --enable-cross-compile --target-os=mingw32 --arch=x86_64 \
      --cross-prefix="$HOST-" --cc="$CC" --cxx="$CXX" \
      --ar=llvm-ar --ranlib=llvm-ranlib --nm=llvm-nm --strip=llvm-strip \
      --pkg-config=pkg-config --pkg-config-flags=--static \
      --extra-cflags="$CFLAGS" \
      --extra-ldflags="$LDFLAGS" \
      --enable-static --disable-shared \
      --disable-autodetect \
      --disable-programs --disable-doc --disable-debug \
      --disable-encoders --disable-muxers --disable-indevs --disable-outdevs \
      --enable-indev=lavfi \
      --enable-muxer=spdif \
      --enable-encoder=mjpeg \
      --disable-filter=gfxcapture,ddagrab \
      --enable-w32threads \
      --enable-zlib --enable-iconv \
      --enable-d3d11va --enable-dxva2 --enable-schannel \
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
  meson_build libplacebo -Dvulkan=disabled -Dopengl=disabled -Dd3d11=enabled \
    -Dshaderc=enabled -Dglslang=disabled -Dlcms=disabled -Ddovi=enabled \
    -Dlibdovi=disabled -Dunwind=disabled -Dxxhash=disabled \
    -Ddemos=false -Dtests=false -Dbench=false -Dfuzz=false
}

build_mpv() {
  rm -rf "$SRC/mpv/_build"
  # `-static`: the C++ runtime (libc++, libunwind) and winpthreads are linked
  # into the DLL rather than imported from DLLs Windows doesn't have.
  # `-liconv`: meson's iconv lookup only finds libiconv when it's linked by
  # default (lld doesn't mind where it appears).
  local link="['-L$PREFIX/lib', '-liconv', '-static']"
  meson setup "$SRC/mpv/_build" "$SRC/mpv" --cross-file "$ROOT/cross.meson" \
    --prefix="$DIST" --libdir=lib --buildtype=release \
    -Ddefault_library=shared -Dprefer_static=true -Db_ndebug=true \
    -Dc_link_args="$link" -Dcpp_link_args="$link" \
    -Dgpl=false -Dlibmpv=true -Dcplayer=false -Dbuild-date=false \
    -Dlua=disabled -Djavascript=disabled -Dlibarchive=disabled -Duchardet=disabled \
    -Dlibbluray=disabled -Ddvdnav=disabled -Dcdda=disabled -Drubberband=disabled \
    -Dzimg=disabled -Dlcms2=disabled -Dvapoursynth=disabled -Djpeg=disabled \
    -Dsdl2-audio=disabled -Dsdl2-video=disabled -Dsdl2-gamepad=disabled \
    -Diconv=enabled -Dwin32-threads=enabled -Dwin32-smtc=disabled \
    -Dd3d11=enabled -Dshaderc=enabled -Dspirv-cross=enabled \
    -Dd3d-hwaccel=enabled -Dd3d9-hwaccel=enabled -Dwasapi=enabled \
    -Dvulkan=disabled -Dgl=disabled -Ddirect3d=disabled -Degl-angle=disabled \
    -Dmanpage-build=disabled -Dhtml-build=disabled -Dpdf-build=disabled
  meson compile -C "$SRC/mpv/_build" -j "$JOBS"
  meson install -C "$SRC/mpv/_build" --quiet --strip
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
    for file in COPYING COPYING.LIB COPYING.LGPLv2.1 LICENSE LICENSE.LGPL LICENSE.md \
      LICENSE.txt LICENSE-MIT LICENSE.rst Copyright.txt docs/FTL.TXT docs/LICENSE.TXT; do
      [[ -f "$SRC/$name/$file" ]] && cp "$SRC/$name/$file" "$out/$name/"
    done
  done
  mkdir -p "$out/llvm-mingw"
  for file in LICENSE.TXT; do
    [[ -f "$TOOLCHAIN/$file" ]] && cp "$TOOLCHAIN/$file" "$out/llvm-mingw/"
  done
  {
    echo "Kiro bundles libmpv (libmpv-2.dll, next to Kiro.exe), built from these"
    echo "unmodified source releases by apps/desktop/scripts/build-libmpv-windows.sh"
    echo "in the Kiro repository. Each component's licence text is in its folder"
    echo "here. The library can be replaced with your own build of the same mpv"
    echo "version. It was compiled with llvm-mingw, whose C++ runtime (libc++,"
    echo "libunwind; Apache-2.0 WITH LLVM-exception) and mingw-w64 runtime are"
    echo "linked in."
    echo
    printf '%-14s %-10s %-34s %s\n' Component Version Licence Source
    for entry in "$LLVM_MINGW" "${SOURCES[@]}"; do
      IFS='|' read -r name version url sha licence <<< "$entry"
      [[ "$name" == llvm-mingw ]] && licence="Apache-2.0 WITH LLVM-exception"
      printf '%-14s %-10s %-34s %s\n' "$name" "$version" "$licence" "$url"
      printf '%-14s %-10s %-34s sha256 %s\n' "" "" "" "$sha"
    done
  } > "$out/README.txt"
}

# Fails unless the result is LGPL and imports only Windows system DLLs.
verify() {
  local dll="$DIST/bin/libmpv-2.dll" config="$SRC/mpv/_build/config.h" imports
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
  grep -q '^#define HAVE_D3D11 1' "$config" || { echo "verify: mpv was built without D3D11" >&2; exit 1; }
  grep -q '^#define CONFIG_D3D11VA 1' "$SRC/ffmpeg/config.h" \
    || { echo "verify: FFmpeg was built without d3d11va" >&2; exit 1; }
  grep -q '^#define CONFIG_SCHANNEL 1' "$SRC/ffmpeg/config.h" \
    || { echo "verify: FFmpeg was built without Schannel" >&2; exit 1; }
  imports="$(llvm-objdump -p "$dll" | sed -n 's/^ *DLL Name: *//p' | tr '[:upper:]' '[:lower:]' | sort -u)"
  [[ -n "$imports" ]] || { echo "verify: could not read the DLL's imports" >&2; exit 1; }
  echo "$imports" | sed 's/^/    imports /'
  # Windows 10's own DLLs. api-ms-win-crt-* is the Universal C Runtime, part of
  # Windows since Windows 10.
  if echo "$imports" | grep -Ev '^(api-ms-win-(crt|core)-[a-z0-9-]+\.dll|advapi32|avrt|bcrypt|comctl32|comdlg32|crypt32|d3d11|d3d9|dwmapi|dwrite|dxgi|gdi32|imm32|kernel32|ncrypt|ntdll|ole32|oleaut32|powrprof|propsys|secur32|setupapi|shcore|shell32|shlwapi|ucrtbase|user32|userenv|uxtheme|version|winmm|ws2_32)(\.dll)?$'; then
    echo "verify: libmpv-2.dll imports DLLs that aren't part of Windows (listed above)" >&2
    exit 1
  fi
  echo "==> libmpv is LGPL-2.1-or-later and self-contained: $dll"
}

for entry in "${SOURCES[@]}"; do fetch "${entry%%|*}"; done
step zlib build_zlib
step libiconv build_libiconv
step dav1d build_dav1d
step freetype build_freetype
step fribidi build_fribidi
step harfbuzz build_harfbuzz
step libass build_libass
step shaderc build_shaderc
step spirv-cross build_spirv_cross
step ffmpeg build_ffmpeg
step libplacebo build_libplacebo
step mpv build_mpv
collect_licenses
verify
