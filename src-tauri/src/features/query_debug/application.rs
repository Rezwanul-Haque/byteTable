//! Use-cases for the query debugger: plan a statement's steps, and run one
//! step. Depends on the shared engine abstraction and the connections
//! feature's `ConnectionManager`, as the explain slice does. No Tauri.
//!
//! Every statement this layer sends is checked with
//! [`crate::shared::readonly::sql_is_read_only`] first, whatever the
//! connection's own setting: debug mode only ever reads.

use std::future::Future;
use std::time::Duration;

use serde::Serialize;
use tokio_util::sync::CancellationToken;

use crate::features::connections::application::{ConnectionHandleId, ConnectionManager};
use crate::shared::engine::{ColumnMeta, Engine, EngineConnection, QueryOptions};
use crate::shared::error::AppError;

use super::domain::{self, CannotDebug, DebugPlan, DebugStep};

/// Rows shown per step.
pub const SAMPLE_ROWS: usize = 200;

/// How long one step's query may run before it is stopped.
const STEP_TIMEOUT: Duration = Duration::from_secs(30);

/// Most WHERE conditions counted one by one; a longer list is still stepped,
/// just without the per-condition table.
const MAX_CONDS: usize = 8;

/// A plan, or why there is none.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PlanOutcome {
    Ready { plan: DebugPlan },
    Cannot { cannot: CannotDebug },
}

/// What one step found. `error` set means the step's own query failed; the
/// counts that are only enrichment (`join`, `conds`) are `None` when their
/// probe failed, and the renderer leaves their notes out.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StepOutcome {
    pub count: Option<u64>,
    /// Which of the step's `count_sql` gave the count; `None` when the sample
    /// itself was the count.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count_source: Option<usize>,
    pub columns: Vec<ColumnMeta>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub join: Option<JoinCounts>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conds: Option<Vec<Option<u64>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// The run was cancelled; nothing else is set.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub cancelled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinCounts {
    /// Incoming rows with no match.
    pub none: Option<u64>,
    /// Incoming rows that matched more than one row.
    pub many: Option<u64>,
}

/// Why one query of a step did not produce an answer.
enum Stop {
    Cancelled,
    Failed(String),
}

/// The plan-only form of a statement, used to ask the engine whether the
/// statement is valid before anything runs. `None` where an engine has no
/// plan-only EXPLAIN that runs as an ordinary statement (SQL Server); its
/// parse errors then surface on the first step instead.
fn plan_only(engine: Engine, sql: &str) -> Option<String> {
    let body = sql.trim().trim_end_matches(';').trim_end();
    match engine {
        Engine::Postgres | Engine::Mysql | Engine::Clickhouse => Some(format!("EXPLAIN {body}")),
        Engine::Sqlite => Some(format!("EXPLAIN QUERY PLAN {body}")),
        _ => None,
    }
}

/// Plan the steps of `sql`. Runs at most one plan-only EXPLAIN, never the
/// statement.
pub async fn plan(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    sql: &str,
    schema: Option<String>,
    sample: Option<u64>,
) -> Result<PlanOutcome, AppError> {
    let connection = manager.get_sql(handle).await?;
    let engine = connection.engine_info().engine;
    let plan = match domain::plan(sql, engine, sample) {
        Ok(plan) => plan,
        Err(cannot) => return Ok(PlanOutcome::Cannot { cannot }),
    };
    if let Some(explain) = plan_only(engine, sql) {
        let options = QueryOptions {
            row_limit: 1,
            schema,
        };
        // A slow planner is not a reason to refuse; only a rejection is.
        if let Ok(Err(e)) =
            tokio::time::timeout(STEP_TIMEOUT, connection.run_query(&explain, options)).await
        {
            return Ok(PlanOutcome::Cannot {
                cannot: CannotDebug::Parse {
                    message: e.to_string(),
                },
            });
        }
    }
    Ok(PlanOutcome::Ready { plan })
}

/// Run one step: its sample, its count, and its join or WHERE probes.
pub async fn run_step(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    step: &DebugStep,
    schema: Option<String>,
    cancel: &CancellationToken,
) -> Result<StepOutcome, AppError> {
    let connection = manager.get_sql(handle).await?;
    let conn: &dyn EngineConnection = &*connection;
    let options = |row_limit| QueryOptions {
        row_limit,
        schema: schema.clone(),
    };

    let sample = match guarded(cancel, conn, &step.sql, options(SAMPLE_ROWS)).await {
        Ok(r) => r,
        Err(Stop::Cancelled) => return Ok(cancelled()),
        Err(Stop::Failed(message)) => {
            return Ok(StepOutcome {
                error: Some(message),
                ..Default::default()
            })
        }
    };

    // A sample that fits is the exact count; only a cut one needs counting —
    // unless the step says its sample is not the answer (`always_count`).
    let mut count = (!sample.truncated && !step.always_count).then_some(sample.row_count as u64);
    let mut count_source = None;
    let mut count_error = None;
    if count.is_none() {
        for (k, sql) in step.count_sql.iter().enumerate() {
            match count_of(cancel, conn, sql, options(1)).await {
                Ok(n) => {
                    count = Some(n);
                    count_source = Some(k);
                    break;
                }
                Err(Stop::Cancelled) => return Ok(cancelled()),
                Err(Stop::Failed(message)) => count_error = Some(message),
            }
        }
    }
    let Some(total) = count else {
        return Ok(StepOutcome {
            error: Some(format!(
                "Couldn't count this step's rows: {}",
                count_error.unwrap_or_default()
            )),
            ..Default::default()
        });
    };

    let mut out = StepOutcome {
        count: Some(total),
        count_source,
        columns: sample.columns,
        rows: sample.rows,
        ms: sample.elapsed_ms,
        ..Default::default()
    };

    if let Some(probe) = &step.join {
        let mut counts = JoinCounts {
            none: None,
            many: None,
        };
        for (sql, slot) in [
            (&probe.none_sql, &mut counts.none),
            (&probe.many_sql, &mut counts.many),
        ] {
            match count_of(cancel, conn, sql, options(1)).await {
                Ok(n) => *slot = Some(n),
                Err(Stop::Cancelled) => return Ok(cancelled()),
                Err(Stop::Failed(_)) => {}
            }
        }
        out.join = Some(counts);
    }

    if let Some(conds) = step.conds.as_ref().filter(|c| c.len() <= MAX_CONDS) {
        let mut keeps = Vec::with_capacity(conds.len());
        for cond in conds {
            match count_of(cancel, conn, &cond.sql, options(1)).await {
                Ok(n) => keeps.push(Some(n)),
                Err(Stop::Cancelled) => return Ok(cancelled()),
                Err(Stop::Failed(_)) => keeps.push(None),
            }
        }
        out.conds = Some(keeps);
    }
    Ok(out)
}

fn cancelled() -> StepOutcome {
    StepOutcome {
        cancelled: true,
        ..Default::default()
    }
}

/// Run one read-only statement with the step timeout, stopping at once if the
/// run is cancelled (the in-flight query future is dropped).
async fn guarded(
    cancel: &CancellationToken,
    conn: &dyn EngineConnection,
    sql: &str,
    options: QueryOptions,
) -> Result<crate::shared::engine::QueryResult, Stop> {
    if !crate::shared::readonly::sql_is_read_only(sql) {
        // Unreachable for a plan this slice wrote; the check is the rule.
        return Err(Stop::Failed(
            "Debug mode only runs statements that read.".into(),
        ));
    }
    race(cancel, conn.run_query(sql, options)).await
}

async fn race<T>(
    cancel: &CancellationToken,
    work: impl Future<Output = Result<T, AppError>>,
) -> Result<T, Stop> {
    tokio::select! {
        _ = cancel.cancelled() => Err(Stop::Cancelled),
        r = tokio::time::timeout(STEP_TIMEOUT, work) => match r {
            Ok(Ok(v)) => Ok(v),
            Ok(Err(e)) => Err(Stop::Failed(e.to_string())),
            Err(_) => Err(Stop::Failed(format!(
                "This step took longer than {} seconds and was stopped.",
                STEP_TIMEOUT.as_secs()
            ))),
        },
    }
}

/// Read a single COUNT(*) cell.
async fn count_of(
    cancel: &CancellationToken,
    conn: &dyn EngineConnection,
    sql: &str,
    options: QueryOptions,
) -> Result<u64, Stop> {
    let result = guarded(cancel, conn, sql, options).await?;
    let cell = result
        .rows
        .first()
        .and_then(|r| r.first())
        .ok_or_else(|| Stop::Failed("The count returned no rows.".into()))?;
    cell.as_u64()
        .or_else(|| cell.as_str().and_then(|s| s.parse().ok()))
        .or_else(|| cell.as_f64().map(|f| f as u64))
        .ok_or_else(|| Stop::Failed("The count was not a number.".into()))
}

/// Runs real step queries against a tempdir SQLite file: the counts, the
/// capped samples and the join / WHERE probes must match the data.
#[cfg(test)]
mod sqlite_integration {
    use super::*;
    use crate::engines::sqlite::SqliteConnector;
    use crate::shared::engine::{ConnectionParams, Connector};

    /// 6 orders; payments for orders 1–4, two for order 2; 250 events.
    async fn open_fixture(dir: &tempfile::TempDir) -> (ConnectionManager, ConnectionHandleId) {
        let path = dir.path().join("debug_fixture.db");
        {
            let conn = rusqlite::Connection::open(&path).expect("create db");
            conn.execute_batch(
                "CREATE TABLE orders (id INTEGER PRIMARY KEY, total REAL, status TEXT);
                 INSERT INTO orders VALUES (1, 50, 'paid'), (2, 150, 'paid'), (3, 250, 'open'),
                     (4, 350, 'open'), (5, 450, 'void'), (6, 550, 'void');
                 CREATE TABLE payments (id INTEGER PRIMARY KEY, order_id INTEGER, status TEXT);
                 INSERT INTO payments VALUES (1, 1, 'ok'), (2, 2, 'ok'), (3, 2, 'retry'),
                     (4, 3, 'ok'), (5, 4, 'ok');
                 CREATE TABLE events (id INTEGER PRIMARY KEY, kind TEXT);
                 WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 250)
                 INSERT INTO events SELECT i, CASE WHEN i % 2 = 0 THEN 'a' ELSE 'b' END FROM n;",
            )
            .expect("seed db");
        }
        let params = ConnectionParams::Sqlite {
            path: path.to_string_lossy().into_owned(),
        };
        let open = SqliteConnector.open(&params).await.expect("open fixture");
        let manager = ConnectionManager::new();
        let handle = manager.insert(open).await;
        (manager, handle)
    }

    async fn run_all(sql: &str) -> Vec<(String, StepOutcome)> {
        let dir = tempfile::tempdir().unwrap();
        let (manager, handle) = open_fixture(&dir).await;
        let PlanOutcome::Ready { plan } = plan(&manager, &handle, sql, None, None).await.unwrap()
        else {
            panic!("not plannable: {sql}");
        };
        let token = CancellationToken::new();
        let mut out = Vec::new();
        for step in &plan.steps {
            let r = run_step(&manager, &handle, step, None, &token)
                .await
                .unwrap();
            out.push((step.key.clone(), r));
        }
        out
    }

    fn at<'a>(steps: &'a [(String, StepOutcome)], key: &str) -> &'a StepOutcome {
        &steps.iter().find(|(k, _)| k == key).unwrap().1
    }

    /// The milestone's acceptance query.
    #[tokio::test]
    async fn the_acceptance_query_finds_where_the_rows_run_out() {
        let s = run_all(
            "SELECT * FROM orders o JOIN payments p ON p.order_id = o.id \
             WHERE o.total > 100 AND p.status = 'zzz'",
        )
        .await;
        assert_eq!(at(&s, "from").count, Some(6));
        let join = at(&s, "join0");
        assert_eq!(join.count, Some(5));
        let jc = join.join.as_ref().unwrap();
        assert_eq!(jc.none, Some(2), "orders 5 and 6 have no payment");
        assert_eq!(jc.many, Some(1), "order 2 has two payments");
        let w = at(&s, "where");
        assert_eq!(w.count, Some(0));
        assert_eq!(w.conds.as_deref(), Some(&[Some(4), Some(0)][..]));
        assert_eq!(at(&s, "select").count, Some(0));
    }

    /// Past the 200-row sample the count comes from a COUNT(*) probe.
    #[tokio::test]
    async fn a_capped_sample_is_counted_exactly() {
        let s = run_all("SELECT DISTINCT kind FROM events WHERE id > 0 ORDER BY kind").await;
        let from = at(&s, "from");
        assert_eq!(from.count, Some(250));
        assert_eq!(from.rows.len(), SAMPLE_ROWS);
        assert_eq!(at(&s, "select").count, Some(250));
        assert_eq!(at(&s, "distinct").count, Some(2));
        assert_eq!(at(&s, "orderBy").count, Some(2));
    }

    #[tokio::test]
    async fn group_by_and_limit_count_what_they_return() {
        let s = run_all(
            "SELECT o.status, COUNT(*) AS n FROM orders o LEFT JOIN payments p ON p.order_id = o.id \
             GROUP BY o.status ORDER BY n DESC LIMIT 2",
        )
        .await;
        let join = at(&s, "join0");
        assert_eq!(join.count, Some(7), "6 orders, order 2 twice");
        assert_eq!(join.join.as_ref().unwrap().none, Some(2));
        assert_eq!(at(&s, "groupBy").count, Some(3));
        assert_eq!(at(&s, "limit").count, Some(2));
    }

    #[tokio::test]
    async fn a_failing_step_reports_the_engines_message() {
        let dir = tempfile::tempdir().unwrap();
        let (manager, handle) = open_fixture(&dir).await;
        // The plan-only check catches it before any step runs.
        let out = plan(&manager, &handle, "SELECT nope FROM orders", None, None)
            .await
            .unwrap();
        assert!(matches!(
            out,
            PlanOutcome::Cannot {
                cannot: CannotDebug::Parse { .. }
            }
        ));
        // A step query that fails on its own still says so.
        let PlanOutcome::Ready { plan } =
            plan(&manager, &handle, "SELECT * FROM orders", None, None)
                .await
                .unwrap()
        else {
            panic!()
        };
        let mut broken = plan.steps[0].clone();
        broken.sql = "SELECT * FROM missing".into();
        let r = run_step(&manager, &handle, &broken, None, &CancellationToken::new())
            .await
            .unwrap();
        assert!(r.error.is_some());
    }

    #[tokio::test]
    async fn a_cancelled_run_starts_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let (manager, handle) = open_fixture(&dir).await;
        let PlanOutcome::Ready { plan } =
            plan(&manager, &handle, "SELECT * FROM orders", None, None)
                .await
                .unwrap()
        else {
            panic!()
        };
        let token = CancellationToken::new();
        token.cancel();
        let r = run_step(&manager, &handle, &plan.steps[0], None, &token)
            .await
            .unwrap();
        assert!(r.cancelled);
    }

    #[tokio::test]
    async fn a_sampled_run_reads_only_the_sample() {
        let dir = tempfile::tempdir().unwrap();
        let (manager, handle) = open_fixture(&dir).await;
        let PlanOutcome::Ready { plan } = plan(
            &manager,
            &handle,
            "SELECT * FROM events WHERE kind = 'a'",
            None,
            Some(10),
        )
        .await
        .unwrap() else {
            panic!()
        };
        assert_eq!(plan.sampled, Some(10));
        let token = CancellationToken::new();
        let from = run_step(&manager, &handle, &plan.steps[0], None, &token)
            .await
            .unwrap();
        assert_eq!(from.count, Some(10));
        let w = run_step(&manager, &handle, &plan.steps[1], None, &token)
            .await
            .unwrap();
        assert_eq!(w.count, Some(5));
    }

    /// UPDATE / DELETE are dry runs: right counts, the new values beside each
    /// row, and nothing in the database changes.
    #[tokio::test]
    async fn a_write_is_a_dry_run_that_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let (manager, handle) = open_fixture(&dir).await;
        let token = CancellationToken::new();
        let run = |sql: &'static str| {
            let (manager, handle, token) = (&manager, &handle, &token);
            async move {
                let PlanOutcome::Ready { plan } =
                    plan(manager, handle, sql, None, None).await.unwrap()
                else {
                    panic!("not plannable: {sql}");
                };
                let mut out = Vec::new();
                for step in &plan.steps {
                    out.push((
                        step.key.clone(),
                        run_step(manager, handle, step, None, token).await.unwrap(),
                    ));
                }
                out
            }
        };

        let upd =
            run("UPDATE orders SET status = 'void', total = total + 1 WHERE total > 300").await;
        let w = at(&upd, "write");
        assert_eq!(w.count, Some(3), "orders 4, 5, 6");
        let names: Vec<_> = w.columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["id", "total", "status", "→ status", "→ total"]);
        assert_eq!(w.rows[0][3], serde_json::json!("void"));
        assert_eq!(w.rows[0][4], serde_json::json!(351.0));

        // Joined: order 2 has two payments but is updated once.
        let joined =
            run("UPDATE orders SET status = 'x' FROM payments p WHERE p.order_id = orders.id")
                .await;
        assert_eq!(at(&joined, "where").count, Some(5), "joined rows");
        let jw = at(&joined, "write");
        assert_eq!(jw.count, Some(4), "distinct orders");
        assert_eq!(jw.count_source, Some(0), "from the DISTINCT count");

        let del = run("DELETE FROM payments WHERE status = 'retry'").await;
        assert_eq!(at(&del, "write").count, Some(1));

        // Nothing was written.
        let conn = manager.get_sql(&handle).await.unwrap();
        let check = conn
            .run_query(
                "SELECT (SELECT COUNT(*) FROM orders WHERE status IN ('void', 'x')), (SELECT COUNT(*) FROM payments)",
                QueryOptions::default(),
            )
            .await
            .unwrap();
        assert_eq!(check.rows[0], [serde_json::json!(2), serde_json::json!(5)]);
    }
}
