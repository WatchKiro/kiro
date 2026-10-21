use tauri::State;

use crate::core::error::{Error, Result};
use crate::core::state::AppState;
use crate::skip_times::{EpisodeQuery, SkipTimes};

/// Intro and credits times for an episode, from SkipDB, for a file of
/// `duration` seconds. Refused unless Settings → Playback → "Look up intro
/// times online" is on, so nothing leaves the device without it.
#[tauri::command]
pub async fn skip_times_lookup(
    imdb_id: String,
    season: u32,
    episode: u32,
    duration: f64,
    state: State<'_, AppState>,
) -> Result<SkipTimes> {
    if !state.settings()?.get()?.playback.online_skip_times {
        return Err(Error::invalid_argument(
            "Looking up intro times online is turned off",
        ));
    }
    let query = EpisodeQuery::new(&imdb_id, season, episode, duration)?;
    state.skip_times().lookup(&query).await
}
