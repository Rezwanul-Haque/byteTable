//! Tauri handlers for query notebooks.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio_util::sync::CancellationToken;

use crate::features::connections::application::ConnectionHandleId;
use crate::features::connections::commands::ConnectionsState;
use crate::shared::engine::{QueryOptions, QueryResult};
use crate::shared::error::AppError;

use super::domain::{self, StatementKind};
use super::files::{self, FileStat};

/// Nudge to the renderer: the user asked to quit while notebooks are unsaved.
/// It answers with Save / Discard / Cancel, then calls [`app_quit`].
pub const QUIT_REQUESTED_EVENT: &str = "app://quit-requested";

/// Most rows a notebook cell asks for: it draws 200 and keeps 20 in the file,
/// but reports the true count up to this (the command-wide ceiling).
const MAX_CELL_ROWS: usize = 10_000;

/// Managed state, registered in `lib.rs`.
#[derive(Default)]
pub struct NotebooksState {
    /// One cancel token per cell run in flight, by the renderer's run id.
    runs: Mutex<HashMap<String, CancellationToken>>,
    /// Some notebook has unsaved changes (the renderer keeps this current).
    unsaved: AtomicBool,
    /// The user already answered the quit prompt; let the exit through.
    quit_confirmed: AtomicBool,
}

impl NotebooksState {
    /// Whether a quit should be held for the renderer's prompt.
    pub fn holds_quit(&self) -> bool {
        self.unsaved.load(Ordering::SeqCst) && !self.quit_confirmed.load(Ordering::SeqCst)
    }
}

/// Hold a quit while notebooks are unsaved: tell the renderer, which shows
/// its prompt. Returns true when the quit was held. Safe before setup (a
/// missing state never holds anything).
pub fn hold_quit(app: &AppHandle) -> bool {
    let Some(state) = app.try_state::<NotebooksState>() else {
        return false;
    };
    if !state.holds_quit() {
        return false;
    }
    let _ = app.emit(QUIT_REQUESTED_EVENT, ());
    true
}

/// One cell's run: its result, or that it was stopped.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CellRun {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<QueryResult>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub cancelled: bool,
}

/// Run one cell's statement. Stoppable with [`notebook_query_cancel`]: the
/// query future is dropped and the cell reports `cancelled`. Writes are
/// refused on a read-only workspace, as `query_run` refuses them.
#[tauri::command]
pub async fn notebook_query_run(
    state: State<'_, ConnectionsState>,
    notebooks: State<'_, NotebooksState>,
    handle_id: ConnectionHandleId,
    run_id: String,
    sql: String,
    schema: Option<String>,
) -> Result<CellRun, AppError> {
    let manager = state.manager();
    if manager.is_read_only(&handle_id).await && !crate::shared::readonly::sql_is_read_only(&sql) {
        return Err(crate::shared::readonly::read_only_error(
            "run a statement that changes data or structure",
        ));
    }
    let token = CancellationToken::new();
    notebooks
        .runs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(run_id.clone(), token.clone());
    let connection = manager.get_sql(&handle_id).await;
    let outcome = match connection {
        Err(e) => Err(e),
        Ok(conn) => {
            let options = QueryOptions {
                row_limit: MAX_CELL_ROWS,
                schema,
            };
            tokio::select! {
                _ = token.cancelled() => Ok(CellRun { result: None, cancelled: true }),
                r = conn.run_query(&sql, options) => r.map(|result| CellRun { result: Some(result), cancelled: false }),
            }
        }
    };
    notebooks
        .runs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&run_id);
    outcome
}

/// Stop a cell's run. A no-op once it has finished.
#[tauri::command]
pub fn notebook_query_cancel(notebooks: State<'_, NotebooksState>, run_id: String) {
    if let Some(token) = notebooks
        .runs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&run_id)
    {
        token.cancel();
    }
}

/// Read / write / transaction control, per statement, for Run and Run all.
#[tauri::command]
pub fn notebook_classify(statements: Vec<String>) -> Vec<StatementKind> {
    statements.iter().map(|s| domain::classify(s)).collect()
}

#[tauri::command]
pub fn notebook_read(path: String) -> Result<String, AppError> {
    files::read(Path::new(&path))
}

#[tauri::command]
pub fn notebook_write(path: String, text: String) -> Result<(), AppError> {
    files::write(Path::new(&path), &text)
}

#[tauri::command]
pub fn notebook_stat(path: String) -> Option<FileStat> {
    files::stat(Path::new(&path))
}

/// The renderer reports whether any notebook has unsaved changes.
#[tauri::command]
pub fn app_set_unsaved(notebooks: State<'_, NotebooksState>, unsaved: bool) {
    notebooks.unsaved.store(unsaved, Ordering::SeqCst);
}

/// Quit after the renderer's prompt (or when nothing is unsaved).
#[tauri::command]
pub fn app_quit(app: AppHandle, notebooks: State<'_, NotebooksState>) {
    notebooks.quit_confirmed.store(true, Ordering::SeqCst);
    app.exit(0);
}
