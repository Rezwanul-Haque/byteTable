//! Use-cases for the insights slice. Depend on the shared engine abstraction
//! plus the connections feature's application layer (the `ConnectionManager`
//! that owns open handles — see the cross-feature note in the slice docs). No
//! Tauri, no drivers.

use crate::features::connections::application::{ConnectionHandleId, ConnectionManager};
use crate::shared::engine::{ColumnStats, ColumnStatsRequest};
use crate::shared::error::AppError;

/// Per-column statistics over the current filtered set on an open connection
/// (M10 "column insights"). The adapter validates the column, reuses the
/// grid's filter compilation, and produces §5 errors for unknown
/// schema/table/column.
pub async fn column_stats(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    req: ColumnStatsRequest,
) -> Result<ColumnStats, AppError> {
    manager.get(handle).await?.column_stats(req).await
}

#[cfg(test)]
mod tests {
    use async_trait::async_trait;

    use super::*;
    use crate::shared::engine::{
        EngineConnection, EngineInfo, FetchRowsRequest, FreqEntry, QueryOptions, QueryResult,
        RowsPage, SchemaInfo, TableInfo, TableMeta,
    };

    /// Minimal fake: only `column_stats` matters here. It echoes the request's
    /// distinct shape back so the use-case wiring is observable.
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

        async fn column_stats(&self, req: ColumnStatsRequest) -> Result<ColumnStats, AppError> {
            // Echo the column name through `top` so delegation is observable.
            Ok(ColumnStats {
                total: 1,
                distinct: 1,
                nulls: 0,
                min: None,
                max: None,
                avg: None,
                numeric: false,
                top: vec![FreqEntry {
                    value: serde_json::json!(format!(
                        "{}.{}.{}",
                        req.schema, req.table, req.column
                    )),
                    count: 1,
                }],
            })
        }

        async fn close(&self) -> Result<(), AppError> {
            Ok(())
        }
    }

    fn sample_request() -> ColumnStatsRequest {
        ColumnStatsRequest {
            schema: "main".into(),
            table: "products".into(),
            column: "qty".into(),
            filter: None,
        }
    }

    #[tokio::test]
    async fn delegates_to_the_connection_behind_the_handle() {
        let manager = ConnectionManager::new();
        let handle = manager.insert(Box::new(FakeConnection)).await;
        let stats = column_stats(&manager, &handle, sample_request())
            .await
            .expect("column stats");
        assert_eq!(stats.top[0].value, serde_json::json!("main.products.qty"));
    }

    #[tokio::test]
    async fn closed_handle_is_a_not_found_with_a_human_message() {
        let manager = ConnectionManager::new();
        let handle = ConnectionHandleId("ghost".into());
        let err = column_stats(&manager, &handle, sample_request())
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
        assert!(err.to_string().contains("closed"));
    }
}
