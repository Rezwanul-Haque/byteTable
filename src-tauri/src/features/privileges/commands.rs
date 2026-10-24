//! Tauri command handlers for the privileges slice (M39). Deserialize →
//! use-case → serialize; no logic lives here.
//!
//! Commands read the connections feature's managed `ConnectionsState` for the
//! open-handle manager — sanctioned cross-feature composition at the
//! presentation/application boundary (see the slice docs in `mod.rs`).
//!
//! There is exactly one command, and it is **read-only**, so unlike
//! `structure::commands` nothing here calls `ensure_writable`. Any future
//! grant/revoke command must.

use tauri::State;

use crate::features::connections::application::ConnectionHandleId;
use crate::features::connections::commands::ConnectionsState;
use crate::shared::error::AppError;
use crate::shared::privileges::PrivilegeSnapshot;

use super::application;

/// Principals, role memberships and grants for the Privileges tab.
///
/// `schema` scopes the grant listing so the matrix stays bounded; `effective`
/// folds role inheritance in (and fills each grant's `via` chain) rather than
/// returning only what the catalog records directly.
#[tauri::command]
pub async fn privilege_snapshot(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    schema: Option<String>,
    effective: bool,
) -> Result<PrivilegeSnapshot, AppError> {
    application::privilege_snapshot(state.manager(), &handle_id, schema.as_deref(), effective).await
}
