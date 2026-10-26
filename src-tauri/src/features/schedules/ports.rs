//! Ports: the traits the schedules use-cases need. Implemented by the
//! infrastructure adapters, faked in application tests.
//!
//! Both are deliberately *sync*, for the same reason as the saved-queries
//! port: the backing stores are small local JSON files, so each call is
//! effectively instant. The Tauri commands are `async fn` for consistency with
//! the rest of the app's surface, and calling these inline from them is fine.
//!
//! `Send + Sync`: one instance is shared across Tauri's async command
//! invocations AND the scheduler task.

use std::collections::BTreeMap;

use crate::shared::error::AppError;

use super::domain::{RunRecord, Schedule};

/// Persistence boundary for the schedule list.
pub trait ScheduleRepository: Send + Sync {
    /// Every schedule, in stored order.
    fn list(&self) -> Result<Vec<Schedule>, AppError>;

    /// Insert or update (by id). The use-case assigns the id, `created_at`
    /// and `next_run_at` before this is called, so adapters can rely on a
    /// fully-populated value.
    fn save(&self, schedule: &Schedule) -> Result<(), AppError>;

    /// Remove a schedule. `NotFound` for unknown ids, so the renderer can tell
    /// a stale list from a successful delete.
    fn delete(&self, id: &str) -> Result<(), AppError>;

    /// Write back ONLY the scheduler's bookkeeping field.
    ///
    /// Its own method rather than a `save` of the whole record, because the
    /// scheduler writes this on every run while the user may be editing the
    /// same schedule in the manager. A full save from the scheduler would
    /// clobber an edit saved a moment earlier with the stale copy the
    /// scheduler happened to be holding.
    fn set_next_run_at(&self, id: &str, next_run_at: u64) -> Result<(), AppError>;
}

/// Persistence boundary for run history, keyed by schedule id.
pub trait RunLogRepository: Send + Sync {
    /// Every schedule's history, newest LAST within each list.
    fn all(&self) -> Result<BTreeMap<String, Vec<RunRecord>>, AppError>;

    /// Append one run, trimming that schedule's history to the newest
    /// [`MAX_HISTORY`](super::domain::MAX_HISTORY) entries.
    fn record(&self, record: &RunRecord) -> Result<(), AppError>;

    /// Drop a schedule's history. Called when the schedule itself is deleted,
    /// so the log cannot grow orphans forever. Unknown ids are a no-op.
    fn forget(&self, schedule_id: &str) -> Result<(), AppError>;
}
