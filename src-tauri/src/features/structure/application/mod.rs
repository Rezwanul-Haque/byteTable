//! Use-cases for the structure-editor slice (M8). Depend on the shared engine
//! abstraction plus the connections feature's application layer (the
//! `ConnectionManager` that owns open handles). No Tauri, no drivers, no SQL.

use crate::features::connections::application::{ConnectionHandleId, ConnectionManager};
use crate::features::structure::domain::AlterOp;
use crate::shared::engine::AlterResult;
use crate::shared::error::AppError;

/// Preview a batch of staged structure edits: return the SQL statement strings
/// the batch implies (the "Review SQL" panel), WITHOUT mutating the database.
/// Delegates to the adapter with `apply == false`.
pub async fn preview_alter(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    schema: &str,
    table: &str,
    ops: &[AlterOp],
) -> Result<AlterResult, AppError> {
    manager
        .get(handle)
        .await?
        .alter_table(schema, table, ops, false)
        .await
}

/// Apply a batch of staged structure edits transactionally. On any failure the
/// adapter rolls back fully and returns the engine error §5-style. Delegates to
/// the adapter with `apply == true`.
pub async fn apply_alter(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    schema: &str,
    table: &str,
    ops: &[AlterOp],
) -> Result<AlterResult, AppError> {
    manager
        .get(handle)
        .await?
        .alter_table(schema, table, ops, true)
        .await
}

#[cfg(test)]
mod tests {
    use async_trait::async_trait;

    use super::*;
    use crate::shared::engine::{
        EngineConnection, EngineInfo, FetchRowsRequest, QueryOptions, QueryResult, RowsPage,
        SchemaInfo, TableInfo, TableMeta,
    };

    /// Fake that echoes the requested mode so the use-case wiring is
    /// observable: a preview returns `applied: false`, an apply `true`, and a
    /// statement naming the schema/table/op-count.
    struct FakeConnection;

    #[async_trait]
    impl EngineConnection for FakeConnection {
        fn engine_info(&self) -> EngineInfo {
            EngineInfo {
                engine: crate::shared::engine::Engine::Sqlite,
                server_version: "SQLite 0.0-test".into(),
            }
        }
        async fn list_schemas(&self) -> Result<Vec<SchemaInfo>, AppError> {
            Ok(vec![])
        }
        async fn list_tables(&self, _schema: &str) -> Result<Vec<TableInfo>, AppError> {
            Ok(vec![])
        }
        async fn table_meta(&self, _schema: &str, _table: &str) -> Result<TableMeta, AppError> {
            Ok(TableMeta::default())
        }
        async fn run_query(
            &self,
            _sql: &str,
            _options: QueryOptions,
        ) -> Result<QueryResult, AppError> {
            Ok(QueryResult {
                columns: vec![],
                rows: vec![],
                row_count: 0,
                truncated: false,
                elapsed_ms: 0,
            })
        }
        async fn fetch_rows(&self, _req: FetchRowsRequest) -> Result<RowsPage, AppError> {
            Ok(RowsPage {
                columns: vec![],
                rows: vec![],
                offset: 0,
                limit: 0,
                total_rows: Some(0),
                elapsed_ms: 0,
            })
        }
        async fn alter_table(
            &self,
            schema: &str,
            table: &str,
            ops: &[AlterOp],
            apply: bool,
        ) -> Result<AlterResult, AppError> {
            Ok(AlterResult {
                statements: vec![format!("{schema}.{table}:{}", ops.len())],
                applied: apply,
            })
        }
        async fn close(&self) -> Result<(), AppError> {
            Ok(())
        }
    }

    fn sample_ops() -> Vec<AlterOp> {
        vec![AlterOp::DropColumn {
            name: "legacy".into(),
        }]
    }

    #[tokio::test]
    async fn preview_delegates_without_applying() {
        let manager = ConnectionManager::new();
        let handle = manager.insert(Box::new(FakeConnection)).await;
        let res = preview_alter(&manager, &handle, "main", "users", &sample_ops())
            .await
            .expect("preview");
        assert!(!res.applied);
        assert_eq!(res.statements, vec!["main.users:1".to_string()]);
    }

    #[tokio::test]
    async fn apply_delegates_and_marks_applied() {
        let manager = ConnectionManager::new();
        let handle = manager.insert(Box::new(FakeConnection)).await;
        let res = apply_alter(&manager, &handle, "main", "users", &sample_ops())
            .await
            .expect("apply");
        assert!(res.applied);
    }

    #[tokio::test]
    async fn closed_handle_is_a_not_found_with_a_human_message() {
        let manager = ConnectionManager::new();
        let handle = ConnectionHandleId("ghost".into());
        let err = preview_alter(&manager, &handle, "main", "users", &sample_ops())
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
        assert!(err.to_string().contains("closed"));
    }
}
