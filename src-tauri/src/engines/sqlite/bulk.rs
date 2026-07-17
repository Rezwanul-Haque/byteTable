//! Bulk insert + PK-pool read for the data-generation feature
//! (`features::generate`). Engine-private.

use rusqlite::types::Value as SqlValue;
use rusqlite::Connection;

use crate::shared::error::AppError;

use super::error::{map_query_error, value_to_json};
use super::introspect::ensure_schema_exists;
use super::sql::{json_to_blob_set, json_to_set_value, quote_ident};

/// Append pre-generated rows to a table in one transaction (M16 generate). A
/// single prepared `INSERT … VALUES (?, …)` is reused per row; any error rolls
/// the whole batch back so a chunk is all-or-nothing. NULL JSON binds as SQL
/// NULL (`json_to_set_value`).
pub(super) fn bulk_insert_blocking(
    conn: &Connection,
    schema: &str,
    table: &str,
    columns: &[String],
    binary: &[bool],
    rows: &[Vec<serde_json::Value>],
) -> Result<u64, AppError> {
    ensure_schema_exists(conn, schema)?;
    if rows.is_empty() || columns.is_empty() {
        return Ok(0);
    }
    let is_binary = |i: usize| binary.get(i).copied().unwrap_or(false);
    let cols_sql = columns
        .iter()
        .map(|c| quote_ident(c))
        .collect::<Vec<_>>()
        .join(", ");
    let placeholders = std::iter::repeat_n("?", columns.len())
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "INSERT INTO {}.{} ({cols_sql}) VALUES ({placeholders})",
        quote_ident(schema),
        quote_ident(table)
    );

    let _ = conn.busy_timeout(std::time::Duration::from_secs(5));
    conn.execute_batch("BEGIN")
        .map_err(|err| map_query_error(conn, err))?;
    let mut affected = 0u64;
    {
        let mut stmt = match conn.prepare(&sql) {
            Ok(stmt) => stmt,
            Err(err) => {
                let _ = conn.execute_batch("ROLLBACK");
                return Err(map_query_error(conn, err));
            }
        };
        for row in rows {
            let params: Vec<SqlValue> = row
                .iter()
                .enumerate()
                .map(|(i, v)| {
                    if is_binary(i) {
                        json_to_blob_set(v)
                    } else {
                        Ok(json_to_set_value(v))
                    }
                })
                .collect::<Result<Vec<_>, _>>()?;
            match stmt.execute(rusqlite::params_from_iter(params.iter())) {
                Ok(n) => affected += n as u64,
                Err(err) => {
                    let _ = conn.execute_batch("ROLLBACK");
                    return Err(map_query_error(conn, err));
                }
            }
        }
    }
    conn.execute_batch("COMMIT")
        .map_err(|err| map_query_error(conn, err))?;
    Ok(affected)
}

/// Read up to `cap` tuples of `columns` from a table for FK sourcing /
/// append-uniqueness baselining (M16 generate).
pub(super) fn fetch_pk_pool_blocking(
    conn: &Connection,
    schema: &str,
    table: &str,
    columns: &[String],
    cap: u64,
) -> Result<Vec<Vec<serde_json::Value>>, AppError> {
    ensure_schema_exists(conn, schema)?;
    if columns.is_empty() {
        return Ok(Vec::new());
    }
    let cols_sql = columns
        .iter()
        .map(|c| quote_ident(c))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT {cols_sql} FROM {}.{} LIMIT {cap}",
        quote_ident(schema),
        quote_ident(table)
    );
    let n = columns.len();
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|err| map_query_error(conn, err))?;
    let rows = stmt
        .query_map([], |r| {
            let mut out = Vec::with_capacity(n);
            for i in 0..n {
                out.push(value_to_json(r.get_ref(i)?));
            }
            Ok(out)
        })
        .map_err(|err| map_query_error(conn, err))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| map_query_error(conn, err))?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engines::sqlite::test_support::*;
    use crate::engines::sqlite::SqliteConnector;
    use crate::shared::engine::*;

    use std::sync::atomic::{AtomicBool, Ordering};

    use crate::features::connections::application::{ConnectionHandleId, ConnectionManager};
    use crate::features::generate::application::{run_generation, GenProgress, RunCtx};
    use crate::features::generate::domain::GenerateSize;

    #[tokio::test]
    async fn bulk_insert_appends_rows_and_pk_pool_reads_them() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_empty(&dir).await;
        conn.run_query(
            "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)",
            QueryOptions::default(),
        )
        .await
        .expect("create t");

        let n = conn
            .bulk_insert(
                "main",
                "t",
                &["id".into(), "name".into()],
                &[false, false],
                &[
                    vec![serde_json::json!(1), serde_json::json!("a")],
                    vec![serde_json::json!(2), serde_json::json!("b")],
                ],
            )
            .await
            .expect("bulk insert");
        assert_eq!(n, 2);

        let pool = conn
            .fetch_pk_pool("main", "t", &["id".into()], 100)
            .await
            .expect("pk pool");
        let mut ids: Vec<i64> = pool.iter().map(|r| r[0].as_i64().unwrap()).collect();
        ids.sort();
        assert_eq!(ids, vec![1, 2]);
    }

    #[tokio::test]
    async fn bulk_insert_rolls_back_the_chunk_on_constraint_violation() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_empty(&dir).await;
        conn.run_query(
            "CREATE TABLE u (id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL)",
            QueryOptions::default(),
        )
        .await
        .expect("create u");

        // second row duplicates the unique email → whole chunk rolls back
        let err = conn
            .bulk_insert(
                "main",
                "u",
                &["id".into(), "email".into()],
                &[false, false],
                &[
                    vec![serde_json::json!(1), serde_json::json!("x@y.z")],
                    vec![serde_json::json!(2), serde_json::json!("x@y.z")],
                ],
            )
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Database(_)));

        let pool = conn
            .fetch_pk_pool("main", "u", &["id".into()], 100)
            .await
            .expect("rolled back");
        assert!(pool.is_empty(), "rolled back: no rows committed");
    }

    async fn open_managed(dir: &tempfile::TempDir) -> (ConnectionManager, ConnectionHandleId) {
        let path = dir.path().join("gen.db");
        {
            Connection::open(&path).expect("create db");
        }
        let open = SqliteConnector
            .open(&params_for(&path))
            .await
            .expect("open db");
        let manager = ConnectionManager::new();
        let handle = manager.insert(open).await;
        (manager, handle)
    }

    fn first_count(r: &QueryResult) -> i64 {
        r.rows[0][0].as_i64().expect("count cell")
    }

    #[tokio::test]
    async fn run_generation_fills_schema_with_no_orphan_fks() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (manager, handle) = open_managed(&dir).await;
        let sql = manager.get_sql(&handle).await.expect("sql");
        sql.run_query(
            "CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL)",
            QueryOptions::default(),
        )
        .await
        .expect("create users");
        sql.run_query(
            "CREATE TABLE orders (id INTEGER PRIMARY KEY, \
             user_id INTEGER NOT NULL REFERENCES users(id), total REAL)",
            QueryOptions::default(),
        )
        .await
        .expect("create orders");

        let cancel = AtomicBool::new(false);
        let noop = |_p: GenProgress| {};
        let summary = run_generation(
            &manager,
            &handle,
            "main",
            GenerateSize::OneK,
            RunCtx {
                cancel: &cancel,
                on_progress: &noop,
                seed: 1,
            },
        )
        .await
        .expect("run");
        assert!(summary.total_inserted > 0);
        assert!(!summary.cancelled);

        let orphans = sql
            .run_query(
                "SELECT count(*) FROM orders o \
                 LEFT JOIN users u ON o.user_id = u.id WHERE u.id IS NULL",
                QueryOptions::default(),
            )
            .await
            .expect("orphan query");
        assert_eq!(first_count(&orphans), 0, "no orphan FKs");

        let dups = sql
            .run_query(
                "SELECT count(*) - count(DISTINCT email) FROM users",
                QueryOptions::default(),
            )
            .await
            .expect("dup query");
        assert_eq!(first_count(&dups), 0, "emails unique");

        // Run again: append must not collide on the UNIQUE email.
        let summary2 = run_generation(
            &manager,
            &handle,
            "main",
            GenerateSize::OneK,
            RunCtx {
                cancel: &cancel,
                on_progress: &noop,
                seed: 2,
            },
        )
        .await
        .expect("run 2");
        assert!(summary2.total_inserted > 0);
        let dups2 = sql
            .run_query(
                "SELECT count(*) - count(DISTINCT email) FROM users",
                QueryOptions::default(),
            )
            .await
            .expect("dup query 2");
        assert_eq!(first_count(&dups2), 0, "emails still unique after append");
    }

    #[tokio::test]
    async fn run_generation_binary_pk_and_fk_round_trip() {
        // Mirrors byteshop: BLOB(16) UUID pk + a BLOB FK referencing it. The FK
        // value must round-trip as raw bytes, not as its 0x-hex text (which would
        // be twice the byte length).
        let dir = tempfile::tempdir().expect("tempdir");
        let (manager, handle) = open_managed(&dir).await;
        let sql = manager.get_sql(&handle).await.expect("sql");
        sql.run_query(
            "CREATE TABLE accounts (id BLOB PRIMARY KEY, name TEXT)",
            QueryOptions::default(),
        )
        .await
        .expect("create accounts");
        sql.run_query(
            "CREATE TABLE documents (id BLOB PRIMARY KEY, \
             account_id BLOB NOT NULL REFERENCES accounts(id), title TEXT)",
            QueryOptions::default(),
        )
        .await
        .expect("create documents");

        let cancel = AtomicBool::new(false);
        let noop = |_p: GenProgress| {};
        let summary = run_generation(
            &manager,
            &handle,
            "main",
            GenerateSize::OneK,
            RunCtx {
                cancel: &cancel,
                on_progress: &noop,
                seed: 4,
            },
        )
        .await
        .expect("run");
        for r in &summary.tables {
            assert!(r.error.is_none(), "table {} failed: {:?}", r.table, r.error);
        }

        // Every document.account_id must match an existing accounts.id (bytes).
        let orphans = sql
            .run_query(
                "SELECT count(*) FROM documents d \
                 LEFT JOIN accounts a ON d.account_id = a.id WHERE a.id IS NULL",
                QueryOptions::default(),
            )
            .await
            .expect("orphan query");
        assert_eq!(first_count(&orphans), 0, "binary FKs resolve to real keys");
    }

    #[tokio::test]
    async fn run_generation_self_ref_has_no_orphans() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (manager, handle) = open_managed(&dir).await;
        let sql = manager.get_sql(&handle).await.expect("sql");
        sql.run_query(
            "CREATE TABLE employees (id INTEGER PRIMARY KEY, name TEXT, \
             manager_id INTEGER REFERENCES employees(id))",
            QueryOptions::default(),
        )
        .await
        .expect("create employees");

        let cancel = AtomicBool::new(false);
        let noop = |_p: GenProgress| {};
        run_generation(
            &manager,
            &handle,
            "main",
            GenerateSize::OneK,
            RunCtx {
                cancel: &cancel,
                on_progress: &noop,
                seed: 3,
            },
        )
        .await
        .expect("run");

        let orphans = sql
            .run_query(
                "SELECT count(*) FROM employees e \
                 WHERE e.manager_id IS NOT NULL \
                 AND e.manager_id NOT IN (SELECT id FROM employees)",
                QueryOptions::default(),
            )
            .await
            .expect("orphan query");
        assert_eq!(first_count(&orphans), 0, "self-ref FKs all valid");
    }

    #[tokio::test]
    async fn run_generation_cancelled_before_start_writes_nothing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (manager, handle) = open_managed(&dir).await;
        let sql = manager.get_sql(&handle).await.expect("sql");
        sql.run_query(
            "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)",
            QueryOptions::default(),
        )
        .await
        .expect("create t");

        let cancel = AtomicBool::new(true); // already cancelled
        let noop = |_p: GenProgress| {};
        let summary = run_generation(
            &manager,
            &handle,
            "main",
            GenerateSize::OneK,
            RunCtx {
                cancel: &cancel,
                on_progress: &noop,
                seed: 1,
            },
        )
        .await
        .expect("run");
        assert!(summary.cancelled);
        assert_eq!(summary.total_inserted, 0);
        let _ = Ordering::Relaxed; // silence unused import in some build configs
    }
}
