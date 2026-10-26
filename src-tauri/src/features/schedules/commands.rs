//! Tauri command handlers for the schedules slice (M41): deserialize →
//! use-case → serialize.
//!
//! The one piece of logic that does live here is [`run_one`], the gate every
//! run passes through — scheduled and manual alike. It is here rather than in
//! the application layer because the thing being serialized is a process-wide
//! resource (open connections), and the state that owns it is a presentation
//! concern: the application layer takes its collaborators as arguments and has
//! no opinion about how many callers there are.

use std::collections::BTreeMap;
use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;

use crate::features::connections::commands::{connect_timeout, ConnectionsState};
use crate::features::settings::commands::SettingsState;
use crate::shared::error::AppError;

use super::application::{self, RunDeps};
use super::domain::{RunRecord, RunTrigger, Schedule};
use super::ports::{RunLogRepository, ScheduleRepository};

/// The event the renderer listens on so an open manager updates the moment a
/// run finishes, scheduled or manual. Payload: the [`RunRecord`].
pub const RUN_FINISHED_EVENT: &str = "schedules://run-finished";

/// Announced when a run STARTS, so an open manager can show the row working.
///
/// Needed because of the asymmetry between the two ways a run begins: a manual
/// run is a command the renderer awaited, so it knows. A scheduled one happens
/// in a background loop with no renderer in the call chain, so without this the
/// whole run — which can take minutes against a real server — is invisible, and
/// the row simply changes without explanation when it ends.
pub const RUN_STARTED_EVENT: &str = "schedules://run-started";

/// [`RUN_STARTED_EVENT`]'s payload.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunStarted {
    pub schedule_id: String,
    pub trigger: RunTrigger,
}

/// Managed state for the schedules slice, registered in `lib.rs`.
///
/// The repositories are `Arc` because the scheduler task shares these very
/// instances — their write mutexes are what keep the loop and the user's edits
/// from interleaving a save with a delete.
pub struct SchedulesState {
    schedules: Arc<dyn ScheduleRepository>,
    runs: Arc<dyn RunLogRepository>,
    /// Serializes every run in the process.
    ///
    /// Five schedules due at midnight open five connections IN SEQUENCE, not
    /// at once — and a user hitting "Run now" while the scheduler is working
    /// queues behind it rather than racing it for the same output file.
    gate: tokio::sync::Mutex<()>,
}

impl SchedulesState {
    pub fn new(schedules: Arc<dyn ScheduleRepository>, runs: Arc<dyn RunLogRepository>) -> Self {
        Self {
            schedules,
            runs,
            gate: tokio::sync::Mutex::new(()),
        }
    }

    pub fn schedules(&self) -> &dyn ScheduleRepository {
        self.schedules.as_ref()
    }

    pub fn runs(&self) -> &dyn RunLogRepository {
        self.runs.as_ref()
    }
}

/// Every schedule, in stored order.
#[tauri::command]
pub async fn schedule_list(state: State<'_, SchedulesState>) -> Result<Vec<Schedule>, AppError> {
    application::list_schedules(state.schedules())
}

/// Insert or update a schedule (send an empty `id` for a new one). Returns the
/// stored value, so the renderer learns the assigned id and the computed
/// `nextRunAt`.
#[tauri::command]
pub async fn schedule_save(
    state: State<'_, SchedulesState>,
    schedule: Schedule,
) -> Result<Schedule, AppError> {
    application::save_schedule(state.schedules(), schedule, application::now_local())
}

/// Remove a schedule and its run history.
#[tauri::command]
pub async fn schedule_delete(state: State<'_, SchedulesState>, id: String) -> Result<(), AppError> {
    application::delete_schedule(state.schedules(), state.runs(), &id)
}

/// Pause or resume a schedule. Returns the stored value with its recomputed
/// `nextRunAt`.
#[tauri::command]
pub async fn schedule_set_enabled(
    state: State<'_, SchedulesState>,
    id: String,
    enabled: bool,
) -> Result<Schedule, AppError> {
    application::set_schedule_enabled(state.schedules(), &id, enabled, application::now_local())
}

/// Every schedule's run history, keyed by schedule id.
#[tauri::command]
pub async fn schedule_runs(
    state: State<'_, SchedulesState>,
) -> Result<BTreeMap<String, Vec<RunRecord>>, AppError> {
    application::run_history(state.runs())
}

/// Run a schedule right now, from the manager's ▶ button.
///
/// Recorded as a MANUAL run and it does NOT move `nextRunAt`: "run now" means
/// "also run now", not "restart the clock". Someone testing a new report at
/// 16:00 must not thereby move their nightly 03:00 run to 16:00 tomorrow.
///
/// Returns the run record — including a failed one, which is a successful
/// command with a recorded failure, not an error. The manager renders it
/// either way.
#[tauri::command]
pub async fn schedule_run_now(
    app: AppHandle,
    state: State<'_, SchedulesState>,
    connections: State<'_, ConnectionsState>,
    settings: State<'_, SettingsState>,
    id: String,
) -> Result<RunRecord, AppError> {
    let schedule = state
        .schedules()
        .list()?
        .into_iter()
        .find(|s| s.id == id)
        .ok_or_else(|| AppError::NotFound(format!("schedule '{id}'")))?;

    Ok(run_one(
        &app,
        &state,
        &connections,
        connect_timeout(&settings),
        &schedule,
        RunTrigger::Manual,
    )
    .await)
}

/// Show a schedule's output in the OS file manager: the output folder itself,
/// or one of its files with the file selected.
///
/// Scoped HERE rather than by widening the opener capability. Granting
/// `opener:allow-open-path` would let the renderer ask the OS to open any path
/// it can name — the capability file currently allows four specific https URLs
/// and nothing else, and that restraint is worth keeping. This command
/// resolves the request against the schedule list first and refuses anything
/// no schedule owns, so the renderer gains exactly the reach this feature
/// needs.
///
/// Ownership is a COMPONENT-wise prefix test (`Path::starts_with`), not a
/// string one: a textual prefix would accept `/Reports2` for a schedule
/// writing to `/Reports`.
#[tauri::command]
pub async fn schedule_reveal(
    app: AppHandle,
    state: State<'_, SchedulesState>,
    path: String,
) -> Result<(), AppError> {
    let target = std::path::Path::new(&path);
    let owned = application::list_schedules(state.schedules())?
        .iter()
        .any(|schedule| {
            let directory = std::path::Path::new(&schedule.directory);
            target == directory || target.starts_with(directory)
        });
    if !owned {
        return Err(AppError::Invalid(format!(
            "{path} is not a scheduled report's output, so it was not opened"
        )));
    }
    if !target.exists() {
        // The normal case for a schedule that has not run yet: the folder is
        // created by the first run, not by saving the schedule.
        return Err(AppError::NotFound(format!(
            "{path} — it is created by the first run"
        )));
    }
    // A folder opens; a file is revealed with its parent open and the file
    // selected, which is what you want when checking a report landed.
    let result = if target.is_dir() {
        app.opener().open_path(path.clone(), None::<&str>)
    } else {
        app.opener().reveal_item_in_dir(target)
    };
    result.map_err(|err| AppError::Io(format!("Could not open {path}: {err}")))
}

/// Run one schedule behind the gate and announce the result.
///
/// Shared by [`schedule_run_now`] and the scheduler loop, so there is exactly
/// one definition of what running a schedule means at the process level.
/// Never returns an error: `run_schedule` records failures instead of raising
/// them.
pub async fn run_one(
    app: &AppHandle,
    state: &SchedulesState,
    connections: &ConnectionsState,
    timeout: std::time::Duration,
    schedule: &Schedule,
    trigger: RunTrigger,
) -> RunRecord {
    // After the gate, not before: with runs serialized, a schedule queued
    // behind another is waiting, not running, and saying otherwise would show
    // two rows working at once when only one is.
    let _guard = state.gate.lock().await;
    let _ = app.emit(
        RUN_STARTED_EVENT,
        RunStarted {
            schedule_id: schedule.id.clone(),
            trigger,
        },
    );
    let deps = RunDeps {
        connections: connections.repository(),
        registry: connections.registry(),
        secret_store: connections.secret_store(),
        manager: connections.manager(),
        schedules: state.schedules(),
        runs: state.runs(),
        timeout,
    };
    let record =
        application::run_schedule(&deps, schedule, trigger, application::now_local()).await;
    // Best-effort: with no window open there is nobody listening, and that is
    // the normal case for a 3am run.
    let _ = app.emit(RUN_FINISHED_EVENT, &record);
    record
}

/// Resolve the managed state the scheduler loop needs, or `None` when the app
/// is shutting down and the state has already gone.
pub fn scheduler_states(
    app: &AppHandle,
) -> Option<(State<'_, SchedulesState>, State<'_, ConnectionsState>)> {
    Some((app.try_state()?, app.try_state()?))
}
