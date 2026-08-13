//! Use-cases for the explain slice. Depend on the shared engine abstraction
//! plus the connections feature's application layer (the `ConnectionManager`
//! that owns open handles — see the cross-feature note in the slice docs). No
//! Tauri, no drivers.

use crate::features::connections::application::{ConnectionHandleId, ConnectionManager};
use crate::shared::engine::QueryOptions;
use crate::shared::error::AppError;

use super::domain::{self, ExplainCapabilities, Measurement, RawPlan, ServerPlan};

/// Row cap for a plan. Generous — a deep plan is long, not wide — but bounded,
/// because this is still an arbitrary result set.
const PLAN_ROW_LIMIT: usize = 2000;

/// Row cap for the measuring run. Above the 500 a normal Run uses, so ordinary
/// result sets are counted exactly; when the cap does bite the result is flagged
/// truncated and the panel reports the count as a lower bound.
const MEASURE_ROW_LIMIT: usize = 1000;

/// What this connection's engine can be asked for.
pub async fn capabilities(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
) -> Result<ExplainCapabilities, AppError> {
    let engine = manager.get_sql(handle).await?.engine_info().engine;
    Ok(domain::capabilities(engine))
}

/// The machine-readable plan behind the plan tree.
///
/// **Executes nothing** — this is always the plan-only form, which is what lets
/// the panel draw a real tree against a production connection.
///
/// `Ok(None)` means "this engine has no structured plan, or its answer was not
/// one we can read": the renderer falls back to its modelled tree, which always
/// draws. Only a failure of the statement itself is an error worth surfacing,
/// and even that the caller may choose to swallow.
pub async fn plan(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    sql: &str,
    schema: Option<String>,
) -> Result<Option<ServerPlan>, AppError> {
    let connection = manager.get_sql(handle).await?;
    let engine = connection.engine_info().engine;
    let Some(statement) = domain::structured_statement(engine, sql) else {
        return Ok(None);
    };
    let result = connection
        .run_query(
            &statement,
            QueryOptions {
                row_limit: PLAN_ROW_LIMIT,
                schema,
            },
        )
        .await?;
    let columns: Vec<String> = result.columns.into_iter().map(|c| c.name).collect();
    Ok(domain::parse(engine, &columns, &result.rows))
}

/// The plan as the engine prints it, for the "Raw output" view — returned
/// untouched, so it reads exactly as it would in a terminal client.
///
/// `analyze: false` plans without executing. **`analyze: true` executes the
/// statement**, which is why it is only ever reached from a deliberate click.
pub async fn raw(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    sql: &str,
    schema: Option<String>,
    analyze: bool,
) -> Result<RawPlan, AppError> {
    let connection = manager.get_sql(handle).await?;
    let engine = connection.engine_info().engine;
    let statement = domain::raw_statement(engine, sql, analyze).ok_or_else(|| {
        AppError::Unsupported("This engine cannot produce that form of EXPLAIN.".into())
    })?;
    let result = connection
        .run_query(
            &statement,
            QueryOptions {
                row_limit: PLAN_ROW_LIMIT,
                schema,
            },
        )
        .await?;
    let text = result.columns.len() == 1;
    Ok(RawPlan {
        statement,
        columns: result.columns.into_iter().map(|c| c.name).collect(),
        rows: result.rows,
        text,
    })
}

/// Measure what the statement actually does: how long it takes, how many rows
/// it returns, and — by counting — how many its base relation read and how many
/// survived the filter.
///
/// **This executes the statement.** It is the one part of the panel that does,
/// which is why the renderer only calls it automatically on dev and staging
/// connections and waits for a click on production ones.
///
/// The two counts are the figures no plan can give: a planner reports
/// estimates, and "rows read" / "selectivity" are worth showing precisely
/// because they are exact. A probe that fails is dropped rather than failing the
/// measurement — the column simply reads "—".
pub async fn measure(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    sql: &str,
    schema: Option<String>,
) -> Result<Measurement, AppError> {
    let connection = manager.get_sql(handle).await?;
    let options = |row_limit| QueryOptions {
        row_limit,
        schema: schema.clone(),
    };

    let run = connection
        .run_query(sql, options(MEASURE_ROW_LIMIT))
        .await?;

    let mut scanned = None;
    let mut kept = None;
    if let Some(probes) = domain::count_probes(sql) {
        scanned = count(&*connection, &probes.scanned, options(1)).await;
        if let Some(filtered) = probes.kept.as_deref() {
            kept = count(&*connection, filtered, options(1)).await;
        }
    }
    // A stale or partial count must never produce a negative "rows removed".
    if let (Some(s), Some(k)) = (scanned, kept) {
        if k > s {
            scanned = Some(k);
        }
    }

    Ok(Measurement {
        ms: run.elapsed_ms,
        rows: run.row_count as i64,
        truncated: run.truncated,
        scanned,
        kept,
    })
}

/// Read a single COUNT(*) cell. Failures are swallowed: the count is an
/// enrichment, and a probe that a dialect rejects must not sink the whole
/// measurement.
async fn count(
    connection: &dyn crate::shared::engine::EngineConnection,
    sql: &str,
    options: QueryOptions,
) -> Option<i64> {
    let result = connection.run_query(sql, options).await.ok()?;
    let cell = result.rows.first()?.first()?;
    cell.as_i64()
        .or_else(|| cell.as_str().and_then(|s| s.parse().ok()))
        .or_else(|| cell.as_f64().map(|f| f as i64))
}
