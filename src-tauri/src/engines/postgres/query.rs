//! Postgres read path: query execution, row paging, single-row lookup, column
//! statistics, and result decoding. Mirrors the `ports::sql::query` contract.

use std::time::Instant;

use sqlx::postgres::{PgPool, PgRow};
use sqlx::{Column, Row, TypeInfo};

use crate::shared::engine::*;
use crate::shared::error::AppError;

use super::error::map_query_error;
use super::introspect::table_meta;
use super::sql::{
    is_numeric_type, order_by_clause, qualified, quote_ident, validate_column, where_clause,
    BoundValue, WhereClause, JS_MAX_SAFE_INTEGER,
};

/// Page-size ceiling for `fetch_rows` (mirrors the SQLite adapter and the
/// connections slice's `MAX_ROW_LIMIT`).
const MAX_PAGE_ROWS: u32 = 10_000;

/// Extracted from the `EngineConnection` impl (canonical layout: the impl
/// delegates; the SQL lives in the concern module).
pub(super) async fn run_query(
    pool: &PgPool,
    sql: &str,
    options: QueryOptions,
) -> Result<QueryResult, AppError> {
    let started = Instant::now();

    // One acquired connection so the `SET search_path` and the query share a
    // session. `SET` on the pool surface lands on a random pooled connection,
    // so the query — which may grab a DIFFERENT pooled connection — would
    // resolve unqualified names against the default search_path instead of
    // the selected schema. Pinning the session is the same fix the MySQL
    // adapter uses.
    let mut conn = pool.acquire().await.map_err(map_query_error)?;

    // Apply the schema as the search_path for unqualified names, when given.
    // Best effort: a bad schema simply leaves the default search_path.
    if let Some(schema) = &options.schema {
        use sqlx::Executor as _;
        let _ = conn
            .execute(format!("SET search_path TO {}", quote_ident(schema)).as_str())
            .await;
    }

    // Read one extra row to detect truncation (matches the SQLite adapter).
    let rows = sqlx::query(sql)
        .fetch_all(&mut *conn)
        .await
        .map_err(map_query_error)?;

    let columns = if let Some(first) = rows.first() {
        column_meta(first)
    } else {
        // No rows returned: ask the engine to describe the statement so an
        // empty SELECT still reports its column headers (the grid shows the
        // columns with a "0 rows" body). A DML/DDL statement describes to no
        // columns, which is exactly what we want ("Query OK"). Best effort —
        // a describe failure falls back to no columns.
        use sqlx::Executor as _;
        match (&mut *conn).describe(sql).await {
            Ok(described) => described
                .columns()
                .iter()
                .map(|col| ColumnMeta {
                    name: col.name().to_string(),
                    type_hint: col.type_info().name().to_string(),
                })
                .collect(),
            Err(_) => Vec::new(),
        }
    };

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
/// delegates; the SQL lives in the concern module).
pub(super) async fn fetch_rows(pool: &PgPool, req: FetchRowsRequest) -> Result<RowsPage, AppError> {
    let started = Instant::now();
    let meta = table_meta(pool, &req.schema, &req.table).await?;
    let column_names: Vec<String> = meta.columns.iter().map(|c| c.name.clone()).collect();

    let order_by = match &req.sort {
        Some(sort) => Some(order_by_clause(&column_names, &req.table, sort)?),
        // No explicit sort: default to the primary key so the browse order is
        // stable. A Postgres heap table has no inherent order, and an UPDATE
        // rewrites the row as a new tuple (MVCC) at a fresh physical slot —
        // without this, a saved edit reshuffles the row (typically to the
        // end / another page), which reads as the row "vanishing". Falls back
        // to unordered when the table has no primary key (those aren't
        // editable in the grid anyway).
        None => {
            let pk: Vec<String> = meta
                .columns
                .iter()
                .filter(|c| c.pk)
                .map(|c| quote_ident(&c.name))
                .collect();
            (!pk.is_empty()).then(|| pk.join(", "))
        }
    };
    let where_clause = match &req.filter {
        Some(filter) => where_clause(&column_names, &req.table, filter)?,
        None => WhereClause::default(),
    };
    let where_sql = match &where_clause.sql {
        Some(body) => format!(" WHERE {body}"),
        None => String::new(),
    };

    let limit = req.limit.min(MAX_PAGE_ROWS);
    let qualified = qualified(&req.schema, &req.table);

    // Exact filtered COUNT(*) for "n of N rows" (§3.5).
    let count_sql = format!("SELECT count(*) AS n FROM {qualified}{where_sql}");
    let mut count_query = sqlx::query(&count_sql);
    for value in &where_clause.params {
        count_query = bind_value(count_query, value);
    }
    let total_rows: i64 = count_query
        .fetch_one(pool)
        .await
        .map_err(map_query_error)?
        .get("n");

    // Page query: WHERE, ORDER BY, then LIMIT/OFFSET as the next $N binds.
    let limit_placeholder = where_clause.next_index();
    let offset_placeholder = limit_placeholder + 1;
    let mut page_sql = format!("SELECT * FROM {qualified}{where_sql}");
    if let Some(clause) = &order_by {
        page_sql.push_str(&format!(" ORDER BY {clause}"));
    }
    page_sql.push_str(&format!(
        " LIMIT ${limit_placeholder} OFFSET ${offset_placeholder}"
    ));

    let mut page_query = sqlx::query(&page_sql);
    for value in &where_clause.params {
        page_query = bind_value(page_query, value);
    }
    page_query = page_query.bind(i64::from(limit)).bind(req.offset as i64);

    let rows = page_query.fetch_all(pool).await.map_err(map_query_error)?;

    // Column metadata: prefer the live result shape; fall back to the
    // introspected columns when the page is empty.
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

/// Extracted from the `EngineConnection` impl (canonical layout: the impl
/// delegates; the SQL lives in the concern module).
pub(super) async fn fetch_row_by_key(
    pool: &PgPool,
    req: RowLookupRequest,
) -> Result<RowLookup, AppError> {
    let meta = table_meta(pool, &req.schema, &req.table).await?;
    let column_names: Vec<String> = meta.columns.iter().map(|c| c.name.clone()).collect();
    validate_column(&column_names, &req.table, &req.column)?;

    let columns: Vec<ColumnMeta> = meta
        .columns
        .iter()
        .map(|c| ColumnMeta {
            name: c.name.clone(),
            type_hint: c.data_type.clone(),
        })
        .collect();

    // A null key never matches `=` in SQL — short-circuit to a clean miss.
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

    let qualified = qualified(&req.schema, &req.table);
    let col = quote_ident(&req.column);

    let row_sql = format!("SELECT * FROM {qualified} WHERE {col} = $1 LIMIT 1");
    let row = bind_value(sqlx::query(&row_sql), &bound)
        .fetch_optional(pool)
        .await
        .map_err(map_query_error)?
        .map(|r| decode_row(&r));

    let match_count = if row.is_none() {
        0
    } else {
        let count_sql = format!("SELECT count(*) AS n FROM {qualified} WHERE {col} = $1");
        let n: i64 = bind_value(sqlx::query(&count_sql), &bound)
            .fetch_one(pool)
            .await
            .map_err(map_query_error)?
            .get("n");
        n.max(0) as u64
    };

    Ok(RowLookup {
        columns,
        row,
        match_count,
    })
}

// ---------------------------------------------------------------------------
// Value binding + decoding
// ---------------------------------------------------------------------------

/// Bind a [`BoundValue`] to a sqlx query with its native Postgres type. The
/// caller has already emitted the matching `$N` placeholder. Binding natively
/// (bool→bool, int→i64, float→f64, text→text) lets the common grid/filter cases
/// compare correctly; a value's JSON type matches the cell it came from.
pub(super) fn bind_value<'q>(
    query: sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments>,
    value: &'q BoundValue,
) -> sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments> {
    match value {
        BoundValue::Null => query.bind(Option::<String>::None),
        BoundValue::Bool(b) => query.bind(*b),
        BoundValue::Int(i) => query.bind(*i),
        BoundValue::Float(f) => query.bind(*f),
        BoundValue::Text(s) => query.bind(s.as_str()),
        BoundValue::Bytes(b) => query.bind(b.as_slice()),
    }
}

/// Column metadata for a result row: name + the Postgres type name as the
/// display type hint.
pub(super) fn column_meta(row: &PgRow) -> Vec<ColumnMeta> {
    row.columns()
        .iter()
        .map(|col| ColumnMeta {
            name: col.name().to_string(),
            type_hint: col.type_info().name().to_string(),
        })
        .collect()
}

/// Decode every column of a row to JSON (module docs for the mapping).
pub(super) fn decode_row(row: &PgRow) -> Vec<serde_json::Value> {
    (0..row.columns().len())
        .map(|i| decode_value(row, i))
        .collect()
}

/// Decode one column of a [`PgRow`] to JSON, dispatching on the Postgres type
/// name (`col.type_info().name()`). See the module docs for the full mapping.
/// Unknown types fall back to the column's text representation; a decode error
/// degrades to null rather than failing the whole row.
pub(super) fn decode_value(row: &PgRow, index: usize) -> serde_json::Value {
    use serde_json::Value;

    let col = &row.columns()[index];
    let type_name = col.type_info().name();

    match type_name {
        "BOOL" => match row.try_get::<Option<bool>, _>(index) {
            Ok(Some(b)) => Value::Bool(b),
            Ok(None) => Value::Null,
            Err(_) => Value::Null,
        },
        "INT2" | "SMALLINT" => decode_int(row, index, |row| {
            row.try_get::<Option<i16>, _>(index)
                .map(|o| o.map(i64::from))
        }),
        "INT4" | "INT" | "INTEGER" => decode_int(row, index, |row| {
            row.try_get::<Option<i32>, _>(index)
                .map(|o| o.map(i64::from))
        }),
        "INT8" | "BIGINT" => decode_int(row, index, |row| row.try_get::<Option<i64>, _>(index)),
        "OID" => decode_int(row, index, |row| {
            row.try_get::<Option<i32>, _>(index)
                .map(|o| o.map(i64::from))
        }),
        "FLOAT4" | "REAL" => match row.try_get::<Option<f32>, _>(index) {
            Ok(Some(f)) => number_or_null(f64::from(f)),
            _ => Value::Null,
        },
        "FLOAT8" | "DOUBLE PRECISION" => match row.try_get::<Option<f64>, _>(index) {
            Ok(Some(f)) => number_or_null(f),
            _ => Value::Null,
        },
        // numeric/decimal: decode to an arbitrary-precision BigDecimal (the
        // `bigdecimal` sqlx feature) and stringify it, then map: a lossless
        // JS-safe value becomes a JSON number, otherwise the exact decimal
        // string (the CellValue precision contract — module docs). MONEY has no
        // BigDecimal decode; fall back to its text form.
        "NUMERIC" | "DECIMAL" => match row.try_get::<Option<sqlx::types::BigDecimal>, _>(index) {
            // `normalized()` strips trailing-zero scale (sqlx's PG NUMERIC
            // decode can carry extra scale, e.g. `9.50` → `9.5000`), so a clean
            // value round-trips to a JSON number and only genuinely
            // high-precision values stay strings.
            Ok(Some(d)) => numeric_text_to_json(&d.normalized().to_string()),
            Ok(None) => Value::Null,
            Err(_) => get_as_text(row, index)
                .map(Value::String)
                .unwrap_or(Value::Null),
        },
        "MONEY" => get_as_text(row, index)
            .map(|t| numeric_text_to_json(&t))
            .unwrap_or(Value::Null),
        // bytea → hex when small (UUID/key), placeholder when large; shared with
        // SQLite/MySQL so binary renders identically everywhere.
        "BYTEA" => match row.try_get::<Option<Vec<u8>>, _>(index) {
            Ok(Some(bytes)) => crate::shared::engine::binary_to_json(&bytes),
            _ => Value::Null,
        },
        // json/jsonb → serialized JSON string (kept a string so the grid renders
        // it as text, consistent with other engines).
        "JSON" | "JSONB" => match row.try_get::<Option<serde_json::Value>, _>(index) {
            Ok(Some(v)) => Value::String(v.to_string()),
            Ok(None) => Value::Null,
            Err(_) => get_as_text(row, index)
                .map(Value::String)
                .unwrap_or(Value::Null),
        },
        // Temporal types decode to chrono values, not String — format them to a
        // display string (the "timestamps don't show" fix). TIMETZ/INTERVAL stay
        // in the text fallback below.
        "DATE" | "TIMESTAMP" | "TIMESTAMPTZ" | "TIME" => get_temporal(row, index, type_name)
            .or_else(|| get_as_text(row, index))
            .map(Value::String)
            .unwrap_or(Value::Null),
        // Text-like and everything else (uuid, timetz, interval, arrays, enums,
        // …): the column's text form. sqlx decodes most of these as String
        // directly; arrays/unknowns fall through to the text cast.
        _ => get_as_text(row, index)
            .map(Value::String)
            .unwrap_or(Value::Null),
    }
}

/// Decode a Postgres temporal column (DATE/TIMESTAMP/TIMESTAMPTZ/TIME) to a
/// display string. These arrive as chrono types (the `chrono` sqlx feature),
/// NOT as `String`, so a plain text read returns NULL — the "timestamps don't
/// show" bug. TIMESTAMPTZ keeps its offset; the rest format naively.
pub(super) fn get_temporal(row: &PgRow, index: usize, type_name: &str) -> Option<String> {
    use sqlx::types::chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, Utc};
    const DT_FMT: &str = "%Y-%m-%d %H:%M:%S%.f";
    match type_name {
        "DATE" => row
            .try_get::<Option<NaiveDate>, _>(index)
            .ok()
            .flatten()
            .map(|d| d.format("%Y-%m-%d").to_string()),
        "TIMESTAMP" => row
            .try_get::<Option<NaiveDateTime>, _>(index)
            .ok()
            .flatten()
            .map(|d| d.format(DT_FMT).to_string()),
        "TIMESTAMPTZ" => row
            .try_get::<Option<DateTime<Utc>>, _>(index)
            .ok()
            .flatten()
            .map(|d| d.format("%Y-%m-%d %H:%M:%S%.f%:z").to_string()),
        "TIME" => row
            .try_get::<Option<NaiveTime>, _>(index)
            .ok()
            .flatten()
            .map(|t| t.format("%H:%M:%S%.f").to_string()),
        _ => None,
    }
}

/// Decode an integer column, applying the ±2^53 string-fallback (the
/// `CellValue` precision contract). `getter` reads the native width as i64.
pub(super) fn decode_int<F>(row: &PgRow, _index: usize, getter: F) -> serde_json::Value
where
    F: Fn(&PgRow) -> Result<Option<i64>, sqlx::Error>,
{
    match getter(row) {
        Ok(Some(i)) if i.unsigned_abs() <= JS_MAX_SAFE_INTEGER as u64 => serde_json::Value::from(i),
        Ok(Some(i)) => serde_json::Value::String(i.to_string()),
        _ => serde_json::Value::Null,
    }
}

/// A finite f64 as a JSON number; non-finite (NaN/Inf — JSON has neither) → null.
pub(super) fn number_or_null(f: f64) -> serde_json::Value {
    serde_json::Number::from_f64(f)
        .map(serde_json::Value::Number)
        .unwrap_or(serde_json::Value::Null)
}

/// Map a NUMERIC's exact decimal text to JSON: a lossless, JS-safe number when
/// possible, else the exact string (preserve precision — module docs).
pub(super) fn numeric_text_to_json(text: &str) -> serde_json::Value {
    // Integer-valued and within the JS-safe range → number.
    if let Ok(i) = text.parse::<i64>() {
        if i.unsigned_abs() <= JS_MAX_SAFE_INTEGER as u64 {
            return serde_json::Value::from(i);
        }
        return serde_json::Value::String(text.to_string());
    }
    if let Ok(f) = text.parse::<f64>() {
        // Only surface as a number when formatting it back yields the same
        // decimal — otherwise we'd silently lose precision; keep the string.
        if f.is_finite() {
            let round_trip = format!("{f}");
            if round_trip == text {
                return number_or_null(f);
            }
        }
    }
    serde_json::Value::String(text.to_string())
}

/// Read a column as its Postgres text representation via an explicit `::text`
/// decode. sqlx returns most types as `String`; for ones it cannot, this is the
/// honest text form. `None` on NULL or decode failure.
pub(super) fn get_as_text(row: &PgRow, index: usize) -> Option<String> {
    row.try_get::<Option<String>, _>(index).ok().flatten()
}

// ---------------------------------------------------------------------------
// column_stats
// ---------------------------------------------------------------------------

/// Per-column statistics over the (filtered) set: total/distinct/null counts,
/// min/max, avg (numeric only), top-5. Reuses the same parameterized
/// [`where_clause`] compilation as `fetch_rows`. Numeric detection comes from
/// the catalog type (cleaner than SQLite's value heuristic — module docs).
pub(super) async fn column_stats(
    pool: &PgPool,
    req: &ColumnStatsRequest,
) -> Result<ColumnStats, AppError> {
    let meta = table_meta(pool, &req.schema, &req.table).await?;
    let column_names: Vec<String> = meta.columns.iter().map(|c| c.name.clone()).collect();
    validate_column(&column_names, &req.table, &req.column)?;

    // The catalog type for numeric detection.
    let udt: String = sqlx::query_scalar(
        "SELECT udt_name FROM information_schema.columns \
         WHERE table_schema = $1 AND table_name = $2 AND column_name = $3",
    )
    .bind(&req.schema)
    .bind(&req.table)
    .bind(&req.column)
    .fetch_one(pool)
    .await
    .map_err(map_query_error)?;
    let numeric = is_numeric_type(&udt);

    let qualified = qualified(&req.schema, &req.table);
    let col = quote_ident(&req.column);

    let where_clause = match &req.filter {
        Some(filter) => where_clause(&column_names, &req.table, filter)?,
        None => WhereClause::default(),
    };
    let where_sql = match &where_clause.sql {
        Some(body) => format!(" WHERE {body}"),
        None => String::new(),
    };
    let and = if where_sql.is_empty() {
        " WHERE"
    } else {
        " AND"
    };

    // total / nulls / distinct in one aggregate.
    let agg_sql = format!(
        "SELECT count(*) AS total, count(*) - count({col}) AS nulls, \
            count(DISTINCT {col}) AS distinct_count FROM {qualified}{where_sql}"
    );
    let agg_row = bind_all(sqlx::query(&agg_sql), &where_clause.params)
        .fetch_one(pool)
        .await
        .map_err(map_query_error)?;
    let total: i64 = agg_row.get("total");
    let nulls: i64 = agg_row.get("nulls");
    let distinct: i64 = agg_row.get("distinct_count");

    // min / max as text → JSON (so big-int/numeric map like everywhere else).
    let minmax_sql = format!(
        "SELECT min({col})::text AS lo, max({col})::text AS hi FROM {qualified}{where_sql}"
    );
    let minmax_row = bind_all(sqlx::query(&minmax_sql), &where_clause.params)
        .fetch_one(pool)
        .await
        .map_err(map_query_error)?;
    let min_text: Option<String> = minmax_row.try_get("lo").unwrap_or(None);
    let max_text: Option<String> = minmax_row.try_get("hi").unwrap_or(None);
    let to_value = |text: Option<String>| -> Option<serde_json::Value> {
        text.map(|t| {
            if numeric {
                numeric_text_to_json(&t)
            } else {
                serde_json::Value::String(t)
            }
        })
    };
    let min = to_value(min_text);
    let max = to_value(max_text);

    // avg only when numeric.
    let avg = if numeric {
        let avg_sql = format!("SELECT avg({col})::float8 AS a FROM {qualified}{where_sql}");
        let row = bind_all(sqlx::query(&avg_sql), &where_clause.params)
            .fetch_one(pool)
            .await
            .map_err(map_query_error)?;
        row.try_get::<Option<f64>, _>("a").unwrap_or(None)
    } else {
        None
    };

    // Top-5 most frequent non-NULL values (value rendered as text → JSON).
    let top_sql = format!(
        "SELECT {col}::text AS v, count(*) AS freq FROM {qualified}{where_sql}{and} {col} IS NOT NULL \
         GROUP BY {col} ORDER BY freq DESC, {col} ASC LIMIT 5"
    );
    let top_rows = bind_all(sqlx::query(&top_sql), &where_clause.params)
        .fetch_all(pool)
        .await
        .map_err(map_query_error)?;
    let top = top_rows
        .into_iter()
        .map(|row| {
            let text: Option<String> = row.try_get("v").unwrap_or(None);
            let freq: i64 = row.get("freq");
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

/// Bind every [`BoundValue`] (the WHERE params) to a query in order.
pub(super) fn bind_all<'q>(
    mut query: sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments>,
    params: &'q [BoundValue],
) -> sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments> {
    for value in params {
        query = bind_value(query, value);
    }
    query
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numeric_text_to_json_preserves_precision() {
        // Small integer-valued → number.
        assert_eq!(numeric_text_to_json("42"), serde_json::json!(42));
        // Within JS-safe → number; a clean decimal round-trips.
        assert_eq!(numeric_text_to_json("3.5"), serde_json::json!(3.5));
        // A huge integer beyond 2^53 → string (precision preserved).
        assert_eq!(
            numeric_text_to_json("9007199254740993"),
            serde_json::json!("9007199254740993")
        );
        // A high-precision decimal that f64 cannot represent exactly → string.
        assert_eq!(
            numeric_text_to_json("0.12345678901234567890"),
            serde_json::json!("0.12345678901234567890")
        );
    }
}
