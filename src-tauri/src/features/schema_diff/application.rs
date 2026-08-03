//! Use-cases for the schema-diff slice (M28): snapshot a schema, compare two
//! snapshots, apply the selected statements. No Tauri, no drivers.
//!
//! Like introspection/structure, this layer consumes the connections feature's
//! `ConnectionManager` to resolve an open handle — the sanctioned cross-feature
//! composition. The two schemas being compared usually live on two *different*
//! handles; nothing here assumes they share a connection.

use crate::features::connections::application::{ConnectionHandleId, ConnectionManager};
use crate::shared::error::AppError;

use super::domain::{compare, MigrationStatement, SchemaComparison, SchemaSnapshot};
use super::infrastructure::EngineSchemaReader;
use super::ports::SchemaReader;
use crate::shared::engine::Engine;

/// Snapshot one schema's structure on an open SQL connection.
///
/// Read-only by construction: the reader can only return columns and indexes
/// (see [`super::ports::SchemaReader`]), so no row ever leaves the database.
pub async fn read_schema(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    schema: &str,
) -> Result<SchemaSnapshot, AppError> {
    let conn = manager.get_sql(handle).await?;
    EngineSchemaReader::new(conn).read_schema(schema).await
}

/// Diff two snapshots and plan the migration that makes `target` match
/// `source`, in the target engine's dialect.
///
/// Pure — the snapshots are values the caller already holds, so swapping
/// direction re-compares without re-reading either database.
pub fn compare_snapshots(
    source: &SchemaSnapshot,
    target: &SchemaSnapshot,
    target_engine: Engine,
) -> SchemaComparison {
    compare(source, target, target_engine)
}

/// Run the selected migration statements against the target schema.
///
/// **Mutates schema. Never touches row data** — the caller may only send
/// statements the planner produced.
///
/// The statements are executed as ONE script through the engine's script path,
/// which is what buys atomicity: Postgres runs it in an implicit transaction
/// and SQLite wraps it in `BEGIN`/`COMMIT`, so a mid-migration failure rolls
/// the whole thing back. **MySQL DDL auto-commits**, so there a failure leaves
/// the earlier statements applied — the same caveat the SQL importer carries.
/// The script path also scopes the run to `schema` (`SET search_path` / `USE`),
/// which is why the planner can emit unqualified table names.
///
/// Returns the number of statements sent.
pub async fn apply_migration(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    schema: &str,
    statements: &[MigrationStatement],
) -> Result<u64, AppError> {
    if statements.is_empty() {
        return Err(AppError::Invalid(
            "Select at least one statement to apply.".into(),
        ));
    }
    let script = statements
        .iter()
        .map(|s| s.sql.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let conn = manager.get_sql(handle).await?;
    conn.execute_script(schema, &script, &|_done, _total| {})
        .await?;
    Ok(statements.len() as u64)
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use async_trait::async_trait;

    use super::*;
    use crate::features::schema_diff::domain::{StatementKind, TableStatus};
    use crate::shared::engine::{
        ColumnInfo, EngineConnection, EngineInfo, FetchRowsRequest, ImportResult, IndexInfo,
        OpenConnection, ProgressCallback, QueryOptions, QueryResult, RowsPage, SchemaInfo,
        TableInfo, TableMeta,
    };

    /// Fake SQL connection: two tables whose shapes are set per instance, plus
    /// a recorder for the script an apply sends.
    struct FakeConnection {
        /// (table, columns as (name, type), indexes as (name, cols, primary))
        tables: Vec<(&'static str, Vec<(&'static str, &'static str)>)>,
        script: Mutex<Option<(String, String)>>,
    }

    impl FakeConnection {
        fn new(tables: Vec<(&'static str, Vec<(&'static str, &'static str)>)>) -> Self {
            Self {
                tables,
                script: Mutex::new(None),
            }
        }
    }

    #[async_trait]
    impl EngineConnection for FakeConnection {
        fn engine_info(&self) -> EngineInfo {
            EngineInfo {
                engine: Engine::Sqlite,
                server_version: "SQLite 0.0-test".into(),
            }
        }

        async fn list_schemas(&self) -> Result<Vec<SchemaInfo>, AppError> {
            Ok(vec![])
        }

        async fn list_tables(&self, _schema: &str) -> Result<Vec<TableInfo>, AppError> {
            Ok(self
                .tables
                .iter()
                .map(|(name, _)| TableInfo {
                    name: (*name).to_string(),
                    approx_row_count: None,
                })
                .collect())
        }

        async fn table_meta(&self, _schema: &str, table: &str) -> Result<TableMeta, AppError> {
            let (_, cols) = self
                .tables
                .iter()
                .find(|(name, _)| *name == table)
                .expect("known table");
            Ok(TableMeta {
                columns: cols
                    .iter()
                    .enumerate()
                    .map(|(i, (name, ty))| ColumnInfo {
                        name: (*name).to_string(),
                        data_type: (*ty).to_string(),
                        nullable: i > 0,
                        pk: i == 0,
                        default_value: None,
                        fk: None,
                        comment: None,
                        auto_increment: false,
                    })
                    .collect(),
                indexes: vec![IndexInfo {
                    name: format!("{table}_pkey"),
                    columns: vec![cols[0].0.to_string()],
                    unique: true,
                    primary: true,
                    origin: None,
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

        async fn execute_script(
            &self,
            schema: &str,
            sql: &str,
            _on_progress: ProgressCallback<'_>,
        ) -> Result<ImportResult, AppError> {
            *self.script.lock().expect("script lock") = Some((schema.to_string(), sql.to_string()));
            Ok(ImportResult { statements: 1 })
        }

        async fn close(&self) -> Result<(), AppError> {
            Ok(())
        }
    }

    fn users_v1() -> Vec<(&'static str, Vec<(&'static str, &'static str)>)> {
        vec![("users", vec![("id", "INTEGER"), ("email", "TEXT")])]
    }

    fn users_v2() -> Vec<(&'static str, Vec<(&'static str, &'static str)>)> {
        vec![(
            "users",
            vec![
                ("id", "INTEGER"),
                ("email", "TEXT"),
                ("country", "VARCHAR(2)"),
            ],
        )]
    }

    #[tokio::test]
    async fn reads_a_snapshot_off_the_connection_behind_the_handle() {
        let manager = ConnectionManager::new();
        let handle = manager
            .insert(OpenConnection::sql(FakeConnection::new(users_v2())))
            .await;
        let snap = read_schema(&manager, &handle, "main")
            .await
            .expect("snapshot");
        assert_eq!(snap.schema, "main");
        assert_eq!(snap.tables.len(), 1);
        let users = &snap.tables[0];
        assert_eq!(users.columns.len(), 3);
        assert!(users.columns[0].pk);
        assert_eq!(users.columns[2].data_type, "VARCHAR(2)");
        // The primary-key index is carried through; the differ ignores it.
        assert!(users.indexes[0].primary);
    }

    #[tokio::test]
    async fn a_closed_handle_is_a_not_found_with_a_human_message() {
        let manager = ConnectionManager::new();
        let handle = ConnectionHandleId("ghost".into());
        let err = read_schema(&manager, &handle, "main").await.unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
        assert!(err.to_string().contains("closed"));
    }

    #[tokio::test]
    async fn two_handles_compare_independently_in_both_directions() {
        let manager = ConnectionManager::new();
        let rich = manager
            .insert(OpenConnection::sql(FakeConnection::new(users_v2())))
            .await;
        let lean = manager
            .insert(OpenConnection::sql(FakeConnection::new(users_v1())))
            .await;
        let rich_snap = read_schema(&manager, &rich, "main")
            .await
            .expect("snapshot");
        let lean_snap = read_schema(&manager, &lean, "main")
            .await
            .expect("snapshot");

        let forward = compare_snapshots(&rich_snap, &lean_snap, Engine::Sqlite);
        assert_eq!(forward.tables[0].status, TableStatus::Changed);
        assert_eq!(forward.statements.len(), 1);
        assert_eq!(forward.statements[0].kind, StatementKind::ColAdd);

        let back = compare_snapshots(&lean_snap, &rich_snap, Engine::Sqlite);
        assert_eq!(back.statements[0].kind, StatementKind::ColDrop);
        assert!(back.statements[0].destructive);
    }

    #[tokio::test]
    async fn apply_sends_the_selected_statements_as_one_schema_scoped_script() {
        let manager = ConnectionManager::new();
        let conn = std::sync::Arc::new(FakeConnection::new(users_v1()));
        let handle = manager.insert(OpenConnection::Sql(conn.clone())).await;

        let statements = vec![
            MigrationStatement {
                id: 0,
                kind: StatementKind::ColAdd,
                sql: "ALTER TABLE users ADD COLUMN country VARCHAR(2);".into(),
                table: "users".into(),
                destructive: false,
            },
            MigrationStatement {
                id: 1,
                kind: StatementKind::Index,
                sql: "CREATE INDEX idx_users_country ON users (country);".into(),
                table: "users".into(),
                destructive: false,
            },
        ];
        let applied = apply_migration(&manager, &handle, "main", &statements)
            .await
            .expect("apply");
        assert_eq!(applied, 2);

        let sent = conn
            .script
            .lock()
            .expect("script lock")
            .clone()
            .expect("script");
        assert_eq!(sent.0, "main");
        assert_eq!(
            sent.1,
            "ALTER TABLE users ADD COLUMN country VARCHAR(2);\nCREATE INDEX idx_users_country ON users (country);"
        );
    }

    #[tokio::test]
    async fn applying_nothing_is_a_validation_error_not_an_empty_run() {
        let manager = ConnectionManager::new();
        let conn = std::sync::Arc::new(FakeConnection::new(users_v1()));
        let handle = manager.insert(OpenConnection::Sql(conn.clone())).await;
        let err = apply_migration(&manager, &handle, "main", &[])
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Invalid(_)));
        assert!(conn.script.lock().expect("script lock").is_none());
    }
}
