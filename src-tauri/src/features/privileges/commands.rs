//! Tauri command handlers for the privileges slice (M39). Deserialize →
//! use-case → serialize; no logic lives here.
//!
//! Commands read the connections feature's managed `ConnectionsState` for the
//! open-handle manager — sanctioned cross-feature composition at the
//! presentation/application boundary (see the slice docs in `mod.rs`).
//!
//! `privilege_snapshot` and `privilege_preview` are pure reads.
//! `privilege_apply` is the only mutating command in the slice, and calls
//! `ensure_writable` FIRST — that call, not a hidden button, is what a
//! read-only workspace refuses on.

use tauri::State;

use crate::features::connections::application::ConnectionHandleId;
use crate::features::connections::commands::ConnectionsState;
use crate::features::privileges::domain::ops::GrantOp;
use crate::shared::engine::AlterResult;
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

/// Preview the SQL a batch of staged privilege edits implies (the "Review SQL"
/// panel). Pure: never mutates the database.
#[tauri::command]
pub async fn privilege_preview(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    ops: Vec<GrantOp>,
) -> Result<AlterResult, AppError> {
    application::preview_privileges(state.manager(), &handle_id, &ops).await
}

/// Apply a batch of staged privilege edits. Atomic only on the engines that
/// report `capabilities.atomic` — see the port docs.
#[tauri::command]
pub async fn privilege_apply(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    ops: Vec<GrantOp>,
) -> Result<AlterResult, AppError> {
    state
        .manager()
        .ensure_writable(&handle_id, "change privileges")
        .await?;
    application::apply_privileges(state.manager(), &handle_id, &ops).await
}
