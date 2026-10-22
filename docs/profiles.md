# Profiles

People sharing a computer each get their own Kiro: their own watchlist, history, Continue watching and settings, as with profiles on a TV app. Everything stays on the device; there are no accounts.

## What is per profile, and what is shared

| Per profile                                                                                                                                                                 | Shared by every profile                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| The library: watchlist, watch history, saved progress, Continue watching, and with it Up next and "Resume from"                                                             | Installed addons and their order: one setup per computer (`addons.json`)    |
| Settings: playback (languages, resume, Up next, volume, "Mark as watched at", keep the screen on), subtitles, streams, Discover/Movies/TV Shows rows, and General → Discord | Caches (SkipDB intro times, addon responses) and the app's own updates      |
| Which profile was used last (it opens next launch)                                                                                                                          | Whether "Who’s watching?" shows at launch, and the sidebar collapsed or not |
| Whether the [first-run setup](first-run.md) was completed or skipped                                                                                                        |                                                                             |

Addons are shared because installing them is setup, not taste: the person who sets up the computer installs them once, and everyone can then hide catalogue rows they don't want (rows are per profile). A Stremio import brings its addons in for everyone and its library into the active profile only.

## Using profiles

- **One profile** (a fresh install, or an upgrade): nothing changes. Kiro opens straight away on "Me", which holds everything from before profiles.
- **Who’s watching?** With more than one profile, Kiro opens on a full-screen picker of large tiles. **Show this at startup** (on the picker, and Settings → Profiles → Ask who’s watching) turns it off; Kiro then opens the profile used last. A profile with a PIN always asks for it at launch.
- **Sidebar.** The active profile's avatar and name sit above Settings. Its menu switches to another profile (one with a PIN opens its PIN pad), opens Who’s watching?, or goes to Settings → Profiles. Switching opens Discover for the new profile.
- **Settings → Profiles** adds (at most 8), renames, recolours, locks and deletes profiles. Names are 1 to 20 characters, distinct ignoring case, with no control or text-direction characters. Avatars are one of eight colours with the name's first letter; there are no uploads.
- **Deleting** a profile deletes its library and settings from the computer, after a confirmation. The active profile can't be deleted (switch first), nor the last one.

## PINs

A profile can be locked with a 4-digit PIN, asked for when switching into it (and at launch, if it was used last). It keeps a child out of a parent's profile and history; it is **a convenience lock, not security**, and the app says so where a PIN is set and entered. Anyone with the computer could read Kiro's files.

- The core stores only a salted PBKDF2-HMAC-SHA256 hash (100,000 rounds, 16-byte random salt, `src-tauri/src/profiles/pin.rs`) and compares in constant time. The PIN is never stored in plain text, logged (`Pin`'s `Debug` prints `Pin(****)`), or kept in a renderer store; the PIN pad holds the digits only while they're typed.
- A locked profile can be renamed, recoloured or have its PIN changed from inside it. From another profile those commands need its PIN, and Settings doesn't offer them.
- **Forgotten PIN.** Deleting a profile doesn't need its PIN, so a forgotten one can't lock a profile in forever: another profile deletes it in Settings → Profiles, after typing its name. Its library goes with it.
- Entry works with a keyboard (digits, Backspace, Escape), a remote (arrows and OK on the on-screen keys) or the pointer.

## Keyboard and remote

The picker and the PIN pad are TV-style screens and work with arrows, Enter and Back. Both are `data-nav-layer`s: arrows stay on them, and focus starts on the profile used last (or the PIN pad's 1). Escape or Back closes the picker when it was opened to switch, and leaves the PIN pad for the tiles; at launch the picker stays until a profile is chosen. Tiles lift with the same focus glow as posters. The sidebar menu and the Settings dialogs are layers too, and return focus to what opened them.

## How it works

### Storage

- **Library.** Migration `0002_profiles.sql` adds a `profiles` table (`id` AUTOINCREMENT so a deleted profile's id is never reused, `name`, `avatar`, `pin_hash`, `created_at`, `last_used_at`) and a one-row `profile_options` table (`show_picker`). It rebuilds `watchlist` and `history` with a `profile_id` column leading their primary keys and indexes, `REFERENCES profiles ON DELETE CASCADE`, and copies every existing row into profile 1, "Me". SQLite can't add a column to a primary key, hence the rebuild; it runs in the migration's transaction, so it is all or nothing.
- **Settings.** One file per profile. Profile 1 keeps `settings.json` in the config directory, exactly where it was, so an older file loads unchanged as Me's (and an older Kiro still reads it). Every other profile has `profiles/<id>/settings.json`. The format and its reading rules are unchanged (`src-tauri/src/settings`). Deleting a profile removes its file; creating one removes any stale file for its id (a database replaced after damage starts counting ids again).

### The active profile

`profiles::Profiles` (in `AppState`) owns the table and the active profile, resolved on first use as the one with the latest `last_used_at`. `AppState::library()` returns a `ProfileLibrary` for it, whose every query is scoped by `profile_id`, and `AppState::settings()` the active profile's `SettingsStore`. So every existing library and settings command, and everything else that reads settings (the player's keep-awake and Discord options, SkipDB's opt-in, the Stremio import's "Mark as watched at"), acts on the active profile only, with no change to its arguments.

`profile_switch` checks the PIN first, so a wrong one changes nothing. It then stops playback and clears Discord (the player's progress belongs to the profile being left; the renderer leaves the player page, which detaches it), makes the profile active and records it as used last, forgets a Stremio account read in the other profile, and applies the new profile's keep-awake and Discord settings.

### Commands

`commands/profiles.rs`, granted by `capabilities/profiles.json` (only these):

| Command                    | Arguments                | Notes                                                                           |
| -------------------------- | ------------------------ | ------------------------------------------------------------------------------- |
| `profile_list`             |                          | Every profile (never a PIN hash), the active one, `showPicker`                  |
| `profile_create`           | `name`, `avatar`, `pin?` | At most 8; names distinct ignoring case                                         |
| `profile_rename`           | `id`, `name`, `pin?`     | `pin`: needed for a locked profile other than the active one                    |
| `profile_set_avatar`       | `id`, `avatar`, `pin?`   | One of `AVATARS`                                                                |
| `profile_set_pin`          | `id`, `newPin`, `pin?`   | `newPin: null` removes it                                                       |
| `profile_delete`           | `id`                     | Not the active or last profile; no PIN (see Forgotten PIN)                      |
| `profile_switch`           | `id`, `pin?`             | `PIN_REQUIRED` or `WRONG_PIN` for a locked profile, even if already active      |
| `profile_set_show_picker`  | `show`                   |                                                                                 |
| `profile_finish_first_run` | `outcome`                | `completed` or `skipped`, for the active profile ([first-run.md](first-run.md)) |

Each returns the profiles as they are now. Arguments are validated at the boundary (`ProfileId`, `ProfileName`, `Avatar`, `Pin` deserialize only from valid values).

### Renderer

`apps/desktop/src/features/profiles/`:

| File                   | What                                                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------------- |
| `profiles-data.ts`     | Avatars, limits, name checks mirroring the core's, and `showsPickerAtLaunch`                              |
| `profiles-store.ts`    | The profiles, the picker's state, and switching (which clears the library store and reloads the settings) |
| `profile-picker.tsx`   | Who’s watching? and its PIN pad                                                                           |
| `profile-menu.tsx`     | The sidebar's profile button and menu                                                                     |
| `profiles-section.tsx` | Settings → Profiles and its dialogs                                                                       |
| `pin-pad.tsx`          | Four-digit entry for keys, a remote or the pointer                                                        |

`AppLayout` reads the profiles before rendering the shell. At launch the picker stands in for the shell, so no page reads a library for a profile that may not be the one chosen; opened later, it covers the (inert) shell. The shell is keyed by the active profile, so after a switch every page renders again and reads the new profile's data.

## Testing

- Rust: `cargo test` covers the migration on a version-1 database shaped like a real one (`storage::database`), isolation between profiles' libraries and settings, PIN hashing and verification, every rule above (`profiles`), and the commands through the real IPC and permissions (`profile_commands_are_allowed_validate_and_keep_profiles_apart` in `lib.rs`).
- TypeScript: `profiles-data.test.ts` and `profiles-store.test.ts` (the launch picker, switching, PINs, and the library and settings stores forgetting the old profile).
- Browser preview (`pnpm --filter @kiro/desktop dev:renderer`): one profile to start with. Set `localStorage['kiro.preview.profiles']` to `family` and reload for three: Me (the seeded library), Sam (a little of their own) and Kids (PIN `1234`).
- A dev build with its own data, leaving the real profile alone: from `apps/desktop`,
  `pnpm exec tauri dev --features libmpv --config '{"identifier":"app.kiro.desktop.profilestest","build":{"devUrl":"http://localhost:5292","beforeDevCommand":"pnpm exec vite --port 5292 --strictPort"}}'`.
  Copy a `kiro.sqlite3` (from `sqlite3 <file> ".backup <copy>"`) and `settings.json` into `~/Library/Application Support/app.kiro.desktop.profilestest/` first to try the migration on real data.
