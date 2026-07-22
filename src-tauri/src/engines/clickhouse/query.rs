//! ClickHouse query execution: `run_query` (editor), `fetch_rows` (grid paging +
//! filter/sort), `fetch_row_by_key` (FK peek), and `column_stats` (insights).
//! Values arrive as raw `serde_json::Value` from `FORMAT JSONCompact` — no
//! per-type decoding — so the JSON contract (64-bit ints as strings, Nullable
//! NULL as null, arrays/tuples as JSON arrays) holds by construction.

use std::time::Instant;

use crate::shared::engine::{
    ColumnMeta, ColumnStats, ColumnStatsRequest, FetchRowsRequest, FilterSpec, FreqEntry,
    QueryOptions, QueryResult, RowLookup, RowLookupRequest, RowsPage,
};
use crate::shared::error::AppError;

use super::http::{ChResult, ClickHouseHttp};
use super::sql::{
    ch_literal, is_numeric_type, order_by_clause, qualified, quote_ident, validate_column,
    where_clause,
};
use super::value::{as_string, as_u64};

/// Map a `FORMAT JSONCompact` `meta` list to the port's [`ColumnMeta`].
fn columns_of(result: &ChResult) -> Vec<ColumnMeta> {
    result
        .meta
        .iter()
        .map(|m| ColumnMeta {
            name: m.name.clone(),
            type_hint: m.ty.clone(),
        })
        .collect()
}

/// Run an editor query with a row limit + timing. `max_result_rows` is set to
/// `row_limit + 1` (with `result_overflow_mode=break`) so a truncation is
/// detectable and reported.
pub async fn run_query(
    http: &ClickHouseHttp,
    sql: &str,
    options: QueryOptions,
) -> Result<QueryResult, AppError> {
    let limit = options.row_limit;
    let started = Instant::now();
    let result = http
        .query(
            sql,
            &[
                ("max_result_rows", (limit as u64 + 1).to_string()),
                ("result_overflow_mode", "break".to_string()),
            ],
        )
        .await?;
    let elapsed_ms = started.elapsed().as_millis() as u64;

    let columns = columns_of(&result);
    let mut rows = result.data;
    let truncated = rows.len() > limit;
    if truncated {
        rows.truncate(limit);
    }
    Ok(QueryResult {
        columns,
        row_count: rows.len(),
        rows,
        truncated,
        elapsed_ms,
    })
}

/// Fetch one page of rows for the grid: paged, optionally sorted + filtered.
pub async fn fetch_rows(
    http: &ClickHouseHttp,
    req: FetchRowsRequest,
) -> Result<RowsPage, AppError> {
    let started = Instant::now();
    let valid = column_names(http, &req.schema, &req.table).await?;
    let target = qualified(&req.schema, &req.table);

    let where_body = match &req.filter {
        Some(filter) => where_clause(&valid, &req.table, filter)?,
        None => None,
    };
    let where_sql = where_body
        .as_deref()
        .map(|w| format!(" WHERE {w}"))
        .unwrap_or_default();

    let order_sql = match &req.sort {
        Some(sort) => format!(" ORDER BY {}", order_by_clause(&valid, &req.table, sort)?),
        None => String::new(),
    };

    let page_sql = format!(
        "SELECT * FROM {target}{where_sql}{order_sql} LIMIT {} OFFSET {}",
        req.limit, req.offset
    );
    let result = http.query(&page_sql, &[]).await?;

    let count_sql = format!("SELECT count() FROM {target}{where_sql}");
    let total_rows = http.scalar(&count_sql).await?.and_then(|v| as_u64(&v));

    let elapsed_ms = started.elapsed().as_millis() as u64;
    Ok(RowsPage {
        columns: columns_of(&result),
        rows: result.data,
        offset: req.offset,
        limit: req.limit,
        total_rows,
        elapsed_ms,
    })
}

/// Look up the row(s) where `column = value` (FK peek). The value is rendered as
/// an escaped literal (or `unhex('…')` for a binary key); a null key matches
/// nothing.
pub async fn fetch_row_by_key(
    http: &ClickHouseHttp,
    req: &RowLookupRequest,
) -> Result<RowLookup, AppError> {
    let valid = column_names(http, &req.schema, &req.table).await?;
    validate_column(&valid, &req.table, &req.column)?;
    let target = qualified(&req.schema, &req.table);
    let col = quote_ident(&req.column);

    // A null key never matches `=`; return the columns with no row.
    if req.value.is_null() {
        let head = http
            .query(&format!("SELECT * FROM {target} LIMIT 0"), &[])
            .await?;
        return Ok(RowLookup {
            columns: columns_of(&head),
            row: None,
            match_count: 0,
        });
    }

    let literal = if req.binary {
        let hex = match crate::shared::engine::parse_binary_value(&req.value)? {
            Some(bytes) => bytes.iter().map(|b| format!("{b:02x}")).collect::<String>(),
            None => String::new(),
        };
        format!("unhex('{hex}')")
    } else {
        ch_literal(&req.value)
    };

    let result = http
        .query(
            &format!("SELECT * FROM {target} WHERE {col} = {literal} LIMIT 1"),
            &[],
        )
        .await?;
    let count = http
        .scalar(&format!(
            "SELECT count() FROM {target} WHERE {col} = {literal}"
        ))
        .await?
        .and_then(|v| as_u64(&v))
        .unwrap_or(0);

    Ok(RowLookup {
        columns: columns_of(&result),
        row: result.data.into_iter().next(),
        match_count: count,
    })
}

/// Per-column statistics over the (optionally filtered) set.
pub async fn column_stats(
    http: &ClickHouseHttp,
    req: &ColumnStatsRequest,
) -> Result<ColumnStats, AppError> {
    let valid = column_names(http, &req.schema, &req.table).await?;
    validate_column(&valid, &req.table, &req.column)?;
    let numeric = is_numeric_type(&column_type(http, &req.schema, &req.table, &req.column).await?);
    let target = qualified(&req.schema, &req.table);
    let col = quote_ident(&req.column);

    let where_sql = filter_where(&valid, &req.table, req.filter.as_ref())?
        .map(|w| format!(" WHERE {w}"))
        .unwrap_or_default();

    // total / distinct / nulls / min / max / avg in one pass. `avg` is only
    // valid on numeric columns; for others select NULL so the query still runs.
    let avg_expr = if numeric {
        format!("avg({col})")
    } else {
        "NULL".to_string()
    };
    let agg_sql = format!(
        "SELECT count() AS total, uniqExact({col}) AS distinct, count() - count({col}) AS nulls, \
         min({col}) AS mn, max({col}) AS mx, {avg_expr} AS av \
         FROM {target}{where_sql}"
    );
    let agg = http.query(&agg_sql, &[]).await?;
    let row = agg.data.into_iter().next().unwrap_or_default();
    let total = row.first().and_then(as_u64).unwrap_or(0);
    let distinct = row.get(1).and_then(as_u64).unwrap_or(0);
    let nulls = row.get(2).and_then(as_u64).unwrap_or(0);
    let min = row.get(3).filter(|v| !v.is_null()).cloned();
    let max = row.get(4).filter(|v| !v.is_null()).cloned();
    let avg = row.get(5).and_then(|v| match v {
        serde_json::Value::Number(n) => n.as_f64(),
        serde_json::Value::String(s) => s.parse::<f64>().ok(),
        _ => None,
    });

    // Top-5 non-null values by frequency.
    let top_sql = format!(
        "SELECT {col} AS v, count() AS c FROM {target}{} \
         GROUP BY v ORDER BY c DESC, v ASC LIMIT 5",
        // Exclude NULLs from the top list.
        if where_sql.is_empty() {
            format!(" WHERE {col} IS NOT NULL")
        } else {
            format!("{where_sql} AND {col} IS NOT NULL")
        }
    );
    let top_result = http.query(&top_sql, &[]).await?;
    let top = top_result
        .data
        .into_iter()
        .filter_map(|r| {
            let value = r.first().cloned()?;
            let count = r.get(1).and_then(as_u64).unwrap_or(0);
            Some(FreqEntry { value, count })
        })
        .collect();

    Ok(ColumnStats {
        total,
        distinct,
        nulls,
        min,
        max,
        avg,
        numeric,
        top,
    })
}

/// Compile the optional filter into a WHERE body (validated columns).
fn filter_where(
    valid: &[String],
    table: &str,
    filter: Option<&FilterSpec>,
) -> Result<Option<String>, AppError> {
    match filter {
        Some(f) => where_clause(valid, table, f),
        None => Ok(None),
    }
}

/// The column names of a table, in position order (for §5 validation).
async fn column_names(
    http: &ClickHouseHttp,
    schema: &str,
    table: &str,
) -> Result<Vec<String>, AppError> {
    let result = http
        .query(
            &format!(
                "SELECT name FROM system.columns WHERE database = {} AND table = {} ORDER BY position",
                super::sql::ch_string_literal(schema),
                super::sql::ch_string_literal(table)
            ),
            &[],
        )
        .await?;
    Ok(result
        .data
        .into_iter()
        .filter_map(|r| r.first().map(as_string))
        .collect())
}

/// The declared ClickHouse type of one column (for numeric detection).
async fn column_type(
    http: &ClickHouseHttp,
    schema: &str,
    table: &str,
    column: &str,
) -> Result<String, AppError> {
    let value = http
        .scalar(&format!(
            "SELECT type FROM system.columns WHERE database = {} AND table = {} AND name = {}",
            super::sql::ch_string_literal(schema),
            super::sql::ch_string_literal(table),
            super::sql::ch_string_literal(column)
        ))
        .await?;
    Ok(value.map(|v| as_string(&v)).unwrap_or_default())
}
