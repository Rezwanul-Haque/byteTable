//! Infrastructure adapters for the connections slice.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use crate::shared::error::AppError;

use super::domain::{SavedConnection, UnsupportedConnection};
use super::ports::ConnectionRepository;

/// Stores the saved-connection registry as pretty-printed JSON at a fixed
/// path (`<app_config_dir>/connections.json` in production; any path in
/// tests). Same file strategy as the preferences slice, with one deliberate
/// difference:
///
/// - Missing file → empty list. First launch is not an error.
/// - Structurally corrupt file (not a JSON array, truncated, invalid JSON) →
///   **error**, not silent reset. Saved connections are user data — silently
///   wiping them on a parse error would be data loss. The error names the file
///   so the user (or a repair flow) can act; the file is never overwritten
///   until it parses again or the user deletes it.
/// - A single unreadable ENTRY (e.g. a connection whose `engine` this build
///   does not know, saved by a newer/feature build) → **skipped**, not fatal.
///   The rest load; the unreadable row stays in the file untouched. This keeps
///   switching between builds/versions from stranding the whole registry behind
///   one row the current build can't parse — no manual file editing needed.
/// - Saves are atomic: write a sibling temp file, then rename over the
///   target, so a crash mid-write never leaves a truncated registry.
/// - An internal mutex serializes read-modify-write cycles so concurrent
///   async commands cannot interleave a save with a delete.
///
/// Secrets: SQLite connections carry only a file path, so plain JSON is
/// fine. Server passwords never reach this file (OS keychain, M12).
pub struct JsonFileConnectionRepository {
    path: PathBuf,
    /// Guards the whole read-modify-write cycle of `save`/`delete`.
    write_lock: Mutex<()>,
}

impl JsonFileConnectionRepository {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            write_lock: Mutex::new(()),
        }
    }

    /// Take the write lock, mapping poison to a graceful `AppError` instead
    /// of panicking — same policy as the SQLite adapter's connection mutex:
    /// one earlier crash must not start a panic cascade across commands.
    fn lock_for_write(&self) -> Result<std::sync::MutexGuard<'_, ()>, AppError> {
        self.write_lock.lock().map_err(|_| {
            AppError::Io(
                "the saved-connections registry is in a broken state after an \
                 earlier crash; restart the app to continue"
                    .into(),
            )
        })
    }

    /// The file as a raw JSON array — the source of truth that PRESERVES every
    /// entry, including ones this build can't parse. A structural failure (not an
    /// array, truncated, invalid JSON) is real corruption → error, never a silent
    /// wipe; missing file → empty. Per-entry meaning is applied by the callers.
    fn read_raw(&self) -> Result<Vec<serde_json::Value>, AppError> {
        let contents = match fs::read_to_string(&self.path) {
            Ok(contents) => contents,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(err) => return Err(err.into()),
        };
        serde_json::from_str(&contents).map_err(|err| {
            AppError::Serialization(format!(
                "the saved-connections file {} could not be read ({err}); \
                 fix or remove the file to continue",
                self.path.display()
            ))
        })
    }

    /// The entries this build CAN parse into a `SavedConnection`. Unreadable rows
    /// (unknown engine, etc.) are left for [`Self::read_unsupported`] — they stay
    /// in the file and never fail the whole load.
    fn read_all(&self) -> Result<Vec<SavedConnection>, AppError> {
        Ok(self
            .read_raw()?
            .into_iter()
            .filter_map(|entry| serde_json::from_value::<SavedConnection>(entry).ok())
            .collect())
    }

    /// The entries this build CANNOT parse, salvaged into display stubs (needs an
    /// `id` to be actionable — entries without one are ignored).
    fn read_unsupported(&self) -> Result<Vec<UnsupportedConnection>, AppError> {
        let mut out = Vec::new();
        for entry in self.read_raw()? {
            if serde_json::from_value::<SavedConnection>(entry.clone()).is_ok() {
                continue; // this build can use it — not "unsupported"
            }
            let str_field = |k: &str| entry.get(k).and_then(|v| v.as_str()).map(str::to_string);
            let Some(id) = str_field("id") else {
                continue; // no id → cannot delete/act on it; skip silently
            };
            let engine = str_field("engine").unwrap_or_else(|| "unknown".into());
            out.push(UnsupportedConnection {
                id,
                name: str_field("name").unwrap_or_else(|| "(unnamed)".into()),
                env: str_field("env"),
                project: str_field("project"),
                color: str_field("color"),
                reason: format!(
                    "This connection's engine \"{engine}\" isn't supported in this \
                     version of ByteTable. Open the build that added it, or delete \
                     this connection."
                ),
                engine,
            });
        }
        Ok(out)
    }

    /// Atomically write the raw entry array back (temp file + rename), preserving
    /// unreadable rows the callers rounded-trip through `read_raw`.
    fn write_raw(&self, entries: &[serde_json::Value]) -> Result<(), AppError> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(entries)?;
        let tmp_path = self.path.with_extension("json.tmp");
        fs::write(&tmp_path, json)?;
        fs::rename(&tmp_path, &self.path)?;
        Ok(())
    }

    /// The `id` field of a raw entry, if it is a string.
    fn entry_id(entry: &serde_json::Value) -> Option<&str> {
        entry.get("id").and_then(|v| v.as_str())
    }
}

impl ConnectionRepository for JsonFileConnectionRepository {
    fn list(&self) -> Result<Vec<SavedConnection>, AppError> {
        self.read_all()
    }

    fn list_unsupported(&self) -> Result<Vec<UnsupportedConnection>, AppError> {
        self.read_unsupported()
    }

    fn get(&self, id: &str) -> Result<Option<SavedConnection>, AppError> {
        Ok(self.read_all()?.into_iter().find(|c| c.id == id))
    }

    fn save(&self, connection: &SavedConnection) -> Result<(), AppError> {
        let _guard = self.lock_for_write()?;
        // Work on the RAW array so unreadable rows (unknown engines from other
        // builds) survive the write instead of being dropped.
        let mut raw = self.read_raw()?;
        let value = serde_json::to_value(connection)?;
        match raw
            .iter_mut()
            .find(|e| Self::entry_id(e) == Some(connection.id.as_str()))
        {
            Some(slot) => *slot = value,
            None => raw.push(value),
        }
        self.write_raw(&raw)
    }

    fn delete(&self, id: &str) -> Result<(), AppError> {
        let _guard = self.lock_for_write()?;
        // Delete by raw id so an unsupported (unknown-engine) entry is deletable
        // too — the connect screen offers a delete action on its struck-out card.
        let mut raw = self.read_raw()?;
        let before = raw.len();
        raw.retain(|e| Self::entry_id(e) != Some(id));
        if raw.len() == before {
            return Err(AppError::NotFound(format!("saved connection '{id}'")));
        }
        self.write_raw(&raw)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::connections::domain::Env;
    use crate::shared::engine::{ConnectionParams, Engine};

    fn repo_in(dir: &tempfile::TempDir) -> JsonFileConnectionRepository {
        JsonFileConnectionRepository::new(dir.path().join("connections.json"))
    }

    fn connection(id: &str, name: &str) -> SavedConnection {
        SavedConnection {
            id: id.into(),
            name: name.into(),
            engine: Engine::Sqlite,
            params: ConnectionParams::Sqlite {
                path: format!("/tmp/{id}.db"),
            },
            env: Env::Dev,
            color: None,
            project: None,
            created_at: Some(1_700_000_000_000),
        }
    }

    #[test]
    fn list_on_missing_file_is_empty() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert!(repo_in(&dir).list().expect("list").is_empty());
    }

    #[test]
    fn save_then_list_and_get_round_trip() {
        let dir = tempfile::tempdir().expect("tempdir");
        let repo = repo_in(&dir);
        let a = connection("a", "Alpha");
        let b = connection("b", "Beta");
        repo.save(&a).expect("save a");
        repo.save(&b).expect("save b");
        assert_eq!(repo.list().expect("list"), vec![a.clone(), b.clone()]);
        assert_eq!(repo.get("b").expect("get"), Some(b));
        assert_eq!(repo.get("nope").expect("get"), None);
    }

    #[test]
    fn save_with_existing_id_updates_in_place() {
        let dir = tempfile::tempdir().expect("tempdir");
        let repo = repo_in(&dir);
        repo.save(&connection("a", "Alpha")).expect("save");
        let renamed = connection("a", "Alpha v2");
        repo.save(&renamed).expect("update");
        let all = repo.list().expect("list");
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].name, "Alpha v2");
    }

    #[test]
    fn delete_removes_and_unknown_id_is_not_found() {
        let dir = tempfile::tempdir().expect("tempdir");
        let repo = repo_in(&dir);
        repo.save(&connection("a", "Alpha")).expect("save");
        repo.delete("a").expect("delete");
        assert!(repo.list().expect("list").is_empty());
        assert!(matches!(repo.delete("a"), Err(AppError::NotFound(_))));
    }

    #[test]
    fn save_leaves_no_temp_file_and_creates_parents() {
        let dir = tempfile::tempdir().expect("tempdir");
        let repo =
            JsonFileConnectionRepository::new(dir.path().join("nested/deep/connections.json"));
        repo.save(&connection("a", "Alpha")).expect("save");
        assert!(dir.path().join("nested/deep/connections.json").exists());
        assert!(!dir.path().join("nested/deep/connections.json.tmp").exists());
        assert_eq!(repo.list().expect("list").len(), 1);
    }

    #[test]
    fn corrupt_file_is_an_error_not_a_silent_reset() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("connections.json");
        fs::write(&path, "{ not json !!").expect("write corrupt file");
        let repo = JsonFileConnectionRepository::new(path.clone());
        let err = repo.list().unwrap_err();
        assert!(matches!(err, AppError::Serialization(_)));
        assert!(err.to_string().contains("connections.json"));
        // The corrupt file is left untouched for the user to inspect.
        assert_eq!(
            fs::read_to_string(&path).expect("read back"),
            "{ not json !!"
        );
    }

    /// A file with a valid SQLite connection plus one whose `engine` this build
    /// does not know (as if saved by a newer/experimental build).
    fn file_with_unsupported(dir: &tempfile::TempDir) -> std::path::PathBuf {
        let path = dir.path().join("connections.json");
        let json = r##"[
          { "id": "ok", "name": "Good", "engine": "sqlite",
            "params": { "engine": "sqlite", "path": "/tmp/ok.db" }, "env": "dev" },
          { "id": "future", "name": "FromNewerBuild", "engine": "oracle",
            "params": { "engine": "oracle", "host": "localhost", "port": 1521 },
            "env": "dev", "project": "local", "color": "#56b6c2" }
        ]"##;
        fs::write(&path, json).expect("write");
        path
    }

    #[test]
    fn unknown_engine_entry_is_not_fatal_and_is_surfaced_separately() {
        let dir = tempfile::tempdir().expect("tempdir");
        let repo = JsonFileConnectionRepository::new(file_with_unsupported(&dir));
        // list() returns only the parseable one — never the whole-file error.
        let all = repo.list().expect("list tolerates the unknown entry");
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, "ok");
        // list_unsupported() surfaces the unknown one as an actionable stub.
        let unsup = repo.list_unsupported().expect("list_unsupported");
        assert_eq!(unsup.len(), 1);
        assert_eq!(unsup[0].id, "future");
        assert_eq!(unsup[0].engine, "oracle");
        assert_eq!(unsup[0].project.as_deref(), Some("local"));
        assert!(unsup[0].reason.contains("oracle"));
    }

    #[test]
    fn saving_another_connection_preserves_the_unsupported_entry() {
        let dir = tempfile::tempdir().expect("tempdir");
        let repo = JsonFileConnectionRepository::new(file_with_unsupported(&dir));
        // Saving a NEW connection must not drop the unknown-engine row.
        repo.save(&connection("new", "New One")).expect("save");
        assert_eq!(repo.list().expect("list").len(), 2); // ok + new
        let unsup = repo.list_unsupported().expect("list_unsupported");
        assert_eq!(unsup.len(), 1); // the unknown one still there
        assert_eq!(unsup[0].id, "future");
    }

    #[test]
    fn deleting_an_unsupported_entry_by_id_removes_it() {
        let dir = tempfile::tempdir().expect("tempdir");
        let repo = JsonFileConnectionRepository::new(file_with_unsupported(&dir));
        // The connect screen's delete action targets the stub's id.
        repo.delete("future").expect("delete unsupported by id");
        assert!(repo
            .list_unsupported()
            .expect("list_unsupported")
            .is_empty());
        assert_eq!(repo.list().expect("list").len(), 1); // the valid one survives
    }
}
