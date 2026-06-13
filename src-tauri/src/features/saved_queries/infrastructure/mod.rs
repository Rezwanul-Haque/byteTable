//! Infrastructure adapter for the saved-queries slice.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use crate::shared::error::AppError;

use super::domain::SavedQuery;
use super::ports::SavedQueryRepository;

/// Stores the global saved-query list as pretty-printed JSON at a fixed path
/// (`<app_config_dir>/saved_queries.json` in production; any path in tests).
/// Same file strategy as the connections registry — saved queries are user
/// data, so the corrupt-file policy follows connections, not preferences:
///
/// - Missing file → empty list. First launch is not an error.
/// - Corrupt file → **error**, not silent reset. Silently wiping a user's
///   saved queries on a parse error would be data loss. The error names the
///   file so the user (or a future repair flow) can act on it; the file is
///   never overwritten until it parses again or the user removes it.
/// - Saves are atomic: write a sibling temp file, then rename over the target,
///   so a crash mid-write never leaves a truncated list.
/// - An internal mutex serializes read-modify-write cycles so concurrent async
///   commands cannot interleave a save with a delete.
pub struct JsonFileSavedQueryRepository {
    path: PathBuf,
    /// Guards the whole read-modify-write cycle of `save`/`delete`.
    write_lock: Mutex<()>,
}

impl JsonFileSavedQueryRepository {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            write_lock: Mutex::new(()),
        }
    }

    /// Take the write lock, mapping poison to a graceful `AppError` instead of
    /// panicking — same policy as the connections adapter: one earlier crash
    /// must not start a panic cascade across commands.
    fn lock_for_write(&self) -> Result<std::sync::MutexGuard<'_, ()>, AppError> {
        self.write_lock.lock().map_err(|_| {
            AppError::Io(
                "the saved-queries store is in a broken state after an earlier \
                 crash; restart the app to continue"
                    .into(),
            )
        })
    }

    fn read_all(&self) -> Result<Vec<SavedQuery>, AppError> {
        let contents = match fs::read_to_string(&self.path) {
            Ok(contents) => contents,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(err) => return Err(err.into()),
        };
        serde_json::from_str(&contents).map_err(|err| {
            AppError::Serialization(format!(
                "Saved queries file is corrupted: {} could not be read ({err}); \
                 fix or remove the file to continue",
                self.path.display()
            ))
        })
    }

    fn write_all(&self, queries: &[SavedQuery]) -> Result<(), AppError> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(queries)?;
        let tmp_path = self.path.with_extension("json.tmp");
        fs::write(&tmp_path, json)?;
        fs::rename(&tmp_path, &self.path)?;
        Ok(())
    }
}

impl SavedQueryRepository for JsonFileSavedQueryRepository {
    fn list(&self) -> Result<Vec<SavedQuery>, AppError> {
        self.read_all()
    }

    fn save(&self, query: &SavedQuery) -> Result<(), AppError> {
        let _guard = self.lock_for_write()?;
        let mut queries = self.read_all()?;
        if let Some(existing) = queries.iter_mut().find(|q| q.id == query.id) {
            *existing = query.clone();
        } else {
            queries.push(query.clone());
        }
        self.write_all(&queries)
    }

    fn delete(&self, id: &str) -> Result<(), AppError> {
        let _guard = self.lock_for_write()?;
        let mut queries = self.read_all()?;
        let before = queries.len();
        queries.retain(|q| q.id != id);
        if queries.len() == before {
            return Err(AppError::NotFound(format!("saved query '{id}'")));
        }
        self.write_all(&queries)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo_in(dir: &tempfile::TempDir) -> JsonFileSavedQueryRepository {
        JsonFileSavedQueryRepository::new(dir.path().join("saved_queries.json"))
    }

    fn query(id: &str, name: &str) -> SavedQuery {
        SavedQuery {
            id: id.into(),
            name: name.into(),
            sql: format!("SELECT '{id}'"),
            saved_at: 1_700_000_000_000,
            connection_id: None,
        }
    }

    #[test]
    fn list_on_missing_file_is_empty() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert!(repo_in(&dir).list().expect("list").is_empty());
    }

    #[test]
    fn save_then_list_round_trip() {
        let dir = tempfile::tempdir().expect("tempdir");
        let repo = repo_in(&dir);
        let a = query("a", "Alpha");
        let b = query("b", "Beta");
        repo.save(&a).expect("save a");
        repo.save(&b).expect("save b");
        assert_eq!(repo.list().expect("list"), vec![a, b]);
    }

    #[test]
    fn connection_id_round_trips_for_scoped_and_global_queries() {
        let dir = tempfile::tempdir().expect("tempdir");
        let repo = repo_in(&dir);
        let scoped = SavedQuery {
            connection_id: Some("conn-1".into()),
            ..query("a", "Alpha")
        };
        let global = query("b", "Beta"); // connection_id None
        repo.save(&scoped).expect("save scoped");
        repo.save(&global).expect("save global");

        let all = repo.list().expect("list");
        assert_eq!(all, vec![scoped, global]);
        assert_eq!(all[0].connection_id.as_deref(), Some("conn-1"));
        assert_eq!(all[1].connection_id, None);

        // Upsert preserves / updates the scoped attachment in place.
        let reattached = SavedQuery {
            connection_id: Some("conn-2".into()),
            ..query("a", "Alpha")
        };
        repo.save(&reattached).expect("upsert scoped");
        let all = repo.list().expect("list after upsert");
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].connection_id.as_deref(), Some("conn-2"));
    }

    #[test]
    fn save_with_existing_id_updates_in_place() {
        let dir = tempfile::tempdir().expect("tempdir");
        let repo = repo_in(&dir);
        repo.save(&query("a", "Alpha")).expect("save");
        repo.save(&query("a", "Alpha v2")).expect("update");
        let all = repo.list().expect("list");
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].name, "Alpha v2");
    }

    #[test]
    fn delete_removes_and_unknown_id_is_not_found() {
        let dir = tempfile::tempdir().expect("tempdir");
        let repo = repo_in(&dir);
        repo.save(&query("a", "Alpha")).expect("save");
        repo.delete("a").expect("delete");
        assert!(repo.list().expect("list").is_empty());
        assert!(matches!(repo.delete("a"), Err(AppError::NotFound(_))));
    }

    #[test]
    fn save_leaves_no_temp_file_and_creates_parents() {
        let dir = tempfile::tempdir().expect("tempdir");
        let repo =
            JsonFileSavedQueryRepository::new(dir.path().join("nested/deep/saved_queries.json"));
        repo.save(&query("a", "Alpha")).expect("save");
        assert!(dir.path().join("nested/deep/saved_queries.json").exists());
        assert!(!dir
            .path()
            .join("nested/deep/saved_queries.json.tmp")
            .exists());
        assert_eq!(repo.list().expect("list").len(), 1);
    }

    #[test]
    fn corrupt_file_is_an_error_not_a_silent_reset() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("saved_queries.json");
        fs::write(&path, "{ not json !!").expect("write corrupt file");
        let repo = JsonFileSavedQueryRepository::new(path.clone());
        let err = repo.list().unwrap_err();
        assert!(matches!(err, AppError::Serialization(_)));
        assert!(err.to_string().contains("Saved queries file is corrupted"));
        assert!(err.to_string().contains("saved_queries.json"));
        // The corrupt file is left untouched for the user to inspect.
        assert_eq!(
            fs::read_to_string(&path).expect("read back"),
            "{ not json !!"
        );
    }
}
