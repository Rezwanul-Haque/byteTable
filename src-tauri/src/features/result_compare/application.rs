//! Use-case for result compare: run query A and query B on one connection and
//! hand both results back. The comparison itself is the renderer's (it needs
//! the user's key and order choices, which change without re-running).
//!
//! Three rules hold here, whatever the renderer sent:
//! - only a single read statement is sent ([`check`]); a refused side is never
//!   sent, and neither side is sent until both have been checked;
//! - a side over [`MAX_ROWS`] is refused, never compared in part;
//! - on Postgres and MySQL both queries run inside one read-only transaction
//!   at a snapshot isolation level, so they read the same data
//!   ([`snapshot_begin`]). Elsewhere they run one after the other.

use std::future::Future;

use serde::Serialize;
use tokio_util::sync::CancellationToken;

use crate::shared::engine::{Engine, EngineConnection, PinnedSession, QueryOptions, QueryResult};
use crate::shared::error::AppError;
use crate::shared::readonly::{sql_is_read_only, statement_count};

/// Rows per side; the adapter reads one more to tell that there are more.
pub const MAX_ROWS: usize = 100_000;

/// Why a side was not sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Refusal {
    /// No query.
    Empty,
    /// Not provably read-only.
    Write,
    /// More than one statement.
    Multi,
    /// More than [`MAX_ROWS`] rows came back.
    TooMany,
}

/// One side's outcome: a result, the engine's error, or a refusal.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SideOutcome {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<QueryResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refused: Option<Refusal>,
}

impl SideOutcome {
    fn refused(r: Refusal) -> Self {
        Self {
            refused: Some(r),
            ..Default::default()
        }
    }
    fn failed(e: AppError) -> Self {
        Self {
            error: Some(e.to_string()),
            ..Default::default()
        }
    }
    fn of(result: QueryResult) -> Self {
        if result.truncated {
            return Self::refused(Refusal::TooMany);
        }
        Self {
            result: Some(result),
            ..Default::default()
        }
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompareOutcome {
    pub a: SideOutcome,
    pub b: SideOutcome,
    /// Both sides read one snapshot.
    pub snapshot: bool,
    /// Stopped by the user; the sides are empty.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub cancelled: bool,
}

fn cancelled() -> CompareOutcome {
    CompareOutcome {
        cancelled: true,
        ..Default::default()
    }
}

/// The statement to send for one side, or why it is refused.
pub fn check(sql: &str) -> Result<String, Refusal> {
    let stmt = sql
        .trim()
        .trim_end_matches(|c: char| c == ';' || c.is_whitespace());
    if statement_count(stmt) == 0 {
        return Err(Refusal::Empty);
    }
    if statement_count(stmt) > 1 {
        return Err(Refusal::Multi);
    }
    if !sql_is_read_only(stmt) {
        return Err(Refusal::Write);
    }
    Ok(stmt.to_string())
}

/// The statements that open a read-only snapshot transaction, where the engine
/// has one that needs no database setting.
///
/// SQLite is left out on purpose: the app holds ONE connection per file, so
/// any statement another tab ran while the transaction was open would run
/// inside it, and the closing ROLLBACK would undo it. SQL Server's SNAPSHOT
/// level must be enabled per database, so it is not assumed either.
pub fn snapshot_begin(engine: Engine) -> Option<&'static [&'static str]> {
    match engine {
        Engine::Postgres => Some(&["BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"]),
        Engine::Mysql => Some(&[
            "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ",
            "START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY",
        ]),
        _ => None,
    }
}

/// `work`, unless the run is cancelled first (the query future is dropped).
async fn race<T>(
    cancel: &CancellationToken,
    work: impl Future<Output = Result<T, AppError>>,
) -> Option<Result<T, AppError>> {
    tokio::select! {
        biased;
        _ = cancel.cancelled() => None,
        r = work => Some(r),
    }
}

/// Run both sides. See the module comment for the rules.
pub async fn run(
    conn: &dyn EngineConnection,
    sql_a: &str,
    sql_b: &str,
    schema: Option<String>,
    cancel: &CancellationToken,
) -> CompareOutcome {
    // Both sides are checked before either is sent.
    let (ca, cb) = (check(sql_a), check(sql_b));
    if let (Ok(a), Ok(b)) = (&ca, &cb) {
        if let Some(begin) = snapshot_begin(conn.engine_info().engine) {
            if let Some(out) = in_snapshot(conn, begin, a, b, schema.clone(), cancel).await {
                return out;
            }
        }
    }
    let options = QueryOptions {
        row_limit: MAX_ROWS,
        schema,
    };
    let mut out = CompareOutcome::default();
    for (check, side) in [(ca, &mut out.a), (cb, &mut out.b)] {
        *side = match check {
            Err(r) => SideOutcome::refused(r),
            Ok(stmt) => match race(cancel, conn.run_query(&stmt, options.clone())).await {
                None => return cancelled(),
                Some(Ok(r)) => SideOutcome::of(r),
                Some(Err(e)) => SideOutcome::failed(e),
            },
        };
    }
    out
}

/// Both sides inside one read-only snapshot transaction. `None` when the
/// transaction could not be opened, so the caller runs them back to back.
async fn in_snapshot(
    conn: &dyn EngineConnection,
    begin: &[&str],
    a: &str,
    b: &str,
    schema: Option<String>,
    cancel: &CancellationToken,
) -> Option<CompareOutcome> {
    let mut session = conn.pin(schema).await.ok()?;
    let s: &mut dyn PinnedSession = session.as_mut();
    for stmt in begin {
        if s.query(stmt, 1).await.is_err() {
            // A server too old for READ ONLY, say. Nothing is open (or it is
            // rolled back here), so back to back is still safe.
            let _ = s.query("ROLLBACK", 1).await;
            return None;
        }
    }
    let mut out = CompareOutcome {
        snapshot: true,
        ..Default::default()
    };
    for (stmt, side) in [(a, &mut out.a), (b, &mut out.b)] {
        *side = match race(cancel, s.query(stmt, MAX_ROWS)).await {
            None => {
                // The transaction must end before the connection goes back
                // to the pool.
                let _ = s.query("ROLLBACK", 1).await;
                return Some(cancelled());
            }
            Some(Ok(r)) => SideOutcome::of(r),
            Some(Err(e)) => SideOutcome::failed(e),
        };
        if side.error.is_some() && conn.engine_info().engine == Engine::Postgres {
            // A failed statement aborts a Postgres transaction; B gets a fresh
            // one, still read-only. Its snapshot is a new one, so say so.
            let _ = s.query("ROLLBACK", 1).await;
            if s.query(begin[0], 1).await.is_err() {
                return None;
            }
            out.snapshot = false;
        }
    }
    let _ = s.query("ROLLBACK", 1).await;
    Some(out)
}

/// Runs the real queries against a tempdir SQLite file (no snapshot there, so
/// the back-to-back path); Postgres's snapshot is covered by the integration
/// test gated on `BYTETABLE_TEST_PG_URL`.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::engines::sqlite::SqliteConnector;
    use crate::shared::engine::{ConnectionParams, Connector};

    #[test]
    fn check_refuses_what_is_not_one_read() {
        assert_eq!(check("  "), Err(Refusal::Empty));
        assert_eq!(check(";"), Err(Refusal::Empty));
        assert_eq!(check("UPDATE t SET a = 1"), Err(Refusal::Write));
        assert_eq!(check("delete from t"), Err(Refusal::Write));
        assert_eq!(check("SELECT 1; SELECT 2"), Err(Refusal::Multi));
        assert_eq!(check("SELECT 1;  \n"), Ok("SELECT 1".into()));
        assert_eq!(check("SELECT ';' AS x"), Ok("SELECT ';' AS x".into()));
    }

    async fn open(dir: &tempfile::TempDir) -> std::sync::Arc<dyn EngineConnection> {
        let path = dir.path().join("compare.db");
        {
            let c = rusqlite::Connection::open(&path).expect("create db");
            c.execute_batch(
                "CREATE TABLE orders (id INTEGER PRIMARY KEY, status TEXT);
                 INSERT INTO orders VALUES (1, 'shipped'), (2, 'delivered'), (3, 'delivered');",
            )
            .expect("seed");
        }
        let params = ConnectionParams::Sqlite {
            path: path.to_string_lossy().into_owned(),
        };
        SqliteConnector
            .open(&params)
            .await
            .expect("open")
            .into_sql()
            .expect("sql")
    }

    #[tokio::test]
    async fn runs_both_sides() {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(&dir).await;
        let token = CancellationToken::new();
        let out = run(
            &*conn,
            "SELECT * FROM orders",
            "SELECT * FROM orders WHERE status = 'delivered';",
            None,
            &token,
        )
        .await;
        assert_eq!(out.a.result.as_ref().unwrap().rows.len(), 3);
        assert_eq!(out.b.result.as_ref().unwrap().rows.len(), 2);
        assert!(!out.snapshot);
    }

    #[tokio::test]
    async fn a_write_is_never_sent() {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(&dir).await;
        let token = CancellationToken::new();
        let out = run(
            &*conn,
            "SELECT * FROM orders",
            "UPDATE orders SET status = 'gone'",
            None,
            &token,
        )
        .await;
        assert_eq!(out.b.refused, Some(Refusal::Write));
        let after = conn
            .run_query(
                "SELECT COUNT(*) FROM orders WHERE status = 'gone'",
                QueryOptions {
                    row_limit: 1,
                    schema: None,
                },
            )
            .await
            .unwrap();
        assert_eq!(after.rows[0][0], serde_json::json!(0));
    }

    #[tokio::test]
    async fn an_engine_error_is_reported_on_its_side() {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(&dir).await;
        let token = CancellationToken::new();
        let out = run(&*conn, "SELECT nope FROM orders", "SELECT 1", None, &token).await;
        assert!(out.a.error.is_some());
        assert!(out.b.result.is_some());
    }

    #[tokio::test]
    async fn a_cancelled_run_reports_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(&dir).await;
        let token = CancellationToken::new();
        token.cancel();
        let out = run(&*conn, "SELECT 1", "SELECT 2", None, &token).await;
        assert!(out.cancelled);
        assert!(out.a.result.is_none());
    }
}
