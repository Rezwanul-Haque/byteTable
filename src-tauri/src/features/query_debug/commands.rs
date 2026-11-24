//! Tauri handlers for the query debugger.
//!
//! Steps run one per call so the renderer can fill the step list as counts
//! arrive and stop between steps. A run is identified by the renderer's
//! `run_id`: [`debug_cancel`] stops the step in flight, and the renderer
//! starts no further step for it. The renderer also cancels a run once its
//! last step is back, which is what lets the token map forget it.

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::State;
use tokio_util::sync::CancellationToken;

use crate::features::connections::application::ConnectionHandleId;
use crate::features::connections::commands::ConnectionsState;
use crate::shared::error::AppError;

use super::application::{self, PlanOutcome, StepOutcome};
use super::domain::DebugStep;

/// Managed state, registered in `lib.rs`: one cancel token per live run.
#[derive(Default)]
pub struct QueryDebugState {
    runs: Mutex<HashMap<String, CancellationToken>>,
}

impl QueryDebugState {
    fn token(&self, run_id: &str) -> CancellationToken {
        let mut runs = self.runs.lock().unwrap_or_else(|e| e.into_inner());
        // A cancelled run is over (stopped, or finished and released), so it
        // is forgotten here; a step in flight holds its own clone.
        runs.retain(|_, t| !t.is_cancelled());
        runs.entry(run_id.to_string()).or_default().clone()
    }
}

/// Plan the steps of `sql`. Executes nothing but a plan-only EXPLAIN.
#[tauri::command]
pub async fn debug_plan(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    sql: String,
    schema: Option<String>,
    sample: Option<u64>,
) -> Result<PlanOutcome, AppError> {
    application::plan(state.manager(), &handle_id, &sql, schema, sample).await
}

/// Run one step of a plan returned by [`debug_plan`]. Read-only on any
/// connection: every statement is checked before it is sent.
#[tauri::command]
pub async fn debug_run_step(
    state: State<'_, ConnectionsState>,
    debug: State<'_, QueryDebugState>,
    handle_id: ConnectionHandleId,
    run_id: String,
    step: DebugStep,
    schema: Option<String>,
) -> Result<StepOutcome, AppError> {
    let token = debug.token(&run_id);
    if token.is_cancelled() {
        return Ok(StepOutcome {
            cancelled: true,
            ..Default::default()
        });
    }
    application::run_step(state.manager(), &handle_id, &step, schema, &token).await
}

/// Stop a run: the step in flight is dropped and no further step starts.
#[tauri::command]
pub fn debug_cancel(debug: State<'_, QueryDebugState>, run_id: String) {
    let runs = debug.runs.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(token) = runs.get(&run_id) {
        token.cancel();
    }
}
