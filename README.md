# Kiro

**Your entertainment. One place.**

Kiro is a lightweight, open-source media discovery and streaming application for the desktop, inspired by Stremio, Plex and Kodi. It brings movies and TV shows from many sources into one fast, beautiful interface, plays them with a native engine, and can be extended with community addons.

> **Status: foundation.** This repository has the architecture, tooling and starter applications in place. The first feature works end to end: install a Stremio-compatible addon by URL and browse its catalogue on Discover. Playback, libraries and the rest are not built yet.

---

## Contents

- [Principles](#principles)
- [Technology stack](#technology-stack)
- [Architecture](#architecture)
- [Repository structure](#repository-structure)
- [Prerequisites](#prerequisites)
- [Getting started](#getting-started)
- [Commands](#commands)
- [Environment configuration](#environment-configuration)
- [Shared packages](#shared-packages)
- [Desktop app internals](#desktop-app-internals)
- [Brand assets](#brand-assets)
- [Security model](#security-model)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Principles

- **Local first.** Discovery, playback and libraries run on the user's machine. The Kiro cloud API is optional (accounts and sync) and is never required for local playback. Media streams never pass through Kiro servers.
- **Native where it matters.** Rust handles native work: playback (libmpv), filesystem, addon networking. The webview renders UI only.
- **Lightweight.** Tauri instead of Electron, system fonts, no heavy UI frameworks, code-split routes, small dependency tree.
- **Secure by default.** Least-privilege Tauri capabilities, strict CSP, validated input at every boundary, and addon code is never executed.
- **Cross-platform.** Windows, macOS and Linux first, with no unnecessary platform coupling so Android / Android TV stay possible.

## Technology stack

| Area          | Technology                                                        | Version                      |
| ------------- | ----------------------------------------------------------------- | ---------------------------- |
| Runtime       | Node.js (LTS)                                                     | ≥ 22.22, 24 recommended      |
| Monorepo      | pnpm workspaces · Turborepo                                       | 12.14 · 2.11                 |
| Language      | TypeScript (strict)                                               | 6.0                          |
| Desktop shell | Tauri · Rust (edition 2024)                                       | 2.12 · ≥ 1.90                |
| Desktop UI    | React · Vite · React Router · Zustand · Tailwind CSS              | 19.3 · 8.3 · 8.4 · 5.0 · 4.3 |
| API           | Express · Helmet · CORS · Zod                                     | 5.3 · 8.3 · 2.8 · 4.6        |
| Website       | Next.js (App Router, Turbopack) · Tailwind CSS                    | 16.4 · 4.3                   |
| Quality       | ESLint (flat config) · typescript-eslint · Prettier · `node:test` | 10 · 8.71 · 3.9              |

> **Why TypeScript 6.0 and not 7.0?** TypeScript 7 (the native Go compiler) is out, but `typescript-eslint` currently supports TypeScript `< 6.1`. 6.0 keeps type-aware linting working; upgrade once the ecosystem catches up.

## Architecture

```
┌─────────────────────────── Desktop app (apps/desktop) ───────────────────────────┐
│                                                                                   │
│   React renderer (webview)                    Rust core (src-tauri)               │
│   ─────────────────────────                   ─────────────────────               │
│   features/ · stores/ · layouts/   invoke()   commands/  ← only renderer surface  │
│   services/native.ts  ───────────────────────▶ core/      lifecycle, state, errors│
│                          (capability-gated)   media/     libmpv backend           │
│   @kiro/ui  @kiro/player-core                 addons/    endpoint policy, fetch   │
│   @kiro/addon-sdk (validation)                storage/   on-device data           │
└───────────────────────────────────────────────────────────────────────────────────┘
          │ optional (accounts, sync)                         │ direct, no proxy
          ▼                                                   ▼
   Kiro API (apps/api)                                 Addon endpoints / stream hosts
   Express · /api/v1

   Website (apps/web) — Next.js marketing site, fully static
```

- **Shared packages are "just-in-time" internal packages.** They export TypeScript source (`"exports": { ".": "./src/index.ts" }`) and are compiled by each consumer: Vite (desktop), Next.js via `transpilePackages` (web), `tsx` in development and an esbuild bundle in production (API). There is no separate package build step and no stale `dist/` to fight with. If a package is ever published to npm (e.g. `@kiro/addon-sdk` for addon authors), give it its own build at that point.
- **Turborepo** orchestrates `dev`, `build`, `lint`, `typecheck` and `test`. Lint, typecheck and test depend on a `transit` task so that a change in a shared package invalidates the cache of every package that uses it.

## Repository structure

```
.
├── apps/
│   ├── desktop/                    Tauri 2 + React desktop app (the core product)
│   │   ├── src/
│   │   │   ├── app/                router and navigation config
│   │   │   ├── components/         app-shell components (sidebar, header, empty states)
│   │   │   ├── features/           feature modules: discovery, library, addons, settings
│   │   │   ├── hooks/              shared React hooks
│   │   │   ├── layouts/            route layouts
│   │   │   ├── lib/                small renderer helpers
│   │   │   ├── services/           typed bridge to Rust commands (native.ts)
│   │   │   ├── stores/             Zustand stores (app-shell UI state)
│   │   │   ├── styles/             Tailwind entry
│   │   │   └── main.tsx
│   │   ├── src-tauri/
│   │   │   ├── src/
│   │   │   │   ├── commands/       Tauri command handlers
│   │   │   │   ├── core/           lifecycle, shared state, error type
│   │   │   │   ├── media/          native playback (libmpv backend, docs/playback.md)
│   │   │   │   ├── addons/         addon URL policy, HTTP transport, installed list
│   │   │   │   ├── storage/        local data directories
│   │   │   │   ├── lib.rs          app builder, IPC tests
│   │   │   │   └── main.rs
│   │   │   ├── capabilities/       window permissions (least privilege)
│   │   │   ├── icons/              generated by brand/generate.sh
│   │   │   ├── build.rs            declares app commands → generated permissions
│   │   │   ├── Cargo.toml
│   │   │   └── tauri.conf.json
│   │   ├── app-icon.png            app icon source (generated by brand/generate.sh)
│   │   ├── public/brand/           logo mark served to the renderer
│   │   ├── index.html
│   │   └── vite.config.ts
│   ├── api/                        Express API
│   │   ├── scripts/build.js        esbuild production bundle
│   │   └── src/
│   │       ├── config/             validated environment
│   │       ├── controllers/
│   │       ├── middleware/         request id, logging, errors, 404
│   │       ├── routes/v1/
│   │       ├── types/              Express type augmentation
│   │       ├── utils/              logger, HttpError, responses, validation
│   │       ├── app.ts              builds the app (no port binding → testable)
│   │       ├── app.test.ts
│   │       └── server.ts           listen + graceful shutdown
│   └── web/                        Next.js website
│       └── src/{app,components,features/landing,lib,styles}
├── brand/
│   ├── kiro-icon.webp              master logo artwork
│   └── generate.sh                 regenerates every icon and logo asset
├── packages/
│   ├── addon-sdk/                  addon protocol contracts + validation
│   ├── api-client/                 typed fetch client for the API
│   ├── config/                     shared ESLint presets
│   ├── player-core/                playback interfaces
│   ├── types/                      shared domain types + Zod schemas
│   ├── ui/                         design tokens + React components
│   └── utils/                      tiny framework-free helpers
├── eslint.config.js                lints root-level files
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json              strict compiler options shared by every project
└── turbo.json
```

Folders are only created when they hold real code.

## Prerequisites

### All platforms

1. **Node.js 24 LTS** (22.22 or newer works). An `.nvmrc` is provided: `nvm use`.
2. **pnpm 12**. The exact version is pinned in `package.json` (`packageManager`). Either:
   ```bash
   corepack enable
   ```
   or install it directly:
   ```bash
   npm install --global pnpm@12
   ```
3. **Rust (stable, 1.90 or newer)** via [rustup](https://rustup.rs). Only needed for the desktop app.

### macOS

```bash
xcode-select --install
```

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

### Windows

1. Install [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) and select **Desktop development with C++**.
2. WebView2 is preinstalled on Windows 10 (1803+) and 11. Otherwise install the [Evergreen Bootstrapper](https://developer.microsoft.com/microsoft-edge/webview2/).
3. Install Rust with [`rustup-init.exe`](https://rustup.rs) and keep the default MSVC toolchain:
   ```powershell
   rustup default stable-msvc
   ```

### Linux

Tauri needs WebKitGTK 4.1 and a few system libraries.

**Debian / Ubuntu**

```bash
sudo apt update && sudo apt install -y libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

**Fedora**

```bash
sudo dnf install -y webkit2gtk4.1-devel openssl-devel curl wget file libappindicator-gtk3-devel librsvg2-devel libxdo-devel && sudo dnf group install -y "c-development"
```

**Arch**

```bash
sudo pacman -S --needed webkit2gtk-4.1 base-devel curl wget file openssl appmenu-gtk-module libappindicator-gtk3 librsvg xdotool
```

Then install Rust:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

See the [Tauri prerequisites guide](https://v2.tauri.app/start/prerequisites/) for other distributions.

## Getting started

```bash
pnpm install
```

Copy the environment templates (all optional — every variable has a working default).

macOS / Linux:

```bash
cp apps/api/.env.example apps/api/.env && cp apps/web/.env.example apps/web/.env.local && cp apps/desktop/.env.example apps/desktop/.env.local
```

Windows (PowerShell):

```powershell
Copy-Item apps/api/.env.example apps/api/.env; Copy-Item apps/web/.env.example apps/web/.env.local; Copy-Item apps/desktop/.env.example apps/desktop/.env.local
```

Start everything:

```bash
pnpm dev
```

| App     | URL / output                          |
| ------- | ------------------------------------- |
| Website | http://localhost:3000                 |
| API     | http://localhost:4000/api/v1/health   |
| Desktop | native window (renderer on port 5173) |

The first desktop run compiles the Rust dependency tree, which takes a few minutes. Later runs are incremental.

## Commands

Run from the repository root.

| Command              | What it does                                                                                                                       |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`           | Start website, API and desktop app together (Turborepo TUI)                                                                        |
| `pnpm dev:desktop`   | Desktop app only (`tauri dev`: Vite + native window, hot reload)                                                                   |
| `pnpm dev:api`       | API only, restarting on file changes (`tsx watch`)                                                                                 |
| `pnpm dev:web`       | Website only (`next dev`)                                                                                                          |
| `pnpm build`         | Production builds: API bundle, website, desktop renderer                                                                           |
| `pnpm build:desktop` | Package the desktop app with `tauri build` (installers in `src-tauri/target/release/bundle`)                                       |
| `pnpm build:mac`     | macOS release: `Kiro.app` and `.dmg` with the bundled LGPL libmpv ([docs/releasing.md](docs/releasing.md))                         |
| `pnpm build:linux`   | Linux release: AppImage and `.deb` with the bundled LGPL libmpv ([docs/releasing.md](docs/releasing.md#linux))                     |
| `pnpm build:windows` | Windows release (on Windows): NSIS installer with the bundled LGPL `libmpv-2.dll` ([docs/releasing.md](docs/releasing.md#windows)) |
| `pnpm lint`          | ESLint for every workspace (type-aware)                                                                                            |
| `pnpm typecheck`     | `tsc` for every workspace                                                                                                          |
| `pnpm test`          | Unit tests (`node:test` via `tsx`)                                                                                                 |
| `pnpm format`        | Prettier (with Tailwind class sorting)                                                                                             |
| `pnpm format:check`  | Verify formatting (for CI)                                                                                                         |

Per-app commands (use `pnpm --filter <name> <script>`):

| Package         | Script                     | Purpose                                                                                                                                                                             |
| --------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@kiro/desktop` | `dev:renderer`             | Renderer only in a browser at :5173 (no Rust needed). A dev-only preview backend answers native calls with live addon data and a sample library; `VITE_KIRO_PREVIEW=0` turns it off |
|                 | `rust:check` / `rust:lint` | `cargo check` / `cargo clippy -D warnings`                                                                                                                                          |
|                 | `rust:test` / `rust:fmt`   | `cargo test` (incl. IPC permission tests) / `cargo fmt`                                                                                                                             |
|                 | `tauri <args>`             | Tauri CLI, e.g. `pnpm --filter @kiro/desktop tauri info`                                                                                                                            |
| `@kiro/api`     | `start`                    | Run the production bundle (`dist/server.js`)                                                                                                                                        |
| `@kiro/web`     | `start`                    | Serve the production build on :3000                                                                                                                                                 |

### Starting each app individually

```bash
pnpm dev:web
```

```bash
pnpm dev:api
```

```bash
pnpm dev:desktop
```

```bash
pnpm --filter @kiro/desktop dev:renderer
```

### Production builds

```bash
pnpm build
```

```bash
pnpm --filter @kiro/api start
```

```bash
pnpm --filter @kiro/web start
```

```bash
pnpm build:desktop
```

`pnpm build:desktop` produces platform installers (`.app`/`.dmg` on macOS, `.msi`/NSIS on Windows, `.deb`/`.rpm`/AppImage on Linux), without native playback. Linux packages with a bundled libmpv aren't set up yet.

For the macOS release with native playback, use `pnpm build:mac`. It builds an LGPL libmpv from source, bundles it into `Kiro.app`, and makes a `.dmg`. It signs ad hoc, or with your Developer ID and notarisation when those are configured. See [docs/releasing.md](docs/releasing.md).

```bash
pnpm build:mac
```

For Linux, `pnpm build:linux` makes an AppImage and a `.deb` with an LGPL libmpv (`apps/desktop/scripts/build-libmpv-linux.sh`). It needs WebKitGTK 4.1, so Ubuntu 22.04 / Debian 12 or newer. See [docs/releasing.md](docs/releasing.md#linux).

```bash
pnpm build:linux
```

For Windows, `pnpm build:windows` (on Windows) makes a per-user NSIS installer with an LGPL `libmpv-2.dll` beside `Kiro.exe`. The DLL is cross-compiled on Linux or macOS by `apps/desktop/scripts/build-libmpv-windows.sh`, or downloaded from the Windows CI workflow. See [docs/releasing.md](docs/releasing.md#windows).

```bash
pnpm build:windows
```

### Releasing

Releases are built by CI, never on a maintainer's machine: bump the version in `apps/desktop/package.json` and `apps/desktop/src-tauri/Cargo.toml`, then push a tag such as `v0.2.0-beta.1`. The Release workflow builds macOS, Windows and Linux, checks that nothing in them names a home folder, and drafts a GitHub release with the installers, the signed update bundles and `latest.json`, the LGPL sources and `SHA256SUMS`. Publishing the draft releases it, and installed copies of Kiro update themselves (macOS, Windows and the AppImage; the `.deb` points at the download). See [docs/releasing.md](docs/releasing.md#cutting-a-release).

## Environment configuration

Each app has a documented `.env.example`. Real `.env*` files are git-ignored.

**Exposure rules — read before adding variables:**

- `apps/api` variables are **server-only**.
- `apps/web`: only `NEXT_PUBLIC_*` variables reach the browser, and they are **public** (inlined at build time). Unprefixed variables stay on the server.
- `apps/desktop`: only `VITE_*` and `TAURI_ENV_*` reach the renderer and are **embedded in the shipped bundle**. Secrets the desktop app ever needs belong in the Rust core, never the webview.

| App     | Variable                      | Default                                       | Notes                                                                                                                                   |
| ------- | ----------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| api     | `NODE_ENV`                    | `development`                                 | `production` switches logs to JSON lines                                                                                                |
| api     | `HOST`                        | `127.0.0.1`                                   | Use `0.0.0.0` in containers                                                                                                             |
| api     | `PORT`                        | `4000`                                        |                                                                                                                                         |
| api     | `LOG_LEVEL`                   | `info`                                        | `debug` · `info` · `warn` · `error` · `silent`                                                                                          |
| api     | `CORS_ORIGINS`                | web, desktop dev and packaged desktop origins | Comma-separated exact origins                                                                                                           |
| api     | `SHUTDOWN_TIMEOUT_MS`         | `10000`                                       | Grace period on SIGINT/SIGTERM                                                                                                          |
| web     | `NEXT_PUBLIC_SITE_URL`        | `http://localhost:3000`                       | Canonical URL for metadata                                                                                                              |
| web     | `NEXT_PUBLIC_GITHUB_URL`      | unset                                         | Shows GitHub links when set                                                                                                             |
| desktop | `VITE_KIRO_API_URL`           | unset                                         | Reserved for optional cloud sync                                                                                                        |
| desktop | `TAURI_DEV_HOST`              | unset                                         | Set by the Tauri CLI for device development                                                                                             |
| desktop | `KIRO_DISCORD_APPLICATION_ID` | unset (a placeholder)                         | Build time, Rust: the Discord application for Rich Presence. Unset, presence stays off ([docs](docs/playback.md#discord-rich-presence)) |

The API validates its environment with Zod at startup and exits with a list of every invalid variable.

## Shared packages

| Package             | Purpose                                                                                                                                                                                                                                                                                                                                  | Depends on                |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `@kiro/types`       | Domain types and Zod schemas: the API response envelope (`{ success, data }` / `{ success, error }`), health contract, media types and identifiers.                                                                                                                                                                                      | zod                       |
| `@kiro/utils`       | Tiny, framework-free helpers (`cx`, `clamp`, `formatDuration`, `assertNever`). Keep it small.                                                                                                                                                                                                                                            | —                         |
| `@kiro/api-client`  | Fetch-based, framework-independent API client. Configurable base URL, timeouts and abort signals, runtime validation of every response, and a single `KiroApiError` type (`NETWORK_ERROR`, `TIMEOUT`, `INVALID_RESPONSE` or the API's own error code).                                                                                   | @kiro/types, zod          |
| `@kiro/addon-sdk`   | Addon protocol (Stremio-compatible manifests, catalogues, metadata, streams, subtitles). Validates **untrusted** responses: http(s)-only URLs, bounded strings and lists, invalid cosmetic fields dropped, invalid list items skipped, unknown fields stripped for forward compatibility. Defines a transport-agnostic `AddonTransport`. | zod                       |
| `@kiro/player-core` | Backend-agnostic `MediaPlayer` interface (load, play, pause, seek, volume, tracks, subtitles, events, buffering, errors), `MediaSource`, `PlayerError`, a typed emitter, and `resolvePlayerFactory` for choosing between a native (libmpv) and web (HTML5) backend. No implementation yet by design.                                     | —                         |
| `@kiro/ui`          | Design tokens (`styles.css` for Tailwind v4) and presentational React components (`Button`, `buttonVariants`, `Badge`, `KiroMark`, `KiroLogo`). No hooks, so they work as React Server Components in Next.js and in the Tauri renderer.                                                                                                  | @kiro/utils, react (peer) |
| `@kiro/config`      | ESLint flat-config presets: `base`, `node`, `react`, `next`. Each workspace's `eslint.config.js` is one line and easy to extend.                                                                                                                                                                                                         | eslint plugins            |

`@kiro/types`, `@kiro/utils`, `@kiro/addon-sdk` and `@kiro/player-core` are **runtime-neutral**: ESLint forbids `node:*` imports outside tests.

## Desktop app internals

### Talking to Rust

The renderer can only call Rust commands that are (1) registered, (2) declared in `build.rs` and (3) granted by a capability. Today that is a single command, `app_info`, and the main window has **no** core plugin permissions at all.

To add a command:

1. Implement it in `src-tauri/src/commands/<area>.rs`. Take validated argument types (see `addons::AddonUrl`, which rejects bad input during deserialization) and return `core::error::Result<T>`.
2. Register it in `app_builder` in `src-tauri/src/lib.rs`.
3. Add its name to `AppManifest::commands` in `src-tauri/build.rs`.
4. Grant `allow-<command-name>` in `src-tauri/capabilities/default.json`.
5. Add a typed wrapper in `src/services/native.ts`.

`cargo test` includes IPC tests running on Tauri's mock runtime that prove granted commands work and ungranted APIs are denied.

### State

Zustand is used for state that is genuinely shared. `stores/ui-store.ts` holds the app shell's UI preferences (persisted). Feature state lives in feature-scoped stores next to each feature, not in one global store (e.g. `features/addons/addons-store.ts` for installed addons and their catalogues). Prefer React local state when it is enough, and subscribe with selectors to avoid re-renders.

### Discover and browsing

Discover, Movies and TV Shows show the enabled addons' catalogues as rows that load as they scroll into view. **Customise** chooses which rows appear and in what order; layouts are saved in the core's settings by addon id, catalogue type and catalogue id, so they survive restarts and addon updates. See [docs/discover.md](docs/discover.md).

### Profiles

People sharing a computer each get their own profile: their own watchlist, history, Continue watching and settings, picked on a "Who’s watching?" screen at launch, with an optional 4-digit PIN (a convenience lock, not security). Addons are shared. The library tables are keyed by profile and each profile has its own settings file; commands act on the active profile. See [docs/profiles.md](docs/profiles.md).

### Routing and performance

React Router (data router). Discover is bundled eagerly as the start screen; every other section is a lazy route chunk. Fonts are the operating system's own, so nothing is downloaded at startup and the app works offline.

### Playback

The native player uses libmpv for hardware decoding, 4K/HDR, MKV, multiple audio and subtitle tracks, accurate seeking and network streams, drawn under the transparent webview with the React controls on top. `media::PlaybackBackend` in Rust mirrors `MediaPlayer` in `@kiro/player-core`; the renderer's `NativePlayer` maps it onto Tauri commands, with state pushed as events over a channel. A `WebPlayer` (HTML5 video) can serve as a fallback later.

It runs on macOS, Windows and Linux, behind the `libmpv` Cargo feature. Install libmpv (`brew install mpv` on macOS, your distribution's `libmpv-dev` on Linux, or an mpv-dev package with `KIRO_LIBMPV_DIR` pointing at `libmpv-2.dll` on Windows) and `pnpm dev` / `pnpm dev:desktop` turn it on automatically (set `KIRO_MPV=0` to start without it). See [docs/playback.md](docs/playback.md) for the design, [docs/releasing.md](docs/releasing.md) for the LGPL libmpv that release builds bundle, and [docs/spikes/libmpv.md](docs/spikes/libmpv.md) for the original measurements.

## Brand assets

The Kiro robot in `brand/kiro-icon.webp` is the single source for every icon and logo. After changing it, run:

```bash
bash brand/generate.sh
```

This regenerates:

- the desktop app icon (`apps/desktop/app-icon.png`, laid out on the macOS icon grid) and all Tauri platform icons in `src-tauri/icons/`
- the UI mark (`public/brand/kiro-mark.webp`) used by `KiroMark` in the desktop app and the website
- the website favicon and Apple touch icon (`apps/web/src/app/icon.png`, `apple-icon.png`)

The script needs `rsvg-convert` and `dwebp`/`cwebp` (`brew install librsvg webp`, or `sudo apt install librsvg2-bin webp`).

## Security model

**Desktop**

- Capability-based permissions: the main window can invoke only Kiro's own commands (`app_info`, `addon_*`). There is no filesystem, shell or HTTP plugin access.
- Strict production CSP (`script-src 'self'`, no remote connections, no frames, no objects). Images may load from `https:` (addon posters and logos). The dev CSP only adds what Vite's HMR needs.
- Command errors serialize to `{ code, message }`. Internal errors never expose paths or system details.
- Updates (release builds) come only from this repository's GitHub releases over https, and are installed only if their signature matches the updater public key built into the app (`plugins.updater` in `tauri.conf.json`), for the version the release announces. The Rust core checks, downloads and installs; the updater plugin's own commands aren't granted to the window, which can only read the status, ask for a check, and confirm a restart ([details](docs/releasing.md#auto-update)).
- Discord Rich Presence (Settings → General, off by default) sends Discord's local app only the title, season and episode numbers, an https poster and timestamps, never stream URLs, addon names or file paths; nothing connects to Discord while it's off ([details](docs/playback.md#discord-rich-presence)).
- Addons are remote services and are never executed. Requests are made by the Rust core (`addons::transport`) with connect/total timeouts, a response size cap and the `AddonUrl` policy re-checked on every redirect; responses are then validated by `@kiro/addon-sdk`. Addon URLs must be https (http only for localhost). Installed addons are stored in `addons.json` in the app config directory.
- Import from Stremio (Settings) signs in to the user's Stremio account once, from the Rust core over https with redirects refused, to read their addons, library and progress. The auth key or password is used for that one read and never stored or logged; a session Kiro opened is signed out again. Imported data is validated like any other input and never overwrites newer Kiro progress. See [docs/stremio-import.md](docs/stremio-import.md).

**API**

- Helmet headers, `x-powered-by` disabled, an explicit CORS allowlist, and a 100 kB JSON body limit.
- Central error handler: known errors return stable codes. Unexpected errors are logged with a request id and returned as a generic 500.
- Request ids are accepted from upstream proxies only if they are safe to log. Query strings are not logged.

**Web**

- Fully static output with no third-party scripts. The font is self-hosted at build time by `next/font`.
- Security headers: `frame-ancestors 'none'`, `nosniff`, a referrer policy, a permissions policy and HSTS. `poweredByHeader` is disabled.

**Supply chain**

- pnpm 12 enforces a minimum release age for new package versions, and dependency build scripts are blocked unless they are allow-listed (`allowBuilds` in `pnpm-workspace.yaml`; only `esbuild` is allowed).

## Troubleshooting

| Problem                                           | Fix                                                                                                                                            |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `cargo: command not found` during `pnpm dev`      | Rust isn't on your `PATH`. Restart the terminal after installing rustup, or run `source "$HOME/.cargo/env"`.                                   |
| `Port 5173 is already in use`                     | Another Vite instance is running. Vite uses `strictPort` because Tauri expects that exact port. Stop the other process.                        |
| Port 3000 / 4000 already in use                   | Stop the other process, or change `PORT` in `apps/api/.env`.                                                                                   |
| `ERR_PNPM_IGNORED_BUILDS`                         | A new dependency wants to run an install script. Review it, then `pnpm approve-builds <pkg>`.                                                  |
| pnpm refuses a just-published version             | That's the minimum-release-age policy. Wait a day, or pin the previous version.                                                                |
| Engine warnings or odd install errors             | Check `node -v` (needs ≥ 22.22). With nvm: `nvm use`.                                                                                          |
| Linux: `webkit2gtk-4.1` not found                 | Install the WebKitGTK 4.1 dev package for your distro (see [Linux](#linux)). Ubuntu 20.04 and older don't ship 4.1.                            |
| Windows: link errors (`link.exe` not found)       | Install the C++ Build Tools workload and use the MSVC Rust toolchain.                                                                          |
| Blank desktop window                              | Make sure nothing else is serving port 5173, and check the terminal running `pnpm dev:desktop` for Vite errors.                                |
| Desktop shows "Preview data" or "Browser preview" | You opened the renderer in a regular browser (`dev:renderer`), with or without the preview backend. Use `pnpm dev:desktop` for the native app. |
| Stale lint/typecheck results                      | `rm -rf .turbo node_modules/.cache` and re-run. Turborepo caches by inputs.                                                                    |

## License

Kiro is released under the [MIT License](LICENSE).

Release builds bundle libmpv and FFmpeg, built as LGPL-2.1-or-later and linked dynamically. Their licence texts ship inside the app, and their sources are published with each release. See [docs/releasing.md](docs/releasing.md).
