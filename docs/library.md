# Watch history: Continue watching and watched marks

Kiro keeps a watch history per profile (see [profiles.md](profiles.md)): one row per film or episode played, with how far it got and whether it counts as watched. Playback fills it in by itself ([playback.md](playback.md#library-progress)). This page covers what people can change by hand: taking titles off Continue watching, and marking films, episodes, seasons and shows watched or unwatched.

## Continue watching

Discover's first row lists, newest first, films and episodes left partway (past 15 s and short of "Mark as watched at"), and series whose latest episode was finished, offering the next one. A finished film, or a series whose last episode was watched, drops out.

### Removing a title

Each card has a menu (below) with **Remove from Continue watching**. It hides the title and keeps everything else:

- **History and progress are kept.** The History section still shows the title, the title page still offers Resume, and "Resume from" still works.
- **It comes back when the title is played again.** For a film that means playing it; for a series, playing any episode (a new one, typically). Marking an episode watched counts too, since that is recording that it was watched now. The rule is "hidden while its latest progress is no newer than the removal".
- **Undo** shows for a few seconds in a notice at the bottom of the window. Removing with the keys puts focus on Undo; Back (or moving away) leaves it, and focus goes to the card beside the removed one.
- Removing a title's history (Library → History, ×) or clearing all history forgets the removal too.

Deleting progress is a separate, deliberate choice: Library → History removes a title's history, and "Mark as unwatched" forgets a film's or episode's progress.

The card's menu also offers **Mark as watched** for the film or episode it resumes, or **Mark S1 E4 as watched** for the next episode it offers, which moves the series on by one.

## Marking watched and unwatched

| Where                                                          | Actions                                                                                         |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| A film's page                                                  | **Mark as watched**, which turns into a pressed **Watched** button; pressing it marks unwatched |
| Film posters (catalogue rows and grids, search, the watchlist) | The poster's menu: **Mark as watched** / **Mark as unwatched**. A watched film shows a tick     |
| A series' page, beside Watchlist                               | The **⋯** menu: **Mark show as watched**, **Mark show as unwatched** (asks first)               |
| Beside the season picker                                       | The **⋯** menu: **Mark Season 2 as watched**, **Mark Season 2 as unwatched** (asks first)       |
| An episode                                                     | Its menu: **Mark as watched** / **Mark as unwatched**, and **Mark watched up to here**          |

Only the actions that would change something are offered: a season that is all watched offers only "unwatched", one never started only "watched". "Up to here" shows while an earlier episode is unwatched; it covers the episodes before this one in viewing order (earlier seasons included, specials left out) and this one. A special's "up to here" covers its own season.

What a mark does:

- **Watched** sets the film or episodes finished, as if they had just been watched in order: the last one marked becomes the title's latest, so Continue watching and the title's Play button move on to the episode after it, and the title moves to the top of History. Saved progress moves to the end; a video never played gets a row with no known length. Episodes already watched keep their dates (only the last one of the mark is always re-dated, so that the series continues from it).
- **Catching up never moves you back.** If every episode marked comes before the series' latest one (marking season 1 while partway through season 2), they are dated just before it, and Continue watching keeps resuming season 2.
- **Unwatched** forgets the progress of those videos, so they show as never played: no tick, no bar, not in History. A series falls back to its latest episode still watched or started. "Mark show as unwatched" forgets the whole show's history (as Library → History's × does).
- **Automatic tracking is unchanged.** Playback still marks progress finished at Settings → Playback → "Mark as watched at", and a watched film played again from the start becomes unfinished progress by the usual rule.

Watched state shows as a **Watched** tick on episodes, the pressed button on a film's page, a tick on film posters, and the existing progress bars on anything partly watched (episodes, Continue watching, History).

## Menus with the mouse, keyboard and remote

The same menu opens three ways:

- the **⋯** button over the card's top right corner, shown on hover and focus;
- a **right click** (or a long press, where the system turns it into one);
- the **Menu key**, or **Shift F10**, while the card is focused. A remote's Menu button works where it arrives as the Menu key (`ContextMenu`), as on Android's `KEYCODE_MENU`; untested on a TV.

The arrows pass the ⋯ buttons by, so Left and Right still go card to card; Tab reaches them. The menu is a `data-nav-layer`: arrows stay in it, Enter chooses, Back closes it and focus returns to the card. Opened with the keys, focus starts on the first action; a question ("Forget your progress in every episode of Season 2?") starts on Cancel. See [keyboard-and-remote.md](keyboard-and-remote.md).

## How it works

### Core

`src-tauri/src/library/mod.rs`, all on the active profile's rows (`ProfileLibrary`):

| Command                    | Does                                                                                                                                                                                               |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `library_continue_dismiss` | Stores `continue_dismissed (profile_id, type, id, dismissed_at)`: now, or the title's latest progress time if that is later (imported progress dated ahead). Nothing for a title with no history   |
| `library_continue_restore` | Deletes that row (Undo)                                                                                                                                                                            |
| `library_mark_watched`     | `title` and up to 5,000 `videos` (each once), upserted as completed with `position = duration`, dated in order ending now (or just before the latest episode, as above). Returns the title's state |
| `library_mark_unwatched`   | Deletes the history rows of up to 5,000 video ids of a title. Returns the title's state                                                                                                            |
| `library_watched_titles`   | Titles whose own video is completed (films), for poster ticks                                                                                                                                      |

`continue_watching` leaves out a title when a `continue_dismissed` row is at least as new as its latest progress. `remove_from_history` and `clear_history` delete dismissals with the history. Arguments are validated as they deserialize (`WatchedVideos`, `VideoIds`, and the existing `TitleSnapshot`, `MediaType`, `MediaId`); the commands are declared in `build.rs` and granted in `capabilities/default.json`.

Migration `0004_continue_dismissed.sql` adds the table, keyed by profile with `ON DELETE CASCADE`, so deleting a profile takes its dismissals with it. Nothing else in the schema changes: a manual mark is an ordinary history row, so History, the title page, Up next, Resume and a Stremio import treat it like any other. A Stremio import merges by date as before (newer progress wins per video), so it can bring back a video marked unwatched if Stremio's progress for it is newer.

### Renderer

- `features/library/watched-data.ts`: which episodes a season, show or "up to here" mark covers, what to send, and what each menu offers (unit-tested).
- `features/library/watch-actions.ts`: the menu actions, and `useWatchedFilm` for poster ticks.
- `features/library/library-store.ts`: `dismissFromContinue`, `restoreToContinue`, `markWatched`, `markUnwatched` (which update the title's state and reload the lists on show) and `watchedFilms`, read once and kept current by marks and playback.
- `components/action-menu.tsx` (`CardMenu`, `MenuButton`) and `components/toaster.tsx` with `stores/toast-store.ts` (the Undo notice).

### Trying it in the browser

`pnpm --filter @kiro/desktop dev:renderer` runs the renderer with the preview backend, which does all of the above in memory on a seeded library: Breaking Bad partway through season 2, The Bear between episodes, Inception half watched, Interstellar finished (a ticked poster in the watchlist). Reloading starts again from the seed, so move between pages with the sidebar to keep changes.
