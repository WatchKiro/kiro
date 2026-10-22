# First-run setup

A new install of Kiro comes with Cinemeta (catalogues and details) and OpenSubtitles (subtitles), so it can browse but has nothing to play until an addon that provides streams is added. The first-run setup says so, plainly, and offers the ways to add one. Kiro is a neutral, addon-based player: it hosts no content, recommends no stream sources, and the user chooses their own addons.

## What it shows

A full-screen welcome, over the app:

> Kiro plays content from addons. Cinemeta (catalogues) and OpenSubtitles (subtitles) are installed. Add addons to watch things.

(The middle sentence only while both defaults are installed.) Then the ways forward:

1. **Add an addon by its link.** Paste a manifest URL. It goes through the same install path and checks as Addons → Install (`AddonUrlForm`, `addonsStore.install`): https only (http for localhost), a valid manifest, configured addons need their configured link.
2. **Import from Stremio.** Opens Settings → Import from Stremio (`/settings#stremio`), the existing import.

There is no list of suggested addons: none could be verified as serving only licensed or public-domain content (see [Research](#research)). If one is verified later, it can be added as a third way, at the top, with a one-click Add.

**Skip for now** (or the close button, Escape or Back) skips it. Once an addon has been added the button reads **Done**. Choosing Import counts as done. Either way the setup never opens by itself again for that profile; Settings → Addons → **Open setup** opens it again whenever wanted, and closing it from there changes nothing.

## When it opens

Per profile, following [profiles.md](profiles.md): each profile records where it is with the setup (`profiles.first_run`: `pending`, `completed` or `skipped`, migration `0003_first_run.sql`). Every profile starts out pending, including ones from before the setup existed.

At launch, once a profile is chosen, the setup opens when that profile is pending **and no enabled addon provides streams** (`firstRunAtLaunch` in `features/onboarding/first-run-data.ts`). Addons are shared by every profile, so:

- a fresh install opens on it;
- a profile added on a computer that is already set up isn't asked (its state stays pending, so it would be asked if every stream addon were later removed);
- an upgraded install whose addons already provide streams isn't asked either;
- if the installed addons can't be read, it waits for the next launch.

Once open it stays open until closed, even if an addon added in it provides streams.

## Title pages without streams

The stream area tells apart why there's nothing to show (`streamAvailability` in `features/title/title-data.ts`):

| Case                                              | Shown                                                                      |
| ------------------------------------------------- | -------------------------------------------------------------------------- |
| No enabled addon provides streams at all          | "None of your addons provide streams." with a note and **Go to Addons**    |
| Some do, but none for this kind of title or id    | "None of your addons provide streams for this title." and **Go to Addons** |
| Addons were asked and found nothing               | "No streams were found for this title."                                    |
| Streams were found but are filtered or can't play | As before: the filtered and "can't play" lists                             |

Torrents remain unsupported, a decided non-goal: such streams are listed as "Torrents aren’t supported" and never opened.

## Keyboard and remote

The setup is a `data-nav-layer`: arrows stay inside it, focus starts on the link field (ready for a paste; Up and Down leave it), and Escape or Back closes it, except while typing in the field, where those keys belong to the field. The app beneath is `inert` while it's open.

## How it works

| Where                                   | What                                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `src-tauri/src/profiles/mod.rs`         | `FirstRun` on each `Profile`; `Profiles::finish_first_run` for the active profile                 |
| `src-tauri/src/commands/profiles.rs`    | `profile_finish_first_run { outcome }`: `completed` or `skipped` only, granted in `profiles.json` |
| `features/onboarding/first-run-data.ts` | `firstRunAtLaunch`                                                                                |
| `features/onboarding/first-run.tsx`     | `FirstRunGate` (beside the shell in `AppLayout`, keyed by the active profile) and the setup       |
| `features/onboarding/setup-store.ts`    | Open or not; `finish` records the outcome while the profile is pending                            |
| `features/onboarding/setup-again.tsx`   | The Settings → Addons entry                                                                       |
| `features/addons/addon-url-form.tsx`    | The link field, shared with the Addons page                                                       |

## Testing

- TypeScript: `first-run.test.ts` (when it opens, per profile, skip and complete, and the three no-streams cases) and `profiles-store.test.ts` (recorded for the active profile only, unchanged when reopened).
- Rust: `first_run_is_per_profile_and_stays_finished` and `only_completed_or_skipped_can_be_recorded` (`profiles`), and the command through the real IPC and permissions in `profile_commands_are_allowed_validate_and_keep_profiles_apart` (`lib.rs`).
- Browser preview (`pnpm --filter @kiro/desktop dev:renderer`): set `localStorage['kiro.preview.profiles']` to `fresh` and reload for a new install (one pending profile, an empty library, only the default addons). Add `https://streams.preview.kiro.invalid` in the setup to install the preview's fake streams. The default and `family` previews already have stream addons, so the setup doesn't open; Settings → Addons → Open setup still opens it.

## Research

Before building the suggestions, Stremio-compatible addons serving legal content were searched for (2026-10-22): the official addon collection, the Stremio community catalogue (716 addons, filtered by keyword), GitHub and the web, looking for public-domain film collections (Internet Archive based), Creative Commons films (Blender's open movies), NASA, and official channels published by rights holders. Each candidate was checked over https for a loading manifest, a catalogue, direct https streams that Kiro can play (not torrents, YouTube ids or external links) and a clear licence.

None passed all of the checks:

- **Internet Archive addons:** every hosted one found was unreachable, retired or returning 404, except one that matches archive.org uploads by title without checking their licence. It returned unrelated or in-copyright items for several films, so it can't be described as public domain only.
- **Blender open movies, NASA:** no hosted addon found.
- **Public broadcasters' free live channels:** the addons found are unofficial relays, not run by the broadcasters, mix in other sources, and are region-locked. Not suitable to recommend.
- **Relays of commercial free, ad-supported services:** unofficial; not suitable to recommend.
- **Others:** streams were YouTube ids or external links (not playable in Kiro), or licensing was unclear.

The sources themselves are reachable: Internet Archive items expose their licence (`licenseurl`) in their metadata, Blender's open movies are CC BY with direct files, and NASA's live channels are public HLS. A small static addon that checks each item's licence, published by the project, would be one way to offer verified suggestions later.
