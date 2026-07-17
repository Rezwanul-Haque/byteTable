//! MSSQL read path: query execution, row paging, single-row lookup, column
//! statistics, and result decoding. Mirrors the `ports::sql::query` contract.

use std::time::Instant;

use tiberius::{Query, Row};

use crate::shared::engine::*;
use crate::shared::error::AppError;

use super::error::map_query_error;
use super::introspect::table_meta;
use super::sql::{
    is_numeric_type, order_by_clause, qualified, quote_ident, where_clause, BoundValue, WhereClause,
};
use super::TdsClient;

/// Page-size ceiling for `fetch_rows` (mirrors the other relational adapters and
/// the connections slice's `MAX_ROW_LIMIT`).
const MAX_PAGE_ROWS: u32 = 10_000;

/// Extracted from the `EngineConnection` impl (canonical layout: the impl
/// locks the client and delegates; the SQL lives in the concern module).
pub(super) async fn run_query(
    client: &mut TdsClient,
    sql: &str,
    options: QueryOptions,
) -> Result<QueryResult, AppError> {
    let started = Instant::now();

    // The whole batch may contain several statements / result sets; take the
    // first result set that produced rows (a SELECT). DML/DDL produce none.
    let results = client
        .simple_query(sql)
        .await
        .map_err(map_query_error)?
        .into_results()
        .await
        .map_err(map_query_error)?;
    let rows: Vec<Row> = results
        .into_iter()
        .find(|set| !set.is_empty())
        .unwrap_or_default();

    let columns = rows.first().map(column_meta).unwrap_or_default();
    let mut out_rows: Vec<Vec<serde_json::Value>> = Vec::new();
    let mut truncated = false;
    for row in &rows {
        if out_rows.len() >= options.row_limit {
            truncated = true;
            break;
        }
        out_rows.push(decode_row(row));
    }

    Ok(QueryResult {
        columns,
        row_count: out_rows.len(),
        rows: out_rows,
        truncated,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

/// Extracted from the `EngineConnection` impl (canonical layout: the impl
/// locks the client and delegates; the SQL lives in the concern module).
pub(super) async fn fetch_rows(
    client: &mut TdsClient,
    req: FetchRowsRequest,
) -> Result<RowsPage, AppError> {
    let started = Instant::now();
    let meta = table_meta(&mut *client, &req.schema, &req.table).await?;
    let column_names: Vec<String> = meta.columns.iter().map(|c| c.name.clone()).collect();

    let order_by = match &req.sort {
        Some(sort) => order_by_clause(&column_names, &req.table, sort)?,
        // T-SQL OFFSET/FETCH requires an ORDER BY. Default to the primary key
        // so the browse order is stable across saves (an arbitrary order can
        // reshuffle an edited row onto another page). Falls back to a stable
        // arbitrary order for a table with no primary key.
        None => {
            let pk: Vec<String> = meta
                .columns
                .iter()
                .filter(|c| c.pk)
                .map(|c| quote_ident(&c.name))
                .collect();
            if pk.is_empty() {
                "(SELECT NULL)".to_string()
            } else {
                pk.join(", ")
            }
        }
    };
    let (where_clause, _next) = match &req.filter {
        Some(filter) => where_clause(&column_names, &req.table, filter, 1)?,
        None => (WhereClause::default(), 1),
    };
    let where_sql = match &where_clause.sql {
        Some(body) => format!(" WHERE {body}"),
        None => String::new(),
    };

    let limit = req.limit.min(MAX_PAGE_ROWS);
    let qualified = qualified(&req.schema, &req.table);

    // Exact filtered COUNT for "n of N rows" (§3.5). COUNT_BIG → bigint.
    let count_sql = format!("SELECT COUNT_BIG(*) AS n FROM {qualified}{where_sql}");
    let mut count_query = Query::new(&count_sql);
    for value in &where_clause.params {
        bind_query(&mut count_query, value);
    }
    let count_rows = count_query
        .query(&mut *client)
        .await
        .map_err(map_query_error)?
        .into_first_result()
        .await
        .map_err(map_query_error)?;
    let total_rows: i64 = count_rows
        .first()
        .and_then(|r| r.try_get("n").ok().flatten())
        .unwrap_or(0);

    // Page query: WHERE params first (numbered @P1..), then OFFSET/FETCH as
    // the two trailing placeholders.
    let offset_idx = where_clause.params.len() + 1;
    let fetch_idx = offset_idx + 1;
    let page_sql = format!(
        "SELECT * FROM {qualified}{where_sql} ORDER BY {order_by} \
         OFFSET @P{offset_idx} ROWS FETCH NEXT @P{fetch_idx} ROWS ONLY"
    );
    let mut page_query = Query::new(&page_sql);
    for value in &where_clause.params {
        bind_query(&mut page_query, value);
    }
    page_query.bind(req.offset as i64);
    page_query.bind(i64::from(limit));
    let rows = page_query
        .query(&mut *client)
        .await
        .map_err(map_query_error)?
        .into_first_result()
        .await
        .map_err(map_query_error)?;

    let columns = if let Some(first) = rows.first() {
        column_meta(first)
    } else {
        meta.columns
            .iter()
            .map(|c| ColumnMeta {
                name: c.name.clone(),
                type_hint: c.data_type.clone(),
            })
            .collect()
    };
    let out_rows: Vec<Vec<serde_json::Value>> = rows.iter().map(decode_row).collect();

    Ok(RowsPage {
        columns,
        rows: out_rows,
        offset: req.offset,
        limit,
        total_rows: Some(total_rows.max(0) as u64),
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

// ---------------------------------------------------------------------------
// Value binding + decoding
// ---------------------------------------------------------------------------

/// Bind a [`BoundValue`] to a tiberius query with its native type. The caller
/// has already emitted the matching `@P{n}` placeholder.
pub(super) fn bind_query(query: &mut Query<'_>, value: &BoundValue) {
    match value {
        BoundValue::Null => query.bind(Option::<i32>::None),
        BoundValue::Bool(b) => query.bind(*b),
        BoundValue::Int(i) => query.bind(*i),
        BoundValue::Float(f) => query.bind(*f),
        BoundValue::Text(s) => query.bind(s.clone()),
        BoundValue::Bytes(b) => query.bind(b.clone()),
    }
}

/// Column metadata for a result row: name + the tiberius column type as the
/// display type hint.
pub(super) fn column_meta(row: &Row) -> Vec<ColumnMeta> {
    row.columns()
        .iter()
        .map(|col| ColumnMeta {
            name: col.name().to_string(),
            type_hint: format!("{:?}", col.column_type()).to_uppercase(),
        })
        .collect()
}

/// Decode every column of a row to JSON.
pub(super) fn decode_row(row: &Row) -> Vec<serde_json::Value> {
    (0..row.columns().len())
        .map(|i| decode_value(row, i))
        .collect()
}

/// Decode one column of a [`Row`] to JSON. tiberius `try_get::<T>` returns `Err`
/// when the column is not type `T`, so we try each target type in turn (widest
/// match wins) and land on the first that fits; a NULL of the right type decodes
/// to `Ok(None)` → JSON null. See the module docs for the type mapping.
pub(super) fn decode_value(row: &Row, index: usize) -> serde_json::Value {
    use serde_json::Value;

    // bit → 0/1 (T-SQL boolean).
    if let Ok(v) = row.try_get::<bool, _>(index) {
        return opt(v, |b| Value::from(if b { 1 } else { 0 }));
    }
    // tinyint (u8), smallint (i16), int (i32).
    if let Ok(v) = row.try_get::<u8, _>(index) {
        return opt(v, Value::from);
    }
    if let Ok(v) = row.try_get::<i16, _>(index) {
        return opt(v, Value::from);
    }
    if let Ok(v) = row.try_get::<i32, _>(index) {
        return opt(v, Value::from);
    }
    // bigint → number within ±2^53 else string.
    if let Ok(v) = row.try_get::<i64, _>(index) {
        return opt(v, int_or_string);
    }
    // real (f32), float (f64).
    if let Ok(v) = row.try_get::<f32, _>(index) {
        return opt(v, |f| number_or_null(f64::from(f)));
    }
    if let Ok(v) = row.try_get::<f64, _>(index) {
        return opt(v, number_or_null);
    }
    // decimal/numeric/money → exact string (precision preserved).
    if let Ok(v) = row.try_get::<tiberius::numeric::Numeric, _>(index) {
        return opt(v, |n| numeric_text_to_json(&n.to_string()));
    }
    // uniqueidentifier.
    if let Ok(v) = row.try_get::<uuid::Uuid, _>(index) {
        return opt(v, |g| Value::from(g.to_string()));
    }
    // char/varchar/nchar/nvarchar/text/xml.
    if let Ok(v) = row.try_get::<&str, _>(index) {
        return opt(v, |s| Value::from(s.to_string()));
    }
    // temporal.
    if let Ok(v) = row.try_get::<chrono::NaiveDateTime, _>(index) {
        return opt(v, |d| Value::from(d.to_string()));
    }
    if let Ok(v) = row.try_get::<chrono::NaiveDate, _>(index) {
        return opt(v, |d| Value::from(d.to_string()));
    }
    if let Ok(v) = row.try_get::<chrono::NaiveTime, _>(index) {
        return opt(v, |t| Value::from(t.to_string()));
    }
    if let Ok(v) = row.try_get::<chrono::DateTime<chrono::Utc>, _>(index) {
        return opt(v, |d| Value::from(d.to_rfc3339()));
    }
    // binary/varbinary/image → placeholder.
    if let Ok(v) = row.try_get::<&[u8], _>(index) {
        return opt(v, |b| Value::from(format!("[{} bytes]", b.len())));
    }
    Value::Null
}

/// `Some(x)` → `f(x)`, `None` → JSON null.
pub(super) fn opt<T>(
    value: Option<T>,
    f: impl FnOnce(T) -> serde_json::Value,
) -> serde_json::Value {
    match value {
        Some(x) => f(x),
        None => serde_json::Value::Null,
    }
}

/// A bigint as a JSON number if it fits JS's safe-integer range, else a string
/// (the `CellValue` precision contract).
pub(super) fn int_or_string(value: i64) -> serde_json::Value {
    if value.abs() <= super::sql::JS_MAX_SAFE_INTEGER {
        serde_json::Value::from(value)
    } else {
        serde_json::Value::from(value.to_string())
    }
}

/// A finite float as a JSON number, else null (JSON has no NaN/Inf).
pub(super) fn number_or_null(value: f64) -> serde_json::Value {
    serde_json::Number::from_f64(value)
        .map(serde_json::Value::Number)
        .unwrap_or(serde_json::Value::Null)
}

/// A decimal's text form as a JSON number when it round-trips through f64
/// losslessly, else the exact decimal *string* (preserve precision).
pub(super) fn numeric_text_to_json(text: &str) -> serde_json::Value {
    if let Ok(f) = text.parse::<f64>() {
        if f.to_string() == text {
            if let Some(n) = serde_json::Number::from_f64(f) {
                return serde_json::Value::Number(n);
            }
        }
    }
    serde_json::Value::from(text.to_string())
}

// ---------------------------------------------------------------------------
// FK peek (M10)
// ---------------------------------------------------------------------------

pub(super) async fn fetch_row_by_key(
    client: &mut TdsClient,
    req: &RowLookupRequest,
) -> Result<RowLookup, AppError> {
    let meta = table_meta(client, &req.schema, &req.table).await?;
    let column_names: Vec<String> = meta.columns.iter().map(|c| c.name.clone()).collect();
    super::sql::validate_column(&column_names, &req.table, &req.column)?;

    let columns: Vec<ColumnMeta> = meta
        .columns
        .iter()
        .map(|c| ColumnMeta {
            name: c.name.clone(),
            type_hint: c.data_type.clone(),
        })
        .collect();

    // A null key never matches `=` — short-circuit to a clean miss.
    if req.value.is_null() {
        return Ok(RowLookup {
            columns,
            row: None,
            match_count: 0,
        });
    }
    let bound = if req.binary {
        BoundValue::from_binary_operand(&req.value)?
    } else {
        BoundValue::from_json_operand(&req.value)?
    };

    let q = qualified(&req.schema, &req.table);
    let col = quote_ident(&req.column);

    let row_sql = format!("SELECT TOP 1 * FROM {q} WHERE {col} = @P1");
    let mut row_query = Query::new(&row_sql);
    bind_query(&mut row_query, &bound);
    let rows = row_query
        .query(client)
        .await
        .map_err(map_query_error)?
        .into_first_result()
        .await
        .map_err(map_query_error)?;
    let row = rows.first().map(decode_row);

    let match_count = if row.is_none() {
        0
    } else {
        let count_sql = format!("SELECT COUNT_BIG(*) AS n FROM {q} WHERE {col} = @P1");
        let mut cq = Query::new(&count_sql);
        bind_query(&mut cq, &bound);
        let crows = cq
            .query(client)
            .await
            .map_err(map_query_error)?
            .into_first_result()
            .await
            .map_err(map_query_error)?;
        crows
            .first()
            .and_then(|r| r.try_get::<i64, _>("n").ok().flatten())
            .unwrap_or(0)
            .max(0) as u64
    };

    Ok(RowLookup {
        columns,
        row,
        match_count,
    })
}

// ---------------------------------------------------------------------------
// Column insights (M10)
// ---------------------------------------------------------------------------

pub(super) async fn column_stats(
    client: &mut TdsClient,
    req: &ColumnStatsRequest,
) -> Result<ColumnStats, AppError> {
    let meta = table_meta(client, &req.schema, &req.table).await?;
    let column_names: Vec<String> = meta.columns.iter().map(|c| c.name.clone()).collect();
    super::sql::validate_column(&column_names, &req.table, &req.column)?;
    let numeric = meta
        .columns
        .iter()
        .find(|c| c.name == req.column)
        .map(|c| is_numeric_type(&c.data_type))
        .unwrap_or(false);

    let q = qualified(&req.schema, &req.table);
    let col = quote_ident(&req.column);

    let (wc, _) = match &req.filter {
        Some(filter) => where_clause(&column_names, &req.table, filter, 1)?,
        None => (WhereClause::default(), 1),
    };
    let where_sql = wc
        .sql
        .as_ref()
        .map(|b| format!(" WHERE {b}"))
        .unwrap_or_default();
    let and = if where_sql.is_empty() {
        " WHERE"
    } else {
        " AND"
    };

    let bind_wc = |sql: &str| -> Query<'static> {
        let mut query = Query::new(sql.to_string());
        for value in &wc.params {
            bind_query(&mut query, value);
        }
        query
    };

    // total / nulls / distinct.
    let agg_sql = format!(
        "SELECT COUNT_BIG(*) AS total, COUNT_BIG(*) - COUNT_BIG({col}) AS nulls, \
            COUNT_BIG(DISTINCT {col}) AS distinct_count FROM {q}{where_sql}"
    );
    let agg = bind_wc(&agg_sql)
        .query(client)
        .await
        .map_err(map_query_error)?
        .into_first_result()
        .await
        .map_err(map_query_error)?;
    let agg = agg.first();
    let total = agg
        .and_then(|r| r.try_get::<i64, _>("total").ok().flatten())
        .unwrap_or(0);
    let nulls = agg
        .and_then(|r| r.try_get::<i64, _>("nulls").ok().flatten())
        .unwrap_or(0);
    let distinct = agg
        .and_then(|r| r.try_get::<i64, _>("distinct_count").ok().flatten())
        .unwrap_or(0);

    // min / max as text → JSON (big-int/decimal map like everywhere else).
    let minmax_sql = format!(
        "SELECT CAST(MIN({col}) AS NVARCHAR(4000)) AS lo, \
            CAST(MAX({col}) AS NVARCHAR(4000)) AS hi FROM {q}{where_sql}"
    );
    let minmax = bind_wc(&minmax_sql)
        .query(client)
        .await
        .map_err(map_query_error)?
        .into_first_result()
        .await
        .map_err(map_query_error)?;
    let minmax = minmax.first();
    let to_value = |text: Option<String>| -> Option<serde_json::Value> {
        text.map(|t| {
            if numeric {
                numeric_text_to_json(&t)
            } else {
                serde_json::Value::String(t)
            }
        })
    };
    let min = to_value(
        minmax
            .and_then(|r| r.try_get::<&str, _>("lo").ok().flatten())
            .map(str::to_string),
    );
    let max = to_value(
        minmax
            .and_then(|r| r.try_get::<&str, _>("hi").ok().flatten())
            .map(str::to_string),
    );

    // avg only when numeric.
    let avg = if numeric {
        let avg_sql = format!("SELECT AVG(CAST({col} AS FLOAT)) AS a FROM {q}{where_sql}");
        let rows = bind_wc(&avg_sql)
            .query(client)
            .await
            .map_err(map_query_error)?
            .into_first_result()
            .await
            .map_err(map_query_error)?;
        rows.first()
            .and_then(|r| r.try_get::<f64, _>("a").ok().flatten())
    } else {
        None
    };

    // Top-5 most frequent non-NULL values.
    let top_sql = format!(
        "SELECT TOP 5 CAST({col} AS NVARCHAR(4000)) AS v, COUNT_BIG(*) AS freq \
         FROM {q}{where_sql}{and} {col} IS NOT NULL GROUP BY {col} ORDER BY freq DESC, {col} ASC"
    );
    let top_rows = bind_wc(&top_sql)
        .query(client)
        .await
        .map_err(map_query_error)?
        .into_first_result()
        .await
        .map_err(map_query_error)?;
    let top = top_rows
        .iter()
        .map(|row| {
            let text = row
                .try_get::<&str, _>("v")
                .ok()
                .flatten()
                .map(str::to_string);
            let freq = row.try_get::<i64, _>("freq").ok().flatten().unwrap_or(0);
            let value = match text {
                Some(t) if numeric => numeric_text_to_json(&t),
                Some(t) => serde_json::Value::String(t),
                None => serde_json::Value::Null,
            };
            FreqEntry {
                value,
                count: freq.max(0) as u64,
            }
        })
        .collect();

    Ok(ColumnStats {
        total: total.max(0) as u64,
        distinct: distinct.max(0) as u64,
        nulls: nulls.max(0) as u64,
        min,
        max,
        avg,
        numeric,
        top,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn int_or_string_preserves_large_bigints() {
        assert_eq!(int_or_string(42), serde_json::json!(42));
        assert_eq!(
            int_or_string(9_007_199_254_740_993),
            serde_json::json!("9007199254740993")
        );
    }

    #[test]
    fn numeric_text_keeps_precision_when_lossy() {
        assert_eq!(numeric_text_to_json("1.50"), serde_json::json!("1.50"));
        assert_eq!(numeric_text_to_json("2.5"), serde_json::json!(2.5));
    }
}
