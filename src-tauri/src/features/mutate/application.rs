//! Use-cases for the mutate slice. Depends on the shared engine abstraction
//! plus the connections feature's application layer (the `ConnectionManager`
//! that owns open handles — see the cross-feature note in the slice docs).
//! No Tauri, no drivers.

use crate::features::connections::application::{ConnectionHandleId, ConnectionManager};
use crate::shared::engine::{UpdateCellRequest, UpdateResult};
use crate::shared::error::AppError;

/// Update a single cell on an open connection (M11 inline edit). The adapter
/// enforces the mutation safety contract: it validates the column, requires the
/// full primary key (mass-update prevention), binds the new value AND every pk
/// value as parameters, and asserts the affected-row count inside a transaction
/// (see `EngineConnection::update_cell`). Unknown schema/table/column, a missing
/// or partial primary key, a stale pk, and engine constraint failures all
/// surface as §5 errors.
pub async fn update_cell(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    req: UpdateCellRequest,
) -> Result<UpdateResult, AppError> {
    manager.get_sql(handle).await?.update_cell(req).await
}

/// Empty a table of all rows, keeping its structure (M15 truncate). **Mutates
/// user data.** The adapter is engine-aware (Postgres/MySQL `TRUNCATE TABLE`;
/// SQLite `DELETE` in a transaction), validates the table exists, and quotes
/// identifiers per engine (see `EngineConnection::truncate_table`). Returns the
/// number of rows removed. The production-confirm dialog is renderer-side
/// (Task 2); this use-case only routes the request.
pub async fn truncate_table(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    schema: &str,
    table: &str,
) -> Result<TruncateResult, AppError> {
    let affected = manager
        .get_sql(handle)
        .await?
        .truncate_table(schema, table)
        .await?;
    Ok(TruncateResult { affected })
}

/// The outcome of a `truncate_table` call: the number of rows removed
/// (`affected`). Camel-case on the wire to match the renderer's
/// `{ affected: number }`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TruncateResult {
    pub affected: u64,
}

#[cfg(test)]
mod tests {
    use async_trait::async_trait;

    use super::*;
    use crate::shared::engine::{
        EngineConnection, EngineInfo, FetchRowsRequest, QueryOptions, QueryResult, RowsPage,
        SchemaInfo, TableInfo, TableMeta,
    };

    /// Minimal fake: only `update_cell` matters here. It echoes the request
    /// back through the result so the use-case wiring is observable, and
    /// asserts the value/pk arrived intact.
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
            unreachable!("not exercised by the mutate use-case tests")
        }

        async fn update_cell(&self, req: UpdateCellRequest) -> Result<UpdateResult, AppError> {
            Ok(UpdateResult {
                affected: 1,
                statement: format!(
                    "{}.{} SET {} (pk {})",
                    req.schema,
                    req.table,
                    req.column,
                    req.pk.len()
                ),
            })
        }

        async fn truncate_table(&self, schema: &str, table: &str) -> Result<u64, AppError> {
            // Echo a deterministic count derived from the names so the use-case
            // wiring (and the TruncateResult mapping) is observable.
            Ok((schema.len() + table.len()) as u64)
        }

        async fn close(&self) -> Result<(), AppError> {
            Ok(())
        }
    }

    fn sample_request() -> UpdateCellRequest {
        UpdateCellRequest {
            schema: "main".into(),
            table: "users".into(),
            column: "name".into(),
            value: serde_json::json!("Ada"),
            pk: vec![crate::shared::engine::PkPredicate {
                column: "id".into(),
                value: serde_json::json!(42),
            }],
        }
    }

    #[tokio::test]
    async fn delegates_to_the_connection_behind_the_handle() {
        let manager = ConnectionManager::new();
        let handle = manager
            .insert(crate::shared::engine::OpenConnection::sql(FakeConnection))
            .await;
        let result = update_cell(&manager, &handle, sample_request())
            .await
            .expect("update cell");
        assert_eq!(result.affected, 1);
        assert_eq!(result.statement, "main.users SET name (pk 1)");
    }

    #[tokio::test]
    async fn truncate_delegates_to_the_connection_behind_the_handle() {
        let manager = ConnectionManager::new();
        let handle = manager
            .insert(crate::shared::engine::OpenConnection::sql(FakeConnection))
            .await;
        let result = truncate_table(&manager, &handle, "main", "users")
            .await
            .expect("truncate");
        // "main" (4) + "users" (5) = 9 from the fake.
        assert_eq!(result.affected, 9);
    }

    #[tokio::test]
    async fn truncate_on_a_closed_handle_is_a_not_found() {
        let manager = ConnectionManager::new();
        let handle = ConnectionHandleId("ghost".into());
        let err = truncate_table(&manager, &handle, "main", "users")
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }

    #[tokio::test]
    async fn closed_handle_is_a_not_found_with_a_human_message() {
        let manager = ConnectionManager::new();
        let handle = ConnectionHandleId("ghost".into());
        let err = update_cell(&manager, &handle, sample_request())
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
        assert!(err.to_string().contains("closed"));
    }
}
