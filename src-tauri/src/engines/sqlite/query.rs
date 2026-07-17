//! SQLite read path: query execution, row paging, single-row lookup, and
//! column statistics. Mirrors the `ports::sql::query` contract.

use std::time::Instant;

use rusqlite::types::Value as SqlValue;
use rusqlite::Connection;

use crate::shared::engine::*;
use crate::shared::error::AppError;

use super::error::{map_query_error, value_to_json};
use super::introspect::table_meta_blocking;
use super::sql::{
    json_to_blob_operand, json_to_sql_value, non_null, order_by_clause, quote_ident,
    validate_column, where_clause, WhereClause,
};

/// Page-size ceiling for `fetch_rows` (the M4 data grid). Mirrors the
/// connections slice's `MAX_ROW_LIMIT` (10 000): a single grid page never
/// usefully shows more, and the clamp keeps a renderer bug or a hand-crafted
/// invoke from marshalling an unbounded page across IPC.
const MAX_PAGE_ROWS: u32 = 10_000;

pub(super) fn run_query_blocking(
    conn: &Connection,
    sql: &str,
    options: &QueryOptions,
) -> Result<QueryResult, AppError> {
    let started = Instant::now();
    let mut stmt = conn
        .prepare(sql)
        .map_err(|err| map_query_error(conn, err))?;

    let columns: Vec<ColumnMeta> = stmt
        .columns()
        .iter()
        .map(|col| ColumnMeta {
            name: col.name().to_string(),
            type_hint: col.decl_type().unwrap_or("").to_string(),
        })
        .collect();
    let column_count = columns.len();

    let mut out_rows: Vec<Vec<serde_json::Value>> = Vec::new();
    let mut truncated = false;
    let mut rows = stmt.query([]).map_err(|err| map_query_error(conn, err))?;
    while let Some(row) = rows.next().map_err(|err| map_query_error(conn, err))? {
        if out_rows.len() >= options.row_limit {
            truncated = true;
            break;
        }
        let mut values = Vec::with_capacity(column_count);
        for index in 0..column_count {
            let value = row
                .get_ref(index)
                .map_err(|err| map_query_error(conn, err))?;
            values.push(value_to_json(value));
        }
        out_rows.push(values);
    }

    Ok(QueryResult {
        columns,
        row_count: out_rows.len(),
        rows: out_rows,
        truncated,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

/// Fetch one page of rows from a table for the data grid (M4 + M5 filters):
/// paged (`LIMIT`/`OFFSET`), optionally sorted by a single validated column,
/// optionally filtered (M5), with an exact `COUNT(*)` for the row-count
/// status.
///
/// SQL safety: schema and table existence are checked first (yielding the §5
/// messages), the sort column is validated against the table's real columns
/// before being quoted, and the ORDER BY direction is the enum's literal
/// `ASC`/`DESC` keyword — never a caller string. `limit` and `offset` are
/// bound as parameters, not interpolated. The only interpolated identifiers
/// are quoted via [`quote_ident`].
///
/// # M5 filtering
///
/// When `req.filter` is present, the same WHERE clause is applied to BOTH the
/// page query and the `COUNT(*)`, so `total_rows` is the *filtered* count (the
/// "n of N rows" status shows the filtered total).
///
/// Two filter modes (see [`FilterSpec`]):
///
/// - **Structured conditions** — each [`Condition`]'s column is validated
///   against the table (same check as the sort column), its operator selects a
///   fixed SQL fragment, and its value is *bound as a parameter* (`?`). There
///   is **no SQL-injection surface**: a value such as `'; DROP TABLE t; --`
///   binds as a literal string that simply matches nothing. The `LIKE` family
///   escapes `%`/`_`/`\` in the bound value (`… ESCAPE '\'`) so a literal `%`
///   in user input matches literally rather than as a wildcard.
///
/// - **Raw WHERE** — the user-typed string is interpolated verbatim into
///   `WHERE (<raw>)`. **Threat model (documented decision):** this is the
///   "Edit as SQL" escape hatch every DB GUI offers. We deliberately do NOT
///   parse or sanitize it — there is no safe way to do so, and any attempt
///   would just be a worse SQL parser. It runs with the connection's
///   privileges, exactly like the SQL query editor will (M6) on this
///   local-first, single-user tool where the user already has full SQL
///   access. The string *can* in principle break out of the WHERE context
///   (e.g. `1=1); DROP TABLE t; --`) the same way the M6 editor allows
///   arbitrary statements; this is accepted for that threat model, not a
///   defect. The only "validation" is execution: a malformed clause surfaces
///   as a §5 error (`map_query_error`). Structured conditions remain fully
///   parameterized — only this explicit escape hatch is interpolated.
pub(super) fn fetch_rows_blocking(
    conn: &Connection,
    req: &FetchRowsRequest,
) -> Result<RowsPage, AppError> {
    let started = Instant::now();

    // Existence first: unknown schema/table get the §5 human messages
    // (`table_meta_blocking` performs both checks and gives us the real
    // column list we need to validate the sort/filter columns against).
    let meta = table_meta_blocking(conn, &req.schema, &req.table)?;

    let order_by = match &req.sort {
        Some(sort) => Some(order_by_clause(&meta, &req.table, sort)?),
        None => None,
    };

    // Build the WHERE body + bound parameters from the filter (if any).
    let where_clause = match &req.filter {
        Some(filter) => where_clause(&meta, &req.table, filter)?,
        None => WhereClause::default(),
    };
    let where_sql = match &where_clause.sql {
        Some(body) => format!(" WHERE {body}"),
        None => String::new(),
    };

    let limit = req.limit.min(MAX_PAGE_ROWS);
    let qualified = format!("{}.{}", quote_ident(&req.schema), quote_ident(&req.table));

    // Exact count for the "N rows" status — filtered when a filter applies, so
    // `total_rows` matches the result set ("n of N rows", §3.5). The WHERE
    // params bind first; the count query has no limit/offset.
    let count_sql = format!("SELECT count(*) FROM {qualified}{where_sql}");
    let total_rows = conn
        .query_row(
            &count_sql,
            rusqlite::params_from_iter(where_clause.params.iter()),
            |row| row.get::<_, u64>(0),
        )
        .map_err(|err| map_query_error(conn, err))?;

    // Build order: WHERE, then ORDER BY, then LIMIT/OFFSET. The WHERE params
    // bind first, then limit, then offset (positional `?` placeholders).
    let mut page_sql = format!("SELECT * FROM {qualified}{where_sql}");
    if let Some(clause) = &order_by {
        page_sql.push_str(&format!(" ORDER BY {clause}"));
    }
    page_sql.push_str(" LIMIT ? OFFSET ?");

    let mut page_params = where_clause.params.clone();
    // offset/limit bound as parameters (i64 — SQLite's integer affinity);
    // limit is already clamped to MAX_PAGE_ROWS, offset is a plain u64.
    page_params.push(SqlValue::Integer(limit as i64));
    page_params.push(SqlValue::Integer(req.offset as i64));

    let mut stmt = conn
        .prepare(&page_sql)
        .map_err(|err| map_query_error(conn, err))?;

    let columns: Vec<ColumnMeta> = stmt
        .columns()
        .iter()
        .map(|col| ColumnMeta {
            name: col.name().to_string(),
            type_hint: col.decl_type().unwrap_or("").to_string(),
        })
        .collect();
    let column_count = columns.len();

    let mut out_rows: Vec<Vec<serde_json::Value>> = Vec::new();
    let mut rows = stmt
        .query(rusqlite::params_from_iter(page_params.iter()))
        .map_err(|err| map_query_error(conn, err))?;
    while let Some(row) = rows.next().map_err(|err| map_query_error(conn, err))? {
        let mut values = Vec::with_capacity(column_count);
        for index in 0..column_count {
            let value = row
                .get_ref(index)
                .map_err(|err| map_query_error(conn, err))?;
            values.push(value_to_json(value));
        }
        out_rows.push(values);
    }

    Ok(RowsPage {
        columns,
        rows: out_rows,
        offset: req.offset,
        limit,
        total_rows: Some(total_rows),
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

/// Look up the row(s) where `column = value` (M10 "FK peek"): the focused
/// single-row counterpart of [`fetch_rows_blocking`].
///
/// SQL safety: schema/table existence is checked first (the §5 messages), the
/// lookup column is validated against the table's real columns before being
/// quoted, and the value is **bound** as a parameter (`?`) — never
/// interpolated, so an injection payload binds as an inert literal. The only
/// interpolated identifiers are quoted via [`quote_ident`].
///
/// Null key semantics: SQL `col = NULL` never matches (it is `UNKNOWN`), so a
/// `null` lookup value short-circuits to a miss (`row: None`, `match_count:
/// 0`) without touching the database. FK keys are non-null in normal use, so
/// this is the honest "no referenced row" answer rather than a surprising
/// `IS NULL` scan (see [`RowLookupRequest::value`]).
pub(super) fn fetch_row_by_key_blocking(
    conn: &Connection,
    req: &RowLookupRequest,
) -> Result<RowLookup, AppError> {
    // Existence first: unknown schema/table get the §5 human messages, and
    // this gives us the real column list to validate `column` against.
    let meta = table_meta_blocking(conn, &req.schema, &req.table)?;
    validate_column(&meta, &req.table, &req.column)?;

    let qualified = format!("{}.{}", quote_ident(&req.schema), quote_ident(&req.table));
    let col = quote_ident(&req.column);

    // The columns are always returned (for field labels), even on a miss — read
    // them straight from the validated meta so a miss still has labels.
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
        json_to_blob_operand(&req.value)?
    } else {
        json_to_sql_value(&req.value)?
    };

    // First matching row (the key is usually unique → 0 or 1 row).
    let row_sql = format!("SELECT * FROM {qualified} WHERE {col} = ? LIMIT 1");
    let mut stmt = conn
        .prepare(&row_sql)
        .map_err(|err| map_query_error(conn, err))?;
    let column_count = stmt.columns().len();
    let mut rows = stmt
        .query([&bound])
        .map_err(|err| map_query_error(conn, err))?;
    let row = match rows.next().map_err(|err| map_query_error(conn, err))? {
        Some(row) => {
            let mut values = Vec::with_capacity(column_count);
            for index in 0..column_count {
                let value = row
                    .get_ref(index)
                    .map_err(|err| map_query_error(conn, err))?;
                values.push(value_to_json(value));
            }
            Some(values)
        }
        None => None,
    };
    drop(rows);
    drop(stmt);

    // Total matches so the UI can flag a non-unique key ("1 of N"). A miss
    // already implies count 0, but counting is cheap and keeps the two answers
    // consistent.
    let match_count = if row.is_none() {
        0
    } else {
        conn.query_row(
            &format!("SELECT count(*) FROM {qualified} WHERE {col} = ?"),
            [&bound],
            |row| row.get::<_, u64>(0),
        )
        .map_err(|err| map_query_error(conn, err))?
    };

    Ok(RowLookup {
        columns,
        row,
        match_count,
    })
}

/// Per-column statistics over the current filtered set (M10 "column
/// insights"): total/distinct/null counts, min/max, avg (numeric only), and
/// the top-5 most frequent values.
///
/// SQL safety: schema/table existence is checked first, the column is
/// validated against the table's real columns before being quoted, and the
/// optional filter reuses [`where_clause`] — the SAME parameterized compilation
/// `fetch_rows` uses, so structured-condition values are bound (the WHERE
/// params bind first, ahead of any per-query params) and insights reflect the
/// grid's visible filtered set.
///
/// Numeric detection: a column is numeric when its non-NULL values are *all*
/// integers/reals — `count(*) == sum(typeof(col) IN ('integer','real'))` over
/// the non-NULL rows. This is value-driven, not declared-type-driven, which
/// matches SQLite's dynamic typing (a column declared `TEXT` that happens to
/// hold only numbers reads as numeric, and vice versa). An all-NULL set is not
/// numeric (no numbers to average); `avg` is surfaced only when numeric.
///
/// Performance: the stats run as a handful of sequential aggregate queries in
/// one `spawn_blocking` hop. Each is a single indexed-or-full scan of the
/// (filtered) set — comfortably <1s on the ~100k-row tables the prototype
/// targets. They are not combined into one statement because the per-stat SQL
/// stays readable and SQLite caches the table pages across the back-to-back
/// scans anyway.
pub(super) fn column_stats_blocking(
    conn: &Connection,
    req: &ColumnStatsRequest,
) -> Result<ColumnStats, AppError> {
    let meta = table_meta_blocking(conn, &req.schema, &req.table)?;
    validate_column(&meta, &req.table, &req.column)?;

    let qualified = format!("{}.{}", quote_ident(&req.schema), quote_ident(&req.table));
    let col = quote_ident(&req.column);

    // Reuse the parameterized filter compilation so stats match the grid's
    // visible set. The WHERE params bind first in every stat query below.
    let where_clause = match &req.filter {
        Some(filter) => where_clause(&meta, &req.table, filter)?,
        None => WhereClause::default(),
    };
    let where_sql = match &where_clause.sql {
        Some(body) => format!(" WHERE {body}"),
        None => String::new(),
    };
    let params = || rusqlite::params_from_iter(where_clause.params.iter());

    // total / nulls / distinct in one aggregate scan.
    let agg_sql = format!(
        "SELECT count(*), count(*) - count({col}), count(DISTINCT {col}) \
         FROM {qualified}{where_sql}"
    );
    let (total, nulls, distinct) = conn
        .query_row(&agg_sql, params(), |row| {
            Ok((
                row.get::<_, u64>(0)?,
                row.get::<_, u64>(1)?,
                row.get::<_, u64>(2)?,
            ))
        })
        .map_err(|err| map_query_error(conn, err))?;

    // min / max (lexicographic for text; the UI decides display). Returned as
    // ValueRef so blobs/big-ints map exactly like everywhere else.
    let minmax_sql = format!("SELECT min({col}), max({col}) FROM {qualified}{where_sql}");
    let (min, max) = conn
        .query_row(&minmax_sql, params(), |row| {
            Ok((
                value_to_json(row.get_ref(0)?),
                value_to_json(row.get_ref(1)?),
            ))
        })
        .map_err(|err| map_query_error(conn, err))?;
    // SQLite min/max over an all-NULL (or empty) set return NULL → map to None.
    let min = non_null(min);
    let max = non_null(max);

    // Numeric detection: all non-NULL values have a numeric typeof. Over an
    // all-NULL set both counts are 0, so `0 == 0` would read as numeric —
    // guard that by requiring at least one non-NULL value.
    let non_null_count = total - nulls;
    let numeric = if non_null_count == 0 {
        false
    } else {
        let numeric_sql = format!(
            "SELECT count(*) FROM {qualified}{where_sql}{and} \
             typeof({col}) IN ('integer', 'real')",
            and = if where_sql.is_empty() {
                " WHERE"
            } else {
                " AND"
            }
        );
        let numeric_count = conn
            .query_row(&numeric_sql, params(), |row| row.get::<_, u64>(0))
            .map_err(|err| map_query_error(conn, err))?;
        numeric_count == non_null_count
    };

    // avg only when numeric (SQLite avg ignores NULLs and returns a real).
    let avg = if numeric {
        conn.query_row(
            &format!("SELECT avg({col}) FROM {qualified}{where_sql}"),
            params(),
            |row| row.get::<_, Option<f64>>(0),
        )
        .map_err(|err| map_query_error(conn, err))?
    } else {
        None
    };

    // Top-5 most frequent non-NULL values (ties broken by value for stable
    // output). The filter WHERE binds first, then the extra NOT NULL guard.
    let top_sql = format!(
        "SELECT {col}, count(*) AS freq FROM {qualified}{where_sql}{and} {col} IS NOT NULL \
         GROUP BY {col} ORDER BY freq DESC, {col} ASC LIMIT 5",
        and = if where_sql.is_empty() {
            " WHERE"
        } else {
            " AND"
        }
    );
    let mut stmt = conn
        .prepare(&top_sql)
        .map_err(|err| map_query_error(conn, err))?;
    let top = stmt
        .query_map(params(), |row| {
            Ok(FreqEntry {
                value: value_to_json(row.get_ref(0)?),
                count: row.get::<_, u64>(1)?,
            })
        })
        .and_then(Iterator::collect::<Result<Vec<_>, _>>)
        .map_err(|err| map_query_error(conn, err))?;

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engines::sqlite::test_support::*;
    use crate::engines::sqlite::SqliteConnector;

    #[tokio::test]
    async fn run_query_maps_values_and_reports_timing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_fixture(&dir).await;
        let result = conn
            .run_query(
                "SELECT id, name, score, avatar FROM users ORDER BY id",
                QueryOptions::default(),
            )
            .await
            .expect("run query");

        let column_names: Vec<&str> = result.columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(column_names, vec!["id", "name", "score", "avatar"]);
        assert_eq!(result.columns[0].type_hint, "INTEGER");
        assert_eq!(result.columns[1].type_hint, "TEXT");

        assert_eq!(result.row_count, 3);
        assert!(!result.truncated);
        assert_eq!(
            result.rows[0],
            vec![
                serde_json::json!(1),
                serde_json::json!("ada"),
                serde_json::json!(9.5),
                serde_json::json!("0xc0ffee"),
            ]
        );
        // NULLs map to JSON null.
        assert_eq!(result.rows[1][2], serde_json::Value::Null);
        // Timing is present and sane (a local select is far under a minute).
        assert!(result.elapsed_ms < 60_000);
    }

    #[tokio::test]
    async fn row_limit_truncates_and_flags_it() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_fixture(&dir).await;
        let limited = conn
            .run_query(
                "SELECT id FROM users ORDER BY id",
                QueryOptions {
                    row_limit: 2,
                    schema: None,
                },
            )
            .await
            .expect("limited query");
        assert_eq!(limited.row_count, 2);
        assert_eq!(limited.rows.len(), 2);
        assert!(limited.truncated);

        let exact = conn
            .run_query(
                "SELECT id FROM users ORDER BY id",
                QueryOptions {
                    row_limit: 3,
                    schema: None,
                },
            )
            .await
            .expect("exact-limit query");
        assert_eq!(exact.row_count, 3);
        assert!(!exact.truncated, "limit == row count is not truncation");
    }

    #[tokio::test]
    async fn missing_table_error_lists_available_tables() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_fixture(&dir).await;
        let err = conn
            .run_query("SELECT * FROM customers", QueryOptions::default())
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Database(_)));
        assert_eq!(
            err.to_string(),
            "Table 'customers' does not exist. Available tables: orders, users."
        );
    }

    #[tokio::test]
    async fn missing_column_and_syntax_errors_are_cleaned_driver_messages() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_fixture(&dir).await;

        let err = conn
            .run_query("SELECT nickname FROM users", QueryOptions::default())
            .await
            .unwrap_err();
        assert_eq!(err.to_string(), "Column 'nickname' does not exist.");

        let err = conn
            .run_query("SELEKT * FROM users", QueryOptions::default())
            .await
            .unwrap_err();
        let message = err.to_string();
        assert!(
            message.contains("syntax error"),
            "expected a syntax message, got {message:?}"
        );
        assert!(
            !message.contains("rusqlite") && !message.contains("Error {"),
            "driver chains must not leak: {message:?}"
        );
    }

    #[tokio::test]
    async fn integers_beyond_js_safe_range_round_trip_as_strings() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("big.db");
        {
            let conn = Connection::open(&path).expect("create db");
            conn.execute_batch(&format!(
                "CREATE TABLE nums (val INTEGER);
                 INSERT INTO nums (val) VALUES ({max}), ({min}), (42);",
                max = i64::MAX,
                min = i64::MIN,
            ))
            .expect("seed db");
        }
        let conn = SqliteConnector
            .open(&params_for(&path))
            .await
            .expect("open db")
            .into_sql()
            .expect("sql connection");
        let result = conn
            .run_query(
                "SELECT val FROM nums ORDER BY rowid",
                QueryOptions::default(),
            )
            .await
            .expect("run query");
        // Beyond ±2^53 − 1: strings, preserving every digit.
        assert_eq!(result.rows[0][0], serde_json::json!("9223372036854775807"));
        assert_eq!(result.rows[1][0], serde_json::json!("-9223372036854775808"));
        // Within the safe range: a plain JSON number.
        assert_eq!(result.rows[2][0], serde_json::json!(42));
    }

    /// Convenience: pull the single-column integer/text value of a cell.
    fn req(schema: &str, table: &str, offset: u64, limit: u32) -> FetchRowsRequest {
        FetchRowsRequest {
            schema: schema.into(),
            table: table.into(),
            sort: None,
            filter: None,
            offset,
            limit,
        }
    }

    #[tokio::test]
    async fn fetch_rows_first_page_returns_rows_columns_and_exact_total() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_fixture(&dir).await;
        let page = conn
            .fetch_rows(FetchRowsRequest {
                sort: Some(SortSpec {
                    column: "id".into(),
                    direction: SortDirection::Asc,
                }),
                ..req("main", "users", 0, 10)
            })
            .await
            .expect("fetch rows");

        let column_names: Vec<&str> = page.columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(column_names, vec!["id", "name", "score", "avatar"]);
        assert_eq!(page.rows.len(), 3);
        assert_eq!(page.offset, 0);
        assert_eq!(page.limit, 10);
        assert_eq!(page.total_rows, Some(3));
        assert!(page.elapsed_ms < 60_000);
        // Values map exactly like run_query (blob → hex, null).
        assert_eq!(page.rows[0][0], serde_json::json!(1));
        assert_eq!(page.rows[0][1], serde_json::json!("ada"));
        assert_eq!(page.rows[0][3], serde_json::json!("0xc0ffee"));
        assert_eq!(page.rows[1][2], serde_json::Value::Null);
    }

    #[tokio::test]
    async fn fetch_rows_paging_returns_distinct_pages_with_stable_total() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_fixture(&dir).await;
        let sort = SortSpec {
            column: "id".into(),
            direction: SortDirection::Asc,
        };

        let page1 = conn
            .fetch_rows(FetchRowsRequest {
                sort: Some(sort.clone()),
                ..req("main", "users", 0, 2)
            })
            .await
            .expect("page 1");
        let page2 = conn
            .fetch_rows(FetchRowsRequest {
                sort: Some(sort),
                ..req("main", "users", 2, 2)
            })
            .await
            .expect("page 2");

        let ids = |p: &crate::shared::engine::RowsPage| -> Vec<serde_json::Value> {
            p.rows.iter().map(|r| r[0].clone()).collect()
        };
        assert_eq!(
            ids(&page1),
            vec![serde_json::json!(1), serde_json::json!(2)]
        );
        assert_eq!(ids(&page2), vec![serde_json::json!(3)]);
        assert_eq!(page1.total_rows, Some(3));
        assert_eq!(page2.total_rows, Some(3));
    }

    #[tokio::test]
    async fn fetch_rows_sort_asc_and_desc_use_real_order() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_fixture(&dir).await;

        // Text column ascending: ada, grace, linus.
        let asc = conn
            .fetch_rows(FetchRowsRequest {
                sort: Some(SortSpec {
                    column: "name".into(),
                    direction: SortDirection::Asc,
                }),
                ..req("main", "users", 0, 10)
            })
            .await
            .expect("asc");
        let names: Vec<serde_json::Value> = asc.rows.iter().map(|r| r[1].clone()).collect();
        assert_eq!(
            names,
            vec![
                serde_json::json!("ada"),
                serde_json::json!("grace"),
                serde_json::json!("linus")
            ]
        );

        // Numeric column descending: 3, 2, 1.
        let desc = conn
            .fetch_rows(FetchRowsRequest {
                sort: Some(SortSpec {
                    column: "id".into(),
                    direction: SortDirection::Desc,
                }),
                ..req("main", "users", 0, 10)
            })
            .await
            .expect("desc");
        let ids: Vec<serde_json::Value> = desc.rows.iter().map(|r| r[0].clone()).collect();
        assert_eq!(
            ids,
            vec![
                serde_json::json!(3),
                serde_json::json!(2),
                serde_json::json!(1)
            ]
        );
    }

    #[tokio::test]
    async fn fetch_rows_sort_by_unknown_column_is_a_human_error_listing_columns() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_fixture(&dir).await;
        let err = conn
            .fetch_rows(FetchRowsRequest {
                sort: Some(SortSpec {
                    column: "nope".into(),
                    direction: SortDirection::Asc,
                }),
                ..req("main", "users", 0, 10)
            })
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Database(_)));
        assert_eq!(
            err.to_string(),
            "Column 'nope' does not exist on 'users' (columns: id, name, score, avatar)."
        );
    }

    #[tokio::test]
    async fn fetch_rows_clamps_limit_to_the_page_ceiling() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_fixture(&dir).await;
        let page = conn
            .fetch_rows(req("main", "users", 0, u32::MAX))
            .await
            .expect("fetch rows");
        assert_eq!(page.limit, MAX_PAGE_ROWS, "limit is clamped to the ceiling");
        // The fixture has fewer rows than the ceiling, so all come back.
        assert_eq!(page.rows.len(), 3);
        assert_eq!(page.total_rows, Some(3));
    }

    #[tokio::test]
    async fn fetch_rows_empty_table_has_no_rows_and_zero_total() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_fixture(&dir).await;
        let page = conn
            .fetch_rows(req("main", "orders", 0, 100))
            .await
            .expect("fetch rows");
        assert!(page.rows.is_empty());
        assert_eq!(page.total_rows, Some(0));
        // Columns still come back from the empty result.
        let names: Vec<&str> = page.columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["id", "total"]);
    }

    #[tokio::test]
    async fn fetch_rows_unknown_table_lists_available_tables() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_fixture(&dir).await;
        let err = conn
            .fetch_rows(req("main", "customers", 0, 100))
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Database(_)));
        assert_eq!(
            err.to_string(),
            "Table 'customers' does not exist. Available tables: orders, users."
        );
    }

    #[tokio::test]
    async fn fetch_rows_unknown_schema_is_a_human_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_fixture(&dir).await;
        let err = conn
            .fetch_rows(req("warehouse", "users", 0, 100))
            .await
            .unwrap_err();
        assert_eq!(
            err.to_string(),
            "Schema 'warehouse' does not exist. Available schemas: main."
        );
    }

    /// The sort direction can only ever be the enum's `ASC`/`DESC` keyword —
    /// there is no path for a caller string to reach the ORDER BY direction.
    /// This guards the no-injection guarantee documented on `SortDirection`.
    #[tokio::test]
    async fn fetch_rows_direction_is_enum_driven_not_injectable() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_fixture(&dir).await;
        // A column name carrying a SQL-injection payload is rejected as an
        // unknown column (it is validated against the real column list)
        // rather than interpolated — the clause builder never trusts it.
        let err = conn
            .fetch_rows(FetchRowsRequest {
                sort: Some(SortSpec {
                    column: "id ASC; DROP TABLE users;--".into(),
                    direction: SortDirection::Asc,
                }),
                ..req("main", "users", 0, 10)
            })
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Database(_)));
        assert!(
            err.to_string().contains("does not exist on 'users'"),
            "injection payload must be rejected as an unknown column: {err}"
        );
        // And the table is unharmed.
        let page = conn
            .fetch_rows(req("main", "users", 0, 10))
            .await
            .expect("table still intact");
        assert_eq!(page.total_rows, Some(3));

        // The keyword mapping is fixed and total over the enum.
        assert_eq!(SortDirection::Asc.sql_keyword(), "ASC");
        assert_eq!(SortDirection::Desc.sql_keyword(), "DESC");
    }

    /// A column whose name needs quoting (embedded double quote) is handled
    /// by `quote_ident`, proving identifier quoting covers the sort column.
    #[tokio::test]
    async fn fetch_rows_sort_column_needing_quoting_is_quoted_not_broken() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("weird.db");
        {
            let conn = Connection::open(&path).expect("create db");
            conn.execute_batch(
                "CREATE TABLE t (\"a\"\"b\" INTEGER);
                 INSERT INTO t (\"a\"\"b\") VALUES (3), (1), (2);",
            )
            .expect("seed db");
        }
        let conn = SqliteConnector
            .open(&params_for(&path))
            .await
            .expect("open db")
            .into_sql()
            .expect("sql connection");
        let page = conn
            .fetch_rows(FetchRowsRequest {
                sort: Some(SortSpec {
                    column: "a\"b".into(),
                    direction: SortDirection::Asc,
                }),
                ..req("main", "t", 0, 10)
            })
            .await
            .expect("fetch rows with quoted sort column");
        let vals: Vec<serde_json::Value> = page.rows.iter().map(|r| r[0].clone()).collect();
        assert_eq!(
            vals,
            vec![
                serde_json::json!(1),
                serde_json::json!(2),
                serde_json::json!(3)
            ]
        );
    }

    // -- fetch_rows filtering (M5) ------------------------------------------

    /// A fixture exercising every filter operator: numerics for the
    /// comparisons, text for the LIKE family (including a value with a literal
    /// `%` to prove wildcard escaping), a nullable column, and an `IN` target.
    ///
    /// products(id, name, qty, price, note):
    ///   1, "Apple Pie",   10, 3.50, "fresh"
    ///   2, "Banana Bread", 5, 2.25, NULL
    ///   3, "50% Off Mug",  0, 9.99, "sale"
    ///   4, "Cherry Tart",  5, 4.00, "fresh"
    async fn open_products_fixture(
        dir: &tempfile::TempDir,
    ) -> std::sync::Arc<dyn EngineConnection> {
        let path = dir.path().join("products.db");
        {
            let conn = Connection::open(&path).expect("create db");
            conn.execute_batch(
                "CREATE TABLE products (
                     id INTEGER PRIMARY KEY,
                     name TEXT NOT NULL,
                     qty INTEGER NOT NULL,
                     price REAL NOT NULL,
                     note TEXT
                 );
                 INSERT INTO products (id, name, qty, price, note) VALUES
                     (1, 'Apple Pie',    10, 3.50, 'fresh'),
                     (2, 'Banana Bread',  5, 2.25, NULL),
                     (3, '50% Off Mug',   0, 9.99, 'sale'),
                     (4, 'Cherry Tart',   5, 4.00, 'fresh');",
            )
            .expect("seed db");
        }
        SqliteConnector
            .open(&params_for(&path))
            .await
            .expect("open products fixture")
            .into_sql()
            .expect("sql connection")
    }

    /// Build a `Some(filter)` request over `products`, sorted by id ascending
    /// for deterministic row order.
    fn filtered(items: Vec<Condition>, combinator: Combinator) -> FetchRowsRequest {
        FetchRowsRequest {
            sort: Some(SortSpec {
                column: "id".into(),
                direction: SortDirection::Asc,
            }),
            filter: Some(FilterSpec::Conditions { items, combinator }),
            ..req("main", "products", 0, 100)
        }
    }

    fn cond(column: &str, op: FilterOp, value: Option<FilterValue>) -> Condition {
        Condition {
            column: column.into(),
            op,
            value,
            binary: false,
        }
    }

    fn scalar(value: serde_json::Value) -> Option<FilterValue> {
        Some(FilterValue::Scalar(value))
    }

    /// Collect the `id` column (first column) of a page.
    fn ids(page: &RowsPage) -> Vec<i64> {
        page.rows
            .iter()
            .map(|r| r[0].as_i64().expect("id is an integer"))
            .collect()
    }

    #[tokio::test]
    async fn filter_eq_and_ne_on_numeric() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_products_fixture(&dir).await;

        let eq = conn
            .fetch_rows(filtered(
                vec![cond("qty", FilterOp::Eq, scalar(serde_json::json!(5)))],
                Combinator::And,
            ))
            .await
            .expect("eq");
        assert_eq!(ids(&eq), vec![2, 4]);
        assert_eq!(eq.total_rows, Some(2));

        let ne = conn
            .fetch_rows(filtered(
                vec![cond("qty", FilterOp::Ne, scalar(serde_json::json!(5)))],
                Combinator::And,
            ))
            .await
            .expect("ne");
        assert_eq!(ids(&ne), vec![1, 3]);
    }

    #[tokio::test]
    async fn filter_ordered_comparisons_on_numeric() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_products_fixture(&dir).await;

        let gt = conn
            .fetch_rows(filtered(
                vec![cond("price", FilterOp::Gt, scalar(serde_json::json!(3.50)))],
                Combinator::And,
            ))
            .await
            .expect("gt");
        assert_eq!(ids(&gt), vec![3, 4]);

        let gte = conn
            .fetch_rows(filtered(
                vec![cond(
                    "price",
                    FilterOp::Gte,
                    scalar(serde_json::json!(3.50)),
                )],
                Combinator::And,
            ))
            .await
            .expect("gte");
        assert_eq!(ids(&gte), vec![1, 3, 4]);

        let lt = conn
            .fetch_rows(filtered(
                vec![cond("qty", FilterOp::Lt, scalar(serde_json::json!(5)))],
                Combinator::And,
            ))
            .await
            .expect("lt");
        assert_eq!(ids(&lt), vec![3]);

        let lte = conn
            .fetch_rows(filtered(
                vec![cond("qty", FilterOp::Lte, scalar(serde_json::json!(5)))],
                Combinator::And,
            ))
            .await
            .expect("lte");
        assert_eq!(ids(&lte), vec![2, 3, 4]);
    }

    #[tokio::test]
    async fn filter_like_family_on_text() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_products_fixture(&dir).await;

        let contains = conn
            .fetch_rows(filtered(
                vec![cond(
                    "name",
                    FilterOp::Contains,
                    scalar(serde_json::json!("an")),
                )],
                Combinator::And,
            ))
            .await
            .expect("contains");
        // "Banana Bread" contains "an"; nothing else does.
        assert_eq!(ids(&contains), vec![2]);

        let not_contains = conn
            .fetch_rows(filtered(
                vec![cond(
                    "name",
                    FilterOp::NotContains,
                    scalar(serde_json::json!("an")),
                )],
                Combinator::And,
            ))
            .await
            .expect("notContains");
        assert_eq!(ids(&not_contains), vec![1, 3, 4]);

        let begins = conn
            .fetch_rows(filtered(
                vec![cond(
                    "name",
                    FilterOp::BeginsWith,
                    scalar(serde_json::json!("C")),
                )],
                Combinator::And,
            ))
            .await
            .expect("beginsWith");
        assert_eq!(ids(&begins), vec![4]);

        let ends = conn
            .fetch_rows(filtered(
                vec![cond(
                    "name",
                    FilterOp::EndsWith,
                    scalar(serde_json::json!("Mug")),
                )],
                Combinator::And,
            ))
            .await
            .expect("endsWith");
        assert_eq!(ids(&ends), vec![3]);
    }

    /// A `contains` value containing a literal `%` must match the `%`
    /// literally, not as a wildcard — proving LIKE-wildcard escaping.
    #[tokio::test]
    async fn filter_contains_escapes_literal_wildcard() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_products_fixture(&dir).await;

        // "%" as a wildcard would match every row; escaped it matches only
        // the row whose name literally contains "%": "50% Off Mug".
        let literal = conn
            .fetch_rows(filtered(
                vec![cond(
                    "name",
                    FilterOp::Contains,
                    scalar(serde_json::json!("%")),
                )],
                Combinator::And,
            ))
            .await
            .expect("contains literal %");
        assert_eq!(ids(&literal), vec![3]);
        assert_eq!(literal.total_rows, Some(1));

        // And the underscore is likewise literal: no row contains "_", so the
        // result is empty rather than "any single character".
        let underscore = conn
            .fetch_rows(filtered(
                vec![cond(
                    "name",
                    FilterOp::Contains,
                    scalar(serde_json::json!("_")),
                )],
                Combinator::And,
            ))
            .await
            .expect("contains literal _");
        assert!(underscore.rows.is_empty());
    }

    #[tokio::test]
    async fn filter_in_list() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_products_fixture(&dir).await;

        let page = conn
            .fetch_rows(filtered(
                vec![cond(
                    "id",
                    FilterOp::InList,
                    Some(FilterValue::List(vec![
                        serde_json::json!(1),
                        serde_json::json!(3),
                    ])),
                )],
                Combinator::And,
            ))
            .await
            .expect("inList");
        assert_eq!(ids(&page), vec![1, 3]);
        assert_eq!(page.total_rows, Some(2));
    }

    #[tokio::test]
    async fn filter_is_null_and_is_not_null() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_products_fixture(&dir).await;

        let is_null = conn
            .fetch_rows(filtered(
                vec![cond("note", FilterOp::IsNull, None)],
                Combinator::And,
            ))
            .await
            .expect("isNull");
        assert_eq!(ids(&is_null), vec![2]);

        let not_null = conn
            .fetch_rows(filtered(
                vec![cond("note", FilterOp::IsNotNull, None)],
                Combinator::And,
            ))
            .await
            .expect("isNotNull");
        assert_eq!(ids(&not_null), vec![1, 3, 4]);
    }

    #[tokio::test]
    async fn filter_and_combined_multi_condition() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_products_fixture(&dir).await;

        // qty = 5 AND note = 'fresh' → only Cherry Tart (id 4); Banana Bread
        // (id 2) has qty 5 but a NULL note.
        let page = conn
            .fetch_rows(filtered(
                vec![
                    cond("qty", FilterOp::Eq, scalar(serde_json::json!(5))),
                    cond("note", FilterOp::Eq, scalar(serde_json::json!("fresh"))),
                ],
                Combinator::And,
            ))
            .await
            .expect("and-combined");
        assert_eq!(ids(&page), vec![4]);
        assert_eq!(page.total_rows, Some(1));
    }

    #[tokio::test]
    async fn filter_or_combined_multi_condition() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_products_fixture(&dir).await;

        // qty = 0 OR price >= 4.00 → ids 3 (qty 0) and 4 (price 4.00); 3 also
        // satisfies the price clause. Deduped by row, sorted by id.
        let page = conn
            .fetch_rows(filtered(
                vec![
                    cond("qty", FilterOp::Eq, scalar(serde_json::json!(0))),
                    cond("price", FilterOp::Gte, scalar(serde_json::json!(4.00))),
                ],
                Combinator::Or,
            ))
            .await
            .expect("or-combined");
        assert_eq!(ids(&page), vec![3, 4]);
    }

    #[tokio::test]
    async fn filter_total_rows_reflects_the_filter() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_products_fixture(&dir).await;
        // Page size of 1 over a 2-row filtered set: total_rows is the FILTERED
        // count (2), not the table's 4 — this drives "n of N rows".
        let page = conn
            .fetch_rows(FetchRowsRequest {
                sort: Some(SortSpec {
                    column: "id".into(),
                    direction: SortDirection::Asc,
                }),
                filter: Some(FilterSpec::Conditions {
                    items: vec![cond("qty", FilterOp::Eq, scalar(serde_json::json!(5)))],
                    combinator: Combinator::And,
                }),
                ..req("main", "products", 0, 1)
            })
            .await
            .expect("filtered page");
        assert_eq!(page.rows.len(), 1, "page is limited to 1 row");
        assert_eq!(page.total_rows, Some(2), "total is the filtered count");
    }

    #[tokio::test]
    async fn filter_unknown_column_is_a_human_error_listing_columns() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_products_fixture(&dir).await;
        let err = conn
            .fetch_rows(filtered(
                vec![cond("nope", FilterOp::Eq, scalar(serde_json::json!(1)))],
                Combinator::And,
            ))
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Database(_)));
        assert_eq!(
            err.to_string(),
            "Column 'nope' does not exist on 'products' (columns: id, name, qty, price, note)."
        );
    }

    #[tokio::test]
    async fn filter_eq_with_null_value_tells_user_to_use_is_null() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_products_fixture(&dir).await;
        let err = conn
            .fetch_rows(filtered(
                vec![cond("note", FilterOp::Eq, scalar(serde_json::Value::Null))],
                Combinator::And,
            ))
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Database(_)));
        assert_eq!(
            err.to_string(),
            "Use IS NULL / IS NOT NULL to compare with NULL."
        );
    }

    #[tokio::test]
    async fn filter_comparison_without_value_is_a_human_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_products_fixture(&dir).await;
        let err = conn
            .fetch_rows(filtered(
                vec![cond("qty", FilterOp::Eq, None)],
                Combinator::And,
            ))
            .await
            .unwrap_err();
        assert_eq!(err.to_string(), "The filter on 'qty' needs a value.");
    }

    /// SECURITY: a structured condition value is *bound*, never interpolated.
    /// A classic injection payload binds as a literal string that matches
    /// nothing — the table survives and the result is empty.
    #[tokio::test]
    async fn filter_value_with_injection_payload_is_bound_as_a_literal() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_products_fixture(&dir).await;

        let page = conn
            .fetch_rows(filtered(
                vec![cond(
                    "name",
                    FilterOp::Eq,
                    scalar(serde_json::json!("'; DROP TABLE products; --")),
                )],
                Combinator::And,
            ))
            .await
            .expect("injection payload binds as a literal, no error");
        assert!(page.rows.is_empty(), "literal matches no row");
        assert_eq!(page.total_rows, Some(0));

        // The table is unharmed: a plain fetch still sees all 4 rows.
        let intact = conn
            .fetch_rows(req("main", "products", 0, 100))
            .await
            .expect("table still intact");
        assert_eq!(intact.total_rows, Some(4));
    }

    #[tokio::test]
    async fn filter_raw_mode_applies_a_valid_where_body() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_products_fixture(&dir).await;
        let page = conn
            .fetch_rows(FetchRowsRequest {
                sort: Some(SortSpec {
                    column: "id".into(),
                    direction: SortDirection::Asc,
                }),
                filter: Some(FilterSpec::Raw {
                    sql: "qty = 5 OR price > 9".into(),
                }),
                ..req("main", "products", 0, 100)
            })
            .await
            .expect("raw where");
        // qty = 5 → ids 2, 4; price > 9 → id 3. Combined and id-sorted.
        assert_eq!(ids(&page), vec![2, 3, 4]);
        assert_eq!(page.total_rows, Some(3));
    }

    #[tokio::test]
    async fn filter_raw_mode_invalid_where_is_a_human_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_products_fixture(&dir).await;
        let err = conn
            .fetch_rows(FetchRowsRequest {
                filter: Some(FilterSpec::Raw {
                    sql: "nope = 1".into(),
                }),
                ..req("main", "products", 0, 100)
            })
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Database(_)));
        // A bad raw clause surfaces as a cleaned §5 driver message, not a Rust
        // error chain.
        let message = err.to_string();
        assert!(
            message.contains("nope"),
            "expected the offending column in the message, got {message:?}"
        );
        assert!(
            !message.contains("rusqlite") && !message.contains("Error {"),
            "driver chains must not leak: {message:?}"
        );
    }

    #[tokio::test]
    async fn filter_empty_conditions_returns_the_whole_table() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_products_fixture(&dir).await;
        let page = conn
            .fetch_rows(FetchRowsRequest {
                filter: Some(FilterSpec::Conditions {
                    items: vec![],
                    combinator: Combinator::And,
                }),
                ..req("main", "products", 0, 100)
            })
            .await
            .expect("empty conditions");
        assert_eq!(page.total_rows, Some(4));
    }

    /// A fixture for FK peek + stats: an `authors` parent (unique pk + a
    /// non-unique `country`) and a `books` child referencing it.
    ///
    /// authors(id, name, country):
    ///   1, "Ada",   "UK"
    ///   2, "Linus", "FI"
    ///   3, "Grace", "US"
    async fn open_fk_fixture(dir: &tempfile::TempDir) -> std::sync::Arc<dyn EngineConnection> {
        let path = dir.path().join("fk.db");
        {
            let conn = Connection::open(&path).expect("create db");
            conn.execute_batch(
                "CREATE TABLE authors (
                     id INTEGER PRIMARY KEY,
                     name TEXT NOT NULL,
                     country TEXT
                 );
                 INSERT INTO authors (id, name, country) VALUES
                     (1, 'Ada', 'UK'),
                     (2, 'Linus', 'FI'),
                     (3, 'Grace', 'US');
                 CREATE TABLE books (
                     id INTEGER PRIMARY KEY,
                     author_id INTEGER REFERENCES authors(id),
                     title TEXT
                 );",
            )
            .expect("seed db");
        }
        SqliteConnector
            .open(&params_for(&path))
            .await
            .expect("open fk fixture")
            .into_sql()
            .expect("sql connection")
    }

    fn lookup(table: &str, column: &str, value: serde_json::Value) -> RowLookupRequest {
        RowLookupRequest {
            schema: "main".into(),
            table: table.into(),
            column: column.into(),
            value,
            binary: false,
        }
    }

    #[tokio::test]
    async fn row_lookup_unique_key_returns_one_row_and_match_count_one() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_fk_fixture(&dir).await;
        let found = conn
            .fetch_row_by_key(lookup("authors", "id", serde_json::json!(2)))
            .await
            .expect("lookup");
        // Columns always returned for field labels.
        let names: Vec<&str> = found.columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["id", "name", "country"]);
        let row = found.row.expect("a matching row");
        assert_eq!(row[0], serde_json::json!(2));
        assert_eq!(row[1], serde_json::json!("Linus"));
        assert_eq!(found.match_count, 1);
    }

    #[tokio::test]
    async fn row_lookup_no_match_returns_none_and_zero_with_columns() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_fk_fixture(&dir).await;
        let miss = conn
            .fetch_row_by_key(lookup("authors", "id", serde_json::json!(999)))
            .await
            .expect("lookup");
        assert_eq!(miss.row, None);
        assert_eq!(miss.match_count, 0);
        // Columns are still returned so the UI can label empty fields.
        assert_eq!(miss.columns.len(), 3);
    }

    #[tokio::test]
    async fn row_lookup_non_unique_value_returns_first_row_and_total_count() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("dupes.db");
        {
            let conn = Connection::open(&path).expect("create db");
            conn.execute_batch(
                "CREATE TABLE tags (id INTEGER PRIMARY KEY, label TEXT);
                 INSERT INTO tags (id, label) VALUES (1, 'x'), (2, 'x'), (3, 'y');",
            )
            .expect("seed db");
        }
        let conn = SqliteConnector
            .open(&params_for(&path))
            .await
            .expect("open db")
            .into_sql()
            .expect("sql connection");
        let found = conn
            .fetch_row_by_key(lookup("tags", "label", serde_json::json!("x")))
            .await
            .expect("lookup");
        let row = found.row.expect("a matching row");
        // LIMIT 1 returns the first match; count reports the full total.
        assert_eq!(row[1], serde_json::json!("x"));
        assert_eq!(found.match_count, 2, "non-unique key reports the total");
    }

    #[tokio::test]
    async fn row_lookup_text_key_works() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_fk_fixture(&dir).await;
        let found = conn
            .fetch_row_by_key(lookup("authors", "name", serde_json::json!("Grace")))
            .await
            .expect("lookup");
        let row = found.row.expect("a matching row");
        assert_eq!(row[0], serde_json::json!(3));
        assert_eq!(found.match_count, 1);
    }

    #[tokio::test]
    async fn row_lookup_null_value_is_a_clean_miss() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_fk_fixture(&dir).await;
        // A null key never matches `=` in SQL — short-circuits to a miss
        // (columns still returned) without an error.
        let miss = conn
            .fetch_row_by_key(lookup("authors", "country", serde_json::Value::Null))
            .await
            .expect("null lookup is a clean miss, not an error");
        assert_eq!(miss.row, None);
        assert_eq!(miss.match_count, 0);
        assert_eq!(miss.columns.len(), 3);
    }

    #[tokio::test]
    async fn row_lookup_unknown_column_is_a_human_error_listing_columns() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_fk_fixture(&dir).await;
        let err = conn
            .fetch_row_by_key(lookup("authors", "nope", serde_json::json!(1)))
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Database(_)));
        assert_eq!(
            err.to_string(),
            "Column 'nope' does not exist on 'authors' (columns: id, name, country)."
        );
    }

    #[tokio::test]
    async fn row_lookup_unknown_table_lists_available_tables() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_fk_fixture(&dir).await;
        let err = conn
            .fetch_row_by_key(lookup("customers", "id", serde_json::json!(1)))
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Database(_)));
        assert!(err.to_string().contains("does not exist"));
    }

    /// SECURITY: the lookup value is *bound*, never interpolated. An injection
    /// payload binds as a literal that matches nothing — the table survives.
    #[tokio::test]
    async fn row_lookup_value_with_injection_payload_is_bound_as_a_literal() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_fk_fixture(&dir).await;
        let miss = conn
            .fetch_row_by_key(lookup(
                "authors",
                "name",
                serde_json::json!("'; DROP TABLE authors; --"),
            ))
            .await
            .expect("injection payload binds as a literal, no error");
        assert_eq!(miss.row, None);
        assert_eq!(miss.match_count, 0);
        // The table is unharmed: a known key still resolves.
        let intact = conn
            .fetch_row_by_key(lookup("authors", "id", serde_json::json!(1)))
            .await
            .expect("table still intact");
        assert_eq!(intact.match_count, 1);
    }

    // -- column_stats (M10 column insights) ---------------------------------

    fn stats_req(table: &str, column: &str, filter: Option<FilterSpec>) -> ColumnStatsRequest {
        ColumnStatsRequest {
            schema: "main".into(),
            table: table.into(),
            column: column.into(),
            filter,
        }
    }

    #[tokio::test]
    async fn column_stats_numeric_column_reports_aggregates_and_top() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_products_fixture(&dir).await;
        // products.qty: 10, 5, 0, 5 — distinct 3, no nulls, min 0, max 10,
        // avg 5.0, most frequent 5 (twice).
        let stats = conn
            .column_stats(stats_req("products", "qty", None))
            .await
            .expect("stats");
        assert_eq!(stats.total, 4);
        assert_eq!(stats.distinct, 3);
        assert_eq!(stats.nulls, 0);
        assert_eq!(stats.min, Some(serde_json::json!(0)));
        assert_eq!(stats.max, Some(serde_json::json!(10)));
        assert_eq!(stats.avg, Some(5.0));
        assert!(stats.numeric, "an all-integer column is numeric");
        // Top-5 most frequent: 5 (×2) leads, then 0/10 (×1 each, value-ordered).
        assert_eq!(stats.top[0].value, serde_json::json!(5));
        assert_eq!(stats.top[0].count, 2);
        assert_eq!(stats.top.len(), 3);
    }

    #[tokio::test]
    async fn column_stats_text_column_is_not_numeric_with_lexicographic_minmax() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_products_fixture(&dir).await;
        // products.name: 4 distinct strings, no nulls.
        let stats = conn
            .column_stats(stats_req("products", "name", None))
            .await
            .expect("stats");
        assert_eq!(stats.total, 4);
        assert_eq!(stats.distinct, 4);
        assert_eq!(stats.nulls, 0);
        assert!(!stats.numeric, "a text column is not numeric");
        assert_eq!(stats.avg, None, "avg is None for non-numeric");
        // Lexicographic min/max ('5' < 'A' < 'B' < 'C' by ASCII).
        assert_eq!(stats.min, Some(serde_json::json!("50% Off Mug")));
        assert_eq!(stats.max, Some(serde_json::json!("Cherry Tart")));
        // Each name appears once → top-5 has up to 4 entries.
        assert_eq!(stats.top.len(), 4);
        assert!(stats.top.iter().all(|e| e.count == 1));
    }

    #[tokio::test]
    async fn column_stats_nullable_column_counts_nulls() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_products_fixture(&dir).await;
        // products.note: 'fresh','fresh','sale', NULL → total 4, nulls 1,
        // distinct 2 (NULLs excluded), top 'fresh' (×2).
        let stats = conn
            .column_stats(stats_req("products", "note", None))
            .await
            .expect("stats");
        assert_eq!(stats.total, 4);
        assert_eq!(stats.nulls, 1);
        assert_eq!(stats.distinct, 2);
        assert_eq!(stats.top[0].value, serde_json::json!("fresh"));
        assert_eq!(stats.top[0].count, 2);
    }

    #[tokio::test]
    async fn column_stats_all_null_column_has_no_min_max_or_distinct() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("allnull.db");
        {
            let conn = Connection::open(&path).expect("create db");
            conn.execute_batch(
                "CREATE TABLE t (id INTEGER PRIMARY KEY, note TEXT);
                 INSERT INTO t (id, note) VALUES (1, NULL), (2, NULL), (3, NULL);",
            )
            .expect("seed db");
        }
        let conn = SqliteConnector
            .open(&params_for(&path))
            .await
            .expect("open db")
            .into_sql()
            .expect("sql connection");
        let stats = conn
            .column_stats(stats_req("t", "note", None))
            .await
            .expect("stats");
        assert_eq!(stats.total, 3);
        assert_eq!(stats.nulls, 3);
        assert_eq!(stats.distinct, 0);
        assert_eq!(stats.min, None);
        assert_eq!(stats.max, None);
        assert_eq!(stats.avg, None);
        assert!(!stats.numeric, "an all-null column is not numeric");
        assert!(stats.top.is_empty());
    }

    #[tokio::test]
    async fn column_stats_respects_the_filter() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_products_fixture(&dir).await;
        // Filter to note = 'fresh' (ids 1 and 4): qty over that subset is
        // 10 and 5 → total 2, distinct 2, avg 7.5, min 5, max 10.
        let filter = FilterSpec::Conditions {
            items: vec![Condition {
                column: "note".into(),
                op: FilterOp::Eq,
                value: Some(FilterValue::Scalar(serde_json::json!("fresh"))),
                binary: false,
            }],
            combinator: Combinator::And,
        };
        let stats = conn
            .column_stats(stats_req("products", "qty", Some(filter)))
            .await
            .expect("filtered stats");
        assert_eq!(stats.total, 2, "stats reflect only the filtered rows");
        assert_eq!(stats.distinct, 2);
        assert_eq!(stats.nulls, 0);
        assert_eq!(stats.min, Some(serde_json::json!(5)));
        assert_eq!(stats.max, Some(serde_json::json!(10)));
        assert_eq!(stats.avg, Some(7.5));
        assert!(stats.numeric);
    }

    /// SECURITY: a filter value is bound, never interpolated — even when the
    /// stats reuse the same `where_clause` compilation. An injection payload
    /// matches nothing, so the filtered set is empty and the table survives.
    #[tokio::test]
    async fn column_stats_filter_injection_payload_is_inert() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_products_fixture(&dir).await;
        let filter = FilterSpec::Conditions {
            items: vec![Condition {
                column: "name".into(),
                op: FilterOp::Eq,
                value: Some(FilterValue::Scalar(serde_json::json!(
                    "'; DROP TABLE products; --"
                ))),
                binary: false,
            }],
            combinator: Combinator::And,
        };
        let stats = conn
            .column_stats(stats_req("products", "qty", Some(filter)))
            .await
            .expect("injection payload binds as a literal, no error");
        assert_eq!(stats.total, 0, "no row matches the literal payload");
        // The table is unharmed: an unfiltered scan still sees all 4 rows.
        let intact = conn
            .column_stats(stats_req("products", "qty", None))
            .await
            .expect("table still intact");
        assert_eq!(intact.total, 4);
    }

    #[tokio::test]
    async fn column_stats_unknown_column_is_a_human_error_listing_columns() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_products_fixture(&dir).await;
        let err = conn
            .column_stats(stats_req("products", "nope", None))
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Database(_)));
        assert_eq!(
            err.to_string(),
            "Column 'nope' does not exist on 'products' (columns: id, name, qty, price, note)."
        );
    }

    #[tokio::test]
    async fn column_stats_empty_table_reports_zero_total() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_fixture(&dir).await;
        // `orders` is empty.
        let stats = conn
            .column_stats(stats_req("orders", "total", None))
            .await
            .expect("stats");
        assert_eq!(stats.total, 0);
        assert_eq!(stats.distinct, 0);
        assert_eq!(stats.nulls, 0);
        assert_eq!(stats.min, None);
        assert_eq!(stats.max, None);
        assert_eq!(stats.avg, None);
        assert!(!stats.numeric, "an empty set has no numeric values");
        assert!(stats.top.is_empty());
    }

    #[tokio::test]
    async fn column_stats_real_column_is_numeric() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_products_fixture(&dir).await;
        // products.price holds reals → numeric, avg meaningful.
        let stats = conn
            .column_stats(stats_req("products", "price", None))
            .await
            .expect("stats");
        assert!(stats.numeric, "a REAL column is numeric");
        assert_eq!(stats.min, Some(serde_json::json!(2.25)));
        assert_eq!(stats.max, Some(serde_json::json!(9.99)));
        assert!(stats.avg.is_some());
    }
}
