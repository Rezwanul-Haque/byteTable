//! Use-cases for the schema-map slice. Depend on domain + ports only — no
//! Tauri, no drivers.

use crate::shared::error::AppError;

use super::domain::MapLayout;
use super::ports::MapLayoutRepository;

/// The saved layout for one (connectionId, schema), or `None` when none was
/// ever saved.
///
/// `?Sized` lets callers pass trait objects (`&dyn MapLayoutRepository`) as
/// well as concrete adapters and test fakes.
pub fn get_map_layout<R: MapLayoutRepository + ?Sized>(
    repository: &R,
    connection_id: &str,
    schema: &str,
) -> Result<Option<MapLayout>, AppError> {
    repository.get(connection_id, schema)
}

/// Persist (overwrite) the layout for one (connectionId, schema).
pub fn save_map_layout<R: MapLayoutRepository + ?Sized>(
    repository: &R,
    connection_id: &str,
    schema: &str,
    layout: MapLayout,
) -> Result<(), AppError> {
    repository.save(connection_id, schema, &layout)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use super::super::domain::{EdgeWaypoint, NodePosition};
    use super::*;

    /// In-memory fake keyed exactly like the real adapter: `connId \0 schema`.
    #[derive(Default)]
    struct FakeRepository {
        items: Mutex<HashMap<String, MapLayout>>,
    }

    fn key(connection_id: &str, schema: &str) -> String {
        format!("{connection_id}\0{schema}")
    }

    impl MapLayoutRepository for FakeRepository {
        fn get(&self, connection_id: &str, schema: &str) -> Result<Option<MapLayout>, AppError> {
            Ok(self
                .items
                .lock()
                .unwrap()
                .get(&key(connection_id, schema))
                .cloned())
        }

        fn save(
            &self,
            connection_id: &str,
            schema: &str,
            layout: &MapLayout,
        ) -> Result<(), AppError> {
            self.items
                .lock()
                .unwrap()
                .insert(key(connection_id, schema), layout.clone());
            Ok(())
        }
    }

    fn layout(table: &str, x: f64) -> MapLayout {
        MapLayout {
            positions: vec![NodePosition {
                table: table.into(),
                x,
                y: 0.0,
                w: None,
            }],
            edges: vec![EdgeWaypoint {
                id: "e1".into(),
                dx: 1.0,
                dy: 2.0,
            }],
            cardinalities: Vec::new(),
            zoom: Some(1.0),
        }
    }

    #[test]
    fn get_is_none_when_never_saved() {
        let repo = FakeRepository::default();
        assert_eq!(get_map_layout(&repo, "conn-1", "main").unwrap(), None);
    }

    #[test]
    fn save_then_get_round_trips() {
        let repo = FakeRepository::default();
        let l = layout("users", 10.0);
        save_map_layout(&repo, "conn-1", "main", l.clone()).expect("save");
        assert_eq!(get_map_layout(&repo, "conn-1", "main").unwrap(), Some(l));
    }

    #[test]
    fn save_overwrites_same_connection_and_schema() {
        let repo = FakeRepository::default();
        save_map_layout(&repo, "conn-1", "main", layout("users", 10.0)).expect("save");
        let updated = layout("users", 99.0);
        save_map_layout(&repo, "conn-1", "main", updated.clone()).expect("overwrite");
        assert_eq!(
            get_map_layout(&repo, "conn-1", "main").unwrap(),
            Some(updated)
        );
    }

    #[test]
    fn layouts_are_independent_per_schema_and_connection() {
        let repo = FakeRepository::default();
        save_map_layout(&repo, "conn-1", "main", layout("a", 1.0)).expect("save main");
        save_map_layout(&repo, "conn-1", "other", layout("b", 2.0)).expect("save other");
        save_map_layout(&repo, "conn-2", "main", layout("c", 3.0)).expect("save conn-2");

        assert_eq!(
            get_map_layout(&repo, "conn-1", "main")
                .unwrap()
                .unwrap()
                .positions[0]
                .table,
            "a"
        );
        assert_eq!(
            get_map_layout(&repo, "conn-1", "other")
                .unwrap()
                .unwrap()
                .positions[0]
                .table,
            "b"
        );
        assert_eq!(
            get_map_layout(&repo, "conn-2", "main")
                .unwrap()
                .unwrap()
                .positions[0]
                .table,
            "c"
        );
    }
}
