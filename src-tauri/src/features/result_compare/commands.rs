//! Tauri handlers for result compare. A run is identified by the renderer's
//! `run_id`; [`compare_cancel`] stops it.
//!
//! The run itself is spawned, so a cancelled one still ends its transaction
//! (and gives its pooled connection back clean) after the command has already
//! answered.

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::State;
use tokio_util::sync::CancellationToken;

use crate::features::connections::application::ConnectionHandleId;
use crate::features::connections::commands::ConnectionsState;
use crate::shared::error::AppError;

use super::application::{self, CompareOutcome};

/// Managed state, registered in `lib.rs`: one cancel token per live run.
#[derive(Default)]
pub struct CompareState {
    runs: Mutex<HashMap<String, CancellationToken>>,
}

impl CompareState {
    fn start(&self, run_id: &str) -> CancellationToken {
        let mut runs = self.runs.lock().unwrap_or_else(|e| e.into_inner());
        let token = CancellationToken::new();
        runs.insert(run_id.to_string(), token.clone());
        token
    }
    fn finish(&self, run_id: &str) {
        let mut runs = self.runs.lock().unwrap_or_else(|e| e.into_inner());
        runs.remove(run_id);
    }
}

/// Run query A and query B. Only single read statements are sent; see
/// [`application::run`].
#[tauri::command]
pub async fn compare_run(
    state: State<'_, ConnectionsState>,
    compare: State<'_, CompareState>,
    handle_id: ConnectionHandleId,
    run_id: String,
    sql_a: String,
    sql_b: String,
    schema: Option<String>,
) -> Result<CompareOutcome, AppError> {
    let conn = state.manager().get_sql(&handle_id).await?;
    let token = compare.start(&run_id);
    let work = token.clone();
    let task = tauri::async_runtime::spawn(async move {
        application::run(&*conn, &sql_a, &sql_b, schema, &work).await
    });
    let out = tokio::select! {
        biased;
        _ = token.cancelled() => Ok(CompareOutcome { cancelled: true, ..Default::default() }),
        r = task => r.map_err(|e| AppError::Database(format!("The comparison stopped: {e}"))),
    };
    compare.finish(&run_id);
    out
}

/// Stop a run: the query in flight is dropped and the other side is not sent.
#[tauri::command]
pub fn compare_cancel(compare: State<'_, CompareState>, run_id: String) {
    let runs = compare.runs.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(token) = runs.get(&run_id) {
        token.cancel();
    }
}
