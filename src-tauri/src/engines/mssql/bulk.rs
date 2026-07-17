//! Bulk insert + PK-pool read for the data-generation feature
//! (`features::generate`).

use tiberius::Query;

use crate::shared::error::AppError;

use super::error::map_query_error;
use super::query::{bind_query, decode_row};
use super::sql::{build_multi_insert_sql, qualified, BoundValue};
use super::structure::quote_idents;
use super::{exec_batch, TdsClient};

// ---------------------------------------------------------------------------
// bulk_insert / fetch_pk_pool (M16 generate)
// ---------------------------------------------------------------------------

pub(super) async fn bulk_insert(
    client: &mut TdsClient,
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
    // T-SQL caps a statement at 2100 parameters; stay under it.
    let max_rows_per_stmt = (2000 / width).max(1);
    let bind_one = |i: usize, v: &serde_json::Value| -> Result<BoundValue, AppError> {
        if binary.get(i).copied().unwrap_or(false) {
            BoundValue::from_binary_set(v)
        } else {
            Ok(BoundValue::from_json_set(v))
        }
    };

    exec_batch(client, "BEGIN TRANSACTION").await?;
    let mut affected = 0u64;
    for chunk in rows.chunks(max_rows_per_stmt) {
        let stmt = build_multi_insert_sql(schema, table, columns, chunk.len());
        let bounds: Result<Vec<BoundValue>, AppError> = chunk
            .iter()
            .flat_map(|row| row.iter().enumerate().map(|(i, v)| bind_one(i, v)))
            .collect();
        let bounds = match bounds {
            Ok(b) => b,
            Err(e) => {
                let _ = exec_batch(client, "ROLLBACK").await;
                return Err(e);
            }
        };
        let mut query = Query::new(&stmt);
        for b in &bounds {
            bind_query(&mut query, b);
        }
        match query.execute(&mut *client).await {
            Ok(res) => affected += res.total(),
            Err(err) => {
                let _ = exec_batch(client, "ROLLBACK").await;
                return Err(map_query_error(err));
            }
        }
    }
    exec_batch(client, "COMMIT").await?;
    Ok(affected)
}

pub(super) async fn fetch_pk_pool(
    client: &mut TdsClient,
    schema: &str,
    table: &str,
    columns: &[String],
    cap: u64,
) -> Result<Vec<Vec<serde_json::Value>>, AppError> {
    if columns.is_empty() {
        return Ok(Vec::new());
    }
    let cols_sql = quote_idents(columns);
    let stmt = format!(
        "SELECT TOP {cap} {cols_sql} FROM {}",
        qualified(schema, table)
    );
    let rows = client
        .simple_query(stmt)
        .await
        .map_err(map_query_error)?
        .into_first_result()
        .await
        .map_err(map_query_error)?;
    Ok(rows.iter().map(decode_row).collect())
}
