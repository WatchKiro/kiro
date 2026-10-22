//! Library commands: the watchlist and watch history (`crate::library`).
//!
//! Each acts on the active profile's library only. All are `async` so
//! database I/O runs off the main thread.

use tauri::State;

use crate::core::error::Result;
use crate::core::state::AppState;
use crate::library::{
    COMPLETED_FRACTION, HistoryEntry, HistoryTitle, MediaId, MediaType, PlaybackProgress,
    TitleLibraryState, TitleRef, TitleSnapshot, VideoIds, WatchedVideos, WatchlistItem,
};

#[tauri::command]
pub async fn library_watchlist(state: State<'_, AppState>) -> Result<Vec<WatchlistItem>> {
    state.library()?.watchlist()
}

/// Adds a title (or refreshes its snapshot) and returns the stored item.
#[tauri::command]
pub async fn library_watchlist_add(
    title: TitleSnapshot,
    state: State<'_, AppState>,
) -> Result<WatchlistItem> {
    state.library()?.add_to_watchlist(title)
}

#[tauri::command]
pub async fn library_watchlist_remove(
    r#type: MediaType,
    id: MediaId,
    state: State<'_, AppState>,
) -> Result<()> {
    state.library()?.remove_from_watchlist(&r#type, &id)
}

/// Saves playback progress for a video and returns the stored entry. Whether
/// it counts as watched follows Settings → Playback → "Mark as watched at";
/// unreadable settings fall back to the default threshold.
#[tauri::command]
pub async fn library_record_progress(
    progress: PlaybackProgress,
    state: State<'_, AppState>,
) -> Result<HistoryEntry> {
    let threshold = state
        .settings()
        .and_then(|settings| settings.get())
        .map(|settings| settings.playback.completed_fraction())
        .unwrap_or(COMPLETED_FRACTION);
    state.library()?.record_progress_at(progress, threshold)
}

/// Recently watched titles (the latest video of each, with how many videos
/// were played), newest first.
#[tauri::command]
pub async fn library_history(
    limit: Option<u32>,
    state: State<'_, AppState>,
) -> Result<Vec<HistoryTitle>> {
    state.library()?.history(limit)
}

/// Titles to carry on with (unfinished, or a series between episodes),
/// newest first, without those taken off the list.
#[tauri::command]
pub async fn library_continue_watching(
    limit: Option<u32>,
    state: State<'_, AppState>,
) -> Result<Vec<HistoryEntry>> {
    state.library()?.continue_watching(limit)
}

/// Watchlist membership and per-video progress for one title.
#[tauri::command]
pub async fn library_title_state(
    r#type: MediaType,
    id: MediaId,
    state: State<'_, AppState>,
) -> Result<TitleLibraryState> {
    state.library()?.title_state(&r#type, &id)
}

/// Forgets all progress for one title.
#[tauri::command]
pub async fn library_history_remove(
    r#type: MediaType,
    id: MediaId,
    state: State<'_, AppState>,
) -> Result<()> {
    state.library()?.remove_from_history(&r#type, &id)
}

#[tauri::command]
pub async fn library_history_clear(state: State<'_, AppState>) -> Result<()> {
    state.library()?.clear_history()
}

/// Takes a title off Continue watching until it is played again. Its history
/// and progress are kept.
#[tauri::command]
pub async fn library_continue_dismiss(
    r#type: MediaType,
    id: MediaId,
    state: State<'_, AppState>,
) -> Result<()> {
    state
        .library()?
        .dismiss_from_continue_watching(&r#type, &id)
}

/// Puts a title taken off Continue watching back (Undo).
#[tauri::command]
pub async fn library_continue_restore(
    r#type: MediaType,
    id: MediaId,
    state: State<'_, AppState>,
) -> Result<()> {
    state.library()?.restore_to_continue_watching(&r#type, &id)
}

/// Marks a film, or episodes of a series in the order given, as watched.
/// Returns the title's state afterwards.
#[tauri::command]
pub async fn library_mark_watched(
    title: TitleSnapshot,
    videos: WatchedVideos,
    state: State<'_, AppState>,
) -> Result<TitleLibraryState> {
    state.library()?.mark_watched(&title, &videos)
}

/// Marks videos of a title as unwatched, forgetting their progress. Returns
/// the title's state afterwards.
#[tauri::command]
pub async fn library_mark_unwatched(
    r#type: MediaType,
    id: MediaId,
    videos: VideoIds,
    state: State<'_, AppState>,
) -> Result<TitleLibraryState> {
    state.library()?.mark_unwatched(&r#type, &id, &videos)
}

/// Finished films, for the watched tick on posters.
#[tauri::command]
pub async fn library_watched_titles(state: State<'_, AppState>) -> Result<Vec<TitleRef>> {
    state.library()?.watched_titles()
}
