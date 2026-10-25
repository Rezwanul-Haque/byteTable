//! Use-cases for the snippets slice. Depend on domain + ports only — no Tauri,
//! no drivers.

use std::time::{SystemTime, UNIX_EPOCH};

use crate::shared::error::AppError;

use super::domain::Snippet;
use super::ports::SnippetRepository;

/// All snippets.
///
/// `?Sized` lets callers pass trait objects (`&dyn SnippetRepository`) as well
/// as concrete adapters and test fakes.
pub fn list_snippets<R: SnippetRepository + ?Sized>(
    repository: &R,
) -> Result<Vec<Snippet>, AppError> {
    repository.list()
}

/// Insert or update a snippet. New entries (empty `id`) get a UUID and a
/// `saved_at` timestamp; updates keep both. Returns the stored value so the
/// renderer learns the assigned id and timestamp.
pub fn save_snippet<R: SnippetRepository + ?Sized>(
    repository: &R,
    mut snippet: Snippet,
) -> Result<Snippet, AppError> {
    if let Some(message) = snippet.validation_error() {
        return Err(AppError::Invalid(message.into()));
    }
    // Normalise the abbreviation on the way in: a blank one is "no
    // abbreviation", not an empty shorthand that would match every keystroke
    // prefix in the editor's completion list.
    snippet.abbreviation = snippet
        .abbreviation
        .map(|a| a.trim().to_string())
        .filter(|a| !a.is_empty());
    if snippet.id.trim().is_empty() {
        snippet.id = uuid::Uuid::new_v4().to_string();
        snippet.saved_at = now_epoch_ms();
    }
    repository.save(&snippet)?;
    Ok(snippet)
}

/// Remove a snippet by id.
pub fn delete_snippet<R: SnippetRepository + ?Sized>(
    repository: &R,
    id: &str,
) -> Result<(), AppError> {
    repository.delete(id)
}

fn now_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    /// In-memory fake implementing the port.
    #[derive(Default)]
    struct FakeRepository {
        items: Mutex<Vec<Snippet>>,
    }

    impl SnippetRepository for FakeRepository {
        fn list(&self) -> Result<Vec<Snippet>, AppError> {
            Ok(self.items.lock().unwrap().clone())
        }

        fn save(&self, snippet: &Snippet) -> Result<(), AppError> {
            let mut items = self.items.lock().unwrap();
            if let Some(existing) = items.iter_mut().find(|s| s.id == snippet.id) {
                *existing = snippet.clone();
            } else {
                items.push(snippet.clone());
            }
            Ok(())
        }

        fn delete(&self, id: &str) -> Result<(), AppError> {
            let mut items = self.items.lock().unwrap();
            let before = items.len();
            items.retain(|s| s.id != id);
            if items.len() == before {
                return Err(AppError::NotFound(format!("snippet '{id}'")));
            }
            Ok(())
        }
    }

    fn new_snippet(name: &str, body: &str) -> Snippet {
        Snippet {
            id: String::new(),
            name: name.into(),
            abbreviation: None,
            body: body.into(),
            engine: None,
            saved_at: 0,
        }
    }

    #[test]
    fn save_assigns_uuid_and_saved_at_to_new_snippets() {
        let repo = FakeRepository::default();
        let saved = save_snippet(&repo, new_snippet("Recent", "SELECT 1")).expect("save");
        assert!(!saved.id.is_empty());
        assert!(saved.saved_at > 0);
        assert_eq!(list_snippets(&repo).unwrap(), vec![saved]);
    }

    #[test]
    fn save_keeps_existing_id_and_saved_at_and_updates_in_place() {
        let repo = FakeRepository::default();
        let saved = save_snippet(&repo, new_snippet("Recent", "SELECT 1")).expect("save");
        let edited = Snippet {
            name: "Recent rows".into(),
            body: "SELECT 2".into(),
            ..saved.clone()
        };
        let stored = save_snippet(&repo, edited).expect("update");
        assert_eq!(stored.id, saved.id);
        assert_eq!(stored.saved_at, saved.saved_at);
        let all = list_snippets(&repo).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].name, "Recent rows");
        assert_eq!(all[0].body, "SELECT 2");
    }

    #[test]
    fn save_trims_an_abbreviation_and_drops_a_blank_one() {
        let repo = FakeRepository::default();
        let padded = Snippet {
            abbreviation: Some("  sel  ".into()),
            ..new_snippet("Select", "SELECT 1")
        };
        assert_eq!(
            save_snippet(&repo, padded).expect("save").abbreviation,
            Some("sel".into())
        );

        // A blank abbreviation is "none" — an empty shorthand would otherwise
        // match every prefix in the completion list.
        let blank = Snippet {
            abbreviation: Some("   ".into()),
            ..new_snippet("Other", "SELECT 2")
        };
        assert_eq!(save_snippet(&repo, blank).expect("save").abbreviation, None);
    }

    #[test]
    fn save_preserves_the_engine_restriction() {
        let repo = FakeRepository::default();
        let scoped = Snippet {
            engine: Some("postgres".into()),
            ..new_snippet("PG only", "SELECT version()")
        };
        let saved = save_snippet(&repo, scoped).expect("save");
        assert_eq!(saved.engine.as_deref(), Some("postgres"));

        let widened = Snippet {
            engine: None,
            ..saved.clone()
        };
        assert_eq!(save_snippet(&repo, widened).expect("update").engine, None);
    }

    #[test]
    fn save_keeps_a_body_with_tab_stops_verbatim() {
        let repo = FakeRepository::default();
        let body = "SELECT #{1:cols}\nFROM #{2:table};#{0}";
        let saved = save_snippet(&repo, new_snippet("Query", body)).expect("save");
        assert_eq!(saved.body, body);
    }

    #[test]
    fn save_rejects_blank_name_with_the_spec_message() {
        let repo = FakeRepository::default();
        let err = save_snippet(&repo, new_snippet("  ", "SELECT 1")).unwrap_err();
        assert!(matches!(err, AppError::Invalid(_)));
        assert!(err.to_string().contains("Snippet name is required."));
        assert!(list_snippets(&repo).unwrap().is_empty());
    }

    #[test]
    fn save_rejects_blank_body_with_the_spec_message() {
        let repo = FakeRepository::default();
        let err = save_snippet(&repo, new_snippet("Recent", "  ")).unwrap_err();
        assert!(matches!(err, AppError::Invalid(_)));
        assert!(err.to_string().contains("Snippet body is required."));
        assert!(list_snippets(&repo).unwrap().is_empty());
    }

    #[test]
    fn delete_removes_and_unknown_id_is_not_found() {
        let repo = FakeRepository::default();
        let saved = save_snippet(&repo, new_snippet("Recent", "SELECT 1")).expect("save");
        delete_snippet(&repo, &saved.id).expect("delete");
        assert!(list_snippets(&repo).unwrap().is_empty());
        assert!(matches!(
            delete_snippet(&repo, "nope"),
            Err(AppError::NotFound(_))
        ));
    }
}
