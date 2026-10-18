# Spike: libmpv playback inside the Tauri window

**Status:** works on macOS (proof of concept) · **Branch:** `spike/libmpv` · **Date:** 2026-10-16

> The spike has since become the native player. The "Not production-ready" items below are resolved; see [docs/playback.md](../playback.md) for the player as built. Licensing and bundling are resolved by the LGPL build in [docs/releasing.md](../releasing.md), and the `libmpv2` crate has been replaced by Kiro's own bindings (below). HDR remains open.

## Verdict

Native libmpv playback inside Kiro's Tauri window works on macOS, with the React UI drawn on top of the video.

- **Decoding:** VideoToolbox hardware decoding, including 4K HEVC HDR10.
- **Smoothness:** 60 fps with no dropped frames in steady state.
- **Cost:** about the same CPU and memory as standalone `mpv`.
- **Visual check:** confirmed by eye. Video sits under the transparent webview, and the HTML controls (pause, seek, volume, stats) work over it.

The approach carries over to Linux and Windows, but each needs its own video-surface code (see [Other platforms](#other-platforms)).

Two things block shipping, and both need decisions rather than more code:

1. **Licensing and bundling libmpv.** Homebrew's build is GPL. Shipping needs an LGPL build of libmpv and FFmpeg, bundled with the app.
2. **True HDR output.** HDR video is decoded and recognised, but is shown as SDR. The current GL layer can't output extended range.

## Approach

`--wid` embedding (mpv drawing into a view we give it) was removed for macOS in mpv 0.37. On 0.41, passing a view just opens a separate mpv window. So the spike uses mpv's **render API**, the same technique IINA and mpv's own macOS output use internally:

```
NSWindow.contentView (wry's webview parent)
├── KiroVideoView   layer-hosting NSView, autoresizing, backed by ↓
│   └── KiroVideoLayer : CAOpenGLLayer   ← mpv renders here (OpenGL 3.2 core)
└── WKWebView       drawsBackground = NO  ← React UI; html/body transparent on /player
```

- **mpv instance:** created with `vo=libmpv` and `hwdec=auto-safe`. The user's `mpv.conf`, scripts, key bindings and yt-dlp are all disabled, so behaviour is deterministic.
- **Layer:** `KiroVideoLayer` is an asynchronous `CAOpenGLLayer`. At display rate, Core Animation asks whether it can draw, and the answer is yes only when:
  - mpv's update callback has flagged a new frame,
  - the layer was resized, or
  - it's the first draw.
- **Render context:** created lazily on the first draw, because that is the first moment the layer's GL context is current. Every `mpv_render_*` call goes through a mutex inside `drawInCGLContext`, as `render.h` requires.
- **Controls:** pause, seek and volume use the normal mpv handle through Tauri commands, never the render thread. They are capability-gated like every other command (`capabilities/player.json`).
- **Feature flag:** the whole thing sits behind the `libmpv` Cargo feature. `pnpm dev` turns it on automatically on macOS when libmpv is installed (`KIRO_MPV=0` opts out); default builds and CI don't need mpv.

Code:

- `src-tauri/src/media/mpv/`: backend (`mod.rs`) and macOS layer (`macos.rs`)
- `src-tauri/src/commands/player.rs`: commands
- `src/features/playback/player-page.tsx`: player page
- `src/services/player.ts`: typed command wrappers

## Results

Measured on an Apple M1 (8 cores) running macOS 26.6.2, with mpv 0.41.0 and FFmpeg 9.0.2 from Homebrew. The window was 1280×800 (2560×1600 at Retina), and streams played over the network.

CPU is a percentage of one core, sampled over 8 s once playback had settled. It counts only the `kiro-desktop` process: WebKit's separate processes and GPU time in WindowServer aren't included.

| Stream                                | Build   | Decoder      | Colour       | fps | Dropped | CPU   | RSS    |
| ------------------------------------- | ------- | ------------ | ------------ | --- | ------- | ----- | ------ |
| 1080p H.264, 3 Mbps (MP4)             | debug   | videotoolbox | bt.709       | 60  | 5¹      | 25.2% | 199 MB |
| 1080p H.264, 3 Mbps (MP4)             | release | videotoolbox | bt.709       | 60  | 0       | 23.1% | 194 MB |
| 4K HEVC HDR10, 40 Mbps (MP4)          | debug   | videotoolbox | bt.2020 / PQ | 60  | 0       | 30.2% | 448 MB |
| 4K HEVC HDR10, 40 Mbps (MP4)          | release | videotoolbox | bt.2020 / PQ | 60  | 0       | 29.5% | 442 MB |
| HLS adaptive (Big Buck Bunny)         | debug   | videotoolbox | bt.709       | 60  | 0       | —     | —      |
| **Baseline:** standalone `mpv`, 1080p | —       | videotoolbox | bt.709       | 60  | —       | 28.9% | 385 MB |

¹ All during start-up; none once playback settled.

- **No measurable overhead.** Embedding costs nothing compared with mpv's own window, and the debug and release Rust builds are nearly identical: the work happens inside libmpv and the GPU.
- **Memory is mostly the stream buffer.** RSS is dominated by mpv's demuxer cache, which grows with bitrate. It can be capped with `demuxer-max-bytes` once there's a playback-settings design.
- **Test streams:** the Jellyfin test videos (CC BY-SA 4.0, `repo.jellyfin.org/test-videos`) and Mux's public HLS test stream. Blender's old Big Buck Bunny MP4 links now return 404.

### How rendering was verified without screen access

My tools can't capture the screen here (macOS Screen Recording and Accessibility permissions), so the spike includes dev-only instrumentation:

- **Stats logging.** `KIRO_SPIKE_LOG=1` prints mpv state every 2 s.
- **Pixel read-back.** Every 60 frames the layer reads back five pixels from its own framebuffer. Playing mpv's `testsrc2` colour pattern returned real colours (`#ff27ff`, `#c4b050`) with no GL errors, which proves mpv draws image data into the layer.
- **Autoplay.** `VITE_KIRO_SPIKE_AUTOPLAY=<url>` opens `/player` and plays a URL on launch.
- **By eye.** You confirmed visually that the video composites under the webview and that the controls respond.

## Gotchas found (and fixed in the spike)

1. **The layer swaps framebuffers.** `CAOpenGLLayer` draws into an FBO that alternates between frames (1 ↔ 8 here), and it is 0 on the very first draw. Read `GL_DRAW_FRAMEBUFFER_BINDING` on every draw, and bind the read framebuffer to it before any `glReadPixels`.
2. **Sync commands run on the main thread.** Tauri runs non-`async` commands there, while `with_webview` queues work _for_ the main thread. A sync attach command that waits for it deadlocks, so `player_attach` is `async`.
3. **StrictMode double-mounts in development.** Two concurrent attaches created two mpv instances and two video layers, and the idle one could cover the real video. Attach is now serialised with a mutex.
4. **The transparent webview relies on a private key.** It uses `drawsBackground = NO`, which wry also uses, so it carries Mac App Store review risk. Outside the player, the app's normal opaque CSS background hides the video layer. The player page adds `html.kiro-video-mode` to make the document transparent.
5. **OpenGL is deprecated on macOS** (since 10.14), and `CAOpenGLLayer` with it. It still works, and libmpv has no Metal render backend yet. Apple's deprecation warnings are silenced in `macos.rs` only.

## Not production-ready (deliberately) — since resolved

The spike's shortcuts, and where each now stands (details in [docs/playback.md](../playback.md)):

- **One leaked player** → `MpvPlayer` owns mpv through an `Arc`. Teardown frees the render context with its CGL context current, stops the event thread, then destroys the core. The player detaches when you leave the player page and re-attaches when you come back.
- **Polling instead of events** → a dedicated event thread observes mpv properties and streams `PlayerEventMap`-shaped events to the webview over a Tauri channel. Only the optional stats overlay still reads periodically.
- **Retina scale fixed at attach** → `KiroVideoView` updates `contentsScale` on `viewDidChangeBackingProperties`.
- **Spike-only scaffolding** → the debug hooks remain, documented as dev tooling (`KIRO_SPIKE_LOG` now also logs commands and events, plus a scripted exercise). The sidebar entry is "Player (debug)", and the volume range comes from mpv's `volume-max`.
- **Feature flag not wired to the renderer** → `AppInfo.nativePlayer` already gated the page; `NativePlayer` also maps a missing command to `BACKEND_UNAVAILABLE`.
- **No subtitles or track selection** → audio and subtitle selection, disabling subtitles, and https external subtitles, with pickers in the UI. Local files are still to do.

## Bundling and licensing (blocking for release)

> **Decided: option (a).** Release builds bundle an LGPL libmpv built from source by `apps/desktop/scripts/build-libmpv.sh`; see [docs/releasing.md](../releasing.md). The `libmpv2` crate (end of this section) has been replaced by Kiro's own bindings.

**Homebrew's libmpv is a GPL build.** mpv is built with `-Dgpl=true` and links Homebrew FFmpeg, which is built with `--enable-gpl --enable-version3`. Treat the result as GPLv3. That's fine for local development, but it can't ship in an app under a permissive or closed licence.

**It isn't relocatable.** `libmpv.2.dylib` uses absolute install names (`/opt/homebrew/opt/mpv/lib/…`) and pulls in about 60 other dylibs. A release `.app` would need all of them copied into `Contents/Frameworks`, rewritten to use `@rpath`, then signed and notarised. Alternatively, build a slim libmpv yourself with only the features you need.

**To ship, either:**

- **(a)** build LGPL libmpv (`-Dgpl=false`) against an LGPL FFmpeg (no `--enable-gpl`, no x264/x265, nothing non-free), link it dynamically, and meet LGPL 2.1 obligations (notices, source, user-replaceable library); or
- **(b)** license Kiro as GPL.

This ties into the choice of Kiro's own licence, since settled as MIT (see `LICENSE`).

**The `libmpv2` Rust crate is LGPL-2.1, and Rust links crates statically.** Before shipping a non-GPL app, either confirm that's acceptable or replace it with a thin MIT/Apache FFI layer of our own. The client and render API surface we use is small.

> **Resolved.** The player now uses hand-written bindings over libmpv's C API (`src-tauri/src/media/mpv/ffi.rs`, `client.rs`, `render.rs`), declared from mpv's ISC-licensed headers and linked with `-lmpv` from `build.rs`.

## HDR

HDR10 decodes in hardware and mpv recognises it (`bt.2020` / PQ), but the 8-bit `CAOpenGLLayer` output means mpv tone-maps it to SDR. True HDR (EDR) output would need one of:

- `wantsExtendedDynamicRangeContent` with a floating-point pixel format and mpv's `target-colorspace-hint`, which is untested with `CAOpenGLLayer`; or
- a Metal/Vulkan render path when libmpv gets one (gpu-next render backends are in review upstream).

## Other platforms

- **Windows: probably the easiest.** Stremio's Windows shell does exactly this today: mpv draws into a child window of the main window, with a fully transparent WebView2 (`DefaultBackgroundColor` alpha 0) on top. We could use mpv's window embedding there, or the render API: OpenGL now, or D3D11 from mpv 0.42 (client API 2.6). Watch the stacking order between mpv's child window and WebView2's, and WebView2's white flash on load.
- **Linux: render API only.** mpv's window embedding works only on X11, and the X window covers the GTK-drawn webview. Wayland has no embedding at all. The render API into an OpenGL area _under_ a transparent WebKitGTK webview is the only approach that works on both X11 and Wayland, and it needs the most platform-specific code. Note too that an LGPL mpv build drops X11 video output entirely.

Both are now built as planned here; see [Windows and Linux surfaces](../playback.md#windows-and-linux-surfaces). One thing this didn't anticipate: on Linux, WebKitGTK only renders a transparent background with real alpha when the window has an RGBA visual, so the window is created transparent on Linux.

## Recommended next steps

1. **Decide Kiro's licence and how libmpv will be distributed**, before investing further. This determines option (a) or (b) above.
2. **Turn the spike into a proper `NativePlayer`.**
   - Teardown without leaking.
   - Event-driven state from mpv property observers, emitted as Tauri events.
   - Track and subtitle commands mirroring `@kiro/player-core`.
   - Update `contentsScale` when the window's display changes.
3. **Prototype Windows next** (lower risk, proven by Stremio), then Linux with the GL render API.
4. **Revisit HDR (EDR) output** when libmpv's gpu-next render backends land.

## Reproduce

```bash
brew install mpv
```

```bash
pnpm dev:desktop
```

Then open **Player (spike)** in the sidebar. To autoplay with stats logging:

```bash
KIRO_SPIKE_LOG=1 VITE_KIRO_SPIKE_AUTOPLAY='https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8' pnpm dev:desktop
```

Side effect on this machine: `brew install mpv` also installed FFmpeg 9.0.2 next to the existing 8.0, plus libplacebo and yt-dlp.
