//! Addon commands: fetching from addon endpoints and the installed-addon list.
//!
//! Fetch commands return the addon's raw JSON; the renderer validates it with
//! `@kiro/addon-sdk` before use.

use std::collections::BTreeMap;

use serde_json::Value;
use tauri::State;

use crate::addons::AddonUrl;
use crate::addons::registry::InstalledAddon;
use crate::addons::requests::RequestId;
use crate::addons::transport::{AddonResource, ResourceRequest};
use crate::core::error::Result;
use crate::core::state::AppState;

#[tauri::command]
pub async fn addon_fetch_manifest(url: AddonUrl, state: State<'_, AppState>) -> Result<Value> {
    Ok(state.addon_transport()?.fetch_manifest(&url).await?)
}

/// Fetches `<resource>/<type>/<id>[/<extra>].json` relative to the addon's
/// manifest URL. With a `request_id`, the fetch can be aborted with
/// [`addon_cancel_request`] and then fails with a `CANCELLED` error.
#[tauri::command]
pub async fn addon_fetch_resource(
    url: AddonUrl,
    resource: AddonResource,
    r#type: String,
    id: String,
    extra: Option<BTreeMap<String, String>>,
    request_id: Option<RequestId>,
    state: State<'_, AppState>,
) -> Result<Value> {
    let request = ResourceRequest::new(resource, r#type, id, extra.unwrap_or_default())?;
    let transport = state.addon_transport()?;
    let fetch = transport.fetch_resource(&url, &request);
    match request_id {
        Some(request_id) => Ok(state.addon_requests().run(request_id, fetch)?.await??),
        None => Ok(fetch.await?),
    }
}

/// Aborts an [`addon_fetch_resource`] call by its `request_id`. Returns
/// whether it was still in flight.
#[tauri::command]
pub fn addon_cancel_request(request_id: RequestId, state: State<'_, AppState>) -> bool {
    state.addon_requests().cancel(&request_id)
}

// The registry commands are `async` so file I/O runs off the main thread.

#[tauri::command]
pub async fn addon_list(state: State<'_, AppState>) -> Result<Vec<InstalledAddon>> {
    state.addons().list()
}

/// Installs (or updates) an addon and returns the new list.
#[tauri::command]
pub async fn addon_install(
    addon: InstalledAddon,
    state: State<'_, AppState>,
) -> Result<Vec<InstalledAddon>> {
    state.addons().install(addon)
}

/// Removes an addon by manifest URL and returns the new list.
#[tauri::command]
pub async fn addon_uninstall(
    url: AddonUrl,
    state: State<'_, AppState>,
) -> Result<Vec<InstalledAddon>> {
    state.addons().uninstall(&url)
}

/// Turns an installed addon on or off without uninstalling it, and returns
/// the new list. Disabled addons are not queried.
#[tauri::command]
pub async fn addon_set_enabled(
    url: AddonUrl,
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<Vec<InstalledAddon>> {
    state.addons().set_enabled(&url, enabled)
}

/// Moves an installed addon to `index` in the priority order and returns the
/// new list.
#[tauri::command]
pub async fn addon_move(
    url: AddonUrl,
    index: u32,
    state: State<'_, AppState>,
) -> Result<Vec<InstalledAddon>> {
    state.addons().move_to(&url, index as usize)
}

/// The addons a new profile starts with, in priority order, whether or not
/// they are installed now.
#[tauri::command]
pub fn addon_defaults(state: State<'_, AppState>) -> Vec<InstalledAddon> {
    state.addons().defaults().to_vec()
}

/// Installs the default addons that are missing, at the end of the list, and
/// returns the new list.
#[tauri::command]
pub async fn addon_restore_defaults(state: State<'_, AppState>) -> Result<Vec<InstalledAddon>> {
    state.addons().restore_defaults()
}
