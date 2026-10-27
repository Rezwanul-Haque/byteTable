//! Tauri commands for the value-search slice. Deserialize → use-case →
//! serialize; no logic here. Cancel flags live in the managed
//! [`ValueSearchState`], keyed by a renderer-supplied run id. Command names
//! match the renderer wrappers in `src/features/value_search/api.ts`.
//!
//! No `ensure_writable` gate: the sweep only ever issues `SELECT`s, so it is as
//! available in a read-only workspace as it is anywhere else.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::ipc::Channel;
use tauri::State;

use crate::features::connections::application::ConnectionHandleId;
use crate::features::connections::commands::ConnectionsState;
use crate::shared::error::AppError;

use super::application::{self, RunCtx, SearchProgress, ValueSearchOptions, ValueSearchSummary};

/// Per-run cancellation flags, keyed by the renderer's run id. A run registers
/// a flag at start, `value_search_cancel` flips it, and the run drops it on
/// finish.
#[derive(Default)]
pub struct ValueSearchState {
    runs: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl ValueSearchState {
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

/// Sweep every table in scope for `needle`, streaming each hit as it lands and
/// honoring cancel (via `run_id` in the managed [`ValueSearchState`]).
///
/// **Full table scan per table** — see the slice docs. Read-only.
#[tauri::command]
pub async fn value_search_run(
    conns: State<'_, ConnectionsState>,
    search: State<'_, ValueSearchState>,
    handle_id: ConnectionHandleId,
    needle: String,
    options: Option<ValueSearchOptions>,
    run_id: String,
    on_progress: Channel<SearchProgress>,
) -> Result<ValueSearchSummary, AppError> {
    let cancel = search.register(&run_id);
    let progress = move |p: SearchProgress| {
        let _ = on_progress.send(p);
    };
    let result = application::run_search(
        conns.manager(),
        &handle_id,
        &needle,
        &options.unwrap_or_default(),
        RunCtx {
            cancel: &cancel,
            on_progress: &progress,
        },
    )
    .await;
    search.finish(&run_id);
    result
}

/// Signal an in-flight sweep to stop (checked between tables).
#[tauri::command]
pub async fn value_search_cancel(
    search: State<'_, ValueSearchState>,
    run_id: String,
) -> Result<(), AppError> {
    search.cancel(&run_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancel_flag_is_settable_per_run() {
        let st = ValueSearchState::default();
        let flag = st.register("run-1");
        assert!(!flag.load(Ordering::Relaxed));
        st.cancel("run-1");
        assert!(flag.load(Ordering::Relaxed));
        st.finish("run-1");
        // after finish, cancelling an unknown run is a no-op (no panic)
        st.cancel("run-1");
    }
}
