//! Use-cases for the saved-queries slice. Depend on domain + ports only —
//! no Tauri, no drivers.

use std::time::{SystemTime, UNIX_EPOCH};

use crate::shared::error::AppError;

use super::domain::SavedQuery;
use super::ports::SavedQueryRepository;

/// All saved queries.
///
/// `?Sized` lets callers pass trait objects (`&dyn SavedQueryRepository`) as
/// well as concrete adapters and test fakes.
pub fn list_saved_queries<R: SavedQueryRepository + ?Sized>(
    repository: &R,
) -> Result<Vec<SavedQuery>, AppError> {
    repository.list()
}

/// Insert or update a saved query. New entries (empty `id`) get a UUID and a
/// `saved_at` timestamp; updates keep both. Returns the stored value so the
/// renderer learns the assigned id and timestamp.
pub fn save_saved_query<R: SavedQueryRepository + ?Sized>(
    repository: &R,
    mut query: SavedQuery,
) -> Result<SavedQuery, AppError> {
    if let Some(message) = query.validation_error() {
        return Err(AppError::Invalid(message.into()));
    }
    if query.id.trim().is_empty() {
        query.id = uuid::Uuid::new_v4().to_string();
        query.saved_at = now_epoch_ms();
    }
    repository.save(&query)?;
    Ok(query)
}

/// Remove a saved query by id.
pub fn delete_saved_query<R: SavedQueryRepository + ?Sized>(
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
        items: Mutex<Vec<SavedQuery>>,
    }

    impl SavedQueryRepository for FakeRepository {
        fn list(&self) -> Result<Vec<SavedQuery>, AppError> {
            Ok(self.items.lock().unwrap().clone())
        }

        fn save(&self, query: &SavedQuery) -> Result<(), AppError> {
            let mut items = self.items.lock().unwrap();
            if let Some(existing) = items.iter_mut().find(|q| q.id == query.id) {
                *existing = query.clone();
            } else {
                items.push(query.clone());
            }
            Ok(())
        }

        fn delete(&self, id: &str) -> Result<(), AppError> {
            let mut items = self.items.lock().unwrap();
            let before = items.len();
            items.retain(|q| q.id != id);
            if items.len() == before {
                return Err(AppError::NotFound(format!("saved query '{id}'")));
            }
            Ok(())
        }
    }

    fn new_query(name: &str, sql: &str) -> SavedQuery {
        SavedQuery {
            id: String::new(),
            name: name.into(),
            sql: sql.into(),
            saved_at: 0,
        }
    }

    #[test]
    fn save_assigns_uuid_and_saved_at_to_new_queries() {
        let repo = FakeRepository::default();
        let saved = save_saved_query(&repo, new_query("Users", "SELECT 1")).expect("save");
        assert!(!saved.id.is_empty());
        assert!(saved.saved_at > 0);
        assert_eq!(list_saved_queries(&repo).unwrap(), vec![saved]);
    }

    #[test]
    fn save_keeps_existing_id_and_saved_at_and_updates_in_place() {
        let repo = FakeRepository::default();
        let saved = save_saved_query(&repo, new_query("Users", "SELECT 1")).expect("save");
        let edited = SavedQuery {
            name: "Active users".into(),
            sql: "SELECT 2".into(),
            ..saved.clone()
        };
        let stored = save_saved_query(&repo, edited).expect("update");
        assert_eq!(stored.id, saved.id);
        assert_eq!(stored.saved_at, saved.saved_at);
        let all = list_saved_queries(&repo).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].name, "Active users");
        assert_eq!(all[0].sql, "SELECT 2");
    }

    #[test]
    fn save_rejects_blank_name_with_the_spec_message() {
        let repo = FakeRepository::default();
        let err = save_saved_query(&repo, new_query("   ", "SELECT 1")).unwrap_err();
        assert!(matches!(err, AppError::Invalid(_)));
        assert!(err.to_string().contains("Query name is required."));
        assert!(list_saved_queries(&repo).unwrap().is_empty());
    }

    #[test]
    fn save_rejects_blank_sql_with_the_spec_message() {
        let repo = FakeRepository::default();
        let err = save_saved_query(&repo, new_query("Users", "  ")).unwrap_err();
        assert!(matches!(err, AppError::Invalid(_)));
        assert!(err.to_string().contains("Query SQL is required."));
        assert!(list_saved_queries(&repo).unwrap().is_empty());
    }

    #[test]
    fn delete_removes_and_unknown_id_is_not_found() {
        let repo = FakeRepository::default();
        let saved = save_saved_query(&repo, new_query("Users", "SELECT 1")).expect("save");
        delete_saved_query(&repo, &saved.id).expect("delete");
        assert!(list_saved_queries(&repo).unwrap().is_empty());
        assert!(matches!(
            delete_saved_query(&repo, "nope"),
            Err(AppError::NotFound(_))
        ));
    }
}
