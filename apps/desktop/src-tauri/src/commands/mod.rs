//! Tauri command handlers — the only native functionality the renderer can reach.
//!
//! Conventions for new commands:
//! - Keep handlers thin; put logic in the owning module (`media`, `addons`, ...).
//! - Take validated argument types (e.g. [`crate::addons::AddonUrl`], which
//!   deserializes via `try_from`) so invalid input is rejected at the boundary.
//! - Return `crate::core::error::Result<T>`; errors serialize to `{ code, message }`
//!   without internal details.
//! - Register the handler in `lib.rs`, list it in `build.rs` and grant its
//!   `allow-*` permission in `capabilities/`.
//! - Mirror the request/response types in `apps/desktop/src/services/native.ts`.

pub mod addons;
pub mod app;
pub mod library;
#[cfg(native_player)]
pub mod player;
pub mod settings;
pub mod skip_times;
pub mod stremio;
