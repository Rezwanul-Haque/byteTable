//! SQLite engine adapter: implements the shared `Connector` /
//! `EngineConnection` ports with `rusqlite` (bundled SQLite).
//!
//! # Threading model
//!
//! `rusqlite::Connection` is synchronous and `!Sync`, so it lives behind
//! `Arc<std::sync::Mutex<…>>` and **every** operation hops through
//! `tokio::task::spawn_blocking` — async executor threads never block on
//! SQLite work (Tauri's async runtime is tokio). The mutex serializes
//! operations per connection, which matches SQLite's own single-writer
//! nature.
//!
//! # Documented choices (M2)
//!
//! - Opening uses `READ_WRITE` *without* `CREATE`: a typo'd path must fail,
//!   never silently create an empty database. A missing or non-database file
//!   produces a human message per DESIGN_SPEC §5.
//! - Row counts are exact `SELECT count(*)` per table — cheap enough for the
//!   local files M2 targets. Counting stops after
//!   [`MAX_COUNTED_TABLES`] tables (remaining tables get `None`) so a
//!   pathological schema cannot stall introspection; M3 revisits caching.
//! - Integers whose magnitude exceeds 2^53 − 1 (JavaScript's
//!   `Number.MAX_SAFE_INTEGER`) map to JSON strings, not numbers — the
//!   renderer would otherwise round them on parse. See
//!   [`JS_MAX_SAFE_INTEGER`].
//! - BLOB values map to the placeholder string `"[blob N bytes]"` rather
//!   than base64: the renderer has no blob viewer yet, and shipping
//!   megabytes of base64 across IPC for a grid cell helps no one. A real
//!   blob inspector (then base64 or a side channel) is a later milestone.
//! - `QueryOptions::schema` is advisory for SQLite (see the port docs):
//!   unqualified names resolve per SQLite's rules across `main` + attached.
//! - `run_query` executes whatever SQL it is given (read/write contexts are
//!   M6's job) but always enforces `row_limit`, reading one extra row to set
//!   `truncated`.
//!
//! # Documented choices (M3, `table_meta`)
//!
//! - Column metadata comes from `PRAGMA "schema".table_info("table")` and
//!   `PRAGMA "schema".foreign_key_list("table")` — no parsing of DDL text.
//! - `nullable` is the raw declared constraint (`notnull == 0`): SQLite does
//!   not set the flag for bare `PRIMARY KEY` columns (and, by a documented
//!   legacy quirk, non-INTEGER primary keys really can hold NULLs), so
//!   "nullable" here means "no NOT NULL constraint declared".
//! - `foreign_key_list` reports `to` as NULL for the implicit form
//!   `REFERENCES t` (no column list). We resolve it to the referenced
//!   table's primary-key column at the fk's `seq` position (same schema —
//!   SQLite fks never cross databases); when that fails (referenced table
//!   missing or without a declared pk) the column falls back to an **empty
//!   string** — an honest "unknown" beats guessing "id".
//! - A column appearing in several foreign keys keeps the first one
//!   `foreign_key_list` reports; `ColumnInfo.fk` is a single ref by design
//!   (sidebar icon + tooltip), M7's structure view gets the full list.
//! - `PRAGMA table_info` returns zero rows (not an error) for an unknown
//!   table, so existence is checked against `sqlite_schema` first to produce
//!   the §5 "Table 'x' does not exist. Available tables: …" message.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use async_trait::async_trait;
use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags};

use rusqlite::types::Value as SqlValue;

use crate::shared::engine::{
    ColumnInfo, ColumnMeta, Condition, ConnectionParams, Connector, Engine, EngineConnection,
    EngineInfo, FetchRowsRequest, FilterOp, FilterSpec, FilterValue, FkRef, QueryOptions,
    QueryResult, RowsPage, SchemaInfo, SortSpec, TableInfo, TableMeta,
};
use crate::shared::error::AppError;

/// Stop running per-table `count(*)` after this many tables; the rest get
/// `approx_row_count: None`. Keeps introspection bounded on huge schemas.
const MAX_COUNTED_TABLES: usize = 200;

/// Page-size ceiling for `fetch_rows` (the M4 data grid). Mirrors the
/// connections slice's `MAX_ROW_LIMIT` (10 000): a single grid page never
/// usefully shows more, and the clamp keeps a renderer bug or a hand-crafted
/// invoke from marshalling an unbounded page across IPC.
const MAX_PAGE_ROWS: u32 = 10_000;

/// JavaScript's `Number.MAX_SAFE_INTEGER` (2^53 − 1). SQLite integers whose
/// magnitude exceeds this serialize as JSON *strings* — a JSON number would
/// silently lose precision the moment the renderer parses it into a `number`.
const JS_MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// Opens SQLite database files. Stateless; registered once in `lib.rs`.
pub struct SqliteConnector;

#[async_trait]
impl Connector for SqliteConnector {
    async fn test(&self, params: &ConnectionParams) -> Result<EngineInfo, AppError> {
        let path = sqlite_path(params)?;
        run_blocking(move || open_validated(&path).map(|_| sqlite_engine_info())).await
    }

    async fn open(&self, params: &ConnectionParams) -> Result<Box<dyn EngineConnection>, AppError> {
        let path = sqlite_path(params)?;
        let connection = run_blocking(move || open_validated(&path)).await?;
        Ok(Box::new(SqliteEngineConnection {
            conn: Arc::new(Mutex::new(connection)),
            info: sqlite_engine_info(),
        }))
    }
}

/// One open SQLite database file.
pub struct SqliteEngineConnection {
    conn: Arc<Mutex<Connection>>,
    info: EngineInfo,
}

#[async_trait]
impl EngineConnection for SqliteEngineConnection {
    fn engine_info(&self) -> EngineInfo {
        self.info.clone()
    }

    async fn list_schemas(&self) -> Result<Vec<SchemaInfo>, AppError> {
        self.with_conn(list_schemas_blocking).await
    }

    async fn list_tables(&self, schema: &str) -> Result<Vec<TableInfo>, AppError> {
        let schema = schema.to_string();
        self.with_conn(move |conn| list_tables_blocking(conn, &schema))
            .await
    }

    async fn table_meta(&self, schema: &str, table: &str) -> Result<TableMeta, AppError> {
        let schema = schema.to_string();
        let table = table.to_string();
        self.with_conn(move |conn| table_meta_blocking(conn, &schema, &table))
            .await
    }

    async fn run_query(&self, sql: &str, options: QueryOptions) -> Result<QueryResult, AppError> {
        let sql = sql.to_string();
        self.with_conn(move |conn| run_query_blocking(conn, &sql, &options))
            .await
    }

    async fn fetch_rows(&self, req: FetchRowsRequest) -> Result<RowsPage, AppError> {
        self.with_conn(move |conn| fetch_rows_blocking(conn, &req))
            .await
    }

    async fn close(&self) -> Result<(), AppError> {
        // rusqlite closes on drop; the manager dropping its Arc is the real
        // teardown. This hook exists for engines that need an explicit
        // goodbye (server engines, M12).
        Ok(())
    }
}

impl SqliteEngineConnection {
    /// Run `f` against the connection on the blocking pool.
    async fn with_conn<T, F>(&self, f: F) -> Result<T, AppError>
    where
        T: Send + 'static,
        F: FnOnce(&Connection) -> Result<T, AppError> + Send + 'static,
    {
        let conn = Arc::clone(&self.conn);
        run_blocking(move || {
            let guard = conn.lock().map_err(|_| {
                AppError::Database(
                    "The connection is in a broken state after an earlier crash; \
                     close and reopen it."
                        .into(),
                )
            })?;
            f(&guard)
        })
        .await
    }
}

/// Hop to tokio's blocking pool and flatten the join error.
async fn run_blocking<T, F>(f: F) -> Result<T, AppError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, AppError> + Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|err| AppError::Database(format!("A background database task failed: {err}.")))?
}

// ---------------------------------------------------------------------------
// Blocking implementations (the only place SQLite-specific SQL exists)
// ---------------------------------------------------------------------------

fn sqlite_path(params: &ConnectionParams) -> Result<String, AppError> {
    match params {
        ConnectionParams::Sqlite { path } => Ok(path.clone()),
        other => Err(AppError::Invalid(format!(
            "the SQLite connector received {} parameters",
            other.engine().display_name()
        ))),
    }
}

fn sqlite_engine_info() -> EngineInfo {
    EngineInfo {
        engine: Engine::Sqlite,
        server_version: format!("SQLite {}", rusqlite::version()),
    }
}

/// Open the file and prove it is a real SQLite database, with §5-style
/// errors for the two common failure modes (missing file, not a database).
fn open_validated(path: &str) -> Result<Connection, AppError> {
    if !Path::new(path).is_file() {
        return Err(AppError::Database(format!(
            "SQLite database file '{path}' does not exist."
        )));
    }
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|err| map_open_error(path, err))?;
    // SQLite opens lazily; force a header read so a non-database file fails
    // here, with a clear message, instead of on the first introspection call.
    conn.query_row("SELECT count(*) FROM sqlite_schema", [], |_| Ok(()))
        .map_err(|err| map_open_error(path, err))?;
    Ok(conn)
}

fn map_open_error(path: &str, err: rusqlite::Error) -> AppError {
    if let rusqlite::Error::SqliteFailure(failure, _) = &err {
        match failure.code {
            rusqlite::ErrorCode::NotADatabase => {
                return AppError::Database(format!("'{path}' is not a SQLite database file."));
            }
            rusqlite::ErrorCode::CannotOpen => {
                return AppError::Database(format!(
                    "SQLite database file '{path}' could not be opened."
                ));
            }
            rusqlite::ErrorCode::PermissionDenied => {
                return AppError::Database(format!(
                    "Permission denied opening SQLite database file '{path}'."
                ));
            }
            _ => {}
        }
    }
    AppError::Database(format!(
        "Could not open '{path}': {}.",
        driver_message(&err)
    ))
}

fn list_schemas_blocking(conn: &Connection) -> Result<Vec<SchemaInfo>, AppError> {
    let names = schema_names(conn)?;
    let mut schemas = Vec::with_capacity(names.len());
    for name in names {
        // Best effort: a count failure (e.g. detached race) downgrades to
        // None rather than failing the whole listing.
        let table_count = count_tables(conn, &name).ok();
        schemas.push(SchemaInfo { name, table_count });
    }
    Ok(schemas)
}

fn schema_names(conn: &Connection) -> Result<Vec<String>, AppError> {
    let mut stmt = conn
        .prepare("PRAGMA database_list")
        .map_err(|err| map_query_error(conn, err))?;
    let names = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .and_then(Iterator::collect::<Result<Vec<String>, _>>)
        .map_err(|err| map_query_error(conn, err))?;
    Ok(names)
}

fn count_tables(conn: &Connection, schema: &str) -> Result<u64, rusqlite::Error> {
    conn.query_row(
        &format!(
            "SELECT count(*) FROM {}.sqlite_schema \
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
            quote_ident(schema)
        ),
        [],
        |row| row.get(0),
    )
}

/// Fail with the §5 "Schema 'x' does not exist…" message unless `schema` is
/// one of the connection's databases.
fn ensure_schema_exists(conn: &Connection, schema: &str) -> Result<(), AppError> {
    let schemas = schema_names(conn)?;
    if schemas.iter().any(|s| s == schema) {
        Ok(())
    } else {
        Err(AppError::Database(format!(
            "Schema '{schema}' does not exist. Available schemas: {}.",
            schemas.join(", ")
        )))
    }
}

fn list_tables_blocking(conn: &Connection, schema: &str) -> Result<Vec<TableInfo>, AppError> {
    ensure_schema_exists(conn, schema)?;

    let mut stmt = conn
        .prepare(&format!(
            "SELECT name FROM {}.sqlite_schema \
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
            quote_ident(schema)
        ))
        .map_err(|err| map_query_error(conn, err))?;
    let names = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .and_then(Iterator::collect::<Result<Vec<String>, _>>)
        .map_err(|err| map_query_error(conn, err))?;

    let mut tables = Vec::with_capacity(names.len());
    for (index, name) in names.into_iter().enumerate() {
        let approx_row_count = if index < MAX_COUNTED_TABLES {
            // Best effort: a failed count is None, not a failed listing.
            conn.query_row(
                &format!(
                    "SELECT count(*) FROM {}.{}",
                    quote_ident(schema),
                    quote_ident(&name)
                ),
                [],
                |row| row.get::<_, u64>(0),
            )
            .ok()
        } else {
            None
        };
        tables.push(TableInfo {
            name,
            approx_row_count,
        });
    }
    Ok(tables)
}

fn table_meta_blocking(
    conn: &Connection,
    schema: &str,
    table: &str,
) -> Result<TableMeta, AppError> {
    ensure_schema_exists(conn, schema)?;

    // `PRAGMA table_info` returns zero rows for an unknown table instead of
    // erroring, so prove existence first to get the §5 message (see module
    // docs).
    let exists: i64 = conn
        .query_row(
            &format!(
                "SELECT count(*) FROM {}.sqlite_schema WHERE type = 'table' AND name = ?1",
                quote_ident(schema)
            ),
            [table],
            |row| row.get(0),
        )
        .map_err(|err| map_query_error(conn, err))?;
    if exists == 0 {
        return Err(missing_table_error(conn, table));
    }

    let mut fk_by_column = foreign_keys_by_column(conn, schema, table)?;

    // table_info columns: cid(0), name(1), type(2), notnull(3), dflt(4), pk(5).
    // `pk` is the 1-based position within the primary key (0 = not part).
    let mut stmt = conn
        .prepare(&format!(
            "PRAGMA {}.table_info({})",
            quote_ident(schema),
            quote_ident(table)
        ))
        .map_err(|err| map_query_error(conn, err))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(5)?,
            ))
        })
        .and_then(Iterator::collect::<Result<Vec<_>, _>>)
        .map_err(|err| map_query_error(conn, err))?;

    let columns = rows
        .into_iter()
        .map(|(name, data_type, notnull, pk)| ColumnInfo {
            fk: fk_by_column.remove(&name),
            name,
            data_type,
            nullable: notnull == 0,
            pk: pk > 0,
        })
        .collect();
    Ok(TableMeta { columns })
}

/// Foreign keys of `table`, keyed by the local (from) column. A column in
/// several fks keeps the first one reported (see module docs).
fn foreign_keys_by_column(
    conn: &Connection,
    schema: &str,
    table: &str,
) -> Result<HashMap<String, FkRef>, AppError> {
    // foreign_key_list columns: id(0), seq(1), table(2), from(3), to(4), ….
    let mut stmt = conn
        .prepare(&format!(
            "PRAGMA {}.foreign_key_list({})",
            quote_ident(schema),
            quote_ident(table)
        ))
        .map_err(|err| map_query_error(conn, err))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })
        .and_then(Iterator::collect::<Result<Vec<_>, _>>)
        .map_err(|err| map_query_error(conn, err))?;

    let mut by_column = HashMap::new();
    for (seq, ref_table, from, to) in rows {
        let column = match to {
            Some(column) => column,
            // Implicit `REFERENCES t`: resolve to the referenced table's pk
            // (same schema — SQLite fks never cross databases).
            None => referenced_pk_column(conn, schema, &ref_table, seq.max(0) as usize),
        };
        by_column.entry(from).or_insert(FkRef {
            table: ref_table,
            column,
        });
    }
    Ok(by_column)
}

/// The referenced table's primary-key column at position `seq`, for
/// resolving implicit fk targets. Best effort: an unresolvable pk (missing
/// table, no declared pk) yields an empty string — an honest "unknown"
/// rather than a guessed "id" (see module docs).
fn referenced_pk_column(conn: &Connection, schema: &str, ref_table: &str, seq: usize) -> String {
    let sql = format!(
        "PRAGMA {}.table_info({})",
        quote_ident(schema),
        quote_ident(ref_table)
    );
    let Ok(mut stmt) = conn.prepare(&sql) else {
        return String::new();
    };
    let Ok(columns) = stmt
        .query_map([], |row| {
            Ok((row.get::<_, i64>(5)?, row.get::<_, String>(1)?))
        })
        .and_then(Iterator::collect::<Result<Vec<(i64, String)>, _>>)
    else {
        return String::new();
    };
    let mut pk_columns: Vec<(i64, String)> =
        columns.into_iter().filter(|(pk, _)| *pk > 0).collect();
    pk_columns.sort_by_key(|(position, _)| *position);
    pk_columns
        .into_iter()
        .nth(seq)
        .map(|(_, name)| name)
        .unwrap_or_default()
}

fn run_query_blocking(
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
fn fetch_rows_blocking(conn: &Connection, req: &FetchRowsRequest) -> Result<RowsPage, AppError> {
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

/// A compiled WHERE clause: the SQL body (without the `WHERE` keyword) and the
/// values to bind, in placeholder order. `sql == None` means "no predicate"
/// (an empty structured filter), which the caller renders as no WHERE clause
/// at all.
#[derive(Default)]
struct WhereClause {
    sql: Option<String>,
    params: Vec<SqlValue>,
}

/// The character used in `ESCAPE '\'` for the LIKE family. A backslash is the
/// conventional choice and never appears unescaped in our patterns.
const LIKE_ESCAPE: char = '\\';

/// Compile a [`FilterSpec`] into a WHERE body + bound parameters.
///
/// Structured conditions validate every column against `meta`, emit a fixed
/// per-operator SQL fragment, and bind every value as a parameter. The raw
/// mode wraps the user string in parentheses verbatim (the documented escape
/// hatch — see [`fetch_rows_blocking`]).
fn where_clause(
    meta: &TableMeta,
    table: &str,
    filter: &FilterSpec,
) -> Result<WhereClause, AppError> {
    match filter {
        FilterSpec::Raw { sql } => {
            let trimmed = sql.trim();
            if trimmed.is_empty() {
                // An empty raw clause is "no filter", not a syntax error.
                return Ok(WhereClause::default());
            }
            // Interpolated verbatim, wrapped in parens (escape hatch). No
            // parameters — the string carries its own literals.
            Ok(WhereClause {
                sql: Some(format!("({trimmed})")),
                params: Vec::new(),
            })
        }
        FilterSpec::Conditions { items, combinator } => {
            let mut fragments: Vec<String> = Vec::with_capacity(items.len());
            let mut params: Vec<SqlValue> = Vec::new();
            for condition in items {
                let fragment = condition_sql(meta, table, condition, &mut params)?;
                fragments.push(fragment);
            }
            if fragments.is_empty() {
                // No conditions → no predicate (whole table).
                return Ok(WhereClause::default());
            }
            let joiner = format!(" {} ", combinator.sql_keyword());
            Ok(WhereClause {
                sql: Some(fragments.join(&joiner)),
                params,
            })
        }
    }
}

/// Compile one structured [`Condition`] into a SQL fragment, pushing any bound
/// values onto `params`. The column is validated against `meta` (a §5 error
/// for an unknown column, identical to the sort-column check); the operator
/// selects a fixed fragment; values are bound, never interpolated.
fn condition_sql(
    meta: &TableMeta,
    table: &str,
    condition: &Condition,
    params: &mut Vec<SqlValue>,
) -> Result<String, AppError> {
    let known = meta.columns.iter().any(|c| c.name == condition.column);
    if !known {
        let listing: Vec<&str> = meta.columns.iter().map(|c| c.name.as_str()).collect();
        return Err(AppError::Database(format!(
            "Column '{}' does not exist on '{}' (columns: {}).",
            condition.column,
            table,
            listing.join(", ")
        )));
    }
    let col = quote_ident(&condition.column);

    match condition.op {
        FilterOp::IsNull => Ok(format!("{col} IS NULL")),
        FilterOp::IsNotNull => Ok(format!("{col} IS NOT NULL")),
        FilterOp::Eq
        | FilterOp::Ne
        | FilterOp::Gt
        | FilterOp::Gte
        | FilterOp::Lt
        | FilterOp::Lte => {
            let value = require_scalar(condition)?;
            params.push(json_to_sql_value(value)?);
            let operator = match condition.op {
                FilterOp::Eq => "=",
                FilterOp::Ne => "<>",
                FilterOp::Gt => ">",
                FilterOp::Gte => ">=",
                FilterOp::Lt => "<",
                FilterOp::Lte => "<=",
                _ => unreachable!("comparison arm"),
            };
            Ok(format!("{col} {operator} ?"))
        }
        FilterOp::Contains | FilterOp::NotContains | FilterOp::BeginsWith | FilterOp::EndsWith => {
            let value = require_scalar(condition)?;
            let text = like_operand(value)?;
            let escaped = escape_like(&text);
            let pattern = match condition.op {
                FilterOp::Contains | FilterOp::NotContains => format!("%{escaped}%"),
                FilterOp::BeginsWith => format!("{escaped}%"),
                FilterOp::EndsWith => format!("%{escaped}"),
                _ => unreachable!("like arm"),
            };
            params.push(SqlValue::Text(pattern));
            let keyword = if matches!(condition.op, FilterOp::NotContains) {
                "NOT LIKE"
            } else {
                "LIKE"
            };
            Ok(format!("{col} {keyword} ? ESCAPE '{LIKE_ESCAPE}'"))
        }
        FilterOp::InList => {
            let values = match &condition.value {
                Some(FilterValue::List(values)) => values,
                Some(FilterValue::Scalar(_)) => {
                    return Err(AppError::Database(format!(
                        "The 'in list' filter on '{}' needs a list of values.",
                        condition.column
                    )));
                }
                None => return Err(missing_value_error(condition)),
            };
            if values.is_empty() {
                return Err(AppError::Database(format!(
                    "The 'in list' filter on '{}' needs at least one value.",
                    condition.column
                )));
            }
            let mut placeholders = Vec::with_capacity(values.len());
            for value in values {
                params.push(json_to_sql_value(value)?);
                placeholders.push("?");
            }
            Ok(format!("{col} IN ({})", placeholders.join(", ")))
        }
    }
}

/// The single scalar a comparison / LIKE operator requires. A missing value or
/// a list where a scalar is expected is a §5 error.
fn require_scalar(condition: &Condition) -> Result<&serde_json::Value, AppError> {
    match &condition.value {
        Some(FilterValue::Scalar(value)) => Ok(value),
        Some(FilterValue::List(_)) => Err(AppError::Database(format!(
            "The filter on '{}' expects a single value, not a list.",
            condition.column
        ))),
        None => Err(missing_value_error(condition)),
    }
}

/// §5 error for an operator that needs a value but received none.
fn missing_value_error(condition: &Condition) -> AppError {
    AppError::Database(format!(
        "The filter on '{}' needs a value.",
        condition.column
    ))
}

/// Map a JSON scalar to a bound SQLite value. NULL is rejected with the §5
/// "use IS NULL / IS NOT NULL" message (matching `engine.js`) — `col = NULL`
/// never matches, so a NULL comparison is always a mistake. Nested
/// arrays/objects are not valid scalars.
fn json_to_sql_value(value: &serde_json::Value) -> Result<SqlValue, AppError> {
    match value {
        serde_json::Value::Null => Err(AppError::Database(
            "Use IS NULL / IS NOT NULL to compare with NULL.".to_string(),
        )),
        serde_json::Value::Bool(b) => Ok(SqlValue::Integer(i64::from(*b))),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Ok(SqlValue::Integer(i))
            } else if let Some(f) = n.as_f64() {
                Ok(SqlValue::Real(f))
            } else {
                // u64 beyond i64::MAX — preserve as text rather than lose it.
                Ok(SqlValue::Text(n.to_string()))
            }
        }
        serde_json::Value::String(s) => Ok(SqlValue::Text(s.clone())),
        serde_json::Value::Array(_) | serde_json::Value::Object(_) => Err(AppError::Database(
            "A filter value must be a single text, number, or boolean.".to_string(),
        )),
    }
}

/// The text operand for a LIKE-family operator. Numbers/bools are stringified
/// (a `contains` on a numeric column still makes sense); NULL is rejected like
/// any other NULL comparison.
fn like_operand(value: &serde_json::Value) -> Result<String, AppError> {
    match value {
        serde_json::Value::Null => Err(AppError::Database(
            "Use IS NULL / IS NOT NULL to compare with NULL.".to_string(),
        )),
        serde_json::Value::String(s) => Ok(s.clone()),
        serde_json::Value::Bool(b) => Ok(b.to_string()),
        serde_json::Value::Number(n) => Ok(n.to_string()),
        serde_json::Value::Array(_) | serde_json::Value::Object(_) => Err(AppError::Database(
            "A filter value must be a single text, number, or boolean.".to_string(),
        )),
    }
}

/// Escape the LIKE metacharacters (`%`, `_`) and the escape character itself
/// in a user-supplied operand, so they match literally under `ESCAPE '\'`.
/// The escape char is doubled first so it cannot accidentally escape a real
/// metacharacter the user typed.
fn escape_like(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        if ch == LIKE_ESCAPE || ch == '%' || ch == '_' {
            out.push(LIKE_ESCAPE);
        }
        out.push(ch);
    }
    out
}

/// Build the validated, quoted ORDER BY body for a single-column sort:
/// `"column" ASC|DESC`. The column MUST exist in `meta` (else a §5 error
/// listing the available columns); the direction is the enum's fixed keyword.
fn order_by_clause(meta: &TableMeta, table: &str, sort: &SortSpec) -> Result<String, AppError> {
    let known = meta.columns.iter().any(|c| c.name == sort.column);
    if !known {
        let listing: Vec<&str> = meta.columns.iter().map(|c| c.name.as_str()).collect();
        return Err(AppError::Database(format!(
            "Column '{}' does not exist on '{}' (columns: {}).",
            sort.column,
            table,
            listing.join(", ")
        )));
    }
    Ok(format!(
        "{} {}",
        quote_ident(&sort.column),
        sort.direction.sql_keyword()
    ))
}

/// SQLite value → JSON. Blobs become a `"[blob N bytes]"` placeholder (see
/// module docs); non-finite reals become null (JSON has no NaN/Infinity);
/// integers beyond ±[`JS_MAX_SAFE_INTEGER`] become decimal strings so the
/// renderer never rounds them (see `QueryResult::rows` in `shared::engine`).
fn value_to_json(value: ValueRef<'_>) -> serde_json::Value {
    match value {
        ValueRef::Null => serde_json::Value::Null,
        ValueRef::Integer(i) if i.unsigned_abs() <= JS_MAX_SAFE_INTEGER as u64 => {
            serde_json::Value::from(i)
        }
        ValueRef::Integer(i) => serde_json::Value::String(i.to_string()),
        ValueRef::Real(f) => serde_json::Number::from_f64(f)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        ValueRef::Text(bytes) => {
            serde_json::Value::String(String::from_utf8_lossy(bytes).into_owned())
        }
        ValueRef::Blob(bytes) => serde_json::Value::String(format!("[blob {} bytes]", bytes.len())),
    }
}

/// Quote an identifier for interpolation into SQLite SQL: wrap in double
/// quotes, doubling embedded quotes.
fn quote_ident(ident: &str) -> String {
    format!("\"{}\"", ident.replace('"', "\"\""))
}

/// The bare driver message, without rusqlite's error-chain wrapping.
fn driver_message(err: &rusqlite::Error) -> String {
    match err {
        rusqlite::Error::SqliteFailure(_, Some(message)) => message.clone(),
        other => other.to_string(),
    }
}

/// Map a query-time driver error to a §5-style human message.
///
/// Best effort: "no such table" gets the available-tables suffix, "no such
/// column" passes through cleaned, everything else is the driver message
/// capitalized — never a Rust error chain.
fn map_query_error(conn: &Connection, err: rusqlite::Error) -> AppError {
    let raw = driver_message(&err);
    if let Some(table) = raw.strip_prefix("no such table: ") {
        return missing_table_error(conn, strip_location_suffix(table));
    }
    if let Some(column) = raw.strip_prefix("no such column: ") {
        return AppError::Database(format!(
            "Column '{}' does not exist.",
            strip_location_suffix(column)
        ));
    }
    AppError::Database(humanize(&raw))
}

/// The §5 unknown-table message, with the "available tables" listing.
fn missing_table_error(conn: &Connection, table: &str) -> AppError {
    let tables = all_table_names(conn);
    let listing = if tables.is_empty() {
        "(none)".to_string()
    } else {
        tables.join(", ")
    };
    AppError::Database(format!(
        "Table '{table}' does not exist. Available tables: {listing}."
    ))
}

/// Newer SQLite appends ` in <sql> at offset N` to "no such …" messages;
/// drop it so only the offending name remains.
fn strip_location_suffix(name: &str) -> &str {
    match name.find(" in ") {
        Some(index) => &name[..index],
        None => name,
    }
}

/// Every user table across all schemas, for "available tables" listings.
/// Attached-schema tables are qualified (`aux.users`); failures are skipped
/// — this only feeds an error message.
fn all_table_names(conn: &Connection) -> Vec<String> {
    let Ok(schemas) = schema_names(conn) else {
        return Vec::new();
    };
    let mut names = Vec::new();
    for schema in schemas {
        let sql = format!(
            "SELECT name FROM {}.sqlite_schema \
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
            quote_ident(&schema)
        );
        let Ok(mut stmt) = conn.prepare(&sql) else {
            continue;
        };
        let Ok(rows) = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .and_then(Iterator::collect::<Result<Vec<String>, _>>)
        else {
            continue;
        };
        for name in rows {
            if schema == "main" {
                names.push(name);
            } else {
                names.push(format!("{schema}.{name}"));
            }
        }
    }
    names
}

/// Capitalize the first letter and ensure a trailing period.
fn humanize(message: &str) -> String {
    let trimmed = message.trim();
    let mut chars = trimmed.chars();
    let capitalized = match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => "The database reported an unknown error".to_string(),
    };
    if capitalized.ends_with(['.', '!', '?']) {
        capitalized
    } else {
        format!("{capitalized}.")
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    /// Create a real SQLite file with a `users` table (3 rows, mixed types)
    /// and an empty `orders` table.
    fn create_fixture_db(path: &Path) {
        let conn = Connection::open(path).expect("create db");
        conn.execute_batch(
            "CREATE TABLE users (
                 id INTEGER PRIMARY KEY,
                 name TEXT NOT NULL,
                 score REAL,
                 avatar BLOB
             );
             INSERT INTO users (id, name, score, avatar)
                 VALUES (1, 'ada', 9.5, x'C0FFEE'),
                        (2, 'grace', NULL, NULL),
                        (3, 'linus', 7.25, NULL);
             CREATE TABLE orders (id INTEGER PRIMARY KEY, total REAL);",
        )
        .expect("seed db");
    }

    fn params_for(path: &Path) -> ConnectionParams {
        ConnectionParams::Sqlite {
            path: path.to_string_lossy().into_owned(),
        }
    }

    async fn open_fixture(dir: &tempfile::TempDir) -> Box<dyn EngineConnection> {
        let path = dir.path().join("fixture.db");
        create_fixture_db(&path);
        SqliteConnector
            .open(&params_for(&path))
            .await
            .expect("open fixture db")
    }

    #[tokio::test]
    async fn test_reports_sqlite_engine_and_version() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("t.db");
        create_fixture_db(&path);
        let info = SqliteConnector
            .test(&params_for(&path))
            .await
            .expect("test connection");
        assert_eq!(info.engine, Engine::Sqlite);
        assert!(
            info.server_version.starts_with("SQLite 3."),
            "got version {:?}",
            info.server_version
        );
    }

    #[tokio::test]
    async fn missing_file_is_a_human_error_and_creates_nothing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("nope.db");
        let err = match SqliteConnector.open(&params_for(&path)).await {
            Ok(_) => panic!("opening a missing file must fail"),
            Err(err) => err,
        };
        assert!(matches!(err, AppError::Database(_)));
        assert_eq!(
            err.to_string(),
            format!("SQLite database file '{}' does not exist.", path.display())
        );
        assert!(!path.exists(), "open must not create the file");
    }

    #[tokio::test]
    async fn non_database_file_is_a_human_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("notes.db");
        fs::write(&path, "definitely not a sqlite database, just some text")
            .expect("write text file");
        let err = SqliteConnector.test(&params_for(&path)).await.unwrap_err();
        assert_eq!(
            err.to_string(),
            format!("'{}' is not a SQLite database file.", path.display())
        );
    }

    #[tokio::test]
    async fn wrong_engine_params_are_rejected() {
        let err = SqliteConnector
            .test(&ConnectionParams::Postgres {
                host: "h".into(),
                port: 5432,
                database: "d".into(),
                user: "u".into(),
                tls: false,
            })
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Invalid(_)));
    }

    #[tokio::test]
    async fn lists_main_schema_with_table_count() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_fixture(&dir).await;
        let schemas = conn.list_schemas().await.expect("list schemas");
        assert_eq!(schemas.len(), 1);
        assert_eq!(schemas[0].name, "main");
        assert_eq!(schemas[0].table_count, Some(2));
    }

    #[tokio::test]
    async fn attached_databases_show_up_as_schemas() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_fixture(&dir).await;

        let aux_path = dir.path().join("aux.db");
        {
            let aux = Connection::open(&aux_path).expect("create aux db");
            aux.execute_batch("CREATE TABLE logs (id INTEGER PRIMARY KEY, line TEXT);")
                .expect("seed aux");
        }
        conn.run_query(
            &format!("ATTACH DATABASE '{}' AS aux", aux_path.display()),
            QueryOptions::default(),
        )
        .await
        .expect("attach");

        let schemas = conn.list_schemas().await.expect("list schemas");
        let names: Vec<&str> = schemas.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["main", "aux"]);

        let tables = conn.list_tables("aux").await.expect("list aux tables");
        assert_eq!(tables.len(), 1);
        assert_eq!(tables[0].name, "logs");
        assert_eq!(tables[0].approx_row_count, Some(0));
    }

    #[tokio::test]
    async fn lists_tables_with_row_counts() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_fixture(&dir).await;
        let tables = conn.list_tables("main").await.expect("list tables");
        let summary: Vec<(&str, Option<u64>)> = tables
            .iter()
            .map(|t| (t.name.as_str(), t.approx_row_count))
            .collect();
        assert_eq!(summary, vec![("orders", Some(0)), ("users", Some(3))]);
    }

    #[tokio::test]
    async fn unknown_schema_is_a_human_error_listing_available_schemas() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_fixture(&dir).await;
        let err = conn.list_tables("warehouse").await.unwrap_err();
        assert_eq!(
            err.to_string(),
            "Schema 'warehouse' does not exist. Available schemas: main."
        );
    }

    /// Open a db exercising every `table_meta` facet: explicit + implicit
    /// fk targets, composite pk, NOT NULL, untyped columns, a non-"id" pk
    /// on the implicitly referenced table.
    async fn open_meta_fixture(dir: &tempfile::TempDir) -> Box<dyn EngineConnection> {
        let path = dir.path().join("meta.db");
        {
            let conn = Connection::open(&path).expect("create db");
            conn.execute_batch(
                "CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
                 CREATE TABLE series (series_code TEXT PRIMARY KEY, title TEXT);
                 CREATE TABLE books (
                     id INTEGER PRIMARY KEY,
                     title TEXT NOT NULL,
                     author_id INTEGER NOT NULL REFERENCES authors(id),
                     series_code TEXT REFERENCES series,
                     ghost_id INTEGER REFERENCES phantoms,
                     notes
                 );
                 CREATE TABLE order_items (
                     order_id INTEGER,
                     item_no INTEGER,
                     qty INTEGER NOT NULL,
                     PRIMARY KEY (order_id, item_no)
                 );",
            )
            .expect("seed db");
        }
        SqliteConnector
            .open(&params_for(&path))
            .await
            .expect("open meta fixture")
    }

    #[tokio::test]
    async fn table_meta_reports_types_nullability_pk_and_fks() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_meta_fixture(&dir).await;
        let meta = conn.table_meta("main", "books").await.expect("table meta");

        let expected = vec![
            ColumnInfo {
                name: "id".into(),
                data_type: "INTEGER".into(),
                // SQLite does not set `notnull` for bare PRIMARY KEY columns;
                // `nullable` reports the declared constraint (module docs).
                nullable: true,
                pk: true,
                fk: None,
            },
            ColumnInfo {
                name: "title".into(),
                data_type: "TEXT".into(),
                nullable: false,
                pk: false,
                fk: None,
            },
            ColumnInfo {
                name: "author_id".into(),
                data_type: "INTEGER".into(),
                nullable: false,
                pk: false,
                // Explicit target: REFERENCES authors(id).
                fk: Some(FkRef {
                    table: "authors".into(),
                    column: "id".into(),
                }),
            },
            ColumnInfo {
                name: "series_code".into(),
                data_type: "TEXT".into(),
                nullable: true,
                pk: false,
                // Implicit target (`REFERENCES series`): resolved to the
                // referenced table's pk, which is deliberately not "id".
                fk: Some(FkRef {
                    table: "series".into(),
                    column: "series_code".into(),
                }),
            },
            ColumnInfo {
                name: "ghost_id".into(),
                data_type: "INTEGER".into(),
                nullable: true,
                pk: false,
                // Implicit target on a table that does not exist: the table
                // name survives, the column falls back to "" (module docs).
                fk: Some(FkRef {
                    table: "phantoms".into(),
                    column: String::new(),
                }),
            },
            ColumnInfo {
                name: "notes".into(),
                // Untyped column: empty declared type, not a made-up one.
                data_type: String::new(),
                nullable: true,
                pk: false,
                fk: None,
            },
        ];
        assert_eq!(meta.columns, expected);
    }

    #[tokio::test]
    async fn table_meta_marks_every_member_of_a_composite_pk() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_meta_fixture(&dir).await;
        let meta = conn
            .table_meta("main", "order_items")
            .await
            .expect("table meta");
        let flags: Vec<(&str, bool, bool)> = meta
            .columns
            .iter()
            .map(|c| (c.name.as_str(), c.pk, c.nullable))
            .collect();
        assert_eq!(
            flags,
            vec![
                ("order_id", true, true),
                ("item_no", true, true),
                ("qty", false, false),
            ]
        );
    }

    #[tokio::test]
    async fn table_meta_for_unknown_table_lists_available_tables() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_fixture(&dir).await;
        let err = conn.table_meta("main", "customers").await.unwrap_err();
        assert!(matches!(err, AppError::Database(_)));
        assert_eq!(
            err.to_string(),
            "Table 'customers' does not exist. Available tables: orders, users."
        );
    }

    #[tokio::test]
    async fn table_meta_for_unknown_schema_is_a_human_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_fixture(&dir).await;
        let err = conn.table_meta("warehouse", "users").await.unwrap_err();
        assert_eq!(
            err.to_string(),
            "Schema 'warehouse' does not exist. Available schemas: main."
        );
    }

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
                serde_json::json!("[blob 3 bytes]"),
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
            .expect("open db");
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

    #[test]
    fn value_to_json_switches_to_strings_exactly_past_the_safe_boundary() {
        let safe = JS_MAX_SAFE_INTEGER;
        assert_eq!(
            value_to_json(ValueRef::Integer(safe)),
            serde_json::json!(9_007_199_254_740_991_i64)
        );
        assert_eq!(
            value_to_json(ValueRef::Integer(-safe)),
            serde_json::json!(-9_007_199_254_740_991_i64)
        );
        assert_eq!(
            value_to_json(ValueRef::Integer(safe + 1)),
            serde_json::json!("9007199254740992")
        );
        assert_eq!(
            value_to_json(ValueRef::Integer(-safe - 1)),
            serde_json::json!("-9007199254740992")
        );
    }

    #[test]
    fn quote_ident_doubles_embedded_quotes() {
        assert_eq!(quote_ident("plain"), "\"plain\"");
        assert_eq!(quote_ident("we\"ird"), "\"we\"\"ird\"");
    }

    #[test]
    fn humanize_capitalizes_and_punctuates() {
        assert_eq!(
            humanize("near \"x\": syntax error"),
            "Near \"x\": syntax error."
        );
        assert_eq!(humanize("Already done."), "Already done.");
    }

    // -- fetch_rows (M4 data grid) ------------------------------------------

    use crate::shared::engine::{
        Combinator, Condition, FetchRowsRequest, FilterOp, FilterSpec, FilterValue, SortDirection,
        SortSpec,
    };

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
        // Values map exactly like run_query (blob placeholder, null).
        assert_eq!(page.rows[0][0], serde_json::json!(1));
        assert_eq!(page.rows[0][1], serde_json::json!("ada"));
        assert_eq!(page.rows[0][3], serde_json::json!("[blob 3 bytes]"));
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
            .expect("open db");
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
    async fn open_products_fixture(dir: &tempfile::TempDir) -> Box<dyn EngineConnection> {
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

    #[test]
    fn escape_like_escapes_metacharacters_and_the_escape_char() {
        assert_eq!(escape_like("plain"), "plain");
        assert_eq!(escape_like("100%"), "100\\%");
        assert_eq!(escape_like("a_b"), "a\\_b");
        // The escape char itself is doubled so it cannot escape a real meta.
        assert_eq!(escape_like("a\\b"), "a\\\\b");
    }
}
