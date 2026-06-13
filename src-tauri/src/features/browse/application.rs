//! Use-cases for the browse slice. Depend on the shared engine abstraction
//! plus the connections feature's application layer (the `ConnectionManager`
//! that owns open handles — see the cross-feature note in the slice docs).
//! No Tauri, no drivers.

use crate::features::connections::application::{ConnectionHandleId, ConnectionManager};
use crate::shared::engine::{FetchRowsRequest, RowLookup, RowLookupRequest, RowsPage};
use crate::shared::error::AppError;

/// Fetch one page of rows from a table on an open connection (M4 data grid).
/// Paging and the optional single-column sort are applied by the adapter,
/// which also validates the sort column and produces §5 errors for unknown
/// schema/table/column.
pub async fn fetch_rows(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    req: FetchRowsRequest,
) -> Result<RowsPage, AppError> {
    manager.get(handle).await?.fetch_rows(req).await
}

/// Look up a single row by key on an open connection (M10 "FK peek"): click a
/// foreign-key cell to peek at the referenced row. The adapter validates the
/// lookup column, binds the value, and returns the first match plus a total
/// match count (so the UI can flag a non-unique key). This is row-fetching, so
/// it lives in the browse slice alongside `fetch_rows`.
pub async fn fetch_row_by_key(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    req: RowLookupRequest,
) -> Result<RowLookup, AppError> {
    manager.get(handle).await?.fetch_row_by_key(req).await
}

#[cfg(test)]
mod tests {
    use async_trait::async_trait;

    use super::*;
    use crate::shared::engine::{
        ColumnMeta, EngineConnection, EngineInfo, QueryOptions, QueryResult, SchemaInfo, TableInfo,
        TableMeta,
    };

    /// Minimal fake: `fetch_rows` and `fetch_row_by_key` matter here. Each
    /// echoes its request back so the use-case wiring is observable.
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

        async fn fetch_rows(&self, req: FetchRowsRequest) -> Result<RowsPage, AppError> {
            Ok(RowsPage {
                columns: vec![ColumnMeta {
                    name: format!("{}.{}", req.schema, req.table),
                    type_hint: String::new(),
                }],
                rows: vec![],
                offset: req.offset,
                limit: req.limit,
                total_rows: Some(0),
                elapsed_ms: 0,
            })
        }

        async fn fetch_row_by_key(&self, req: RowLookupRequest) -> Result<RowLookup, AppError> {
            Ok(RowLookup {
                columns: vec![ColumnMeta {
                    name: format!("{}.{}.{}", req.schema, req.table, req.column),
                    type_hint: String::new(),
                }],
                row: Some(vec![req.value.clone()]),
                match_count: 1,
            })
        }

        async fn close(&self) -> Result<(), AppError> {
            Ok(())
        }
    }

    fn sample_request() -> FetchRowsRequest {
        FetchRowsRequest {
            schema: "main".into(),
            table: "users".into(),
            sort: None,
            filter: None,
            offset: 20,
            limit: 10,
        }
    }

    #[tokio::test]
    async fn delegates_to_the_connection_behind_the_handle() {
        let manager = ConnectionManager::new();
        let handle = manager.insert(Box::new(FakeConnection)).await;
        let page = fetch_rows(&manager, &handle, sample_request())
            .await
            .expect("fetch rows");
        assert_eq!(page.columns[0].name, "main.users");
        assert_eq!(page.offset, 20);
        assert_eq!(page.limit, 10);
    }

    #[tokio::test]
    async fn closed_handle_is_a_not_found_with_a_human_message() {
        let manager = ConnectionManager::new();
        let handle = ConnectionHandleId("ghost".into());
        let err = fetch_rows(&manager, &handle, sample_request())
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
        assert!(err.to_string().contains("closed"));
    }

    fn sample_lookup() -> RowLookupRequest {
        RowLookupRequest {
            schema: "main".into(),
            table: "authors".into(),
            column: "id".into(),
            value: serde_json::json!(42),
        }
    }

    #[tokio::test]
    async fn fetch_row_by_key_delegates_to_the_connection() {
        let manager = ConnectionManager::new();
        let handle = manager.insert(Box::new(FakeConnection)).await;
        let lookup = fetch_row_by_key(&manager, &handle, sample_lookup())
            .await
            .expect("row lookup");
        assert_eq!(lookup.columns[0].name, "main.authors.id");
        assert_eq!(lookup.row, Some(vec![serde_json::json!(42)]));
        assert_eq!(lookup.match_count, 1);
    }

    #[tokio::test]
    async fn fetch_row_by_key_closed_handle_is_a_not_found() {
        let manager = ConnectionManager::new();
        let handle = ConnectionHandleId("ghost".into());
        let err = fetch_row_by_key(&manager, &handle, sample_lookup())
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
        assert!(err.to_string().contains("closed"));
    }
}
