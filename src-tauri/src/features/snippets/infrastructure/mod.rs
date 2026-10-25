//! Infrastructure adapter for the snippets slice.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use crate::shared::error::AppError;

use super::domain::Snippet;
use super::ports::SnippetRepository;

/// Stores the global snippet library as pretty-printed JSON at a fixed path
/// (`<app_config_dir>/snippets.json` in production; any path in tests).
///
/// Same file strategy and corrupt-file policy as the saved-queries store — a
/// snippet library is user data someone built by hand:
///
/// - Missing file → empty list. First launch is not an error.
/// - Corrupt file → **error**, not silent reset. The error names the file so
///   the user can act on it; the file is never overwritten until it parses
///   again or the user removes it.
/// - Saves are atomic: write a sibling temp file, then rename over the target,
///   so a crash mid-write never leaves a truncated library.
/// - An internal mutex serializes read-modify-write cycles so concurrent async
///   commands cannot interleave a save with a delete.
pub struct JsonFileSnippetRepository {
    path: PathBuf,
    /// Guards the whole read-modify-write cycle of `save`/`delete`.
    write_lock: Mutex<()>,
}

impl JsonFileSnippetRepository {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            write_lock: Mutex::new(()),
        }
    }

    /// Take the write lock, mapping poison to a graceful `AppError` instead of
    /// panicking — one earlier crash must not start a panic cascade across
    /// commands.
    fn lock_for_write(&self) -> Result<std::sync::MutexGuard<'_, ()>, AppError> {
        self.write_lock.lock().map_err(|_| {
            AppError::Io(
                "the snippet store is in a broken state after an earlier \
                 crash; restart the app to continue"
                    .into(),
            )
        })
    }

    fn read_all(&self) -> Result<Vec<Snippet>, AppError> {
        let contents = match fs::read_to_string(&self.path) {
            Ok(contents) => contents,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(err) => return Err(err.into()),
        };
        serde_json::from_str(&contents).map_err(|err| {
            AppError::Serialization(format!(
                "Snippets file is corrupted: {} could not be read ({err}); \
                 fix or remove the file to continue",
                self.path.display()
            ))
        })
    }

    fn write_all(&self, snippets: &[Snippet]) -> Result<(), AppError> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(snippets)?;
        let tmp_path = self.path.with_extension("json.tmp");
        fs::write(&tmp_path, json)?;
        fs::rename(&tmp_path, &self.path)?;
        Ok(())
    }
}

impl SnippetRepository for JsonFileSnippetRepository {
    fn list(&self) -> Result<Vec<Snippet>, AppError> {
        self.read_all()
    }

    fn save(&self, snippet: &Snippet) -> Result<(), AppError> {
        let _guard = self.lock_for_write()?;
        let mut snippets = self.read_all()?;
        if let Some(existing) = snippets.iter_mut().find(|s| s.id == snippet.id) {
            *existing = snippet.clone();
        } else {
            snippets.push(snippet.clone());
        }
        self.write_all(&snippets)
    }

    fn delete(&self, id: &str) -> Result<(), AppError> {
        let _guard = self.lock_for_write()?;
        let mut snippets = self.read_all()?;
        let before = snippets.len();
        snippets.retain(|s| s.id != id);
        if snippets.len() == before {
            return Err(AppError::NotFound(format!("snippet '{id}'")));
        }
        self.write_all(&snippets)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo_in(dir: &tempfile::TempDir) -> JsonFileSnippetRepository {
        JsonFileSnippetRepository::new(dir.path().join("snippets.json"))
    }

    fn snippet(id: &str, name: &str) -> Snippet {
        Snippet {
            id: id.into(),
            name: name.into(),
            abbreviation: Some(id.into()),
            body: format!("SELECT '{id}' FROM #{{1:table}};"),
            engine: None,
            saved_at: 1_700_000_000_000,
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
        let a = snippet("a", "Alpha");
        let b = snippet("b", "Beta");
        repo.save(&a).expect("save a");
        repo.save(&b).expect("save b");
        assert_eq!(repo.list().expect("list"), vec![a, b]);
    }

    #[test]
    fn tab_stops_and_the_engine_restriction_survive_the_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let repo = repo_in(&dir);
        let scoped = Snippet {
            engine: Some("mysql".into()),
            body: "SHOW CREATE TABLE #{1:table};#{0}".into(),
            ..snippet("a", "Show create")
        };
        repo.save(&scoped).expect("save");
        let all = repo.list().expect("list");
        assert_eq!(all, vec![scoped]);
        assert!(all[0].body.contains("#{1:table}"));
        assert_eq!(all[0].engine.as_deref(), Some("mysql"));
    }

    #[test]
    fn save_with_existing_id_updates_in_place() {
        let dir = tempfile::tempdir().expect("tempdir");
        let repo = repo_in(&dir);
        repo.save(&snippet("a", "Alpha")).expect("save");
        repo.save(&snippet("a", "Alpha v2")).expect("update");
        let all = repo.list().expect("list");
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].name, "Alpha v2");
    }

    #[test]
    fn delete_removes_and_unknown_id_is_not_found() {
        let dir = tempfile::tempdir().expect("tempdir");
        let repo = repo_in(&dir);
        repo.save(&snippet("a", "Alpha")).expect("save");
        repo.delete("a").expect("delete");
        assert!(repo.list().expect("list").is_empty());
        assert!(matches!(repo.delete("a"), Err(AppError::NotFound(_))));
    }

    #[test]
    fn save_leaves_no_temp_file_and_creates_parents() {
        let dir = tempfile::tempdir().expect("tempdir");
        let repo = JsonFileSnippetRepository::new(dir.path().join("nested/deep/snippets.json"));
        repo.save(&snippet("a", "Alpha")).expect("save");
        assert!(dir.path().join("nested/deep/snippets.json").exists());
        assert!(!dir.path().join("nested/deep/snippets.json.tmp").exists());
        assert_eq!(repo.list().expect("list").len(), 1);
    }

    #[test]
    fn corrupt_file_is_an_error_not_a_silent_reset() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("snippets.json");
        fs::write(&path, "{ not json !!").expect("write corrupt file");
        let repo = JsonFileSnippetRepository::new(path.clone());
        let err = repo.list().unwrap_err();
        assert!(matches!(err, AppError::Serialization(_)));
        assert!(err.to_string().contains("Snippets file is corrupted"));
        assert!(err.to_string().contains("snippets.json"));
        // The corrupt file is left untouched for the user to inspect.
        assert_eq!(
            fs::read_to_string(&path).expect("read back"),
            "{ not json !!"
        );
    }
}
