//! Infrastructure adapters for the schedules slice: two JSON files in the app
//! config dir, written atomically (temp file + rename) under a mutex that
//! serializes the whole read-modify-write cycle — the saved-queries pattern.
//!
//! The two stores differ in ONE deliberate way, their corrupt-file policy:
//!
//! - **`schedules.json` → error.** Schedules are user data. Silently resetting
//!   them would mean a nightly report stops running and nobody is told.
//! - **`schedule_runs.json` → reset.** The history is a diagnostic written by
//!   the app, not by the user. Losing it is an inconvenience; refusing to run
//!   anything because the *log* of past runs will not parse would turn a
//!   cosmetic fault into an outage.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::shared::error::AppError;

use super::domain::{RunRecord, Schedule, MAX_HISTORY};
use super::ports::{RunLogRepository, ScheduleRepository};

/// Take a write lock, mapping poison to a graceful `AppError` instead of
/// panicking — the connections/saved-queries policy: one earlier crash must
/// not start a panic cascade across commands.
fn lock<'a>(mutex: &'a Mutex<()>, what: &str) -> Result<std::sync::MutexGuard<'a, ()>, AppError> {
    mutex.lock().map_err(|_| {
        AppError::Io(format!(
            "the {what} store is in a broken state after an earlier crash; \
             restart the app to continue"
        ))
    })
}

/// Serialize `value` to a sibling temp file and rename it over `path`, so a
/// crash mid-write never leaves a truncated store.
fn write_atomic<T: serde::Serialize>(path: &Path, value: &T) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(value)?;
    let tmp_path = path.with_extension("json.tmp");
    fs::write(&tmp_path, json)?;
    fs::rename(&tmp_path, path)?;
    Ok(())
}

/// The schedule list as pretty-printed JSON at a fixed path
/// (`<app_config_dir>/schedules.json` in production; any path in tests).
pub struct JsonFileScheduleRepository {
    path: PathBuf,
    write_lock: Mutex<()>,
}

impl JsonFileScheduleRepository {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            write_lock: Mutex::new(()),
        }
    }

    fn read_all(&self) -> Result<Vec<Schedule>, AppError> {
        let contents = match fs::read_to_string(&self.path) {
            Ok(contents) => contents,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(err) => return Err(err.into()),
        };
        serde_json::from_str(&contents).map_err(|err| {
            AppError::Serialization(format!(
                "Schedules file is corrupted: {} could not be read ({err}); \
                 fix or remove the file to continue",
                self.path.display()
            ))
        })
    }
}

impl ScheduleRepository for JsonFileScheduleRepository {
    fn list(&self) -> Result<Vec<Schedule>, AppError> {
        self.read_all()
    }

    fn save(&self, schedule: &Schedule) -> Result<(), AppError> {
        let _guard = lock(&self.write_lock, "schedules")?;
        let mut schedules = self.read_all()?;
        if let Some(existing) = schedules.iter_mut().find(|s| s.id == schedule.id) {
            *existing = schedule.clone();
        } else {
            schedules.push(schedule.clone());
        }
        write_atomic(&self.path, &schedules)
    }

    fn delete(&self, id: &str) -> Result<(), AppError> {
        let _guard = lock(&self.write_lock, "schedules")?;
        let mut schedules = self.read_all()?;
        let before = schedules.len();
        schedules.retain(|s| s.id != id);
        if schedules.len() == before {
            return Err(AppError::NotFound(format!("schedule '{id}'")));
        }
        write_atomic(&self.path, &schedules)
    }

    fn set_next_run_at(&self, id: &str, next_run_at: u64) -> Result<(), AppError> {
        let _guard = lock(&self.write_lock, "schedules")?;
        let mut schedules = self.read_all()?;
        let Some(existing) = schedules.iter_mut().find(|s| s.id == id) else {
            // The user deleted it while the run was in flight. Not an error:
            // there is simply nothing left to bookkeep.
            return Ok(());
        };
        existing.next_run_at = next_run_at;
        write_atomic(&self.path, &schedules)
    }
}

/// Run history as pretty-printed JSON, keyed by schedule id
/// (`<app_config_dir>/schedule_runs.json`).
pub struct JsonFileRunLogRepository {
    path: PathBuf,
    write_lock: Mutex<()>,
}

impl JsonFileRunLogRepository {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            write_lock: Mutex::new(()),
        }
    }

    /// Missing OR unparseable file → an empty log (see the module docs on why
    /// this store resets where the schedule store errors).
    fn read_all(&self) -> BTreeMap<String, Vec<RunRecord>> {
        fs::read_to_string(&self.path)
            .ok()
            .and_then(|contents| serde_json::from_str(&contents).ok())
            .unwrap_or_default()
    }
}

impl RunLogRepository for JsonFileRunLogRepository {
    fn all(&self) -> Result<BTreeMap<String, Vec<RunRecord>>, AppError> {
        Ok(self.read_all())
    }

    fn record(&self, record: &RunRecord) -> Result<(), AppError> {
        let _guard = lock(&self.write_lock, "schedule history")?;
        let mut log = self.read_all();
        let entries = log.entry(record.schedule_id.clone()).or_default();
        entries.push(record.clone());
        if entries.len() > MAX_HISTORY {
            entries.drain(..entries.len() - MAX_HISTORY);
        }
        write_atomic(&self.path, &log)
    }

    fn forget(&self, schedule_id: &str) -> Result<(), AppError> {
        let _guard = lock(&self.write_lock, "schedule history")?;
        let mut log = self.read_all();
        if log.remove(schedule_id).is_none() {
            return Ok(());
        }
        write_atomic(&self.path, &log)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::schedules::domain::{OutputFormat, Recurrence, RunTrigger};

    fn schedules_in(dir: &tempfile::TempDir) -> JsonFileScheduleRepository {
        JsonFileScheduleRepository::new(dir.path().join("schedules.json"))
    }

    fn runs_in(dir: &tempfile::TempDir) -> JsonFileRunLogRepository {
        JsonFileRunLogRepository::new(dir.path().join("schedule_runs.json"))
    }

    fn schedule(id: &str, name: &str) -> Schedule {
        Schedule {
            id: id.into(),
            name: name.into(),
            enabled: true,
            connection_id: "conn-1".into(),
            schema: None,
            saved_query_id: None,
            sql: "SELECT 1".into(),
            recurrence: Recurrence::Daily { hour: 3, minute: 0 },
            format: OutputFormat::Csv,
            directory: "/tmp".into(),
            filename: "{{name}}_{{date}}".into(),
            keep: 30,
            row_limit: 100_000,
            created_at: 1,
            next_run_at: 0,
        }
    }

    fn run(schedule_id: &str, started_at: u64) -> RunRecord {
        RunRecord {
            schedule_id: schedule_id.into(),
            started_at,
            duration_ms: 5,
            trigger: RunTrigger::Scheduled,
            path: Some("/tmp/out.csv".into()),
            row_count: 1,
            truncated: false,
            error: None,
        }
    }

    #[test]
    fn list_on_missing_file_is_empty() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert!(schedules_in(&dir).list().expect("list").is_empty());
    }

    #[test]
    fn save_then_list_round_trip_and_upsert_in_place() {
        let dir = tempfile::tempdir().expect("tempdir");
        let repo = schedules_in(&dir);
        repo.save(&schedule("a", "Alpha")).expect("save a");
        repo.save(&schedule("b", "Beta")).expect("save b");
        assert_eq!(repo.list().expect("list").len(), 2);

        repo.save(&schedule("a", "Alpha v2")).expect("update");
        let all = repo.list().expect("list");
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].name, "Alpha v2");
    }

    #[test]
    fn delete_removes_and_unknown_id_is_not_found() {
        let dir = tempfile::tempdir().expect("tempdir");
        let repo = schedules_in(&dir);
        repo.save(&schedule("a", "Alpha")).expect("save");
        repo.delete("a").expect("delete");
        assert!(repo.list().expect("list").is_empty());
        assert!(matches!(repo.delete("a"), Err(AppError::NotFound(_))));
    }

    #[test]
    fn set_next_run_at_touches_only_that_field() {
        let dir = tempfile::tempdir().expect("tempdir");
        let repo = schedules_in(&dir);
        repo.save(&schedule("a", "Alpha")).expect("save");
        repo.set_next_run_at("a", 1_761_534_000_000).expect("patch");
        let stored = &repo.list().expect("list")[0];
        assert_eq!(stored.next_run_at, 1_761_534_000_000);
        assert_eq!(stored.name, "Alpha");
    }

    #[test]
    fn set_next_run_at_on_a_deleted_schedule_is_not_an_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        // The user can delete a schedule while its run is in flight; the
        // bookkeeping write that follows must not surface as a failure.
        assert!(schedules_in(&dir).set_next_run_at("gone", 1).is_ok());
    }

    #[test]
    fn save_leaves_no_temp_file_and_creates_parents() {
        let dir = tempfile::tempdir().expect("tempdir");
        let repo = JsonFileScheduleRepository::new(dir.path().join("nested/deep/schedules.json"));
        repo.save(&schedule("a", "Alpha")).expect("save");
        assert!(dir.path().join("nested/deep/schedules.json").exists());
        assert!(!dir.path().join("nested/deep/schedules.json.tmp").exists());
    }

    #[test]
    fn a_corrupt_schedule_file_is_an_error_not_a_silent_reset() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("schedules.json");
        fs::write(&path, "{ not json !!").expect("write corrupt");
        let repo = JsonFileScheduleRepository::new(path.clone());
        let err = repo.list().unwrap_err();
        assert!(matches!(err, AppError::Serialization(_)));
        assert!(err.to_string().contains("Schedules file is corrupted"));
        // Left untouched for the user to inspect.
        assert_eq!(fs::read_to_string(&path).expect("read"), "{ not json !!");
    }

    #[test]
    fn history_records_newest_last_and_is_bounded() {
        let dir = tempfile::tempdir().expect("tempdir");
        let repo = runs_in(&dir);
        for n in 0..(MAX_HISTORY as u64 + 5) {
            repo.record(&run("a", n)).expect("record");
        }
        let log = repo.all().expect("all");
        let entries = &log["a"];
        assert_eq!(entries.len(), MAX_HISTORY);
        // The five oldest were dropped, and the newest is last.
        assert_eq!(entries[0].started_at, 5);
        assert_eq!(
            entries[entries.len() - 1].started_at,
            MAX_HISTORY as u64 + 4
        );
    }

    #[test]
    fn history_is_kept_per_schedule_and_forgotten_with_it() {
        let dir = tempfile::tempdir().expect("tempdir");
        let repo = runs_in(&dir);
        repo.record(&run("a", 1)).expect("record a");
        repo.record(&run("b", 1)).expect("record b");
        repo.forget("a").expect("forget");
        let log = repo.all().expect("all");
        assert!(!log.contains_key("a"));
        assert_eq!(log["b"].len(), 1);
        // Forgetting an unknown id is a no-op, not an error.
        assert!(repo.forget("nope").is_ok());
    }

    #[test]
    fn a_corrupt_history_file_resets_instead_of_blocking_runs() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("schedule_runs.json");
        fs::write(&path, "{ not json !!").expect("write corrupt");
        let repo = JsonFileRunLogRepository::new(path);
        assert!(repo.all().expect("all").is_empty());
        // And the next run can still be recorded.
        repo.record(&run("a", 1)).expect("record");
        assert_eq!(repo.all().expect("all")["a"].len(), 1);
    }
}
