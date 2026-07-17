//! Oracle read path: query execution, row paging, and result decoding. Mirrors
//! the `ports::sql::query` contract. Blocking (rust-oracle is synchronous);
//! `super` (`mod.rs`) hops these onto the blocking pool. Gated behind
//! `engine-oracle`.

use oracle::sql_type::{OracleType, ToSql};

use crate::shared::engine::{ColumnMeta, FetchRowsRequest, QueryOptions, QueryResult, RowsPage};
use crate::shared::error::AppError;

use super::error::map_ora_query_err;
use super::introspect::table_meta;
use super::sql::{
    is_numeric_type, order_by_clause, paging_clause, qualified, quote_ident, where_clause,
    BoundValue, WhereClause, JS_MAX_SAFE_INTEGER,
};

/// Page-size ceiling for `fetch_rows` (mirrors the other relational adapters).
const MAX_PAGE_ROWS: u32 = 10_000;

/// Execute SQL verbatim with a row limit + timing. A statement that returns rows
/// (SELECT / WITH) is queried; anything else runs as DML/DDL (committed) and
/// reports "Query OK" with no columns.
pub(super) fn run_query(
    c: &oracle::Connection,
    sql: &str,
    options: QueryOptions,
) -> Result<QueryResult, AppError> {
    let started = std::time::Instant::now();
    let trimmed = sql.trim().trim_end_matches(';');

    let is_select = {
        let head = trimmed
            .split_whitespace()
            .next()
            .unwrap_or("")
            .to_ascii_uppercase();
        head == "SELECT" || head == "WITH"
    };

    if !is_select {
        c.execute(trimmed, &[]).map_err(map_ora_query_err)?;
        c.commit().map_err(map_ora_query_err)?;
        return Ok(QueryResult {
            columns: Vec::new(),
            rows: Vec::new(),
            row_count: 0,
            truncated: false,
            elapsed_ms: started.elapsed().as_millis() as u64,
        });
    }

    let rows = c.query(trimmed, &[]).map_err(map_ora_query_err)?;
    let (columns, numeric) = column_meta_and_numeric(rows.column_info());
    let mut out_rows: Vec<Vec<serde_json::Value>> = Vec::new();
    let mut truncated = false;
    for row in rows {
        if out_rows.len() >= options.row_limit {
            truncated = true;
            break;
        }
        let row = row.map_err(map_ora_query_err)?;
        out_rows.push(decode_row(&row, &numeric)?);
    }

    Ok(QueryResult {
        columns,
        row_count: out_rows.len(),
        rows: out_rows,
        truncated,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

/// Fetch one page of rows for the data grid: paged (`OFFSET…FETCH`), optionally
/// sorted, optionally filtered, with an exact `COUNT(*)` for "n of N rows".
pub(super) fn fetch_rows(
    c: &oracle::Connection,
    req: FetchRowsRequest,
) -> Result<RowsPage, AppError> {
    let started = std::time::Instant::now();
    let meta = table_meta(c, &req.schema, &req.table)?;
    let column_names: Vec<String> = meta.columns.iter().map(|col| col.name.clone()).collect();

    // OFFSET/FETCH needs a stable ORDER BY; default to the primary key so an
    // edited row keeps its page.
    let order_by = match &req.sort {
        Some(sort) => order_by_clause(&column_names, &req.table, sort)?,
        None => {
            let pk: Vec<String> = meta
                .columns
                .iter()
                .filter(|col| col.pk)
                .map(|col| quote_ident(&col.name))
                .collect();
            if pk.is_empty() {
                // Any stable expression works; ROWID is Oracle's physical key.
                "ROWID".to_string()
            } else {
                pk.join(", ")
            }
        }
    };
    let (wc, _next) = match &req.filter {
        Some(filter) => where_clause(&column_names, &req.table, filter, 1)?,
        None => (WhereClause::default(), 1),
    };
    let where_sql = match &wc.sql {
        Some(body) => format!(" WHERE {body}"),
        None => String::new(),
    };

    let limit = req.limit.min(MAX_PAGE_ROWS);
    let q = qualified(&req.schema, &req.table);

    // Exact filtered COUNT for "n of N rows" (§3.5). The WHERE binds (`:1..`)
    // apply to both the count and the page query.
    let count_sql = format!("SELECT COUNT(*) FROM {q}{where_sql}");
    let params = bind_params(&wc.params);
    let param_refs: Vec<&dyn ToSql> = params.iter().map(|b| b.as_ref()).collect();
    let total_rows: i64 = c
        .query_row_as::<i64>(&count_sql, &param_refs)
        .map_err(map_ora_query_err)?;

    // Page query: WHERE binds (`:1..`), then the inlined OFFSET/FETCH clause.
    let paging = paging_clause(req.offset, u64::from(limit));
    let page_sql = format!("SELECT * FROM {q}{where_sql} ORDER BY {order_by} {paging}");
    let rows = c.query(&page_sql, &param_refs).map_err(map_ora_query_err)?;
    let (columns, numeric) = column_meta_and_numeric(rows.column_info());
    let mut out_rows: Vec<Vec<serde_json::Value>> = Vec::new();
    for row in rows {
        let row = row.map_err(map_ora_query_err)?;
        out_rows.push(decode_row(&row, &numeric)?);
    }
    let columns = if columns.is_empty() {
        meta.columns
            .iter()
            .map(|col| ColumnMeta {
                name: col.name.clone(),
                type_hint: col.data_type.clone(),
            })
            .collect()
    } else {
        columns
    };

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

/// Box each [`BoundValue`] as an owned `ToSql` so a `&[&dyn ToSql]` slice can be
/// built for `:1..` positional binds.
fn bind_params(values: &[BoundValue]) -> Vec<Box<dyn ToSql>> {
    values
        .iter()
        .map(|v| -> Box<dyn ToSql> {
            match v {
                BoundValue::Null => Box::new(Option::<String>::None),
                BoundValue::Bool(b) => Box::new(if *b { 1i64 } else { 0i64 }),
                BoundValue::Int(i) => Box::new(*i),
                BoundValue::Float(f) => Box::new(*f),
                BoundValue::Text(s) => Box::new(s.clone()),
                BoundValue::Bytes(b) => Box::new(b.clone()),
            }
        })
        .collect()
}

/// Column metadata for a result + a parallel "is this column numeric" mask that
/// drives NUMBER decoding to a JSON number (vs. a string).
fn column_meta_and_numeric(info: &[oracle::ColumnInfo]) -> (Vec<ColumnMeta>, Vec<bool>) {
    let mut columns = Vec::with_capacity(info.len());
    let mut numeric = Vec::with_capacity(info.len());
    for col in info {
        let type_hint = format!("{}", col.oracle_type());
        numeric.push(
            matches!(
                col.oracle_type(),
                OracleType::Number(_, _)
                    | OracleType::Float(_)
                    | OracleType::BinaryFloat
                    | OracleType::BinaryDouble
                    | OracleType::Int64
                    | OracleType::UInt64
            ) || is_numeric_type(&type_hint),
        );
        columns.push(ColumnMeta {
            name: col.name().to_string(),
            type_hint: type_hint.to_ascii_uppercase(),
        });
    }
    (columns, numeric)
}

/// Decode every column of a row to JSON, using the numeric mask for NUMBER
/// columns and a byte-length placeholder for RAW/BLOB.
fn decode_row(row: &oracle::Row, numeric: &[bool]) -> Result<Vec<serde_json::Value>, AppError> {
    let info = row.column_info();
    let mut out = Vec::with_capacity(info.len());
    for (i, col) in info.iter().enumerate() {
        out.push(decode_value(
            row,
            i,
            col,
            numeric.get(i).copied().unwrap_or(false),
        )?);
    }
    Ok(out)
}

/// Decode one column to JSON. Binary types render as a `"[N bytes]"` placeholder;
/// numeric columns parse to a JSON number (falling back to the exact string to
/// preserve precision); everything else is the driver's string rendering.
fn decode_value(
    row: &oracle::Row,
    index: usize,
    col: &oracle::ColumnInfo,
    numeric: bool,
) -> Result<serde_json::Value, AppError> {
    use serde_json::Value;

    // Binary → placeholder (never dumped as text).
    if matches!(
        col.oracle_type(),
        OracleType::Raw(_) | OracleType::LongRaw | OracleType::BLOB
    ) {
        let bytes: Option<Vec<u8>> = row.get(index).map_err(map_ora_query_err)?;
        return Ok(match bytes {
            Some(b) => Value::from(format!("[{} bytes]", b.len())),
            None => Value::Null,
        });
    }

    let text: Option<String> = row.get(index).map_err(map_ora_query_err)?;
    Ok(match text {
        None => Value::Null,
        Some(s) if numeric => numeric_text_to_json(&s),
        Some(s) => Value::from(s),
    })
}

/// A numeric column's text form as a JSON number when it round-trips through i64
/// (within JS's safe range) or f64 losslessly, else the exact decimal *string*.
fn numeric_text_to_json(text: &str) -> serde_json::Value {
    let t = text.trim();
    if let Ok(i) = t.parse::<i64>() {
        if i.abs() <= JS_MAX_SAFE_INTEGER {
            return serde_json::Value::from(i);
        }
        return serde_json::Value::from(i.to_string());
    }
    if let Ok(f) = t.parse::<f64>() {
        if f.to_string() == t {
            if let Some(n) = serde_json::Number::from_f64(f) {
                return serde_json::Value::Number(n);
            }
        }
    }
    serde_json::Value::from(t.to_string())
}

#[cfg(test)]
mod tests {
    use super::numeric_text_to_json;

    #[test]
    fn numeric_text_preserves_large_ints_and_scale() {
        assert_eq!(numeric_text_to_json("42"), serde_json::json!(42));
        assert_eq!(
            numeric_text_to_json("9007199254740993"),
            serde_json::json!("9007199254740993")
        );
        assert_eq!(numeric_text_to_json("1.50"), serde_json::json!("1.50"));
        assert_eq!(numeric_text_to_json("2.5"), serde_json::json!(2.5));
    }
}
