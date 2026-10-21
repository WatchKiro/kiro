//! Profile commands (`crate::profiles`): list, add, change, delete and switch
//! profiles. PINs arrive as [`Pin`]s, which never appear in logs.
//!
//! `async` so database and file I/O run off the main thread.

use tauri::{AppHandle, Runtime, State};

use crate::core::error::Result;
use crate::core::state::AppState;
use crate::profiles::{Avatar, Pin, ProfileId, ProfileName, ProfilesOverview};

/// Every profile, the active one, and whether the picker shows at launch.
#[tauri::command]
pub async fn profile_list(state: State<'_, AppState>) -> Result<ProfilesOverview> {
    state.profiles().overview()
}

/// Adds a profile (at most `MAX_PROFILES`), optionally locked with a PIN.
#[tauri::command]
pub async fn profile_create(
    name: ProfileName,
    avatar: Avatar,
    pin: Option<Pin>,
    state: State<'_, AppState>,
) -> Result<ProfilesOverview> {
    state.profiles().create(name, avatar, pin)
}

/// `pin`: the profile's PIN, needed to change a locked profile other than
/// the active one. So for the commands below.
#[tauri::command]
pub async fn profile_rename(
    id: ProfileId,
    name: ProfileName,
    pin: Option<Pin>,
    state: State<'_, AppState>,
) -> Result<ProfilesOverview> {
    state.profiles().rename(id, name, pin.as_ref())
}

#[tauri::command]
pub async fn profile_set_avatar(
    id: ProfileId,
    avatar: Avatar,
    pin: Option<Pin>,
    state: State<'_, AppState>,
) -> Result<ProfilesOverview> {
    state.profiles().set_avatar(id, avatar, pin.as_ref())
}

/// Sets the profile's PIN to `newPin`, or removes it (`null`).
#[tauri::command]
pub async fn profile_set_pin(
    id: ProfileId,
    new_pin: Option<Pin>,
    pin: Option<Pin>,
    state: State<'_, AppState>,
) -> Result<ProfilesOverview> {
    state.profiles().set_pin(id, new_pin, pin.as_ref())
}

/// Deletes a profile with its library and settings, without its PIN (how a
/// forgotten one is got rid of). The renderer has the user type the name
/// first; the active profile and the last one are refused.
#[tauri::command]
pub async fn profile_delete(id: ProfileId, state: State<'_, AppState>) -> Result<ProfilesOverview> {
    state.profiles().delete(id)
}

/// Switches to a profile (its PIN, if it has one). Playback stops first, and
/// the import of a Stremio account read in the other profile is forgotten.
#[tauri::command]
pub async fn profile_switch<R: Runtime>(
    id: ProfileId,
    pin: Option<Pin>,
    app: AppHandle<R>,
    state: State<'_, AppState>,
) -> Result<ProfilesOverview> {
    // A wrong PIN leaves everything as it was.
    state.profiles().check_pin(id, pin.as_ref())?;
    #[cfg(native_player)]
    if let Some(player) = tauri::Manager::try_state::<crate::commands::player::PlayerState>(&app) {
        player.close_for_profile_switch();
    }
    let overview = state.profiles().switch(id, pin.as_ref())?;
    state.stremio_import().discard();
    // Discord and keeping the screen on follow the new profile's settings.
    if let Ok(settings) = state.settings().and_then(|settings| settings.get()) {
        crate::commands::settings::apply(&app, &settings);
    }
    Ok(overview)
}

/// Whether "Who's watching?" shows at launch.
#[tauri::command]
pub async fn profile_set_show_picker(
    show: bool,
    state: State<'_, AppState>,
) -> Result<ProfilesOverview> {
    state.profiles().set_show_picker(show)
}
