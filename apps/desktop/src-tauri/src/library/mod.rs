//! The local library: a watchlist and watch history (playback progress),
//! stored in the on-device [`Database`].
//!
//! Entries carry a snapshot of the title's display data (name, poster) so the
//! Library and "Continue watching" render without asking an addon.
//!
//! - [`types`] — validated inputs and the records returned to the renderer

pub mod types;

use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{OptionalExtension, Row, params};

pub use types::*;

use crate::core::error::{Error, Result};
use crate::storage::database::Database;

/// Watched at least this fraction of the video: counted as finished, so it
/// leaves "Continue watching" and is not offered for resuming. The default
/// for Settings → Playback → "Mark as watched at" (`settings::PlaybackSettings`).
pub const COMPLETED_FRACTION: f64 = 0.9;
/// Progress before this point (seconds) is not worth resuming.
pub const MIN_RESUME_SECONDS: f64 = 15.0;

pub const MAX_WATCHLIST_ITEMS: i64 = 10_000;
pub const DEFAULT_LIST_LIMIT: u32 = 100;
pub const MAX_LIST_LIMIT: u32 = 1_000;
/// Upper bound on the videos returned for one title (a long-running series).
const MAX_TITLE_VIDEOS: u32 = 5_000;

const HISTORY_COLUMNS: &str = "type, id, video_id, name, poster, season, episode, video_name, \
                               position, duration, completed, updated_at";

#[derive(Debug)]
pub struct Library {
    database: Database,
    /// Current time in Unix milliseconds; replaced in tests.
    clock: fn() -> i64,
}

impl Library {
    pub fn new(database: Database) -> Self {
        Self {
            database,
            clock: now_millis,
        }
    }

    // --- Watchlist -------------------------------------------------------------

    /// Watchlist items, most recently added first.
    pub fn watchlist(&self) -> Result<Vec<WatchlistItem>> {
        self.database.with(|connection| {
            let mut statement = connection.prepare(
                "SELECT type, id, name, poster, added_at FROM watchlist ORDER BY added_at DESC",
            )?;
            let items = statement
                .query_map([], |row| {
                    Ok(WatchlistItem {
                        title: TitleSnapshot {
                            r#type: MediaType::from_db(row.get(0)?),
                            id: MediaId::from_db(row.get(1)?),
                            name: DisplayName::from_db(row.get(2)?),
                            poster: row.get::<_, Option<String>>(3)?.map(PosterUrl::from_db),
                        },
                        added_at: row.get(4)?,
                    })
                })?
                .collect::<rusqlite::Result<_>>()?;
            Ok(items)
        })
    }

    /// Adds a title, or refreshes its snapshot if it is already listed (keeping
    /// its place in the list).
    pub fn add_to_watchlist(&self, title: TitleSnapshot) -> Result<WatchlistItem> {
        let now = (self.clock)();
        self.database.with(|connection| {
            let transaction = connection.transaction()?;
            let listed = transaction
                .query_row(
                    "SELECT 1 FROM watchlist WHERE type = ?1 AND id = ?2",
                    params![title.r#type.as_str(), title.id.as_str()],
                    |_| Ok(()),
                )
                .optional()?
                .is_some();
            let count: i64 =
                transaction.query_row("SELECT COUNT(*) FROM watchlist", [], |row| row.get(0))?;
            if !listed && count >= MAX_WATCHLIST_ITEMS {
                return Err(Error::invalid_argument("Your watchlist is full"));
            }
            let added_at: i64 = transaction.query_row(
                "INSERT INTO watchlist (type, id, name, poster, added_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT (type, id) DO UPDATE SET name = excluded.name, poster = excluded.poster
                 RETURNING added_at",
                params![
                    title.r#type.as_str(),
                    title.id.as_str(),
                    title.name.as_str(),
                    title.poster.as_ref().map(PosterUrl::as_str),
                    now
                ],
                |row| row.get(0),
            )?;
            transaction.commit()?;
            Ok(WatchlistItem { title, added_at })
        })
    }

    pub fn remove_from_watchlist(&self, r#type: &MediaType, id: &MediaId) -> Result<()> {
        self.database.with(|connection| {
            connection.execute(
                "DELETE FROM watchlist WHERE type = ?1 AND id = ?2",
                params![r#type.as_str(), id.as_str()],
            )?;
            Ok(())
        })
    }

    // --- History ---------------------------------------------------------------

    /// Saves progress with the default "watched" threshold.
    #[cfg(test)]
    pub fn record_progress(&self, progress: PlaybackProgress) -> Result<HistoryEntry> {
        self.record_progress_at(progress, COMPLETED_FRACTION)
    }

    /// Saves how far into a video playback got, replacing earlier progress for
    /// the same video. It counts as finished once `completed_fraction` of the
    /// video was watched (the user's setting, already clamped). The flag is
    /// worked out here, as progress is saved, and stored: changing the setting
    /// only affects progress saved afterwards, never earlier history.
    pub fn record_progress_at(
        &self,
        progress: PlaybackProgress,
        completed_fraction: f64,
    ) -> Result<HistoryEntry> {
        let PlaybackProgress {
            title,
            video,
            position,
            duration,
        } = progress;
        let entry = HistoryEntry {
            title,
            video,
            position,
            duration,
            completed: position >= duration * completed_fraction,
            updated_at: (self.clock)(),
        };
        self.database.with(|connection| {
            connection.execute(
                "INSERT INTO history (type, id, video_id, name, poster, season, episode, video_name,
                                      position, duration, completed, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
                 ON CONFLICT (type, id, video_id) DO UPDATE SET
                     name = excluded.name, poster = excluded.poster, season = excluded.season,
                     episode = excluded.episode, video_name = excluded.video_name,
                     position = excluded.position, duration = excluded.duration,
                     completed = excluded.completed, updated_at = excluded.updated_at",
                params![
                    entry.title.r#type.as_str(),
                    entry.title.id.as_str(),
                    entry.video.id.as_str(),
                    entry.title.name.as_str(),
                    entry.title.poster.as_ref().map(PosterUrl::as_str),
                    entry.video.season,
                    entry.video.episode,
                    entry.video.name.as_ref().map(DisplayName::as_str),
                    entry.position,
                    entry.duration,
                    entry.completed,
                    entry.updated_at,
                ],
            )?;
            Ok(())
        })?;
        Ok(entry)
    }

    /// Recently watched titles, newest first: the latest video of each title,
    /// with how many of its videos have been played.
    pub fn history(&self, limit: Option<u32>) -> Result<Vec<HistoryTitle>> {
        self.latest_per_title_with("1", limit, |row| {
            Ok(HistoryTitle {
                latest: history_entry(row)?,
                played_videos: row.get(12)?,
            })
        })
    }

    /// Titles to carry on with, newest first: unfinished progress worth
    /// resuming, plus series whose latest episode was finished (the renderer
    /// offers the next episode, or leaves the series out once it's over). A
    /// film whose latest progress was finished is left out.
    pub fn continue_watching(&self, limit: Option<u32>) -> Result<Vec<HistoryEntry>> {
        // `MIN_RESUME_SECONDS` is a constant, not user input.
        self.latest_per_title(
            &format!(
                "((completed = 0 AND position >= {MIN_RESUME_SECONDS:.1}) \
                  OR (type = 'series' AND completed = 1))"
            ),
            limit,
        )
    }

    fn latest_per_title(&self, filter: &str, limit: Option<u32>) -> Result<Vec<HistoryEntry>> {
        self.latest_per_title_with(filter, limit, history_entry)
    }

    /// The latest video of each title matching `filter`, newest first, read
    /// with `read` from [`HISTORY_COLUMNS`] plus the title's played videos.
    fn latest_per_title_with<T>(
        &self,
        filter: &str,
        limit: Option<u32>,
        read: impl Fn(&Row<'_>) -> rusqlite::Result<T>,
    ) -> Result<Vec<T>> {
        let limit = limit.unwrap_or(DEFAULT_LIST_LIMIT).clamp(1, MAX_LIST_LIMIT);
        self.database.with(|connection| {
            let mut statement = connection.prepare(&format!(
                "SELECT {HISTORY_COLUMNS}, played_videos FROM (
                     SELECT *, ROW_NUMBER() OVER (
                         PARTITION BY type, id ORDER BY updated_at DESC, video_id
                     ) AS rank,
                     COUNT(*) OVER (PARTITION BY type, id) AS played_videos
                     FROM history
                 )
                 WHERE rank = 1 AND {filter}
                 ORDER BY updated_at DESC
                 LIMIT ?1"
            ))?;
            let entries = statement
                .query_map([limit], read)?
                .collect::<rusqlite::Result<_>>()?;
            Ok(entries)
        })
    }

    /// Whether a title is on the watchlist, and the progress of each of its
    /// videos that has been played (newest first).
    pub fn title_state(&self, r#type: &MediaType, id: &MediaId) -> Result<TitleLibraryState> {
        self.database.with(|connection| {
            let in_watchlist = connection
                .query_row(
                    "SELECT 1 FROM watchlist WHERE type = ?1 AND id = ?2",
                    params![r#type.as_str(), id.as_str()],
                    |_| Ok(()),
                )
                .optional()?
                .is_some();
            let mut statement = connection.prepare(&format!(
                "SELECT {HISTORY_COLUMNS} FROM history WHERE type = ?1 AND id = ?2
                 ORDER BY updated_at DESC LIMIT ?3"
            ))?;
            let progress = statement
                .query_map(
                    params![r#type.as_str(), id.as_str(), MAX_TITLE_VIDEOS],
                    history_entry,
                )?
                .collect::<rusqlite::Result<_>>()?;
            Ok(TitleLibraryState {
                in_watchlist,
                progress,
            })
        })
    }

    /// Forgets all progress for a title.
    pub fn remove_from_history(&self, r#type: &MediaType, id: &MediaId) -> Result<()> {
        self.database.with(|connection| {
            connection.execute(
                "DELETE FROM history WHERE type = ?1 AND id = ?2",
                params![r#type.as_str(), id.as_str()],
            )?;
            Ok(())
        })
    }

    pub fn clear_history(&self) -> Result<()> {
        self.database.with(|connection| {
            connection.execute("DELETE FROM history", [])?;
            Ok(())
        })
    }

    // --- Import ----------------------------------------------------------------

    /// Adds titles from another app's library, keeping their `added_at`.
    /// Titles already listed are left exactly as they are; once the watchlist
    /// is full the rest fail. One transaction: all or nothing.
    pub fn import_watchlist(&self, items: &[WatchlistItem]) -> Result<ImportCounts> {
        self.database.with(|connection| {
            let transaction = connection.transaction()?;
            let mut count: i64 =
                transaction.query_row("SELECT COUNT(*) FROM watchlist", [], |row| row.get(0))?;
            let mut counts = ImportCounts::default();
            for WatchlistItem { title, added_at } in items {
                let listed = transaction
                    .query_row(
                        "SELECT 1 FROM watchlist WHERE type = ?1 AND id = ?2",
                        params![title.r#type.as_str(), title.id.as_str()],
                        |_| Ok(()),
                    )
                    .optional()?
                    .is_some();
                if listed {
                    counts.skipped += 1;
                    continue;
                }
                if count >= MAX_WATCHLIST_ITEMS {
                    counts.failed += 1;
                    continue;
                }
                transaction.execute(
                    "INSERT INTO watchlist (type, id, name, poster, added_at)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        title.r#type.as_str(),
                        title.id.as_str(),
                        title.name.as_str(),
                        title.poster.as_ref().map(PosterUrl::as_str),
                        added_at
                    ],
                )?;
                count += 1;
                counts.added += 1;
            }
            transaction.commit()?;
            Ok(counts)
        })
    }

    /// Merges progress from another app, video by video, by when it was
    /// watched: an entry replaces Kiro's progress for the same video only if
    /// it is newer, so nothing watched in Kiro since is lost. Entries keep
    /// their own `updated_at` and `completed`. One transaction.
    pub fn import_history(&self, entries: &[HistoryEntry]) -> Result<ImportCounts> {
        self.database.with(|connection| {
            let transaction = connection.transaction()?;
            let mut counts = ImportCounts::default();
            for entry in entries {
                let existing: Option<i64> = transaction
                    .query_row(
                        "SELECT updated_at FROM history WHERE type = ?1 AND id = ?2 AND video_id = ?3",
                        params![
                            entry.title.r#type.as_str(),
                            entry.title.id.as_str(),
                            entry.video.id.as_str()
                        ],
                        |row| row.get(0),
                    )
                    .optional()?;
                match existing {
                    Some(kiro) if kiro >= entry.updated_at => {
                        counts.skipped += 1;
                        continue;
                    }
                    Some(_) => counts.updated += 1,
                    None => counts.added += 1,
                }
                transaction.execute(
                    "INSERT INTO history (type, id, video_id, name, poster, season, episode,
                                          video_name, position, duration, completed, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
                     ON CONFLICT (type, id, video_id) DO UPDATE SET
                         position = excluded.position, duration = excluded.duration,
                         completed = excluded.completed, updated_at = excluded.updated_at,
                         season = COALESCE(excluded.season, history.season),
                         episode = COALESCE(excluded.episode, history.episode)",
                    params![
                        entry.title.r#type.as_str(),
                        entry.title.id.as_str(),
                        entry.video.id.as_str(),
                        entry.title.name.as_str(),
                        entry.title.poster.as_ref().map(PosterUrl::as_str),
                        entry.video.season,
                        entry.video.episode,
                        entry.video.name.as_ref().map(DisplayName::as_str),
                        entry.position,
                        entry.duration,
                        entry.completed,
                        entry.updated_at,
                    ],
                )?;
            }
            transaction.commit()?;
            Ok(counts)
        })
    }
}

/// Reads a row selected with [`HISTORY_COLUMNS`].
fn history_entry(row: &Row<'_>) -> rusqlite::Result<HistoryEntry> {
    Ok(HistoryEntry {
        title: TitleSnapshot {
            r#type: MediaType::from_db(row.get(0)?),
            id: MediaId::from_db(row.get(1)?),
            name: DisplayName::from_db(row.get(3)?),
            poster: row.get::<_, Option<String>>(4)?.map(PosterUrl::from_db),
        },
        video: VideoSnapshot {
            id: MediaId::from_db(row.get(2)?),
            season: row.get(5)?,
            episode: row.get(6)?,
            name: row.get::<_, Option<String>>(7)?.map(DisplayName::from_db),
        },
        position: row.get(8)?,
        duration: row.get(9)?,
        completed: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX)
        })
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicI64, Ordering};

    use serde_json::json;

    use super::*;
    use crate::storage::database::tests::temp_dir;

    /// A clock that advances by one second on every reading.
    fn ticking_clock() -> i64 {
        static NOW: AtomicI64 = AtomicI64::new(1_700_000_000_000);
        NOW.fetch_add(1_000, Ordering::Relaxed)
    }

    struct Fixture {
        library: Library,
        dir: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let dir = temp_dir("library");
            let library = Library {
                database: Database::new(&dir),
                clock: ticking_clock,
            };
            Self { library, dir }
        }

        fn reopen(&self) -> Library {
            Library::new(Database::new(&self.dir))
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    fn title(r#type: &str, id: &str, name: &str) -> TitleSnapshot {
        serde_json::from_value(json!({
            "type": r#type,
            "id": id,
            "name": name,
            "poster": format!("https://img.example/{id}.jpg"),
        }))
        .unwrap()
    }

    fn progress(
        title: &TitleSnapshot,
        video: &str,
        position: f64,
        duration: f64,
    ) -> PlaybackProgress {
        serde_json::from_value(json!({
            "title": title,
            "video": { "id": video },
            "position": position,
            "duration": duration,
        }))
        .unwrap()
    }

    fn titles(entries: &[HistoryTitle]) -> Vec<(&str, &str)> {
        entries
            .iter()
            .map(|title| {
                (
                    title.latest.title.id.as_str(),
                    title.latest.video.id.as_str(),
                )
            })
            .collect()
    }

    fn ids(entries: &[HistoryEntry]) -> Vec<(&str, &str)> {
        entries
            .iter()
            .map(|entry| (entry.title.id.as_str(), entry.video.id.as_str()))
            .collect()
    }

    #[test]
    fn watchlist_round_trips_newest_first() {
        let fixture = Fixture::new();
        let library = &fixture.library;
        assert!(library.watchlist().unwrap().is_empty());

        library
            .add_to_watchlist(title("movie", "tt1", "One"))
            .unwrap();
        library
            .add_to_watchlist(title("series", "tt2", "Two"))
            .unwrap();
        // Re-adding refreshes the snapshot without moving the item.
        library
            .add_to_watchlist(title("movie", "tt1", "One (renamed)"))
            .unwrap();

        let items = fixture.reopen().watchlist().unwrap();
        let names: Vec<_> = items.iter().map(|item| item.title.name.as_str()).collect();
        assert_eq!(names, ["Two", "One (renamed)"]);
        assert_eq!(
            items[1].title.poster.as_ref().map(PosterUrl::as_str),
            Some("https://img.example/tt1.jpg")
        );

        let (r#type, id) = (
            MediaType::parse("movie").unwrap(),
            MediaId::parse("tt1").unwrap(),
        );
        assert!(library.title_state(&r#type, &id).unwrap().in_watchlist);
        library.remove_from_watchlist(&r#type, &id).unwrap();
        assert!(!library.title_state(&r#type, &id).unwrap().in_watchlist);
        assert_eq!(library.watchlist().unwrap().len(), 1);
    }

    #[test]
    fn the_watched_threshold_applies_to_progress_as_it_is_saved() {
        let fixture = Fixture::new();
        let library = &fixture.library;
        let movie = title("movie", "tt1", "Movie");
        // 85% watched.
        let saved = library
            .record_progress_at(progress(&movie, "tt1", 850.0, 1000.0), 0.9)
            .unwrap();
        assert!(!saved.completed);
        let saved = library
            .record_progress_at(progress(&movie, "tt1", 850.0, 1000.0), 0.8)
            .unwrap();
        assert!(saved.completed);
        // Stored as saved: a later, higher threshold doesn't change history.
        let history = library.continue_watching(None).unwrap();
        assert!(
            history.is_empty(),
            "a finished film leaves Continue watching"
        );
    }

    #[test]
    fn continue_watching_follows_the_watched_threshold() {
        let fixture = Fixture::new();
        let library = &fixture.library;
        let film = title("movie", "tt1", "Film");
        let show = title("series", "tt2", "Show");
        // Both 85% watched: unfinished at 90%, finished at 80%.
        library
            .record_progress_at(progress(&film, "tt1", 850.0, 1000.0), 0.9)
            .unwrap();
        library
            .record_progress_at(progress(&show, "tt2:1:1", 850.0, 1000.0), 0.8)
            .unwrap();
        let entries = library.continue_watching(None).unwrap();
        let mut found: Vec<_> = entries
            .iter()
            .map(|entry| (entry.video.id.as_str(), entry.completed))
            .collect();
        found.sort();
        // The film is resumed; the finished episode stays, to offer the next one.
        assert_eq!(found, [("tt1", false), ("tt2:1:1", true)]);

        library
            .record_progress_at(progress(&film, "tt1", 850.0, 1000.0), 0.8)
            .unwrap();
        let entries = library.continue_watching(None).unwrap();
        assert_eq!(ids(&entries), [("tt2", "tt2:1:1")]);
    }

    #[test]
    fn records_progress_per_video_and_lists_titles_by_latest_activity() {
        let fixture = Fixture::new();
        let library = &fixture.library;
        let movie = title("movie", "tt1", "Movie");
        let show = title("series", "tt2", "Show");

        library
            .record_progress(progress(&movie, "tt1", 30.0, 6000.0))
            .unwrap();
        library
            .record_progress(progress(&show, "tt2:1:1", 1300.0, 1400.0))
            .unwrap();
        library
            .record_progress(progress(&show, "tt2:1:2", 200.0, 1400.0))
            .unwrap();
        // Saving the same video again replaces its progress.
        let latest = library
            .record_progress(progress(&movie, "tt1", 900.0, 6000.0))
            .unwrap();
        assert!(!latest.completed);

        let history = fixture.reopen().history(None).unwrap();
        assert_eq!(titles(&history), [("tt1", "tt1"), ("tt2", "tt2:1:2")]);
        assert_eq!(history[0].latest.position, 900.0);
        // The series is one entry, counting both of its played episodes.
        let played: Vec<_> = history.iter().map(|title| title.played_videos).collect();
        assert_eq!(played, [1, 2]);

        let state = library
            .title_state(
                &MediaType::parse("series").unwrap(),
                &MediaId::parse("tt2").unwrap(),
            )
            .unwrap();
        let videos: Vec<_> = state
            .progress
            .iter()
            .map(|entry| entry.video.id.as_str())
            .collect();
        assert_eq!(videos, ["tt2:1:2", "tt2:1:1"]);
        assert!(state.progress[1].completed);

        assert_eq!(titles(&library.history(Some(1)).unwrap()), [("tt1", "tt1")]);
    }

    #[test]
    fn continue_watching_keeps_series_between_episodes_but_skips_finished_films() {
        let fixture = Fixture::new();
        let library = &fixture.library;
        let started = title("movie", "tt1", "Started");
        let barely = title("movie", "tt2", "Barely");
        let finished = title("movie", "tt3", "Finished");
        let show = title("series", "tt4", "Show");

        library
            .record_progress(progress(&started, "tt1", 600.0, 6000.0))
            .unwrap();
        library
            .record_progress(progress(&barely, "tt2", 5.0, 6000.0))
            .unwrap();
        library
            .record_progress(progress(&finished, "tt3", 5900.0, 6000.0))
            .unwrap();
        library
            .record_progress(progress(&show, "tt4:1:1", 100.0, 1400.0))
            .unwrap();
        // The show's latest episode is finished: it stays, so the next
        // episode can be offered.
        library
            .record_progress(progress(&show, "tt4:1:2", 1400.0, 1400.0))
            .unwrap();

        let entries = library.continue_watching(None).unwrap();
        let mut found = ids(&entries);
        found.sort();
        assert_eq!(found, [("tt1", "tt1"), ("tt4", "tt4:1:2")]);
        assert_eq!(library.history(None).unwrap().len(), 4);
    }

    #[test]
    fn removes_and_clears_history() {
        let fixture = Fixture::new();
        let library = &fixture.library;
        let show = title("series", "tt4", "Show");
        library
            .record_progress(progress(&show, "tt4:1:1", 100.0, 1400.0))
            .unwrap();
        library
            .record_progress(progress(&show, "tt4:1:2", 100.0, 1400.0))
            .unwrap();
        library
            .record_progress(progress(
                &title("movie", "tt1", "Movie"),
                "tt1",
                100.0,
                1400.0,
            ))
            .unwrap();

        library
            .remove_from_history(
                &MediaType::parse("series").unwrap(),
                &MediaId::parse("tt4").unwrap(),
            )
            .unwrap();
        assert_eq!(titles(&library.history(None).unwrap()), [("tt1", "tt1")]);

        library.clear_history().unwrap();
        assert!(library.history(None).unwrap().is_empty());
    }

    fn imported(
        title: &TitleSnapshot,
        video: &str,
        position: f64,
        completed: bool,
        updated_at: i64,
    ) -> HistoryEntry {
        HistoryEntry {
            title: title.clone(),
            video: VideoSnapshot {
                id: MediaId::parse(video).unwrap(),
                season: None,
                episode: None,
                name: None,
            },
            position,
            duration: 1000.0,
            completed,
            updated_at,
        }
    }

    #[test]
    fn imports_watchlist_items_without_touching_listed_ones() {
        let fixture = Fixture::new();
        let library = &fixture.library;
        library
            .add_to_watchlist(title("movie", "tt1", "Kiro's name"))
            .unwrap();
        let items = [
            WatchlistItem {
                title: title("movie", "tt1", "Stremio's name"),
                added_at: 1,
            },
            WatchlistItem {
                title: title("series", "tt2", "Two"),
                added_at: 1_600_000_000_000,
            },
        ];
        let counts = library.import_watchlist(&items).unwrap();
        assert_eq!(
            counts,
            ImportCounts {
                added: 1,
                skipped: 1,
                ..ImportCounts::default()
            }
        );
        let watchlist = fixture.reopen().watchlist().unwrap();
        let found: Vec<_> = watchlist
            .iter()
            .map(|item| (item.title.name.as_str(), item.added_at))
            .collect();
        // Kiro's entry is untouched; the import keeps Stremio's date, so it
        // sorts by when it was really added.
        assert_eq!(found[1], ("Two", 1_600_000_000_000));
        assert_eq!(found[0].0, "Kiro's name");

        // Importing again changes nothing.
        let again = library.import_watchlist(&items).unwrap();
        assert_eq!((again.added, again.skipped), (0, 2));
    }

    #[test]
    fn imported_progress_never_overwrites_newer_kiro_progress() {
        let fixture = Fixture::new();
        let library = &fixture.library;
        let film = title("movie", "tt1", "Film");
        let show = title("series", "tt2", "Show");
        // Kiro progress, saved "now" (the ticking clock starts in 2023).
        let kiro = library
            .record_progress(progress(&film, "tt1", 100.0, 1000.0))
            .unwrap();
        library
            .record_progress(progress(&show, "tt2:1:1", 100.0, 1000.0))
            .unwrap();

        let counts = library
            .import_history(&[
                // Older than Kiro's: skipped.
                imported(&film, "tt1", 900.0, true, kiro.updated_at - 1),
                // Newer than Kiro's: replaces it.
                imported(&show, "tt2:1:1", 500.0, false, 4_000_000_000_000),
                // A video Kiro hasn't seen: added.
                imported(&show, "tt2:1:2", 200.0, false, 1_000_000_000_000),
            ])
            .unwrap();
        assert_eq!(
            counts,
            ImportCounts {
                added: 1,
                updated: 1,
                skipped: 1,
                failed: 0,
            }
        );

        let film_state = library
            .title_state(&film.r#type, &film.id)
            .unwrap()
            .progress;
        assert_eq!(film_state[0].position, 100.0);
        assert!(!film_state[0].completed);
        let show_state = library
            .title_state(&show.r#type, &show.id)
            .unwrap()
            .progress;
        let videos: Vec<_> = show_state
            .iter()
            .map(|entry| (entry.video.id.as_str(), entry.position, entry.updated_at))
            .collect();
        assert_eq!(
            videos,
            [
                ("tt2:1:1", 500.0, 4_000_000_000_000),
                ("tt2:1:2", 200.0, 1_000_000_000_000)
            ]
        );
        // Imported progress shows up in Continue watching straight away,
        // ordered by when it was watched.
        let resume = library.continue_watching(None).unwrap();
        assert_eq!(ids(&resume), [("tt2", "tt2:1:1"), ("tt1", "tt1")]);
    }

    #[test]
    fn serializes_for_the_renderer() {
        let fixture = Fixture::new();
        let entry = fixture
            .library
            .record_progress(
                serde_json::from_value(json!({
                    "title": { "type": "series", "id": "tt4", "name": "Show" },
                    "video": { "id": "tt4:1:2", "season": 1, "episode": 2, "name": "Pilot" },
                    "position": 100.5,
                    "duration": 1400,
                }))
                .unwrap(),
            )
            .unwrap();
        let json = serde_json::to_value(&entry).unwrap();
        assert_eq!(
            json,
            json!({
                "title": { "type": "series", "id": "tt4", "name": "Show", "poster": null },
                "video": { "id": "tt4:1:2", "season": 1, "episode": 2, "name": "Pilot" },
                "position": 100.5,
                "duration": 1400.0,
                "completed": false,
                "updatedAt": entry.updated_at,
            })
        );
    }
}
