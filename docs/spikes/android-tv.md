# Spike: Kiro on Android TV

**Status:** works on the Android TV emulator (proof of concept) · **Branch:** `claude/android-tv-spike` · **Date:** 2026-10-23

## Verdict

Kiro can run on Android TV as the same Tauri app, with little Android-only code.

- **App shell:** the whole Rust core (addons, library and SQLite, settings, profiles, Stremio import) compiled for Android unchanged. Only TLS needed Android-specific setup (a few lines). The React UI runs unchanged in Android's WebView, and Kiro's existing keyboard and remote navigation drives it with the D-pad.
- **Playback:** a Media3 (ExoPlayer) player behind the same `player_*` commands as libmpv played a direct https MP4, an HLS stream and a multi-track MKV, with embedded subtitles, track switching and seeking. Kiro's own player page and controls were drawn over the video, and the remote's keys worked.
- **Not tested:** real TV hardware. Everything below was measured on the emulator. Hardware decoding of HEVC/AV1, HDR, audio passthrough and performance on a cheap box can only be checked on a device.

**Recommendation:** build the Android TV app as an Android target of `apps/desktop`, and play video with **Media3 through a small Kotlin plugin** behind the existing player commands. Don't port libmpv first. Then make a sideloaded, signed APK the first release. This is roughly 3 to 5 weeks of work to a first beta, plus device testing (see [Estimate](#estimate)).

## What the proof of concept does

On the emulator (Android TV 16, API 36, arm64, 1920×1080):

1. **Launch:** Kiro installs and starts from the TV launcher, with a launcher banner.
2. **First run:** the first-run page opens, and Back closes it.
3. **Discover:** Discover loads Cinemeta's catalogues over https.
4. **Navigation:** the D-pad moves focus through the sidebar, the hero and the rows. OK opens a title. Back returns to Discover with focus on the same item. Back on Discover leaves the app.
5. **Playback:** the player page opens a stream:
   - 1080p H.264 MP4 (test-videos.co.uk);
   - HLS (test-streams.mux.dev, five variants);
   - Matroska test file 5 (H.264, two AAC tracks, eight SRT subtitle tracks).
6. **Player controls:** Play/Pause and ← → (seek ±10 s) work on the remote. ↓ reaches the controls, and OK on Pause pauses. Switching audio to the commentary track and subtitles to German worked. Embedded subtitles show between the video and Kiro's controls.

Screenshots of these steps were taken during the spike. They are not committed.

### Changes on the branch

| Where                                                     | What                                                                                                                                                                               |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src-tauri/tauri.android.conf.json`                       | Identifier `app.kiro.tv`, so nothing collides with the desktop app. Adds the `android` capability.                                                                                 |
| `src-tauri/capabilities/android.json`                     | Android only: the back-button listener and `exit`.                                                                                                                                 |
| `src-tauri/src/android.rs`, `core/lifecycle.rs`           | Hands the JVM to `rustls-platform-verifier` at startup. Without it, the first https request fails.                                                                                 |
| `src-tauri/src/commands/player_android.rs`                | The `player_*` commands on Android, forwarded to Kotlin. Same names and arguments as libmpv's, so `NativePlayer` and the player page are unchanged.                                |
| `src-tauri/src/lib.rs`, `commands/app.rs`                 | Registers them on Android and reports `nativePlayer: true` there.                                                                                                                  |
| `src-tauri/gen/android/`                                  | The Android Studio project from `tauri android init`, plus `PlayerPlugin.kt`, the banner, a manifest that doesn't require a touchscreen, and the Media3 and verifier dependencies. |
| `src/features/remote/android-back.ts`                     | Turns the remote's Back into Kiro's own Back (see [Remote control](#3-remote-control)).                                                                                            |
| `remote-navigation.ts`, `track-menu.tsx`, `first-run.tsx` | Back at home reports itself as unhandled. The track menu claims Back. First run doesn't focus the link field on a TV.                                                              |

Desktop is unaffected: all renderer tests (436), Rust tests (241) and clippy, with and without `libmpv`, pass.

## 1. App shell

`tauri android init` and `tauri android build` worked first time. The first cold build took about 6 minutes (Rust took 1 min 20 s). Incremental builds take under 30 s.

**Why little breaks:** the desktop-only code is already behind `cfg`.

- `native_player` is set only for macOS, Windows and Linux.
- `main.rs`'s fixes are per-OS.
- `lib.rs` already has `#[cfg_attr(mobile, tauri::mobile_entry_point)]`.
- `Cargo.toml` already builds a `cdylib`.

These needed attention:

- **TLS:** reqwest 0.13 verifies certificates with `rustls-platform-verifier`, which on Android calls the system trust manager through the JVM. It needs two things:
  - a call to `init_with_env` before the first request;
  - its Kotlin half, `org.rustls:rustls-platform-verifier`, from the rustls project's Maven archive.

  Both are on the branch. The Gradle version must match `rustls-platform-verifier-android` in `Cargo.lock`. Their README has a Gradle snippet that reads it from the lock file. Use that before this ships.

- **Updater:** `tauri-plugin-updater` builds, but its `install` does nothing on mobile (`updater.rs`: `#[cfg(mobile)] fn install_inner … Ok(())`). Its check would find no `android-*` entry in the feed. See [Distribution](#5-distribution).
- **`open_in_browser`:** `updates.rs` runs `xdg-open`, which doesn't exist on Android. It needs an `ACTION_VIEW` intent, though most TVs have no browser.
- **Desktop features that do nothing on Android:**
  - Window fullscreen: the TV app is always full screen, so hide the button.
  - Discord presence: the command is a no-op.
  - Keep-awake: the player's `SurfaceView.keepScreenOn` does it instead.
- **WebView:** the emulator's WebView is Chromium 143. Kiro's CSS (Tailwind 4) needs Chrome 111 or later. Most Android TV and Google TV devices update their WebView through the Play Store. Fire TV ships Amazon's own Chromium-based WebView with Fire OS, so its version has to be checked on a device. This is the main risk for old boxes.
- **Emulator:** this Mac is Apple Silicon, so the spike used the arm64 Android TV image. The x86_64 image the brief mentions runs on Intel Macs and on Linux CI with KVM.
- **ABIs:** many popular TV sticks ship a 32-bit (armeabi-v7a) userland on 64-bit chips. Ship both `armv7` and `aarch64`. The release build below covers both.

## 2. Playback

Measured: the three streams above, through Media3 1.11.1 on the emulator (software "goldfish" decoders). Everything else in this table comes from the libraries' documentation and source, not from this spike.

|                                              | **Media3 / ExoPlayer** (Kotlin plugin, `SurfaceView` under the WebView)                                                                                                       | **libmpv** (as in mpv-android)                                                                                                                                                                       | **WebView `<video>`**                                                             |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| MKV / MP4 / HLS                              | **All three played** (MKV via Media3's Matroska extractor)                                                                                                                    | All three                                                                                                                                                                                            | MP4 and WebM. **No MKV:** `canPlayType('video/x-matroska')` is `""`. HLS "maybe". |
| H.264 / HEVC / AV1 hardware decoding         | MediaCodec, the device's decoders. Software AV1 through Media3's libgav1 extension.                                                                                           | `hwdec=mediacodec`. Zero-copy needs `vo=mediacodec_embed`, which can't draw subtitles or an OSD (mpv issue #14176). Otherwise copy-back or `vo=gpu`, which is heavy on weak GPUs.                    | MediaCodec through Chromium. `canPlayType` says yes to HEVC and AV1 here.         |
| HDR                                          | HDR10/HLG (and Dolby Vision where the device decodes it) straight to the display through `SurfaceView`. The refresh rate follows the video (`Surface.setFrameRate`, API 30+). | No sign that mpv sets the display's HDR mode on Android. Expect tone-mapping to SDR, as on the desktop today.                                                                                        | Not controllable.                                                                 |
| Passthrough (AC-3, E-AC-3, DTS over HDMI)    | `DefaultAudioSink` sends AC-3, E-AC-3 (with Atmos/JOC), DTS, DTS-HD and TrueHD as the HDMI sink advertises them. Kiro's passthrough setting decides whether it may.           | `ao_audiotrack` wraps every spdif format as `ENCODING_IEC61937` (mpv 0.41 source, `ao_audiotrack.c:660`), so Kiro's existing `audio-spdif` logic would carry over.                                   | **None:** `canPlayType` is `""` for `ac-3`, `ec-3` and `dtsc`.                    |
| Decoding AC-3/DTS/TrueHD without passthrough | Only where the device has the decoder. Otherwise Media3's FFmpeg audio extension, which Kiro would build LGPL like the desktop libmpv.                                        | Built in (FFmpeg).                                                                                                                                                                                   | No.                                                                               |
| Embedded subtitles                           | SRT shown (MKV test 5). PGS, VobSub, WebVTT and TTML are supported. **ASS/SSA only basically:** no full styling or karaoke.                                                   | Full ASS via libass, as on the desktop.                                                                                                                                                              | None from MKV.                                                                    |
| External subtitles                           | `SubtitleConfiguration` on the media item: adding one means rebuilding the item. Not done in the spike.                                                                       | `sub-add`, as today.                                                                                                                                                                                 | `<track>` (WebVTT).                                                               |
| Seeking                                      | Worked (MP4, HLS, MKV with Cues).                                                                                                                                             | Works.                                                                                                                                                                                               | Works.                                                                            |
| Seek previews                                | Needs a second player or `MediaMetadataRetriever`.                                                                                                                            | Kiro's existing preview core (`preview.rs`) could be reused.                                                                                                                                         | No.                                                                               |
| Cost                                         | Apache 2.0. Size: see [Distribution](#5-distribution). Maintained by Google for TV.                                                                                           | LGPL build of mpv, FFmpeg and libplacebo for two ABIs with the NDK (new scripts like `build-libmpv*.sh`). Roughly 25 to 40 MB per ABI (an estimate from the 43 MB Windows DLL). JNI for the surface. | Nothing.                                                                          |

**Recommendation: Media3.** It is what TV hardware is built and certified for:

- hardware decoding straight to the display;
- HDR mode switching and frame-rate matching;
- passthrough that follows what the TV or receiver advertises.

It is also small, and Apache-licensed.

The cost is a second playback engine beside libmpv. It falls short in two places:

- **ASS styling:** only basic.
- **Some audio codecs:** devices without an AC-3, DTS or TrueHD decoder can't play those tracks unless passthrough is on. Media3's LGPL FFmpeg audio extension fixes that, and should be in the first beta.

Keep libmpv on Android as a possible later fallback for files Media3 refuses, the way the desktop falls back between streams. It shouldn't be the starting point. `<video>` is ruled out: no MKV and no surround codecs.

Kiro features that need Android work in the player plugin:

- external subtitles and subtitle style;
- audio and subtitle delay: Media3 has no subtitle delay. It would mean offsetting cue times.
- stats, chapters, seek previews and Up next (the event model already supports them);
- HLS links without `.m3u8` in the URL. Media3 guesses the type from the extension. Kiro would have to tell it, from the response's `Content-Type`.

## 3. Remote control

Measured on the emulator with `adb shell input keyevent`, and a `keydown` listener in the page:

| Remote                       | What the page gets                                          | Kiro today                                                                                                                                  |
| ---------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| D-pad                        | `ArrowUp/Down/Left/Right` (`code` is empty, `key` is right) | Works: Kiro reads `key`.                                                                                                                    |
| OK (DPAD_CENTER)             | `Enter`                                                     | Works, except in the player with nothing focused: there OK does nothing (a desktop choice). On a TV, OK should show the controls, or pause. |
| Back                         | **Nothing:** Android handles it                             | Without the fix, Back went straight back to the TV launcher.                                                                                |
| Menu                         | **Nothing**                                                 | Kiro's card menu (`ContextMenu` key) is unreachable. Long-press OK is the TV convention.                                                    |
| Play/Pause, FF, Rewind       | `MediaPlayPause`, `MediaFastForward`, `MediaRewind`         | Work in the player.                                                                                                                         |
| Info, colour buttons, Search | `Info`, `ColorF0Red`, `BrowserSearch`                       | Unused. Search could open search.                                                                                                           |

**Back:** Tauri's `AppPlugin` steps back through the webview's history, then leaves the app, unless the page listens with `onBackButtonPress`. That skips Kiro's own Back: closing menus, the player's Back, and returning focus.

`android-back.ts` listens and sends the page an `Escape`, which every menu, dialog and page already takes as Back. If nothing takes it (`defaultPrevented` stays false), Back was pressed on the home page, and the app exits.

Two consequences:

- `goBack` reports when there is nothing to go back to.
- The player's track menu now calls `preventDefault()`. Before, Back in that menu would have left the app.

**Text fields:** on a TV, focusing a text field hands the D-pad to the on-screen keyboard (the keys arrive as `Unidentified`, 229). First run used to focus its link field, so the D-pad seemed dead. It no longer does on Android. Search has the same pattern.

## 4. TV specifics

- **Launcher:** Tauri's template already has `LEANBACK_LAUNCHER` and `android.software.leanback required="false"`. The branch adds:
  - `android.hardware.touchscreen required="false"`, which Google TV and the Play Store need;
  - a 320×180 `android:banner` (`drawable-xhdpi/banner.png`), made from `app-icon.png`.
- **Scale:** at 1080p the TV runs at 320 dpi, so the page is **960×540 CSS px at devicePixelRatio 2**. 4K Android TV devices also lay out at 960×540 dp. The emulator's framebuffer stays 1080p, so this wasn't measured. The layout is the same on both, and text is crisp at 4K.
  - At 960×540, Kiro's desktop layout mostly fits. Its minimum window is 960×600, though, so 540 px of height is new.
  - Screenshots show the header search over the hero's logo, and "Customise" over "See all" on Discover.
  - A TV layout pass is needed: no sidebar collapse button, no "Ctrl K", bigger focus rings.
- **Overscan:** Android TV's guidelines keep content 48 dp from the sides and 27 dp from the top and bottom. Kiro's sidebar and header sit about 16 to 32 px from the edges. That is one CSS change for Android (padding on the app frame).
- **Performance:** memory on the emulator:
  - release build, at rest on Discover: Kiro's process 118 MB PSS (252 MB RSS), the WebView renderer 216 MB RSS;
  - debug build, playing 1080p H.264: Kiro's process 223 MB PSS (362 MB RSS), the WebView renderer about 200 MB RSS.

  Cheap boxes have 1 to 2 GB of RAM, so this needs measuring during playback on a 1 GB device. Animations, blur and big artwork are the levers. Nothing on the emulator was slow, but the emulator runs on an M1.

## 5. Distribution

- **APK size (measured):** the release APK is **11.4 MB for arm64-v8a and 9.0 MB for armv7**, Media3 included. Media3, Tauri and the rest of the Kotlin and Java code come to 2.6 MB of dex after R8. Kiro's Rust library is 9.1 MB (arm64) and 6.8 MB (armv7).
  - The signed release build was installed on the emulator. It ran, and loaded Discover over https.
  - Shrinking with R8 removed `rustls-platform-verifier`'s Kotlin classes, which are only called from JNI. The branch keeps them with a ProGuard rule (`app/proguard-rules.pro`).
  - Playback wasn't tried in the release build: without DevTools there was no way to open a stream with no stream addon installed.
- **Sideload first:** publish per-ABI APKs (armeabi-v7a, arm64-v8a) on GitHub Releases. TV users install them with a Downloader-style app from a short link. On Android 8 and later, the installer asks for "install unknown apps" permission once.
- **Signing:** release APKs need a keystore. Every later update must be signed with the same key, or users have to uninstall, and they lose their data.
  - Create it once and keep it like the updater key, as CI secrets.
  - Use apksigner v2 and v3 signing.
  - The debug key is only for development.
- **Self-update:** the Tauri updater can't install on Android. Kiro would do it itself:
  1. Check the same feed, with new `android-armv7` and `android-aarch64` entries.
  2. Download the APK and verify its minisign signature in Rust. `minisign-verify` is already in the tree, through the updater.
  3. Hand the APK to `PackageInstaller`. This needs `REQUEST_INSTALL_PACKAGES`, and the user confirms each install.

  It's a few days' work. Until then, the app can show "a new version is available" with the short link.

- **Play Store (notes only):**
  - an AAB instead of APKs;
  - the yearly target-API rule;
  - the TV quality checklist: banner, D-pad everywhere, no touch;
  - no self-updating: `REQUEST_INSTALL_PACKAGES` isn't allowed for this.

  Google reviews apps that play third-party content closely, and an addon-based player may be refused. Sideloading avoids all of this.

## 6. Code sharing and repository structure

**Shared as is:**

- **Rust core:** all of it (addons, library and SQLite, settings, profiles, skip times, Stremio import, updates' feed logic).
- **React UI:** all of it, including the player page and remote navigation.
- **Player model:** the `PlayerEvent` and `PlayerSnapshot` shapes, which Kotlin now speaks.

**Android-only:**

- the Kotlin player plugin;
- the TLS initialisation;
- the Back adapter;
- the self-updater;
- a TV layout layer: CSS for 960×540, overscan, focus;
- the Gradle project.

**Proposed structure:** keep one app.

- Build Android from `apps/desktop` (its `src-tauri` already is the mobile library), and commit `src-tauri/gen/android`.
- Move the Kotlin player into an in-repo Tauri plugin crate, for example `packages/tauri-plugin-kiro-player` with an `android/` folder. Re-running `tauri android init` then can't clobber it, and the plugin gets its own Gradle dependencies.
- Rename `apps/desktop` to `apps/app` later, if the name starts to mislead.

A separate `apps/tv` would mean duplicating `src-tauri`, or splitting the core into a shared crate first. That is a large refactor with no benefit at this size.

**Decisions for you:**

- the Android application ID: `app.kiro.tv` on the branch, which is permanent once released;
- whether the same APK should also be offered for phones and tablets (more layout work).

## Risks

1. **No real device yet.** Hardware decoding, HDR, passthrough, frame-rate switching and performance are all from documentation. A Chromecast with Google TV (32-bit, 2 GB of RAM) and a Fire TV stick would cover the low end.
2. **Old or vendor WebViews.** Fire OS in particular. If a device's WebView is older than Chrome 111, Kiro's CSS breaks.
3. **Memory on 1 GB devices:** the WebView and React UI together.
4. **Two playback engines.** Every player feature (subtitle style, delays, previews, stats, passthrough settings) needs a Media3 version, or a "not on TV" state.
5. **ASS styling:** fansub-style ASS subtitles look plain in Media3.
6. **Play Store policy:** if it matters later.

## Estimate

For one person, after this spike:

| Step                             | Work                                                                                                                                                                                           | Estimate             |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| 1. Player plugin to beta quality | External subtitles; subtitle style (`CaptionStyleCompat`); errors and fallback; HLS without `.m3u8`; stats; FFmpeg audio extension (LGPL); passthrough setting; audio focus; keep-awake; tests | 1.5–2 weeks          |
| 2. TV UI pass                    | 960×540 layout, overscan, hiding desktop-only controls; OK and long-press in the player and on cards; search without the keyboard trap                                                         | 1 week               |
| 3. Release pipeline              | Keystore and secrets; CI job for two ABIs (Linux runner, NDK); per-ABI APKs on the release; scan for local paths, as for the desktop                                                           | 3–4 days             |
| 4. First real-device round       | Google TV and Fire TV: decoding, passthrough, HDR, memory                                                                                                                                      | 3–5 days, plus fixes |
| **First installable beta**       | Sideloaded, signed, updated by hand                                                                                                                                                            | **about 3–5 weeks**  |
| Later                            | Self-updater (3–5 days); seek previews; libmpv fallback if needed; Play Store                                                                                                                  | —                    |

## Recommended next steps

1. Decide on the application ID and the Media3 recommendation.
2. Get one real device (ideally a Chromecast with Google TV) and repeat the proof of concept on it: decoding, passthrough to a receiver, memory.
3. Then steps 1–3 of the estimate, in that order.

## Reproduce

On macOS with Android Studio's SDK:

1. Install the command-line tools into `~/Library/Android/sdk/cmdline-tools/latest`.
2. With `sdkmanager`, install `ndk;28.2.13676358`, `platforms;android-36` and `system-images;android-36;android-tv;arm64-v8a`.
3. Run:

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export ANDROID_HOME=~/Library/Android/sdk NDK_HOME=~/Library/Android/sdk/ndk/28.2.13676358
rustup target add aarch64-linux-android armv7-linux-androideabi
avdmanager create avd -n Kiro_TV_1080p -k "system-images;android-36;android-tv;arm64-v8a" -d tv_1080p
emulator -avd Kiro_TV_1080p &
cd apps/desktop
pnpm tauri android build --debug --apk --target aarch64
adb install -r src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```

Debug builds expose the WebView's DevTools protocol: `adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>`. The spike opened the player on a stream from there, by pushing a `/player` history entry with `{ url, title }` as its state.

Player logs are under the logcat tag `KiroPlayer`, and commands under `Tauri/Plugin`.
