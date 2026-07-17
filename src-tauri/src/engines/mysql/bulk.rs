//! Bulk insert + PK-pool read for the data-generation feature
//! (`features::generate`).

use sqlx::mysql::MySqlPool;

use crate::shared::error::AppError;

use super::error::map_query_error;
use super::query::{bind_value, decode_value};
use super::sql::{qualified, quote_ident, BoundValue};

/// Append pre-generated rows to a table (M16 generate). All rows go in one
/// transaction; within it, rows are split into statements that stay under
/// MySQL's 65535 bind-parameter ceiling. Any error rolls the whole call back.
/// NULL JSON binds as SQL NULL (`BoundValue::from_json_set`).
pub(super) async fn bulk_insert(
    pool: &MySqlPool,
    schema: &str,
    table: &str,
    columns: &[String],
    binary: &[bool],
    rows: &[Vec<serde_json::Value>],
) -> Result<u64, AppError> {
    if rows.is_empty() || columns.is_empty() {
        return Ok(0);
    }
    let width = columns.len();
    let max_rows_per_stmt = (60_000 / width).max(1);
    let bind_one = |i: usize, v: &serde_json::Value| -> Result<BoundValue, AppError> {
        if binary.get(i).copied().unwrap_or(false) {
            BoundValue::from_binary_set(v)
        } else {
            Ok(BoundValue::from_json_set(v))
        }
    };

    let mut tx = pool.begin().await.map_err(map_query_error)?;
    let mut affected = 0u64;
    for chunk in rows.chunks(max_rows_per_stmt) {
        let stmt = super::sql::build_multi_insert_sql(schema, table, columns, chunk.len());
        let bounds: Vec<BoundValue> = chunk
            .iter()
            .flat_map(|row| row.iter().enumerate().map(|(i, v)| bind_one(i, v)))
            .collect::<Result<Vec<_>, _>>()?;
        let mut query = sqlx::query(&stmt);
        for b in &bounds {
            query = bind_value(query, b);
        }
        let res = query.execute(&mut *tx).await.map_err(map_query_error)?;
        affected += res.rows_affected();
    }
    tx.commit().await.map_err(map_query_error)?;
    Ok(affected)
}

/// Read up to `cap` tuples of `columns` for FK sourcing / append baselining.
pub(super) async fn fetch_pk_pool(
    pool: &MySqlPool,
    schema: &str,
    table: &str,
    columns: &[String],
    cap: u64,
) -> Result<Vec<Vec<serde_json::Value>>, AppError> {
    if columns.is_empty() {
        return Ok(Vec::new());
    }
    let cols_sql = columns
        .iter()
        .map(|c| quote_ident(c))
        .collect::<Vec<_>>()
        .join(", ");
    let stmt = format!(
        "SELECT {cols_sql} FROM {} LIMIT {cap}",
        qualified(schema, table)
    );
    let rows = sqlx::query(&stmt)
        .fetch_all(pool)
        .await
        .map_err(map_query_error)?;
    Ok(rows
        .iter()
        .map(|r| (0..columns.len()).map(|i| decode_value(r, i)).collect())
        .collect())
}
