//! MySQL read path: query execution, row paging, single-row lookup, column
//! statistics, and result decoding. Mirrors the `ports::sql::query` contract.

use std::time::Instant;

use sqlx::mysql::{MySqlPool, MySqlRow};
use sqlx::{Column, Row, TypeInfo};

use crate::shared::engine::*;
use crate::shared::error::AppError;

use super::error::{is_unpreparable, map_query_error};
use super::introspect::table_meta;
use super::sql::{
    is_numeric_type, order_by_clause, qualified, quote_ident, validate_column, where_clause,
    BoundValue, WhereClause, JS_MAX_SAFE_INTEGER,
};

/// Page-size ceiling for `fetch_rows` (mirrors the SQLite/Postgres adapters and
/// the connections slice's `MAX_ROW_LIMIT`).
const MAX_PAGE_ROWS: u32 = 10_000;

/// Extracted from the `EngineConnection` impl (canonical layout: the impl
/// delegates; the SQL lives in the concern module).
pub(super) async fn run_query(
    pool: &MySqlPool,
    sql: &str,
    options: QueryOptions,
) -> Result<QueryResult, AppError> {
    // One acquired connection so a `USE` and the query share a session.
    // A `USE` on the pool surface lands on a random pooled connection, so
    // the query — which may grab a DIFFERENT pooled connection — would not
    // see the selected database. With an empty default database (the
    // connection's database field is optional) an unqualified query then
    // fails with MySQL ERROR 1046 "No database selected". Pinning the
    // session is the same fix `execute_script` uses for imports.
    let mut conn = pool.acquire().await.map_err(map_query_error)?;
    apply_schema(&mut conn, options.schema.as_deref()).await;
    run_on_conn(&mut conn, sql, &options).await
}

/// Session-pinned multi-statement execution (the `run_batch` port method):
/// run EVERY statement on ONE acquired connection, in order, so transaction /
/// savepoint / session state carries across them. A per-statement `run_query`
/// loop cannot do this — the pool hands each call a different connection, so
/// `START TRANSACTION` / `SAVEPOINT` / `SET SESSION` set on one connection are
/// invisible to the next statement (that was the "SAVEPOINT sp1 does not
/// exist" bug).
///
/// The `USE schema` is applied ONCE on the pinned connection and persists for
/// the whole batch. Continue-on-error: each statement's success result or §5
/// error is captured into a `StatementOutcome`; a failing statement never
/// aborts the rest (matches the editor's per-statement result tabs). Only a
/// failure to acquire the connection is the outer `Err`.
pub(super) async fn run_batch(
    pool: &MySqlPool,
    statements: &[String],
    options: QueryOptions,
) -> Result<Vec<StatementOutcome>, AppError> {
    let mut conn = pool.acquire().await.map_err(map_query_error)?;
    apply_schema(&mut conn, options.schema.as_deref()).await;

    let mut out = Vec::with_capacity(statements.len());
    for stmt in statements {
        let outcome = match run_on_conn(&mut conn, stmt, &options).await {
            Ok(result) => StatementOutcome {
                sql: stmt.clone(),
                result: Some(result),
                error: None,
            },
            Err(err) => StatementOutcome {
                sql: stmt.clone(),
                result: None,
                error: Some(err.to_string()),
            },
        };
        out.push(outcome);
    }
    Ok(out)
}

/// Apply `schema` as the default database (`USE`) for unqualified names on the
/// given connection, when given. Best effort: a bad schema simply leaves the
/// current default. Applied ONCE per acquired connection so it persists for
/// every statement run on it.
async fn apply_schema(conn: &mut sqlx::mysql::MySqlConnection, schema: Option<&str>) {
    if let Some(schema) = schema {
        use sqlx::Executor as _;
        let _ = conn
            .execute(format!("USE {}", quote_ident(schema)).as_str())
            .await;
    }
}

/// Run ONE statement on an already-acquired connection and decode it to a
/// [`QueryResult`]. Shared by the single-statement `run_query` and the
/// session-pinned `run_batch` so both take the same prepared→text fallback and
/// decoding path; the caller owns connection acquisition and `USE schema`.
async fn run_on_conn(
    conn: &mut sqlx::mysql::MySqlConnection,
    sql: &str,
    options: &QueryOptions,
) -> Result<QueryResult, AppError> {
    let started = Instant::now();

    // MySQL refuses some commands in the prepared-statement protocol
    // (error 1295) — notably CREATE/DROP FUNCTION/PROCEDURE/TRIGGER — and some
    // statements (e.g. `SET GLOBAL time_zone=...`) return a PrepareOk packet
    // sqlx cannot decode. On either, re-run via the unprepared TEXT protocol
    // (`raw_sql`), which accepts them; such statements return no result rows.
    let rows = match sqlx::query(sql).fetch_all(&mut *conn).await {
        Ok(rows) => rows,
        Err(err) if is_unpreparable(&err) => {
            use sqlx::Executor as _;
            conn.execute(sqlx::raw_sql(sql))
                .await
                .map_err(map_query_error)?;
            Vec::new()
        }
        Err(err) => return Err(map_query_error(err)),
    };

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
                    type_hint: result_type_hint(col.type_info().name()),
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
pub(super) async fn fetch_rows(
    pool: &MySqlPool,
    req: FetchRowsRequest,
) -> Result<RowsPage, AppError> {
    let started = Instant::now();
    let meta = table_meta(pool, &req.schema, &req.table).await?;
    let column_names: Vec<String> = meta.columns.iter().map(|c| c.name.clone()).collect();

    let order_by = match &req.sort {
        Some(sort) => Some(order_by_clause(&column_names, &req.table, sort)?),
        None => None,
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

    // Page query: WHERE params first (in order), then LIMIT/OFFSET as the
    // trailing `?` binds.
    let mut page_sql = format!("SELECT * FROM {qualified}{where_sql}");
    if let Some(clause) = &order_by {
        page_sql.push_str(&format!(" ORDER BY {clause}"));
    }
    page_sql.push_str(" LIMIT ? OFFSET ?");

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
    pool: &MySqlPool,
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

    let row_sql = format!("SELECT * FROM {qualified} WHERE {col} = ? LIMIT 1");
    let row = bind_value(sqlx::query(&row_sql), &bound)
        .fetch_optional(pool)
        .await
        .map_err(map_query_error)?
        .map(|r| decode_row(&r));

    let match_count = if row.is_none() {
        0
    } else {
        let count_sql = format!("SELECT count(*) AS n FROM {qualified} WHERE {col} = ?");
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

/// Bind a [`BoundValue`] to a sqlx query with its native MySQL type. The caller
/// has already emitted the matching `?` placeholder. Binding natively
/// (bool→bool, int→i64, float→f64, text→text) lets the common grid/filter cases
/// compare correctly.
pub(super) fn bind_value<'q>(
    query: sqlx::query::Query<'q, sqlx::MySql, sqlx::mysql::MySqlArguments>,
    value: &'q BoundValue,
) -> sqlx::query::Query<'q, sqlx::MySql, sqlx::mysql::MySqlArguments> {
    match value {
        BoundValue::Null => query.bind(Option::<String>::None),
        BoundValue::Bool(b) => query.bind(*b),
        BoundValue::Int(i) => query.bind(*i),
        BoundValue::Float(f) => query.bind(*f),
        BoundValue::Text(s) => query.bind(s.as_str()),
        BoundValue::Bytes(b) => query.bind(b.as_slice()),
    }
}

/// Bind every [`BoundValue`] (the WHERE params) to a query in order.
pub(super) fn bind_all<'q>(
    mut query: sqlx::query::Query<'q, sqlx::MySql, sqlx::mysql::MySqlArguments>,
    params: &'q [BoundValue],
) -> sqlx::query::Query<'q, sqlx::MySql, sqlx::mysql::MySqlArguments> {
    for value in params {
        query = bind_value(query, value);
    }
    query
}

/// The display type hint for a result column. sqlx surfaces `tinyint(1)` (and
/// its `BOOL`/`BOOLEAN` aliases) as the type name "BOOLEAN", but MySQL has no
/// native boolean — the value is decoded as the integer 0/1 (module docs) — so
/// we report the real underlying type `tinyint(1)`. That matches
/// information_schema's `COLUMN_TYPE` (introspection) and keeps the grid /
/// row inspector treating the column as the integer it actually is.
pub(super) fn result_type_hint(name: &str) -> String {
    match name.to_ascii_uppercase().as_str() {
        "BOOLEAN" | "BOOL" => "tinyint(1)".to_string(),
        _ => name.to_string(),
    }
}

/// Column metadata for a result row: name + the MySQL type name as the display
/// type hint.
pub(super) fn column_meta(row: &MySqlRow) -> Vec<ColumnMeta> {
    row.columns()
        .iter()
        .map(|col| ColumnMeta {
            name: col.name().to_string(),
            type_hint: result_type_hint(col.type_info().name()),
        })
        .collect()
}

/// Decode every column of a row to JSON (module docs for the mapping).
pub(super) fn decode_row(row: &MySqlRow) -> Vec<serde_json::Value> {
    (0..row.columns().len())
        .map(|i| decode_value(row, i))
        .collect()
}

/// Decode one column of a [`MySqlRow`] to JSON, dispatching on the MySQL type
/// name (`col.type_info().name()`, uppercase, e.g. `INT`, `BIGINT`, `DECIMAL`,
/// `VARCHAR`). See the module docs for the full mapping. Unknown types fall
/// back to the column's text form; a decode error degrades to null rather than
/// failing the whole row.
pub(super) fn decode_value(row: &MySqlRow, index: usize) -> serde_json::Value {
    use serde_json::Value;

    let col = &row.columns()[index];
    // sqlx reports MySQL type names uppercase, with an UNSIGNED suffix for
    // unsigned integers (e.g. "INT UNSIGNED", "BIGINT UNSIGNED").
    let type_name = col.type_info().name().to_ascii_uppercase();
    let unsigned = type_name.contains("UNSIGNED");
    let base = type_name
        .split_whitespace()
        .next()
        .unwrap_or(&type_name)
        .to_string();

    match base.as_str() {
        // sqlx reports a `tinyint(1)` / `BOOL` / `BOOLEAN` column with the type
        // name "BOOLEAN" and decodes it to a Rust `bool`. MySQL has no native
        // boolean — it is stored as TINYINT(1) and conceptually an integer — so
        // we surface it as the number 0/1, NOT a JSON bool (module docs; only
        // Postgres emits native JSON bool). A wider tinyint (e.g. tinyint(4))
        // keeps the "TINYINT" type name and flows through the integer arm below.
        "BOOLEAN" | "BOOL" => match row.try_get::<Option<bool>, _>(index) {
            Ok(Some(b)) => Value::from(i64::from(b)),
            Ok(None) => Value::Null,
            // Fall back to a narrow signed-int read if the bool decode fails.
            Err(_) => decode_signed_width(row, index, unsigned, IntWidth::I8),
        },
        // Small integers — always fit i64 (and the JS-safe range). sqlx decodes
        // each MySQL integer width to a specific Rust type (TINYINT → i8,
        // SMALLINT → i16, MEDIUMINT/INT → i32, BIGINT → i64), and a `try_get`
        // for the wrong width fails — so we read the native width and widen.
        // TINYINT(1)/BOOL is a TINYINT here and surfaces as 0/1 (module docs:
        // MySQL has no native bool).
        "TINYINT" => decode_signed_width(row, index, unsigned, IntWidth::I8),
        "SMALLINT" => decode_signed_width(row, index, unsigned, IntWidth::I16),
        "MEDIUMINT" | "INT" | "INTEGER" => decode_signed_width(row, index, unsigned, IntWidth::I32),
        // BIGINT: signed via i64; unsigned via u64 (so the full range decodes,
        // then the ±2^53 / >2^53 string-fallback applies).
        "BIGINT" => decode_signed_width(row, index, unsigned, IntWidth::I64),
        "FLOAT" => match row.try_get::<Option<f32>, _>(index) {
            Ok(Some(f)) => number_or_null(f64::from(f)),
            _ => Value::Null,
        },
        "DOUBLE" => match row.try_get::<Option<f64>, _>(index) {
            Ok(Some(f)) => number_or_null(f),
            _ => Value::Null,
        },
        // decimal/numeric: decode to arbitrary-precision BigDecimal (the
        // `bigdecimal` sqlx feature) and stringify, then map: a lossless JS-safe
        // value becomes a JSON number, otherwise the exact decimal string (the
        // CellValue precision contract — module docs).
        "DECIMAL" | "NEWDECIMAL" => {
            match row.try_get::<Option<sqlx::types::BigDecimal>, _>(index) {
                Ok(Some(d)) => numeric_text_to_json(&d.normalized().to_string()),
                Ok(None) => Value::Null,
                Err(_) => get_as_text(row, index)
                    .map(Value::String)
                    .unwrap_or(Value::Null),
            }
        }
        // bit: a bit-field. Decode the raw bytes to an unsigned integer (big-
        // endian), mapping to number-or-string by the same ±2^53 rule. BIT(1)
        // is the common "boolean-ish" case and yields 0/1.
        "BIT" => match row.try_get::<Option<Vec<u8>>, _>(index) {
            Ok(Some(bytes)) => bit_to_json(&bytes),
            Ok(None) => Value::Null,
            Err(_) => Value::Null,
        },
        // json → the JSON text (kept a string so the grid renders it as text,
        // consistent with other engines). Over sqlx's binary protocol a JSON
        // column does NOT satisfy the checked `String` decode (distinct type
        // code), so `get_as_text` returns NULL — that was the "JSON column shows
        // NULL" bug. `try_get_unchecked` decodes the raw bytes as a String
        // regardless of the type code; MySQL stores JSON as UTF-8 text, so this
        // yields the JSON document, with no `json` sqlx feature needed.
        "JSON" => row
            .try_get_unchecked::<Option<String>, _>(index)
            .ok()
            .flatten()
            .map(Value::String)
            .unwrap_or(Value::Null),
        // Binary families → hex when small (UUID/key), placeholder when large;
        // shared with SQLite/Postgres so binary renders identically everywhere.
        "BLOB" | "TINYBLOB" | "MEDIUMBLOB" | "LONGBLOB" | "BINARY" | "VARBINARY" | "GEOMETRY" => {
            match row.try_get::<Option<Vec<u8>>, _>(index) {
                Ok(Some(bytes)) => crate::shared::engine::binary_to_json(&bytes),
                _ => Value::Null,
            }
        }
        // Temporal types decode to chrono values, not String — format them to a
        // display string (the "timestamps don't show" fix). YEAR stays in the
        // text/numeric fallback below.
        "DATE" | "DATETIME" | "TIMESTAMP" | "TIME" => get_temporal(row, index, base.as_str())
            .or_else(|| get_as_text(row, index))
            .map(Value::String)
            .unwrap_or(Value::Null),
        // Text-like and everything else (char/varchar/text families, enum, set,
        // year, …): the column's string form. sqlx decodes these as String.
        _ => get_as_text(row, index)
            .map(Value::String)
            .unwrap_or(Value::Null),
    }
}

/// The native Rust integer width sqlx decodes a given MySQL integer type to.
#[derive(Clone, Copy)]
pub(super) enum IntWidth {
    I8,
    I16,
    I32,
    I64,
}

/// Decode an integer column to JSON, reading the native signed/unsigned width
/// sqlx uses for the MySQL type, widening to i64/u64, and applying the
/// magnitude string-fallback above 2^53 (the `CellValue` precision contract).
/// Reading the wrong width fails in sqlx, so the width must match the type.
pub(super) fn decode_signed_width(
    row: &MySqlRow,
    index: usize,
    unsigned: bool,
    width: IntWidth,
) -> serde_json::Value {
    if unsigned {
        let value: Result<Option<u64>, _> = match width {
            IntWidth::I8 => row
                .try_get::<Option<u8>, _>(index)
                .map(|o| o.map(u64::from)),
            IntWidth::I16 => row
                .try_get::<Option<u16>, _>(index)
                .map(|o| o.map(u64::from)),
            IntWidth::I32 => row
                .try_get::<Option<u32>, _>(index)
                .map(|o| o.map(u64::from)),
            IntWidth::I64 => row.try_get::<Option<u64>, _>(index),
        };
        return match value {
            Ok(Some(u)) if u <= JS_MAX_SAFE_INTEGER as u64 => serde_json::Value::from(u),
            Ok(Some(u)) => serde_json::Value::String(u.to_string()),
            _ => serde_json::Value::Null,
        };
    }
    let value: Result<Option<i64>, _> = match width {
        IntWidth::I8 => row
            .try_get::<Option<i8>, _>(index)
            .map(|o| o.map(i64::from)),
        IntWidth::I16 => row
            .try_get::<Option<i16>, _>(index)
            .map(|o| o.map(i64::from)),
        IntWidth::I32 => row
            .try_get::<Option<i32>, _>(index)
            .map(|o| o.map(i64::from)),
        IntWidth::I64 => row.try_get::<Option<i64>, _>(index),
    };
    match value {
        Ok(Some(i)) if i.unsigned_abs() <= JS_MAX_SAFE_INTEGER as u64 => serde_json::Value::from(i),
        Ok(Some(i)) => serde_json::Value::String(i.to_string()),
        _ => serde_json::Value::Null,
    }
}

/// Decode a BIT column's big-endian bytes to JSON: a number when it fits the
/// JS-safe range, else the decimal string (a BIT can be up to 64 bits).
pub(super) fn bit_to_json(bytes: &[u8]) -> serde_json::Value {
    let mut acc: u64 = 0;
    for &b in bytes.iter().take(8) {
        acc = (acc << 8) | u64::from(b);
    }
    if acc <= JS_MAX_SAFE_INTEGER as u64 {
        serde_json::Value::from(acc)
    } else {
        serde_json::Value::String(acc.to_string())
    }
}

/// A finite f64 as a JSON number; non-finite (NaN/Inf — JSON has neither) → null.
pub(super) fn number_or_null(f: f64) -> serde_json::Value {
    serde_json::Number::from_f64(f)
        .map(serde_json::Value::Number)
        .unwrap_or(serde_json::Value::Null)
}

/// Map a DECIMAL's exact decimal text to JSON: a lossless, JS-safe number when
/// possible, else the exact string (preserve precision — module docs).
pub(super) fn numeric_text_to_json(text: &str) -> serde_json::Value {
    if let Ok(i) = text.parse::<i64>() {
        if i.unsigned_abs() <= JS_MAX_SAFE_INTEGER as u64 {
            return serde_json::Value::from(i);
        }
        return serde_json::Value::String(text.to_string());
    }
    if let Ok(f) = text.parse::<f64>() {
        if f.is_finite() {
            let round_trip = format!("{f}");
            if round_trip == text {
                return number_or_null(f);
            }
        }
    }
    serde_json::Value::String(text.to_string())
}

/// Read a column as its MySQL string representation. sqlx returns most types as
/// `String`; `None` on NULL or decode failure.
pub(super) fn get_as_text(row: &MySqlRow, index: usize) -> Option<String> {
    row.try_get::<Option<String>, _>(index).ok().flatten()
}

/// Decode a MySQL temporal column (DATE/DATETIME/TIMESTAMP/TIME) to a display
/// string. These arrive over the binary protocol as chrono types (the `chrono`
/// sqlx feature), NOT as `String`, so a plain text read returns NULL — that was
/// the "timestamps don't show" bug. DATETIME/TIMESTAMP format to
/// `YYYY-MM-DD HH:MM:SS[.ffffff]` (fractional shown only when present).
pub(super) fn get_temporal(row: &MySqlRow, index: usize, base: &str) -> Option<String> {
    use sqlx::types::chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, Utc};
    const DT_FMT: &str = "%Y-%m-%d %H:%M:%S%.f";
    match base {
        "DATE" => row
            .try_get::<Option<NaiveDate>, _>(index)
            .ok()
            .flatten()
            .map(|d| d.format("%Y-%m-%d").to_string()),
        "DATETIME" => row
            .try_get::<Option<NaiveDateTime>, _>(index)
            .ok()
            .flatten()
            .map(|d| d.format(DT_FMT).to_string()),
        // TIMESTAMP is UTC-backed; try the tz-aware decode first, then fall back
        // to a naive read for servers/drivers that hand it back naive.
        "TIMESTAMP" => row
            .try_get::<Option<DateTime<Utc>>, _>(index)
            .ok()
            .flatten()
            .map(|d| d.naive_utc().format(DT_FMT).to_string())
            .or_else(|| {
                row.try_get::<Option<NaiveDateTime>, _>(index)
                    .ok()
                    .flatten()
                    .map(|d| d.format(DT_FMT).to_string())
            }),
        "TIME" => row
            .try_get::<Option<NaiveTime>, _>(index)
            .ok()
            .flatten()
            .map(|t| t.format("%H:%M:%S%.f").to_string()),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// column_stats
// ---------------------------------------------------------------------------

/// Per-column statistics over the (filtered) set: total/distinct/null counts,
/// min/max, avg (numeric only), top-5. Reuses the same parameterized
/// [`where_clause`] compilation as `fetch_rows`. Numeric detection comes from
/// the catalog DATA_TYPE.
pub(super) async fn column_stats(
    pool: &MySqlPool,
    req: &ColumnStatsRequest,
) -> Result<ColumnStats, AppError> {
    let meta = table_meta(pool, &req.schema, &req.table).await?;
    let column_names: Vec<String> = meta.columns.iter().map(|c| c.name.clone()).collect();
    validate_column(&column_names, &req.table, &req.column)?;

    // The catalog DATA_TYPE for numeric detection.
    let data_type: String = sqlx::query_scalar(
        "SELECT CAST(data_type AS CHAR) FROM information_schema.columns \
         WHERE table_schema = ? AND table_name = ? AND column_name = ?",
    )
    .bind(&req.schema)
    .bind(&req.table)
    .bind(&req.column)
    .fetch_one(pool)
    .await
    .map_err(map_query_error)?;
    let numeric = is_numeric_type(&data_type);

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

    // min / max as text → JSON (so big-int/decimal map like everywhere else).
    let minmax_sql = format!(
        "SELECT CAST(min({col}) AS CHAR) AS lo, CAST(max({col}) AS CHAR) AS hi \
         FROM {qualified}{where_sql}"
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

    // avg only when numeric. MySQL's avg() over an integer/decimal column
    // returns a DECIMAL, which sqlx cannot decode straight to f64 — cast it to a
    // DOUBLE in SQL so the f64 decode succeeds.
    let avg = if numeric {
        let avg_sql = format!("SELECT CAST(avg({col}) AS DOUBLE) AS a FROM {qualified}{where_sql}");
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
        "SELECT CAST({col} AS CHAR) AS v, count(*) AS freq FROM {qualified}{where_sql}{and} \
         {col} IS NOT NULL GROUP BY {col} ORDER BY freq DESC, {col} ASC LIMIT 5"
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numeric_text_to_json_preserves_precision() {
        assert_eq!(numeric_text_to_json("42"), serde_json::json!(42));
        assert_eq!(numeric_text_to_json("3.5"), serde_json::json!(3.5));
        assert_eq!(
            numeric_text_to_json("9007199254740993"),
            serde_json::json!("9007199254740993")
        );
        assert_eq!(
            numeric_text_to_json("0.12345678901234567890"),
            serde_json::json!("0.12345678901234567890")
        );
    }

    #[test]
    fn bit_to_json_decodes_big_endian_with_precision_guard() {
        assert_eq!(bit_to_json(&[0x01]), serde_json::json!(1));
        assert_eq!(bit_to_json(&[0x00]), serde_json::json!(0));
        assert_eq!(bit_to_json(&[0x01, 0x00]), serde_json::json!(256));
        // 8 bytes all 0xFF = u64::MAX → beyond 2^53 → string.
        assert_eq!(
            bit_to_json(&[0xFF; 8]),
            serde_json::json!(u64::MAX.to_string())
        );
    }
}
