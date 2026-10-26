//! Use-cases for the schedules slice (M41). Depend on domain + ports, plus —
//! for the run path only — the connections slice's application layer.
//!
//! That cross-slice dependency is the sanctioned composition pattern this app
//! already uses in browse / insights / mutate / export: open connection
//! handles are owned by `ConnectionManager`, and a feature that needs one
//! consumes it here rather than opening its own driver. Two things make this
//! slice's use of it different from those, and both are deliberate:
//!
//! 1. **It opens its own connection.** Every other slice receives a handle the
//!    renderer already opened. A scheduled run has no renderer, so it opens one
//!    from the saved connection id, uses it, and closes it. It never borrows
//!    the user's workspace handle, which may be mid-transaction or about to be
//!    closed from under it.
//! 2. **It opens READ-ONLY, always.** See [`run_schedule`].

use std::collections::BTreeMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use chrono::{DateTime, Local, TimeZone};

use crate::features::connections::application::{
    self as connections_app, ConnectionHandleId, ConnectionManager, ConnectorRegistry, OpenTarget,
    TransientSecrets,
};
use crate::features::connections::domain::Env;
use crate::features::connections::ports::ConnectionRepository;
use crate::features::connections::secrets::SecretStore;
use crate::features::export::application::save_text_file_atomic;
use crate::shared::engine::QueryOptions;
use crate::shared::error::AppError;

use super::domain::{
    resolve_sql_tokens, rows_to_csv, rows_to_json, sql_only_reads, OutputFormat, RunRecord,
    RunTrigger, Schedule, WRITE_REFUSED,
};
use super::ports::{RunLogRepository, ScheduleRepository};

/// Everything the run path needs, in one place.
///
/// A struct rather than nine loose parameters: unlike `open_connection`'s
/// argument list — where each one is a decision the caller makes per call —
/// these are fixed collaborators resolved once from the composition root, and
/// the scheduler passes the identical set on every tick.
pub struct RunDeps<'a> {
    pub connections: &'a dyn ConnectionRepository,
    pub registry: &'a ConnectorRegistry,
    pub secret_store: &'a dyn SecretStore,
    pub manager: &'a ConnectionManager,
    pub schedules: &'a dyn ScheduleRepository,
    pub runs: &'a dyn RunLogRepository,
    /// Connect timeout, resolved from settings exactly as `connection_open`
    /// resolves it.
    pub timeout: Duration,
}

/// Every schedule, in stored order.
pub fn list_schedules(repository: &dyn ScheduleRepository) -> Result<Vec<Schedule>, AppError> {
    repository.list()
}

/// Insert or update a schedule.
///
/// New entries (empty `id`) get a UUID and a `created_at`. `next_run_at` is
/// ALWAYS recomputed here, never taken from the renderer: it is scheduler
/// bookkeeping, and an edit that changes the recurrence must not keep pointing
/// at the old recurrence's next occurrence. A disabled schedule gets 0 — there
/// is no next run to point at.
pub fn save_schedule(
    repository: &dyn ScheduleRepository,
    mut schedule: Schedule,
    now: DateTime<Local>,
) -> Result<Schedule, AppError> {
    schedule.name = schedule.name.trim().to_string();
    if let Some(message) = schedule.validation_error() {
        return Err(AppError::Invalid(message.into()));
    }
    if schedule.id.trim().is_empty() {
        schedule.id = uuid::Uuid::new_v4().to_string();
        schedule.created_at = epoch_ms(now);
    }
    schedule.next_run_at = next_run_at(&schedule, now);
    repository.save(&schedule)?;
    Ok(schedule)
}

/// Remove a schedule and its history. The history goes too, so the log cannot
/// accumulate entries for schedules that no longer exist — and a new schedule
/// that happens to reuse the id cannot inherit someone else's failures.
pub fn delete_schedule(
    repository: &dyn ScheduleRepository,
    runs: &dyn RunLogRepository,
    id: &str,
) -> Result<(), AppError> {
    repository.delete(id)?;
    // Best-effort: the schedule is already gone, and failing the whole delete
    // because its diagnostic log would not rewrite helps nobody.
    let _ = runs.forget(id);
    Ok(())
}

/// Pause or resume a schedule, recomputing `next_run_at` from NOW on resume —
/// not from whatever it held when it was paused, which may be months stale and
/// would make the resume fire instantly via the catch-up path.
pub fn set_schedule_enabled(
    repository: &dyn ScheduleRepository,
    id: &str,
    enabled: bool,
    now: DateTime<Local>,
) -> Result<Schedule, AppError> {
    let mut schedule = repository
        .list()?
        .into_iter()
        .find(|s| s.id == id)
        .ok_or_else(|| AppError::NotFound(format!("schedule '{id}'")))?;
    schedule.enabled = enabled;
    schedule.next_run_at = next_run_at(&schedule, now);
    repository.save(&schedule)?;
    Ok(schedule)
}

/// Every schedule's run history, keyed by schedule id.
pub fn run_history(
    runs: &dyn RunLogRepository,
) -> Result<BTreeMap<String, Vec<RunRecord>>, AppError> {
    runs.all()
}

/// The ids of the schedules due to run at `now`.
///
/// A disabled schedule is never due. A schedule whose `next_run_at` is 0 has
/// never been scheduled (hand-written file, or a build that predates the
/// field) — it is NOT run on the spot; the caller stamps a next run on it and
/// it fires then. Firing immediately would mean every app launch runs every
/// such schedule, which is exactly the behaviour the bounded catch-up exists
/// to prevent.
pub fn due_schedule_ids(schedules: &[Schedule], now: DateTime<Local>) -> Vec<String> {
    let now_ms = epoch_ms(now);
    schedules
        .iter()
        .filter(|s| s.enabled && s.next_run_at > 0 && s.next_run_at <= now_ms)
        .map(|s| s.id.clone())
        .collect()
}

/// The schedules whose `next_run_at` needs stamping before they can ever be
/// due: enabled, never scheduled. Returned as `(id, next_run_at)` pairs.
pub fn missing_next_runs(schedules: &[Schedule], now: DateTime<Local>) -> Vec<(String, u64)> {
    schedules
        .iter()
        .filter(|s| s.enabled && s.next_run_at == 0)
        .map(|s| (s.id.clone(), next_run_at(s, now)))
        .collect()
}

/// `next_run_at` for a schedule as of `now`: the next occurrence for an
/// enabled schedule, 0 for a disabled one.
///
/// Computed from NOW, never from the stale stored value. That is what makes
/// the catch-up *bounded*: a laptop closed over a long weekend produces one
/// Monday-morning run of a nightly report, not three, because the moment it
/// runs the next time is measured from the present.
pub fn next_run_at(schedule: &Schedule, now: DateTime<Local>) -> u64 {
    if !schedule.enabled {
        return 0;
    }
    schedule
        .recurrence
        .next_due_after(now)
        .map(epoch_ms)
        .unwrap_or(0)
}

/// Run one schedule to completion and record the outcome.
///
/// **Infallible by design** — it returns a [`RunRecord`], not a `Result`. Every
/// failure (a deleted connection, an unreachable server, a SQL error, a full
/// disk) is a recorded failed run rather than an error propagated to a caller
/// that, in the scheduled case, is a background loop with nobody to tell. The
/// manager shows the failure; the next occurrence is the retry.
///
/// The connection is opened **read-only** (`read_only_request: true`), so
/// `shared::readonly` refuses anything that is not provably a read. Not a
/// checkbox: an unattended `DELETE` at 3am with nobody watching is the one
/// failure mode in this feature that cannot be undone. This composes with the
/// existing rule in `open_connection` — an entry saved read-only can never be
/// opened writable — so the request can only ever tighten.
///
/// The run deliberately bypasses the renderer's `MAX_ROW_LIMIT` clamp. That
/// constant exists to stop an unbounded result set crossing the IPC boundary;
/// this path writes to a file and never goes near IPC. `truncated` is recorded
/// so a report quietly losing rows to the schedule's own limit is visible in
/// the history.
pub async fn run_schedule(
    deps: &RunDeps<'_>,
    schedule: &Schedule,
    trigger: RunTrigger,
    now: DateTime<Local>,
) -> RunRecord {
    let started = SystemTime::now();
    let outcome = execute(deps, schedule, now).await;
    let duration_ms = started.elapsed().map(|d| d.as_millis() as u64).unwrap_or(0);

    let record = match outcome {
        Ok(success) => RunRecord {
            schedule_id: schedule.id.clone(),
            started_at: epoch_ms(now),
            duration_ms,
            trigger,
            path: Some(success.path),
            row_count: success.row_count,
            truncated: success.truncated,
            error: None,
        },
        Err(err) => RunRecord {
            schedule_id: schedule.id.clone(),
            started_at: epoch_ms(now),
            duration_ms,
            trigger,
            path: None,
            row_count: 0,
            truncated: false,
            error: Some(err.to_string()),
        },
    };
    // A history write that fails must not turn a successful run into a failed
    // one — the report is on disk either way.
    let _ = deps.runs.record(&record);
    record
}

/// What a successful run produced.
struct RunSuccess {
    path: String,
    row_count: u64,
    truncated: bool,
}

/// The run itself, as a `Result` so every step can use `?`. Wrapped by
/// [`run_schedule`], which is the part that cannot fail.
async fn execute(
    deps: &RunDeps<'_>,
    schedule: &Schedule,
    now: DateTime<Local>,
) -> Result<RunSuccess, AppError> {
    // Before anything else, and before a socket is opened: the SQL must
    // provably only read.
    //
    // Belt AND braces. `save_schedule` already refuses a writing statement, so
    // this can only fire on a hand-edited `schedules.json` — which is exactly
    // the case worth guarding, because the alternative is that editing a text
    // file by hand is a way to get an unattended `DELETE` at 3am. Opening the
    // connection read-only would catch it too, but only at the command layer's
    // guard, which this path does not pass through: `application::run_query`
    // is below `refuse_writes_in_read_only`, not above it.
    if !sql_only_reads(&schedule.sql) {
        return Err(AppError::ReadOnly(WRITE_REFUSED.into()));
    }

    let saved = deps
        .connections
        .get(&schedule.connection_id)?
        .ok_or_else(|| {
            AppError::NotFound(format!(
                "the connection this schedule runs against (id '{}') — it was deleted; \
                 point the schedule at another connection",
                schedule.connection_id
            ))
        })?;

    let opened = connections_app::open_connection(
        deps.connections,
        deps.registry,
        deps.secret_store,
        deps.manager,
        OpenTarget::SavedId(schedule.connection_id.clone()),
        &TransientSecrets::new(None, None),
        deps.timeout,
        // Read-only, always. See the doc comment on `run_schedule`.
        true,
    )
    .await?;

    // Everything from here on must close the handle, success or not — a leaked
    // handle is a connection held open until the app quits.
    let result =
        query_and_write(deps, schedule, now, env_label(saved.env), &opened.handle_id).await;
    let _ = connections_app::close_connection(deps.manager, &opened.handle_id).await;
    result
}

/// Run the SQL, format it, write it, prune old output.
async fn query_and_write(
    deps: &RunDeps<'_>,
    schedule: &Schedule,
    now: DateTime<Local>,
    env: &str,
    handle: &ConnectionHandleId,
) -> Result<RunSuccess, AppError> {
    let sql = resolve_sql_tokens(&schedule.sql, now);
    let result = connections_app::run_query(
        deps.manager,
        handle,
        &sql,
        QueryOptions {
            row_limit: schedule.row_limit as usize,
            schema: schedule.schema.clone(),
        },
    )
    .await?;

    let columns: Vec<String> = result.columns.iter().map(|c| c.name.clone()).collect();
    let text = match schedule.format {
        OutputFormat::Csv => rows_to_csv(&columns, &result.rows),
        OutputFormat::Json => rows_to_json(&columns, &result.rows),
    };

    let directory = std::path::Path::new(&schedule.directory);
    std::fs::create_dir_all(directory).map_err(|err| {
        AppError::Io(format!(
            "Could not create the output folder {}: {err}",
            schedule.directory
        ))
    })?;
    let path = directory.join(schedule.output_filename(now, env));
    let path_text = path.to_string_lossy().to_string();
    save_text_file_atomic(&path_text, &text, false)?;

    // Pruning is best-effort and runs after the write: failing a run that
    // produced its report, because an OLD file would not delete, would be
    // backwards.
    prune_outputs(schedule, directory, env);

    Ok(RunSuccess {
        path: path_text,
        row_count: result.row_count as u64,
        truncated: result.truncated,
    })
}

/// Delete this schedule's oldest output files beyond `keep`.
///
/// Only files [`Schedule::owns_filename`] accepts are even considered, so the
/// pruner can never delete something the schedule did not write — a shared
/// Reports folder is the normal case, not the exception. Ordering is by
/// modification time, with the filename as a tiebreak so a batch of files
/// written in the same second still prunes deterministically.
fn prune_outputs(schedule: &Schedule, directory: &std::path::Path, env: &str) {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    let mut owned: Vec<(SystemTime, String, std::path::PathBuf)> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if !path.is_file() {
                return None;
            }
            let name = path.file_name()?.to_str()?.to_string();
            if !schedule.owns_filename(&name, env) {
                return None;
            }
            let modified = entry
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(UNIX_EPOCH);
            Some((modified, name, path))
        })
        .collect();

    let keep = schedule.keep as usize;
    if owned.len() <= keep {
        return;
    }
    owned.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    for (_, _, path) in owned.iter().take(owned.len() - keep) {
        let _ = std::fs::remove_file(path);
    }
}

/// The `{{env}}` token's value. Matches the renderer's `normalizeEnv` output,
/// so a scheduled filename and a manual export of the same connection carry
/// the same word.
fn env_label(env: Env) -> &'static str {
    match env {
        Env::Dev => "dev",
        Env::Staging => "staging",
        Env::Production => "production",
    }
}

/// `now` as Unix epoch milliseconds.
fn epoch_ms(now: DateTime<Local>) -> u64 {
    now.timestamp_millis().max(0) as u64
}

/// Epoch milliseconds back into a local instant, for the renderer-facing
/// bookkeeping the scheduler does. Falls back to the epoch on an out-of-range
/// value rather than panicking.
pub fn local_from_ms(ms: u64) -> DateTime<Local> {
    Local
        .timestamp_millis_opt(ms as i64)
        .single()
        .unwrap_or_else(|| Local.timestamp_nanos(0))
}

/// The current local instant. One place, so tests can pass their own `now`
/// everywhere else.
pub fn now_local() -> DateTime<Local> {
    Local::now()
}

/// `SystemTime::now()` as epoch milliseconds.
pub fn now_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;
    use crate::features::connections::domain::SavedConnection;
    use crate::features::connections::infrastructure::JsonFileConnectionRepository;
    use crate::features::connections::secrets::InMemorySecretStore;
    use crate::features::schedules::domain::{OutputFormat, Recurrence};
    use crate::features::schedules::infrastructure::{
        JsonFileRunLogRepository, JsonFileScheduleRepository,
    };
    use crate::shared::engine::{ConnectionParams, Engine};

    /// In-memory fake implementing the schedule port.
    #[derive(Default)]
    struct FakeSchedules {
        items: Mutex<Vec<Schedule>>,
    }

    impl ScheduleRepository for FakeSchedules {
        fn list(&self) -> Result<Vec<Schedule>, AppError> {
            Ok(self.items.lock().unwrap().clone())
        }
        fn save(&self, schedule: &Schedule) -> Result<(), AppError> {
            let mut items = self.items.lock().unwrap();
            match items.iter_mut().find(|s| s.id == schedule.id) {
                Some(existing) => *existing = schedule.clone(),
                None => items.push(schedule.clone()),
            }
            Ok(())
        }
        fn delete(&self, id: &str) -> Result<(), AppError> {
            let mut items = self.items.lock().unwrap();
            let before = items.len();
            items.retain(|s| s.id != id);
            if items.len() == before {
                return Err(AppError::NotFound(format!("schedule '{id}'")));
            }
            Ok(())
        }
        fn set_next_run_at(&self, id: &str, next_run_at: u64) -> Result<(), AppError> {
            if let Some(found) = self.items.lock().unwrap().iter_mut().find(|s| s.id == id) {
                found.next_run_at = next_run_at;
            }
            Ok(())
        }
    }

    /// In-memory fake implementing the run-log port.
    #[derive(Default)]
    struct FakeRuns {
        items: Mutex<BTreeMap<String, Vec<RunRecord>>>,
    }

    impl RunLogRepository for FakeRuns {
        fn all(&self) -> Result<BTreeMap<String, Vec<RunRecord>>, AppError> {
            Ok(self.items.lock().unwrap().clone())
        }
        fn record(&self, record: &RunRecord) -> Result<(), AppError> {
            self.items
                .lock()
                .unwrap()
                .entry(record.schedule_id.clone())
                .or_default()
                .push(record.clone());
            Ok(())
        }
        fn forget(&self, schedule_id: &str) -> Result<(), AppError> {
            self.items.lock().unwrap().remove(schedule_id);
            Ok(())
        }
    }

    fn at(y: i32, m: u32, d: u32, h: u32, min: u32) -> DateTime<Local> {
        Local
            .with_ymd_and_hms(y, m, d, h, min, 0)
            .single()
            .expect("unambiguous local time")
    }

    fn new_schedule() -> Schedule {
        Schedule {
            id: String::new(),
            name: "Nightly orders".into(),
            enabled: true,
            connection_id: "conn-1".into(),
            schema: None,
            saved_query_id: None,
            sql: "SELECT 1".into(),
            recurrence: Recurrence::Daily { hour: 3, minute: 0 },
            format: OutputFormat::Csv,
            directory: "/tmp/reports".into(),
            filename: "{{name}}_{{date}}".into(),
            keep: 3,
            row_limit: 1000,
            created_at: 0,
            next_run_at: 0,
        }
    }

    // --- CRUD -------------------------------------------------------------

    #[test]
    fn save_assigns_an_id_a_created_at_and_a_next_run() {
        let repo = FakeSchedules::default();
        let now = at(2026, 10, 26, 10, 0);
        let saved = save_schedule(&repo, new_schedule(), now).expect("save");
        assert!(!saved.id.is_empty());
        assert_eq!(saved.created_at, epoch_ms(now));
        // Daily at 03:00, saved at 10:00 → tomorrow.
        assert_eq!(saved.next_run_at, epoch_ms(at(2026, 10, 27, 3, 0)));
        assert_eq!(list_schedules(&repo).expect("list"), vec![saved]);
    }

    #[test]
    fn save_trims_the_name_and_rejects_an_invalid_schedule() {
        let repo = FakeSchedules::default();
        let now = at(2026, 10, 26, 10, 0);
        let padded = Schedule {
            name: "  Padded  ".into(),
            ..new_schedule()
        };
        assert_eq!(
            save_schedule(&repo, padded, now).expect("save").name,
            "Padded"
        );

        let blank = Schedule {
            name: "   ".into(),
            ..new_schedule()
        };
        let err = save_schedule(&repo, blank, now).unwrap_err();
        assert!(matches!(err, AppError::Invalid(_)));
        assert!(err.to_string().contains("Schedule name is required."));
        // The rejected one was not stored.
        assert_eq!(list_schedules(&repo).expect("list").len(), 1);
    }

    #[test]
    fn an_edit_keeps_the_id_and_recomputes_the_next_run_from_the_new_recurrence() {
        let repo = FakeSchedules::default();
        let saved = save_schedule(&repo, new_schedule(), at(2026, 10, 26, 10, 0)).expect("save");
        let edited = Schedule {
            recurrence: Recurrence::Daily {
                hour: 23,
                minute: 0,
            },
            ..saved.clone()
        };
        let stored = save_schedule(&repo, edited, at(2026, 10, 26, 10, 0)).expect("edit");
        assert_eq!(stored.id, saved.id);
        assert_eq!(stored.created_at, saved.created_at);
        // Not the old 03:00-tomorrow — the new recurrence's next occurrence.
        assert_eq!(stored.next_run_at, epoch_ms(at(2026, 10, 26, 23, 0)));
    }

    #[test]
    fn a_disabled_schedule_has_no_next_run() {
        let repo = FakeSchedules::default();
        let disabled = Schedule {
            enabled: false,
            ..new_schedule()
        };
        let saved = save_schedule(&repo, disabled, at(2026, 10, 26, 10, 0)).expect("save");
        assert_eq!(saved.next_run_at, 0);
        assert!(due_schedule_ids(&[saved], at(2030, 1, 1, 0, 0)).is_empty());
    }

    #[test]
    fn resuming_recomputes_from_now_not_from_the_stale_stored_value() {
        let repo = FakeSchedules::default();
        let saved = save_schedule(&repo, new_schedule(), at(2026, 10, 26, 10, 0)).expect("save");
        let paused =
            set_schedule_enabled(&repo, &saved.id, false, at(2026, 10, 26, 11, 0)).expect("pause");
        assert_eq!(paused.next_run_at, 0);

        // Resumed months later: the next run is months later too, so the
        // catch-up path does not fire it instantly.
        let resumed =
            set_schedule_enabled(&repo, &saved.id, true, at(2027, 2, 10, 10, 0)).expect("resume");
        assert_eq!(resumed.next_run_at, epoch_ms(at(2027, 2, 11, 3, 0)));
        assert!(due_schedule_ids(&[resumed], at(2027, 2, 10, 12, 0)).is_empty());
    }

    #[test]
    fn enabling_an_unknown_schedule_is_not_found() {
        let repo = FakeSchedules::default();
        assert!(matches!(
            set_schedule_enabled(&repo, "nope", true, at(2026, 10, 26, 10, 0)),
            Err(AppError::NotFound(_))
        ));
    }

    #[test]
    fn delete_takes_the_history_with_it() {
        let repo = FakeSchedules::default();
        let runs = FakeRuns::default();
        let saved = save_schedule(&repo, new_schedule(), at(2026, 10, 26, 10, 0)).expect("save");
        runs.record(&RunRecord {
            schedule_id: saved.id.clone(),
            started_at: 1,
            duration_ms: 1,
            trigger: RunTrigger::Manual,
            path: None,
            row_count: 0,
            truncated: false,
            error: Some("boom".into()),
        })
        .expect("record");

        delete_schedule(&repo, &runs, &saved.id).expect("delete");
        assert!(list_schedules(&repo).expect("list").is_empty());
        assert!(run_history(&runs).expect("history").is_empty());
        assert!(matches!(
            delete_schedule(&repo, &runs, &saved.id),
            Err(AppError::NotFound(_))
        ));
    }

    // --- due-ness ---------------------------------------------------------

    #[test]
    fn a_schedule_is_due_once_its_next_run_has_passed() {
        let due = Schedule {
            id: "a".into(),
            next_run_at: epoch_ms(at(2026, 10, 26, 3, 0)),
            ..new_schedule()
        };
        let later = Schedule {
            id: "b".into(),
            next_run_at: epoch_ms(at(2026, 10, 27, 3, 0)),
            ..new_schedule()
        };
        assert_eq!(
            due_schedule_ids(&[due.clone(), later.clone()], at(2026, 10, 26, 3, 0)),
            vec!["a".to_string()]
        );
        assert!(due_schedule_ids(&[due, later], at(2026, 10, 26, 2, 59)).is_empty());
    }

    #[test]
    fn a_never_scheduled_entry_is_stamped_rather_than_fired_on_the_spot() {
        let fresh = Schedule {
            id: "a".into(),
            next_run_at: 0,
            ..new_schedule()
        };
        // Not due — otherwise every launch would run every such schedule.
        assert!(due_schedule_ids(std::slice::from_ref(&fresh), at(2026, 10, 26, 10, 0)).is_empty());
        assert_eq!(
            missing_next_runs(&[fresh], at(2026, 10, 26, 10, 0)),
            vec![("a".to_string(), epoch_ms(at(2026, 10, 27, 3, 0)))]
        );
    }

    #[test]
    fn a_long_outage_produces_one_catch_up_run_not_a_backlog() {
        // Missed for three days.
        let stale = Schedule {
            id: "a".into(),
            next_run_at: epoch_ms(at(2026, 10, 23, 3, 0)),
            ..new_schedule()
        };
        let now = at(2026, 10, 26, 9, 0);
        assert_eq!(due_schedule_ids(std::slice::from_ref(&stale), now).len(), 1);
        // After it runs, the next one is measured from NOW — so the three
        // missed days are gone, not queued.
        assert_eq!(next_run_at(&stale, now), epoch_ms(at(2026, 10, 27, 3, 0)));
    }

    // --- the run path -----------------------------------------------------

    /// A SQLite database with one table, plus the registry entry pointing at
    /// it — the whole rig a scheduled run needs, in-process.
    fn sqlite_rig(
        dir: &tempfile::TempDir,
    ) -> (JsonFileConnectionRepository, ConnectorRegistry, String) {
        let db_path = dir.path().join("report.db");
        let connection = rusqlite::Connection::open(&db_path).expect("open sqlite");
        connection
            .execute_batch(
                "CREATE TABLE orders (id INTEGER PRIMARY KEY, note TEXT);
                 INSERT INTO orders (id, note) VALUES (1, 'first'), (2, 'say \"hi\"');",
            )
            .expect("seed");
        drop(connection);

        let repository = JsonFileConnectionRepository::new(dir.path().join("connections.json"));
        repository
            .save(&SavedConnection {
                id: "conn-1".into(),
                name: "Reports".into(),
                engine: Engine::Sqlite,
                params: ConnectionParams::Sqlite {
                    path: db_path.to_string_lossy().to_string(),
                },
                env: Env::Production,
                color: None,
                project: None,
                read_only: false,
                created_at: Some(0),
            })
            .expect("save connection");

        let mut registry = ConnectorRegistry::new();
        registry.register(
            Engine::Sqlite,
            Arc::new(crate::engines::sqlite::SqliteConnector),
        );
        (repository, registry, db_path.to_string_lossy().to_string())
    }

    struct Rig {
        _dir: tempfile::TempDir,
        connections: JsonFileConnectionRepository,
        registry: ConnectorRegistry,
        secrets: InMemorySecretStore,
        manager: ConnectionManager,
        schedules: JsonFileScheduleRepository,
        runs: JsonFileRunLogRepository,
        out_dir: std::path::PathBuf,
    }

    impl Rig {
        fn new() -> Self {
            let dir = tempfile::tempdir().expect("tempdir");
            let (connections, registry, _) = sqlite_rig(&dir);
            let out_dir = dir.path().join("out");
            Self {
                connections,
                registry,
                secrets: InMemorySecretStore::default(),
                manager: ConnectionManager::new(),
                schedules: JsonFileScheduleRepository::new(dir.path().join("schedules.json")),
                runs: JsonFileRunLogRepository::new(dir.path().join("runs.json")),
                out_dir,
                _dir: dir,
            }
        }

        fn deps(&self) -> RunDeps<'_> {
            RunDeps {
                connections: &self.connections,
                registry: &self.registry,
                secret_store: &self.secrets,
                manager: &self.manager,
                schedules: &self.schedules,
                runs: &self.runs,
                timeout: Duration::from_secs(10),
            }
        }

        fn schedule(&self, sql: &str, format: OutputFormat) -> Schedule {
            Schedule {
                id: "s1".into(),
                sql: sql.into(),
                format,
                directory: self.out_dir.to_string_lossy().to_string(),
                filename: "{{name}}_{{env}}_{{date}}".into(),
                ..new_schedule()
            }
        }
    }

    #[tokio::test]
    async fn a_successful_run_writes_the_csv_and_records_the_outcome() {
        let rig = Rig::new();
        let now = at(2026, 10, 26, 3, 0);
        let schedule = rig.schedule("SELECT id, note FROM orders ORDER BY id", OutputFormat::Csv);

        let record = run_schedule(&rig.deps(), &schedule, RunTrigger::Scheduled, now).await;

        assert!(record.succeeded(), "run failed: {:?}", record.error);
        assert_eq!(record.row_count, 2);
        assert!(!record.truncated);
        assert_eq!(record.trigger, RunTrigger::Scheduled);

        let path = record.path.expect("path");
        // The env token used the connection's env, not the schedule's.
        assert!(
            path.ends_with("Nightly orders_production_20261026.csv"),
            "{path}"
        );
        let written = std::fs::read_to_string(&path).expect("read output");
        assert_eq!(written, "id,note\n1,first\n2,\"say \"\"hi\"\"\"\n");

        // And it is in the history.
        let history = run_history(&rig.runs).expect("history");
        assert_eq!(history["s1"].len(), 1);
        assert!(history["s1"][0].succeeded());
    }

    #[tokio::test]
    async fn json_output_is_parseable_and_in_column_order() {
        let rig = Rig::new();
        let schedule = rig.schedule(
            "SELECT id, note FROM orders ORDER BY id",
            OutputFormat::Json,
        );
        let record = run_schedule(
            &rig.deps(),
            &schedule,
            RunTrigger::Manual,
            at(2026, 10, 26, 3, 0),
        )
        .await;

        let path = record.path.expect("path");
        assert!(path.ends_with(".json"), "{path}");
        let parsed: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).expect("read")).expect("json");
        assert_eq!(parsed[0]["id"], serde_json::json!(1));
        assert_eq!(parsed[1]["note"], serde_json::json!("say \"hi\""));
    }

    #[tokio::test]
    async fn date_tokens_in_the_sql_are_resolved_per_run() {
        let rig = Rig::new();
        // `{{today}}` inside a literal, exactly as the renderer's parameter
        // substitution would have left it.
        let schedule = rig.schedule("SELECT '{{today}}' AS as_of", OutputFormat::Csv);
        let record = run_schedule(
            &rig.deps(),
            &schedule,
            RunTrigger::Manual,
            at(2026, 10, 26, 3, 0),
        )
        .await;

        assert!(record.succeeded(), "run failed: {:?}", record.error);
        let written = std::fs::read_to_string(record.path.expect("path")).expect("read");
        assert_eq!(written, "as_of\n2026-10-26\n");
    }

    #[tokio::test]
    async fn a_write_is_refused_before_a_connection_is_even_opened() {
        let rig = Rig::new();
        // Only reachable by hand-editing schedules.json — `save_schedule`
        // refuses this — which is precisely the case worth covering.
        let schedule = rig.schedule("DELETE FROM orders", OutputFormat::Csv);
        let record = run_schedule(
            &rig.deps(),
            &schedule,
            RunTrigger::Manual,
            at(2026, 10, 26, 3, 0),
        )
        .await;

        assert!(!record.succeeded());
        assert!(record.path.is_none());
        assert!(record
            .error
            .as_deref()
            .expect("error")
            .contains("only read"));
        assert_eq!(
            rig.manager.open_count().await,
            0,
            "no connection was opened"
        );
        // And the table is untouched.
        let saved = rig.connections.get("conn-1").expect("get").expect("entry");
        let ConnectionParams::Sqlite { path } = saved.params else {
            panic!("the rig saves a SQLite connection");
        };
        let connection = rusqlite::Connection::open(path).expect("reopen");
        let count: i64 = connection
            .query_row("SELECT count(*) FROM orders", [], |row| row.get(0))
            .expect("count");
        assert_eq!(count, 2);
    }

    #[tokio::test]
    async fn a_failing_run_is_recorded_rather_than_raised() {
        let rig = Rig::new();
        let schedule = rig.schedule("SELECT * FROM does_not_exist", OutputFormat::Csv);
        let record = run_schedule(
            &rig.deps(),
            &schedule,
            RunTrigger::Scheduled,
            at(2026, 10, 26, 3, 0),
        )
        .await;

        assert!(!record.succeeded());
        assert!(record
            .error
            .expect("error")
            .to_lowercase()
            .contains("does_not_exist"));
        assert_eq!(run_history(&rig.runs).expect("history")["s1"].len(), 1);
    }

    #[tokio::test]
    async fn a_deleted_connection_names_itself_in_the_failure() {
        let rig = Rig::new();
        let schedule = Schedule {
            connection_id: "gone".into(),
            ..rig.schedule("SELECT 1", OutputFormat::Csv)
        };
        let record = run_schedule(
            &rig.deps(),
            &schedule,
            RunTrigger::Scheduled,
            at(2026, 10, 26, 3, 0),
        )
        .await;

        let error = record.error.expect("error");
        assert!(error.contains("gone"), "{error}");
        assert!(error.contains("deleted"), "{error}");
    }

    #[tokio::test]
    async fn the_handle_is_closed_after_every_run_including_a_failing_one() {
        let rig = Rig::new();
        let ok = rig.schedule("SELECT 1", OutputFormat::Csv);
        let bad = rig.schedule("SELECT * FROM nope", OutputFormat::Csv);
        let now = at(2026, 10, 26, 3, 0);

        run_schedule(&rig.deps(), &ok, RunTrigger::Manual, now).await;
        run_schedule(&rig.deps(), &bad, RunTrigger::Manual, now).await;

        assert_eq!(rig.manager.open_count().await, 0);
    }

    #[tokio::test]
    async fn the_row_limit_is_honoured_and_truncation_is_recorded() {
        let rig = Rig::new();
        let schedule = Schedule {
            row_limit: 1,
            ..rig.schedule("SELECT id FROM orders ORDER BY id", OutputFormat::Csv)
        };
        let record = run_schedule(
            &rig.deps(),
            &schedule,
            RunTrigger::Manual,
            at(2026, 10, 26, 3, 0),
        )
        .await;

        assert!(record.succeeded(), "run failed: {:?}", record.error);
        assert_eq!(record.row_count, 1);
        assert!(record.truncated, "a cut report must say so");
    }

    #[tokio::test]
    async fn pruning_keeps_the_newest_and_never_touches_a_file_it_did_not_write() {
        let rig = Rig::new();
        std::fs::create_dir_all(&rig.out_dir).expect("mkdir");
        let schedule = rig.schedule("SELECT 1", OutputFormat::Csv); // keep: 3

        // Four files this schedule's pattern owns, plus two it does not.
        let stranger = rig.out_dir.join("someone-elses-report.csv");
        let other_format = rig.out_dir.join("Nightly orders_production_20260101.json");
        std::fs::write(&stranger, "keep me").expect("write");
        std::fs::write(&other_format, "[]").expect("write");
        for day in 1..=4 {
            let now = at(2026, 10, 20 + day, 3, 0);
            let record = run_schedule(&rig.deps(), &schedule, RunTrigger::Scheduled, now).await;
            assert!(record.succeeded(), "run failed: {:?}", record.error);
        }

        let names: Vec<String> = std::fs::read_dir(&rig.out_dir)
            .expect("read_dir")
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        // The oldest of the four is gone; the two outsiders are untouched.
        assert!(!names.contains(&"Nightly orders_production_20261021.csv".to_string()));
        assert!(names.contains(&"Nightly orders_production_20261024.csv".to_string()));
        assert!(names.contains(&"someone-elses-report.csv".to_string()));
        assert!(names.contains(&"Nightly orders_production_20260101.json".to_string()));
    }

    #[tokio::test]
    async fn the_output_folder_is_created_if_it_does_not_exist_yet() {
        let rig = Rig::new();
        let nested = rig.out_dir.join("deep/deeper");
        let schedule = Schedule {
            directory: nested.to_string_lossy().to_string(),
            ..rig.schedule("SELECT 1", OutputFormat::Csv)
        };
        let record = run_schedule(
            &rig.deps(),
            &schedule,
            RunTrigger::Manual,
            at(2026, 10, 26, 3, 0),
        )
        .await;
        assert!(record.succeeded(), "run failed: {:?}", record.error);
        assert!(nested.exists());
    }
}
