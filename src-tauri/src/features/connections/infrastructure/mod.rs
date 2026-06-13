//! Infrastructure adapters for the connections slice.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use crate::shared::error::AppError;

use super::domain::SavedConnection;
use super::ports::ConnectionRepository;

/// Stores the saved-connection registry as pretty-printed JSON at a fixed
/// path (`<app_config_dir>/connections.json` in production; any path in
/// tests). Same file strategy as the preferences slice, with one deliberate
/// difference:
///
/// - Missing file → empty list. First launch is not an error.
/// - Corrupt file → **error**, not silent reset. Unlike appearance
///   preferences, saved connections are user data — silently wiping them on
///   a parse error would be data loss. The error message names the file so
///   the user (or a future repair flow) can act on it; the file is never
///   overwritten until it parses again or the user deletes it.
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

    fn read_all(&self) -> Result<Vec<SavedConnection>, AppError> {
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

    fn write_all(&self, connections: &[SavedConnection]) -> Result<(), AppError> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(connections)?;
        let tmp_path = self.path.with_extension("json.tmp");
        fs::write(&tmp_path, json)?;
        fs::rename(&tmp_path, &self.path)?;
        Ok(())
    }
}

impl ConnectionRepository for JsonFileConnectionRepository {
    fn list(&self) -> Result<Vec<SavedConnection>, AppError> {
        self.read_all()
    }

    fn get(&self, id: &str) -> Result<Option<SavedConnection>, AppError> {
        Ok(self.read_all()?.into_iter().find(|c| c.id == id))
    }

    fn save(&self, connection: &SavedConnection) -> Result<(), AppError> {
        let _guard = self.lock_for_write()?;
        let mut connections = self.read_all()?;
        if let Some(existing) = connections.iter_mut().find(|c| c.id == connection.id) {
            *existing = connection.clone();
        } else {
            connections.push(connection.clone());
        }
        self.write_all(&connections)
    }

    fn delete(&self, id: &str) -> Result<(), AppError> {
        let _guard = self.lock_for_write()?;
        let mut connections = self.read_all()?;
        let before = connections.len();
        connections.retain(|c| c.id != id);
        if connections.len() == before {
            return Err(AppError::NotFound(format!("saved connection '{id}'")));
        }
        self.write_all(&connections)
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
}
