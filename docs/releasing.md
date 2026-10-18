# Releasing

- [macOS](#macos): `pnpm build:mac`, a `.dmg` with an LGPL libmpv.
- [Linux](#linux): `pnpm build:linux`, an AppImage and a `.deb` with an LGPL libmpv.
- [Windows](#windows): `pnpm build:windows`, an NSIS installer with an LGPL libmpv.

## macOS

```bash
pnpm build:mac
```

This produces `Kiro.app` and `Kiro_<version>_aarch64.dmg` in `apps/desktop/src-tauri/target/release/bundle/`, with native playback through a bundled LGPL build of libmpv. Apple Silicon only for now.

The first run compiles libmpv and its dependencies from source, which takes about 5 minutes on an M-series Mac. Later runs reuse that build (`apps/desktop/.libmpv`, git-ignored); delete the folder to rebuild from scratch.

Requirements: Xcode, Node 24 and pnpm, Rust, and `brew install meson ninja pkg-config`. Homebrew's `mpv` isn't used for releases (it's still what `pnpm dev` uses).

### What's in the bundle

| Path                                 | What                                                                                                                        |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `Contents/MacOS/kiro-desktop`        | The app. Finds libmpv through its rpath (`@executable_path/../Frameworks`).                                                 |
| `Contents/Frameworks/libmpv.2.dylib` | libmpv with FFmpeg, libplacebo, libass, FreeType, FriBidi, HarfBuzz and dav1d linked in. Links only macOS system libraries. |
| `Contents/Resources/licenses/`       | Each component's licence text, and `README.txt` listing exact versions, source URLs and checksums.                          |

### How libmpv is built

`apps/desktop/scripts/build-libmpv.sh` downloads pinned source releases, verifies their SHA-256 checksums (the same ones Homebrew verifies), and builds:

- **mpv 0.41.0** with `-Dgpl=false`, as a library only (no `mpv` player). Lua, JavaScript, Vulkan, Blu-ray, DVD, CD audio and other optional features are off. Cocoa, OpenGL, VideoToolbox interop and Core Audio are on: the same playback path as development.
- **FFmpeg 9.0.2** without `--enable-gpl`, `--enable-version3` or `--enable-nonfree`, with `--disable-autodetect` so nothing optional is picked up from the build machine. HTTPS uses macOS's TLS (Secure Transport), so there is no OpenSSL. Hardware decoding uses VideoToolbox. AV1 is decoded by dav1d, since M1 and M2 have no AV1 hardware.
- **Dependencies**, statically: libplacebo, libass (Core Text font provider, no fontconfig), FreeType, FriBidi, HarfBuzz and dav1d.

pkg-config only sees the build's own prefix, never Homebrew, and everything targets macOS 12 (`minimumSystemVersion`). The script fails unless:

- mpv's `HAVE_GPL` is 0;
- FFmpeg reports "LGPL version 2.1 or later";
- `libmpv.2.dylib` links nothing outside `/usr/lib` and `/System/Library`.

To change versions, update the `SOURCES` table, using a checksum you have verified yourself (or Homebrew's), then delete `apps/desktop/.libmpv`.

### Licensing

The bundled libmpv is **LGPL-2.1-or-later**. It is linked dynamically and can be swapped for another build of the same mpv version. Its parts are LGPL-2.1+ (mpv, FFmpeg, libplacebo, FriBidi), ISC (libass), FTL (FreeType), MIT (HarfBuzz) and BSD-2-Clause (dav1d). None of this places requirements on Kiro's own licence (MIT, see `LICENSE`). Kiro talks to libmpv through its own bindings (`src-tauri/src/media/mpv/ffi.rs`), written from mpv's ISC-licensed headers, so no LGPL code is linked statically into the app.

When distributing a build:

- **Keep `Contents/Resources/licenses/`** in the app. It's added automatically.
- **Publish the sources** alongside the release: the tarballs from `apps/desktop/.libmpv/downloads` and `build-libmpv.sh`. Attaching them to the GitHub release next to the `.dmg` is the simplest way to meet LGPL's source requirement.

This is engineering guidance, not legal advice.

### Signing and notarisation

Without credentials the app is signed **ad hoc**. It runs on the Mac that built it. On another Mac, Gatekeeper blocks it the first time: right-click the app, choose **Open**, then confirm. You may need to allow it in **System Settings → Privacy & Security**.

To ship to other people, sign with a **Developer ID Application** certificate from an Apple Developer account and notarise. Tauri does both when these are set:

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
export APPLE_ID="you@example.com"
export APPLE_PASSWORD="app-specific-password"
export APPLE_TEAM_ID="TEAMID"
pnpm build:mac
```

With a Developer ID, the app uses the hardened runtime (notarisation requires it), and Tauri signs `libmpv.2.dylib` with the same identity. Ad hoc builds turn the hardened runtime off: an ad hoc signature has no Team ID, so its library validation would refuse to load libmpv.

### Not done yet

- **Intel Macs:** build libmpv for `x86_64` (FFmpeg needs `nasm`) and combine both with `lipo`, or ship a second `.dmg`.
- **Auto-update:** Tauri's updater plugin plus a signed update feed.
- **CI:** build the release on GitHub Actions' macOS runners, with the libmpv build cached.

## Linux

```bash
pnpm build:linux
```

This produces `Kiro_<version>_amd64.AppImage` and `Kiro_<version>_amd64.deb` in `apps/desktop/src-tauri/target/release/bundle/{appimage,deb}/`, with native playback through a bundled LGPL build of libmpv and hardware decoding through VA-API. x86_64 only for now.

**Supported systems:** WebKitGTK 4.1 is the minimum, so Ubuntu 22.04 or newer, Debian 12 or newer, and current Fedora and Arch. Build on **Ubuntu 22.04**: the oldest supported base, so the packages need nothing newer than its glibc (2.35) and libraries. CI does exactly that (`.github/workflows/linux-packages.yml`) and keeps both packages as artifacts.

The first run compiles libmpv and its dependencies (`apps/desktop/scripts/build-libmpv-linux.sh`), about 15 minutes on a 4-core machine. Later runs reuse it (`apps/desktop/.libmpv`, git-ignored); delete the folder to rebuild. The distribution's `libmpv-dev` isn't used for releases (it's GPL; `pnpm dev` still uses it).

Requirements on Ubuntu 22.04: Node 24 and pnpm, Rust, meson 1.11 or newer (`pip install --user meson`; 22.04's is too old), and

```bash
sudo apt-get install build-essential nasm pkg-config ninja-build python3-pip perl file \
  libva-dev libdrm-dev libegl-dev libxkbcommon-dev libpulse-dev libasound2-dev libffi-dev \
  libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libxdo-dev libssl-dev
```

### What's in the packages

| Path                                                      | What                                                                                                                          |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `.deb`: `/usr/bin/kiro-desktop`                           | The app. Finds libmpv through its rpath (`$ORIGIN/../lib/kiro`).                                                              |
| `.deb`: `/usr/lib/kiro/libmpv.so.2`                       | libmpv, with FFmpeg, libplacebo, libass, fontconfig, FreeType, HarfBuzz, FriBidi, dav1d, OpenSSL and zlib linked in.          |
| `.deb`: `/usr/lib/Kiro/licenses/`                         | Each component's licence text, and `README.txt` listing exact versions, source URLs, checksums and the system libraries used. |
| AppImage: `usr/lib/libmpv.so.2`, `usr/lib/Kiro/licenses/` | The same, with WebKitGTK, GTK and their dependencies bundled by Tauri's AppImage tooling (linuxdeploy).                       |

The .deb depends on the distribution's WebKitGTK 4.1 and GTK 3 (added by Tauri) and on the libraries libmpv links: `libegl1`, `libva2`, `libva-drm2`, `libva-wayland2`, `libdrm2`, `libwayland-client0`, `libwayland-cursor0`, `libxkbcommon0`, `libpulse0` and `libasound2t64 | libasound2` (`src-tauri/tauri.release.linux.conf.json`).

The AppImage is self-contained except for what every desktop provides and must come from the host: glibc, OpenGL, EGL and GLES (libglvnd) and the GPU driver, X11 or Wayland, fontconfig and FreeType, ALSA, and **VA-API** (`libva2`, `libva-drm2`, `libva-wayland2`). libva is deliberately not bundled: it has to load the host's VA-API drivers, which are built against the host's libva, and an older bundled copy can't load newer drivers (`LINUXDEPLOY_EXCLUDED_LIBRARIES` in `scripts/build-linux.sh`). The AppImage is the format Tauri's updater supports on Linux.

### How libmpv is built

`apps/desktop/scripts/build-libmpv-linux.sh` mirrors the macOS script: pinned source releases with verified SHA-256 checksums (the same versions of mpv, FFmpeg, libplacebo, libass, FreeType, FriBidi, HarfBuzz and dav1d as macOS; keep them in step), built into one `libmpv.so.2`:

- **mpv 0.41.0** with `-Dgpl=false` and `-Dauto_features=disabled`, then only what Kiro uses: the OpenGL render API (`plain-gl`, EGL), VA-API (DRM and Wayland displays, dmabuf interop), Wayland, DRM, PulseAudio and ALSA. `gpl=false` also drops all of mpv's X11 code, including its X11 window output, which Kiro doesn't use (it renders into a `GtkGLArea`).
- **FFmpeg 9.0.2** without `--enable-gpl`, `--enable-version3` or `--enable-nonfree`, with `--disable-autodetect`, and with VA-API and libdrm. HTTPS uses a static **OpenSSL 3.5** (Apache-2.0, which FFmpeg allows in LGPL builds).
- **Dependencies**, statically: libplacebo, libass with **fontconfig** (and expat) for system fonts, FreeType, FriBidi, HarfBuzz, dav1d, OpenSSL, zlib and libdisplay-info (for mpv's DRM support, with an empty monitor-name table rather than hwdata's GPL-or-X11 one). Linked with `--exclude-libs,ALL`, so their symbols stay inside libmpv and can't clash with the copies GTK and WebKitGTK load.
- **Build-time only:** Wayland 1.21 (headers and `wayland-scanner`; its generated protocol code is compiled in) and wayland-protocols.

pkg-config only sees the build's own prefix and an allowed list of system packages. The script fails unless:

- mpv's `HAVE_GPL` is 0 and FFmpeg reports "LGPL version 2.1 or later";
- VA-API (DRM and Wayland), dmabuf GL interop, EGL, Wayland, PulseAudio and ALSA are all built in;
- `libmpv.so.2` links nothing but `SYSTEM_LIBS`: glibc, libstdc++ and libgcc_s, `libEGL.so.1`, `libva.so.2`, `libva-drm.so.2`, `libva-wayland.so.2`, `libdrm.so.2`, `libwayland-client.so.0`, `libwayland-cursor.so.0`, `libxkbcommon.so.0`, `libpulse.so.0` and `libasound.so.2`;
- it exports nothing but mpv's API (`mpv_*`);
- every symbol resolves against the build machine's own libraries (`ldd -r`), and it needs no glibc newer than 2.35.

### Hardware decoding

mpv runs with `hwdec=auto-safe`. The video surface passes GDK's display to mpv's render context (`MPV_RENDER_PARAM_WL_DISPLAY` or `MPV_RENDER_PARAM_X11_DISPLAY`, `src-tauri/src/media/mpv/linux.rs`):

- **Wayland:** mpv opens VA-API on the compositor connection and imports decoded frames into the GL area's EGL context as dmabufs: zero-copy `vaapi`.
- **X11:** GTK 3 draws GL areas with GLX, which can't import dmabufs, and the LGPL build has no X11 VA-API display (mpv's X11 code is GPL). mpv uses `vaapi-copy` instead, through the DRM render node (`/dev/dri/renderD128`): still hardware decoding, with a copy back to system memory.
- **No VA-API device or driver** (CI, some VMs, NVIDIA without `nvidia-vaapi-driver`): mpv falls back to software decoding. CI checks this: it plays an H.264 file and expects `hwdec` `no` with the picture intact.

The player's stats (`player_stats`, and `KIRO_SPIKE_LOG=1`) report which decoder is in use as `hwdec`. **Not yet verified on real hardware:** GitHub's runners have no GPU, so `vaapi` on Wayland and `vaapi-copy` on X11 still need checking on an Intel or AMD machine (`KIRO_SPIKE_LOG=1 kiro-desktop`, play an H.264 or HEVC stream, look for `hwdec: Some("vaapi")`).

### NVIDIA

WebKitGTK's DMA-BUF renderer passes the page to the UI process in GPU buffers allocated through GBM, in formats NVIDIA's proprietary driver doesn't provide, so the window can stay blank or white. On Linux, when NVIDIA's driver is loaded (`/proc/driver/nvidia/version` exists), Kiro sets `WEBKIT_DMABUF_RENDERER_FORCE_SHM=1` at startup (`src-tauri/src/main.rs`): the renderer stays, but passes the page through shared memory instead. That is the path WebKit takes anyway on machines without a DRM device, such as CI's, so it's the one the smoke tests cover. It costs a copy per frame, so it isn't used with other GPUs. Kiro leaves both variables alone if the user has set either.

The usual workaround, `WEBKIT_DISABLE_DMABUF_RENDERER=1` (Tauri's [Linux graphics issues](https://v2.tauri.app/develop/debug/linux-graphics/) guide), doesn't suit Kiro: WebKit's older renderer doesn't draw the page over the video area under the webview, so the player's controls disappear (seen in CI on Ubuntu 24.04). **Not yet verified on NVIDIA hardware.**

### CI

`.github/workflows/linux-packages.yml`, on pull requests and pushes to `main` that touch the desktop app:

1. **Build** on Ubuntu 22.04: libmpv (cached by the build script's hash), then `pnpm build:linux`. Uploads both packages (`kiro-linux-x86_64`) and libmpv's source tarballs, build script and licences (`libmpv-linux-sources`).
2. **Test** each package on clean `ubuntu:22.04` and `ubuntu:24.04` containers. The .deb is installed with `apt-get install ./kiro.deb` alone, and every library it links must then resolve; the AppImage gets only the host libraries listed above. With a display (Xvfb), Mesa's software GL and fonts added, `scripts/playback-smoke.mjs --app` starts the installed app with `KIRO_SMOKE_TEST_URL`: it opens the player on an H.264 copy of the test pattern (served over local http, since release builds only play http and https), pauses, and the screenshot must show the pattern through the webview, the right way up, under the controls, decoded in software after the hardware decoder probe. Each job runs it three times and all must pass, since a black video on software OpenGL used to be intermittent ([playback](playback.md), Software OpenGL). One more job runs the .deb on 24.04 with `WEBKIT_DMABUF_RENDERER_FORCE_SHM=1`, the NVIDIA setting.

There's no tagged-release workflow yet (for macOS either). When there is, it should run this build and attach the packages and `libmpv-linux-sources` to the release.

### Licensing

As on macOS: the bundled libmpv is **LGPL-2.1-or-later**, linked dynamically, and can be replaced with another build of the same mpv version. Its parts are LGPL-2.1+ (mpv, FFmpeg, libplacebo, FriBidi), ISC (libass), FTL (FreeType), MIT (HarfBuzz, fontconfig, expat, libdisplay-info, Wayland's generated code), BSD-2-Clause (dav1d), Apache-2.0 (OpenSSL) and zlib. When distributing, keep the licences folder in the package (added automatically) and publish the sources: the tarballs from `apps/desktop/.libmpv/downloads` and `build-libmpv-linux.sh` (CI's `libmpv-linux-sources` artifact).

### Next: Flatpak and Flathub

Not built yet. Flathub is where many Linux users look for apps, and Flatpak solves the library-compatibility problem differently: the app runs on a fixed runtime (GNOME 48 or later provides WebKitGTK 4.1, GTK 3 and libva) instead of the host's libraries. The work:

- A manifest (`app.kiro.desktop.yml`) on the GNOME runtime, building Kiro from source with the Rust and Node SDK extensions. Flathub builds offline, so Cargo and pnpm dependencies must be vendored with `flatpak-cargo-generator` and `flatpak-node-generator`.
- libmpv as a module in the manifest, built with the same LGPL options as `build-libmpv-linux.sh` (the runtime already has FFmpeg, but its build options aren't ours, and some runtimes' FFmpeg is GPL). The `org.freedesktop.Platform.GL` and VA-API driver extensions give the app the host's GPU drivers.
- Permissions: `--socket=wayland --socket=fallback-x11 --device=dri --socket=pulseaudio --share=network`, and AppStream metadata (`app.kiro.desktop.metainfo.xml`) with screenshots.
- Updates come from Flathub, so Tauri's updater should be off in that build.

### Not done yet

- **arm64 Linux:** the build script is x86_64 only.
- **Auto-update:** the AppImage supports Tauri's updater once the plugin and a signed update feed are added.
- **Hardware decoding on real GPUs:** see Hardware decoding above.

## Windows

```bash
pnpm build:windows
```

Run on Windows (x64). This produces `Kiro_<version>_x64-setup.exe` (about 17 MB) in `apps/desktop/src-tauri/target/release/bundle/nsis/`: a per-user NSIS installer, with native playback through a bundled LGPL build of libmpv.

The installer doesn't build libmpv itself. `libmpv-2.dll` is cross-compiled by `apps/desktop/scripts/build-libmpv-windows.sh` on Linux or macOS (WSL works too) into `apps/desktop/.libmpv-windows/dist`. Get that folder onto the Windows machine in one of two ways:

- Run the script on Linux, macOS or WSL and copy `apps/desktop/.libmpv-windows/dist` across. It takes 20 to 30 minutes the first time; later runs reuse the build (`apps/desktop/.libmpv-windows`, git-ignored).
- Download the `libmpv-windows` artifact from the [Windows workflow](../.github/workflows/windows.yml) and unpack it into `apps/desktop/.libmpv-windows/dist`.

Requirements: on the Windows machine, the usual Tauri setup (MSVC Build Tools, Rust, Node 24 and pnpm). Tauri downloads NSIS itself. To build the DLL: `meson` (1.3 or newer), `ninja`, `cmake`, `nasm`, `pkg-config`, `make` and `python3` (`brew install meson ninja cmake nasm pkg-config` on macOS; `apt install ninja-build cmake nasm pkg-config` and `pipx install meson` on Ubuntu). The compiler (llvm-mingw) is downloaded by the script.

### What's in the install

The installer puts the app in `%LOCALAPPDATA%\Kiro`:

| Path            | What                                                                                                                                                             |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Kiro.exe`      | The app. Imports `libmpv-2.dll` at load time (`raw-dylib`), from its own folder.                                                                                 |
| `libmpv-2.dll`  | libmpv with FFmpeg, libplacebo, libass, FreeType, FriBidi, HarfBuzz, dav1d, shaderc, SPIRV-Cross, libiconv and zlib linked in. Imports only Windows system DLLs. |
| `licenses\`     | Each component's licence text, and `README.txt` listing exact versions, source URLs and checksums.                                                               |
| `uninstall.exe` | Removes the app (also in **Settings → Apps**).                                                                                                                   |

The release overlay is `src-tauri/tauri.windows-release.conf.json`: the DLL and licences as resources (on Windows, Tauri's resource folder is the app's own folder), `installMode: currentUser`, and the WebView2 runtime installed by an embedded bootstrapper when it's missing.

### How libmpv is built

`build-libmpv-windows.sh` is the Windows twin of `build-libmpv.sh`. It downloads pinned source releases, verifies their SHA-256 checksums, and cross-compiles them for x86_64 Windows with [llvm-mingw](https://github.com/mstorsjo/llvm-mingw) (clang, lld, libc++ and the mingw-w64 runtime targeting the Universal C Runtime), itself a pinned, checksum-verified download.

- **mpv 0.41.0** with `-Dgpl=false`, as a library only. Video output is Direct3D 11 (`vo=gpu-next`), hardware decoding is D3D11VA (and DXVA2), and audio is WASAPI. OpenGL, Vulkan, Lua, JavaScript, Blu-ray, DVD and media keys (SMTC) are off.
- **FFmpeg 9.0.2** without `--enable-gpl`, `--enable-version3` or `--enable-nonfree`, with `--disable-autodetect`. HTTPS uses Windows' own TLS (Schannel), so there is no OpenSSL. Hardware decoding uses D3D11VA and DXVA2; AV1 without hardware support is decoded by dav1d.
- **Dependencies**, statically: libplacebo, libass (DirectWrite font provider), FreeType, FriBidi, HarfBuzz, dav1d, shaderc (with glslang and SPIRV-Tools) and SPIRV-Cross, which mpv's and libplacebo's Direct3D 11 renderers use to translate shaders to HLSL, plus libiconv (subtitle character sets) and zlib, which macOS provides but Windows doesn't. The C++ runtime (libc++) is linked in too.

The versions shared with macOS are the same releases. The script fails unless:

- mpv's `HAVE_GPL` is 0, and mpv has Direct3D 11;
- FFmpeg reports "LGPL version 2.1 or later", with D3D11VA and Schannel;
- `libmpv-2.dll` imports only Windows system DLLs (checked with `llvm-objdump` against an allowlist). Today that's `kernel32`, `user32`, `gdi32`, `ole32`, `shell32`, `secur32`, `crypt32`, `bcrypt`, `avrt` and a few more, plus the Universal C Runtime (`api-ms-win-crt-*`), which is part of Windows 10 and later. Direct3D 11 and DXGI are loaded at run time. A stray `libc++.dll`, `libwinpthread-1.dll` or FFmpeg DLL fails the build.

**Why cross-compile with llvm-mingw** rather than build in MSYS2 on Windows: the whole toolchain is one pinned, checksummed download, so a build in a year uses the same compiler as today; MSYS2 is a rolling distribution whose packages can't be pinned. It's also the toolchain mpv's own CI and most Windows mpv builds use, it runs on cheaper and much faster Linux runners (FFmpeg's configure script is slow under MSYS2), it can be run on a Mac, and the script stays a close copy of the macOS one (same `SOURCES` table, `fetch`, `step` and checks). MSVC isn't an option: FFmpeg and mpv's Windows builds target MinGW.

To change versions, update the `SOURCES` table with checksums you have verified yourself (or Homebrew's), then delete `apps/desktop/.libmpv-windows`. shaderc must be paired with the glslang, SPIRV-Tools and SPIRV-Headers revisions in its `DEPS` file. The CI cache is keyed on the script's hash, so a changed script rebuilds there.

### Licensing

The bundled libmpv is **LGPL-2.1-or-later** and linked dynamically: `libmpv-2.dll` can be swapped for another build of mpv 0.41. Besides the LGPL parts shared with macOS (mpv, FFmpeg, libplacebo, FriBidi, and libass, FreeType, HarfBuzz and dav1d under their permissive licences), the Windows DLL contains:

- libiconv (LGPL-2.1-or-later) and zlib (Zlib);
- shaderc, SPIRV-Tools and SPIRV-Cross (Apache-2.0), glslang (BSD-3-Clause, Apache-2.0 and MIT; its Bison-generated parser carries Bison's exception, so the GPL-3.0 notice on the grammar source doesn't reach the library);
- llvm-mingw's runtime: libc++ and libunwind (Apache-2.0 with LLVM exception) and mingw-w64 (ZPL and public domain).

Apache-2.0 code combined with LGPL-2.1-or-later code is distributed under the LGPL's "or later" option (LGPL-3.0), with which Apache-2.0 is compatible. That's still the LGPL, and none of it places requirements on Kiro's own licence: Kiro talks to libmpv through its own bindings (`src-tauri/src/media/mpv/ffi.rs`), so no LGPL code is linked into `Kiro.exe`.

Nothing from shinchiro's mpv-winbuild-cmake is shipped. Those builds are GPL; the Playback workflow still uses them to test development builds.

When distributing a build:

- **Keep `licenses\`** next to `Kiro.exe`. It's added automatically.
- **Publish the sources** alongside the release: the tarballs in `apps/desktop/.libmpv-windows/downloads` (except the llvm-mingw toolchain) and `build-libmpv-windows.sh`. For tags, CI collects them as the `libmpv-windows-sources` artifact.

This is engineering guidance, not legal advice.

### Signing

Without credentials the build is **unsigned**. Windows still installs and runs it, but testers see warnings:

- **SmartScreen**, when the installer is opened: "Windows protected your PC". Choose **More info**, then **Run anyway**. Browsers may also flag the download as uncommonly downloaded; keep it.
- The installer runs per user, so there's **no administrator prompt**. It installs to `%LOCALAPPDATA%\Kiro`, adds a Start menu shortcut, and, on Windows 10 without the WebView2 runtime, installs that first (this needs an internet connection).

A signed build avoids the "unknown publisher" warning. SmartScreen reputation builds up per certificate over the first downloads, so new certificates may still show a warning for a while.

`pnpm build:windows` signs `Kiro.exe`, `libmpv-2.dll`, the uninstaller and the installer when either of these is set (Tauri runs `scripts/sign-windows.mjs` for each file through `bundle.windows.signCommand`):

- **Azure Artifact Signing** (formerly Trusted Signing), the cheapest way to an OV-equivalent signature: `AZURE_ARTIFACT_SIGNING_ENDPOINT` (e.g. `https://weu.codesigning.azure.net`), `AZURE_ARTIFACT_SIGNING_ACCOUNT`, `AZURE_ARTIFACT_SIGNING_CERTIFICATE_PROFILE`, and an app registration's `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET`. Needs `artifact-signing-cli` (`cargo install artifact-signing-cli`), .NET 8 and the Windows SDK's signtool.
- **A code signing certificate** (.pfx): `WINDOWS_CERTIFICATE` (the .pfx, base64-encoded) and `WINDOWS_CERTIFICATE_PASSWORD`. Needs the Windows SDK's signtool (or set `SIGNTOOL`). Timestamps come from DigiCert unless `WINDOWS_TIMESTAMP_URL` says otherwise.

```powershell
$env:WINDOWS_CERTIFICATE = [Convert]::ToBase64String([IO.File]::ReadAllBytes('kiro.pfx'))
$env:WINDOWS_CERTIFICATE_PASSWORD = '...'
pnpm build:windows
```

In CI, add the same names as repository secrets; the workflow passes them through. Without them, CI checks the signing hook with a throwaway self-signed certificate instead.

### CI

`.github/workflows/windows.yml` runs on pushes to `main`, tags (`v*`) and pull requests touching the desktop app:

1. **libmpv-2.dll** (Ubuntu): runs `build-libmpv-windows.sh`, cached on the script's hash, and uploads `libmpv-windows` (the DLL, headers and licences). For tags it also uploads `libmpv-windows-sources`.
2. **Installer** (Windows Server 2025): `pnpm build:windows`, uploads `kiro-windows-installer`, then installs it silently, checks the installed files, starts the installed `Kiro.exe` and checks that it's running with `libmpv-2.dll` and WebView2 loaded, and has the installed DLL open an HTTPS video (Schannel). Then the Rust tests and the playback smoke test (`scripts/playback-smoke.mjs`) run against the same DLL. Screenshots are kept as `windows-checks`.

Tagged builds produce the artifacts but don't publish a GitHub release yet; attach the installer and the sources to the release by hand.

### Not done yet

- **Arm64 Windows:** llvm-mingw can target `aarch64-w64-mingw32`; the script and installer are x64 only for now.
- **Auto-update:** Tauri's updater plugin plus a signed update feed.
- **A release workflow** that publishes the macOS, Linux and Windows builds together for a tag.
