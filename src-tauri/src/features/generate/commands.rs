//! Tauri commands for the generate slice (M16). Deserialize → use-case →
//! serialize; no logic here. Cancel flags live in the managed [`GenerateState`],
//! keyed by a renderer-supplied run id. Command names match the renderer
//! wrappers in `src/features/generate/api.ts`.
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::ipc::Channel;
use tauri::State;

use crate::features::connections::application::ConnectionHandleId;
use crate::features::connections::commands::ConnectionsState;
use crate::shared::error::AppError;

use super::application::{self, GenProgress, RunCtx};
use super::domain::{GeneratePlan, GenerateSize, GenerateSummary};

/// Per-run cancellation flags, keyed by the renderer's run id. A run registers a
/// flag at start, `generate_cancel` flips it, and the run drops it on finish.
#[derive(Default)]
pub struct GenerateState {
    runs: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl GenerateState {
    pub fn register(&self, run_id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        self.runs
            .lock()
            .unwrap()
            .insert(run_id.to_string(), Arc::clone(&flag));
        flag
    }
    pub fn cancel(&self, run_id: &str) {
        if let Some(flag) = self.runs.lock().unwrap().get(run_id) {
            flag.store(true, Ordering::Relaxed);
        }
    }
    pub fn finish(&self, run_id: &str) {
        self.runs.lock().unwrap().remove(run_id);
    }
}

/// Build the display plan for the preview (no writes).
#[tauri::command]
pub async fn generate_preview(
    state: State<'_, ConnectionsState>,
    handle_id: ConnectionHandleId,
    schema: String,
    size: GenerateSize,
) -> Result<GeneratePlan, AppError> {
    application::build_plan(state.manager(), &handle_id, &schema, size).await
}

/// Generate and append data for the whole schema, streaming progress and
/// honoring cancel (via `run_id` in the managed [`GenerateState`]).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn generate_run(
    conns: State<'_, ConnectionsState>,
    gen: State<'_, GenerateState>,
    handle_id: ConnectionHandleId,
    schema: String,
    size: GenerateSize,
    run_id: String,
    seed: Option<u64>,
    on_progress: Channel<GenProgress>,
) -> Result<GenerateSummary, AppError> {
    let cancel = gen.register(&run_id);
    let progress = move |p: GenProgress| {
        let _ = on_progress.send(p);
    };
    let ctx = RunCtx {
        cancel: &cancel,
        on_progress: &progress,
        seed: seed.unwrap_or(0),
    };
    let result = application::run_generation(conns.manager(), &handle_id, &schema, size, ctx).await;
    gen.finish(&run_id);
    result
}

/// Signal a running generation to stop (checked between chunks).
#[tauri::command]
pub async fn generate_cancel(
    gen: State<'_, GenerateState>,
    run_id: String,
) -> Result<(), AppError> {
    gen.cancel(&run_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancel_flag_is_settable_per_run() {
        let st = GenerateState::default();
        let flag = st.register("run-1");
        assert!(!flag.load(Ordering::Relaxed));
        st.cancel("run-1");
        assert!(flag.load(Ordering::Relaxed));
        st.finish("run-1");
        // after finish, cancelling an unknown run is a no-op (no panic)
        st.cancel("run-1");
    }
}
