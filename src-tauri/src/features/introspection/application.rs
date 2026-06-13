//! Use-cases for the introspection slice. Depend on the shared engine
//! abstraction plus the connections feature's application layer (the
//! `ConnectionManager` that owns open handles — see the cross-feature note
//! in the slice docs). No Tauri, no drivers.

use crate::features::connections::application::{ConnectionHandleId, ConnectionManager};
use crate::shared::engine::TableMeta;
use crate::shared::error::AppError;

/// Column-level metadata for one table on an open connection (M3 sidebar).
pub async fn get_table_meta(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    schema: &str,
    table: &str,
) -> Result<TableMeta, AppError> {
    manager
        .get_sql(handle)
        .await?
        .table_meta(schema, table)
        .await
}

#[cfg(test)]
mod tests {
    use async_trait::async_trait;

    use super::*;
    use crate::shared::engine::{
        ColumnInfo, EngineConnection, EngineInfo, FetchRowsRequest, QueryOptions, QueryResult,
        RowsPage, SchemaInfo, TableInfo,
    };

    /// Minimal fake: only `table_meta` matters here.
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

        async fn table_meta(&self, schema: &str, table: &str) -> Result<TableMeta, AppError> {
            Ok(TableMeta {
                columns: vec![ColumnInfo {
                    name: format!("{schema}.{table}.col"),
                    data_type: "TEXT".into(),
                    nullable: true,
                    pk: false,
                    default_value: None,
                    fk: None,
                }],
                ..Default::default()
            })
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

        async fn close(&self) -> Result<(), AppError> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn delegates_to_the_connection_behind_the_handle() {
        let manager = ConnectionManager::new();
        let handle = manager
            .insert(crate::shared::engine::OpenConnection::sql(FakeConnection))
            .await;
        let meta = get_table_meta(&manager, &handle, "main", "users")
            .await
            .expect("table meta");
        assert_eq!(meta.columns[0].name, "main.users.col");
    }

    #[tokio::test]
    async fn closed_handle_is_a_not_found_with_a_human_message() {
        let manager = ConnectionManager::new();
        let handle = ConnectionHandleId("ghost".into());
        let err = get_table_meta(&manager, &handle, "main", "users")
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
        assert!(err.to_string().contains("closed"));
    }
}
