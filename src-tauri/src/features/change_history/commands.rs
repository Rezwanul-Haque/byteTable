//! Tauri handlers for the change history (M48).

use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::features::connections::application::ConnectionHandleId;
use crate::features::connections::commands::ConnectionsState;
use crate::shared::error::AppError;

use super::application::{self, ApplyOutcome, CheckView, Limits, Recorded};
use super::domain::{key_string, Entry, Source, State as RowState};
use super::store::{HistoryStore, Summary, Totals};

/// Managed state, registered in `lib.rs`.
pub struct HistoryState {
    pub store: HistoryStore,
}

/// Run statements and record what they change. Read-only workspaces refuse
/// writes, exactly as `query_run` does.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn history_record(
    state: State<'_, ConnectionsState>,
    history: State<'_, HistoryState>,
    handle_id: ConnectionHandleId,
    connection_id: String,
    statements: Vec<String>,
    schema: String,
    source: Source,
    limits: Limits,
) -> Result<Recorded, AppError> {
    let manager = state.manager();
    if manager.is_read_only(&handle_id).await
        && !statements
            .iter()
            .all(|s| crate::shared::readonly::sql_is_read_only(s))
    {
        return Err(crate::shared::readonly::read_only_error(
            "run a statement that changes data or structure",
        ));
    }
    application::record(
        manager,
        &history.store,
        &handle_id,
        &connection_id,
        &statements,
        &schema,
        source,
        limits,
    )
    .await
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TruncateRecorded {
    pub affected: u64,
    pub entry: Option<String>,
}

/// Truncate a table, recording its rows first (source `action`).
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn history_truncate(
    state: State<'_, ConnectionsState>,
    history: State<'_, HistoryState>,
    handle_id: ConnectionHandleId,
    connection_id: String,
    schema: String,
    table: String,
    force: bool,
    limits: Limits,
) -> Result<TruncateRecorded, AppError> {
    state
        .manager()
        .ensure_writable(&handle_id, "empty tables")
        .await?;
    let (affected, entry) = application::record_truncate(
        state.manager(),
        &history.store,
        &handle_id,
        &connection_id,
        &schema,
        &table,
        force,
        limits,
    )
    .await?;
    Ok(TruncateRecorded { affected, entry })
}

/// Does this entry touch `table` (and, with `key`, that one row)?
fn touches(e: &Entry, table: &str, key: Option<&[Value]>) -> bool {
    let row = e
        .changes
        .iter()
        .any(|c| c.table == table && key.is_none_or(|k| key_string(&c.key) == key_string(k)));
    row || (key.is_none()
        && (e.tables.iter().any(|t| t == table)
            || (e.cant.is_some()
                && e.sql
                    .to_ascii_lowercase()
                    .contains(&table.to_ascii_lowercase()))))
}

/// A connection's history, newest first — optionally only the entries that
/// touch a table, or one row of it.
#[tauri::command]
pub fn history_list(
    history: State<'_, HistoryState>,
    connection_id: String,
    table: Option<String>,
    key: Option<Vec<Value>>,
) -> Result<Vec<Summary>, AppError> {
    let entries = history.store.list(&connection_id)?;
    Ok(entries
        .iter()
        .filter(|e| {
            table
                .as_deref()
                .is_none_or(|t| touches(e, t, key.as_deref()))
        })
        .map(Summary::from)
        .collect())
}

#[tauri::command]
pub fn history_get(
    history: State<'_, HistoryState>,
    id: String,
) -> Result<Option<Entry>, AppError> {
    history.store.get(&id)
}

/// What undo (or redo) would do to each row, and the statements it would run.
#[tauri::command]
pub async fn history_check(
    state: State<'_, ConnectionsState>,
    history: State<'_, HistoryState>,
    handle_id: ConnectionHandleId,
    id: String,
) -> Result<CheckView, AppError> {
    application::check_entry(state.manager(), &history.store, &handle_id, &id).await
}

/// Undo (or redo) an entry, provided every row's verdict still matches what
/// the user reviewed (`reviewed`, in change order).
#[tauri::command]
pub async fn history_apply(
    state: State<'_, ConnectionsState>,
    history: State<'_, HistoryState>,
    handle_id: ConnectionHandleId,
    id: String,
    reviewed: Vec<RowState>,
) -> Result<ApplyOutcome, AppError> {
    application::apply_entry(state.manager(), &history.store, &handle_id, &id, &reviewed).await
}

/// Clear one connection's history, or (no id) everyone's.
#[tauri::command]
pub fn history_clear(
    history: State<'_, HistoryState>,
    connection_id: Option<String>,
) -> Result<(), AppError> {
    history.store.clear(connection_id.as_deref())
}

/// Apply the retention limits now (a setting was lowered).
#[tauri::command]
pub fn history_prune(history: State<'_, HistoryState>, limits: Limits) -> Result<(), AppError> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64);
    history
        .store
        .prune(limits.keep_days, limits.keep_entries, now)
}

#[tauri::command]
pub fn history_totals(history: State<'_, HistoryState>) -> Result<Totals, AppError> {
    history.store.totals()
}

#[tauri::command]
pub fn history_set_recording(
    history: State<'_, HistoryState>,
    connection_id: String,
    on: bool,
) -> Result<(), AppError> {
    history.store.set_recording(&connection_id, on)
}

#[tauri::command]
pub fn history_recording(
    history: State<'_, HistoryState>,
    connection_id: String,
) -> Result<bool, AppError> {
    history.store.is_recording(&connection_id)
}
