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
//! - BLOB values: small ones (≤ 32 bytes — UUIDs/keys) map to a `0x…` hex
//!   string so they're readable + usable; larger ones map to the `"[N bytes]"`
//!   placeholder (no blob viewer yet, and shipping megabytes across IPC for a
//!   grid cell helps no one). Shared via `shared::engine::binary_to_json`.
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
//!
//! # Documented choices (M7, structure view §3.6)
//!
//! `table_meta` also populates the structure-view fields of [`TableMeta`]:
//!
//! - `indexes` from `PRAGMA index_list` (name/unique/origin) + `PRAGMA
//!   index_info` (member columns, ordered by `seqno`). `primary` is
//!   `origin == "pk"`; `origin` is SQLite's `"c"`/`"u"`/`"pk"` passed through.
//!   Note an `INTEGER PRIMARY KEY` is an alias for the rowid and has NO entry
//!   in `index_list` (it is the rowid, not a separate index); only a
//!   *non-rowid* pk (composite, or a non-INTEGER pk) produces an implicit
//!   `origin == "pk"` index. Expression members report a NULL name from
//!   `index_info` and are skipped, so an expression index simply has fewer
//!   named columns.
//! - `foreign_keys` reuses `PRAGMA foreign_key_list`, now grouped by the `id`
//!   column into one [`ForeignKeyInfo`] per constraint with columns ordered by
//!   `seq` (so a composite fk is a single entry). `on_delete`/`on_update` come
//!   from the pragma's `on_delete`/`on_update` columns. SQLite has no fk
//!   constraint names, so `name` is always `None`. Implicit `REFERENCES t`
//!   (NULL `to`) resolves the referenced column to the parent's pk, same as
//!   `ColumnInfo.fk` (empty string when unresolvable — module docs above).
//! - `referenced_by` scans every *other* user table in the SAME schema and
//!   keeps the foreign keys whose target table is THIS table, grouped per
//!   constraint. Cost: one `foreign_key_list` pragma per other table — O(N)
//!   for N tables, each a cheap schema-only read (no table scan). This is fine
//!   for the local schemas ByteTable targets; the scan is deliberately
//!   unbounded (unlike the row-count cap) because a pragma over the schema is
//!   far cheaper than `count(*)` and §3.6 needs the complete inbound list to
//!   be truthful. SQLite fks never cross databases, so only the table's own
//!   schema is scanned.
//! - `ddl` is `SELECT sql FROM "schema".sqlite_schema WHERE type='table' AND
//!   name = ?`, returned verbatim (the modal syntax-highlights it; verbatim is
//!   truthful). `None` if the row has no stored SQL (existence is already
//!   proven before this point, so a missing table never reaches here).
//! - `comment` is always `None` — SQLite has no table comments (the field is
//!   modelled for §3.6 and server engines; see [`TableMeta::comment`]).

mod structure;

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use async_trait::async_trait;
use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags};

use rusqlite::types::Value as SqlValue;

use crate::features::structure::domain::AlterOp;
use crate::shared::engine::{
    count_statements, AlterResult, ColumnInfo, ColumnMeta, ColumnStats, ColumnStatsRequest,
    Condition, ConnectionParams, Connector, Engine, EngineConnection, EngineInfo, FetchRowsRequest,
    FilterOp, FilterSpec, FilterValue, FkRef, ForeignKeyInfo, FreqEntry, ImportResult,
    InboundFkInfo, IndexInfo, OpenConnection, PkPredicate, QueryOptions, QueryResult, RowLookup,
    RowLookupRequest, RowsPage, SchemaInfo, SortSpec, TableInfo, TableMeta, UpdateCellRequest,
    UpdateResult,
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

    async fn open(&self, params: &ConnectionParams) -> Result<OpenConnection, AppError> {
        let path = sqlite_path(params)?;
        let connection = run_blocking(move || open_validated(&path)).await?;
        Ok(OpenConnection::sql(SqliteEngineConnection {
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

    async fn fetch_row_by_key(&self, req: RowLookupRequest) -> Result<RowLookup, AppError> {
        self.with_conn(move |conn| fetch_row_by_key_blocking(conn, &req))
            .await
    }

    async fn column_stats(&self, req: ColumnStatsRequest) -> Result<ColumnStats, AppError> {
        self.with_conn(move |conn| column_stats_blocking(conn, &req))
            .await
    }

    async fn alter_table(
        &self,
        schema: &str,
        table: &str,
        ops: &[AlterOp],
        apply: bool,
    ) -> Result<AlterResult, AppError> {
        let schema = schema.to_string();
        let table = table.to_string();
        let ops = ops.to_vec();
        self.with_conn(move |conn| {
            structure::alter_table_blocking(conn, &schema, &table, &ops, apply)
        })
        .await
    }

    async fn update_cell(&self, req: UpdateCellRequest) -> Result<UpdateResult, AppError> {
        self.with_conn(move |conn| update_cell_blocking(conn, &req))
            .await
    }

    fn quote_identifier(&self, ident: &str) -> String {
        quote_ident(ident)
    }

    async fn truncate_table(&self, schema: &str, table: &str) -> Result<u64, AppError> {
        let schema = schema.to_string();
        let table = table.to_string();
        self.with_conn(move |conn| truncate_table_blocking(conn, &schema, &table))
            .await
    }

    async fn drop_schema(&self, schema: &str) -> Result<(), AppError> {
        let schema = schema.to_string();
        self.with_conn(move |conn| drop_schema_blocking(conn, &schema))
            .await
    }

    async fn execute_script(&self, schema: &str, sql: &str) -> Result<ImportResult, AppError> {
        let schema = schema.to_string();
        let sql = sql.to_string();
        self.with_conn(move |conn| execute_script_blocking(conn, &schema, &sql))
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

    // Read the foreign_key_list once and derive both views from it: the
    // per-column map for `ColumnInfo.fk` (M3 sidebar) and the grouped
    // table-level list for §3.6.
    let fk_rows = foreign_key_rows(conn, schema, table)?;
    let mut fk_by_column = foreign_keys_by_column(conn, schema, &fk_rows);
    let foreign_keys = group_foreign_keys(&fk_rows);

    // table_info columns: cid(0), name(1), type(2), notnull(3),
    // dflt_value(4), pk(5). `pk` is the 1-based position within the primary
    // key (0 = not part); `dflt_value` is the DEFAULT expression as stored SQL
    // text (NULL = no default), surfaced as `ColumnInfo.default_value`.
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
                // dflt_value(4): the column's DEFAULT expression as stored SQL
                // text, NULL when the column has no default.
                row.get::<_, Option<String>>(4)?,
                row.get::<_, i64>(5)?,
            ))
        })
        .and_then(Iterator::collect::<Result<Vec<_>, _>>)
        .map_err(|err| map_query_error(conn, err))?;

    let columns: Vec<ColumnInfo> = rows
        .into_iter()
        .map(|(name, data_type, notnull, dflt_value, pk)| ColumnInfo {
            fk: fk_by_column.remove(&name),
            name,
            data_type,
            nullable: notnull == 0,
            pk: pk > 0,
            default_value: dflt_value,
        })
        .collect();
    drop(stmt);

    let indexes = table_indexes(conn, schema, table)?;
    let referenced_by = inbound_foreign_keys(conn, schema, table)?;
    let ddl = table_ddl(conn, schema, table)?;

    Ok(TableMeta {
        columns,
        // SQLite has no table comments (module docs).
        comment: None,
        indexes,
        foreign_keys,
        referenced_by,
        ddl,
    })
}

/// One raw row of `PRAGMA foreign_key_list`, the shared shape both the
/// per-column map and the grouped table-level list derive from.
struct FkRow {
    /// `id` groups rows of the same (possibly composite) constraint.
    id: i64,
    /// `seq` orders columns within one constraint.
    seq: i64,
    ref_table: String,
    /// Local (child) column.
    from: String,
    /// Referenced (parent) column; `None` for implicit `REFERENCES t`.
    to: Option<String>,
    on_delete: Option<String>,
    on_update: Option<String>,
}

/// Read every `PRAGMA foreign_key_list` row for `table`. Columns:
/// id(0), seq(1), table(2), from(3), to(4), on_update(5), on_delete(6),
/// match(7).
fn foreign_key_rows(conn: &Connection, schema: &str, table: &str) -> Result<Vec<FkRow>, AppError> {
    let mut stmt = conn
        .prepare(&format!(
            "PRAGMA {}.foreign_key_list({})",
            quote_ident(schema),
            quote_ident(table)
        ))
        .map_err(|err| map_query_error(conn, err))?;
    let rows = stmt
        .query_map([], |row| {
            Ok(FkRow {
                id: row.get::<_, i64>(0)?,
                seq: row.get::<_, i64>(1)?,
                ref_table: row.get::<_, String>(2)?,
                from: row.get::<_, String>(3)?,
                to: row.get::<_, Option<String>>(4)?,
                on_update: blank_to_none(row.get::<_, Option<String>>(5)?),
                on_delete: blank_to_none(row.get::<_, Option<String>>(6)?),
            })
        })
        .and_then(Iterator::collect::<Result<Vec<_>, _>>)
        .map_err(|err| map_query_error(conn, err))?;
    Ok(rows)
}

/// Treat an empty string the same as absent — SQLite reports `"NO ACTION"`
/// for the default, never an empty string, but be defensive about it.
fn blank_to_none(value: Option<String>) -> Option<String> {
    value.filter(|s| !s.is_empty())
}

/// Foreign keys of `table`, keyed by the local (from) column, for
/// `ColumnInfo.fk`. A column in several fks keeps the first one reported (see
/// module docs).
fn foreign_keys_by_column(
    conn: &Connection,
    schema: &str,
    rows: &[FkRow],
) -> HashMap<String, FkRef> {
    let mut by_column = HashMap::new();
    for row in rows {
        let column = match &row.to {
            Some(column) => column.clone(),
            // Implicit `REFERENCES t`: resolve to the referenced table's pk
            // (same schema — SQLite fks never cross databases).
            None => referenced_pk_column(conn, schema, &row.ref_table, row.seq.max(0) as usize),
        };
        by_column.entry(row.from.clone()).or_insert(FkRef {
            table: row.ref_table.clone(),
            column,
        });
    }
    by_column
}

/// Group `foreign_key_list` rows into one [`ForeignKeyInfo`] per constraint
/// (by `id`), columns ordered by `seq`. The implicit-target `to` is left as
/// the empty string here (the grouped list is the structure view; the
/// per-column map already resolves implicit targets to the parent pk).
fn group_foreign_keys(rows: &[FkRow]) -> Vec<ForeignKeyInfo> {
    // Preserve first-seen id order so the output is stable across runs.
    let mut order: Vec<i64> = Vec::new();
    let mut grouped: HashMap<i64, Vec<&FkRow>> = HashMap::new();
    for row in rows {
        grouped.entry(row.id).or_insert_with(|| {
            order.push(row.id);
            Vec::new()
        });
        grouped.get_mut(&row.id).expect("just inserted").push(row);
    }

    order
        .into_iter()
        .map(|id| {
            let mut members = grouped.remove(&id).expect("id from order");
            members.sort_by_key(|r| r.seq);
            let first = members[0];
            ForeignKeyInfo {
                // SQLite's foreign_key_list carries no constraint name.
                name: None,
                columns: members.iter().map(|r| r.from.clone()).collect(),
                ref_table: first.ref_table.clone(),
                ref_columns: members
                    .iter()
                    .map(|r| r.to.clone().unwrap_or_default())
                    .collect(),
                on_delete: first.on_delete.clone(),
                on_update: first.on_update.clone(),
            }
        })
        .collect()
}

/// Indexes on `table` (§3.6): `PRAGMA index_list` for name/unique/origin, then
/// `PRAGMA index_info` per index for the ordered member columns.
fn table_indexes(conn: &Connection, schema: &str, table: &str) -> Result<Vec<IndexInfo>, AppError> {
    // index_list columns: seq(0), name(1), unique(2), origin(3), partial(4).
    let mut stmt = conn
        .prepare(&format!(
            "PRAGMA {}.index_list({})",
            quote_ident(schema),
            quote_ident(table)
        ))
        .map_err(|err| map_query_error(conn, err))?;
    let listed = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })
        .and_then(Iterator::collect::<Result<Vec<_>, _>>)
        .map_err(|err| map_query_error(conn, err))?;
    drop(stmt);

    let mut indexes = Vec::with_capacity(listed.len());
    for (name, unique, origin) in listed {
        let columns = index_columns(conn, schema, &name)?;
        let primary = origin.as_deref() == Some("pk");
        indexes.push(IndexInfo {
            name,
            columns,
            unique: unique != 0,
            primary,
            origin,
        });
    }
    Ok(indexes)
}

/// The member columns of one index, ordered by `seqno`. Expression members
/// report a NULL column name and are skipped (module docs).
fn index_columns(conn: &Connection, schema: &str, index: &str) -> Result<Vec<String>, AppError> {
    // index_info columns: seqno(0), cid(1), name(2). name is NULL for an
    // expression / rowid member.
    let mut stmt = conn
        .prepare(&format!(
            "PRAGMA {}.index_info({})",
            quote_ident(schema),
            quote_ident(index)
        ))
        .map_err(|err| map_query_error(conn, err))?;
    let mut rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(2)?))
        })
        .and_then(Iterator::collect::<Result<Vec<_>, _>>)
        .map_err(|err| map_query_error(conn, err))?;
    rows.sort_by_key(|(seqno, _)| *seqno);
    Ok(rows.into_iter().filter_map(|(_, name)| name).collect())
}

/// Inbound foreign keys (§3.6 "referenced by"): scan every *other* user table
/// in the same schema and keep the constraints whose target is `table`,
/// grouped per constraint. Cost is one `foreign_key_list` pragma per other
/// table — cheap and deliberately unbounded (module docs).
fn inbound_foreign_keys(
    conn: &Connection,
    schema: &str,
    table: &str,
) -> Result<Vec<InboundFkInfo>, AppError> {
    let others = user_table_names(conn, schema)?;
    let mut inbound = Vec::new();
    for child in others {
        if child == table {
            continue;
        }
        let rows = foreign_key_rows(conn, schema, &child)?;
        for fk in group_foreign_keys(&rows) {
            if fk.ref_table == table {
                inbound.push(InboundFkInfo {
                    table: child.clone(),
                    columns: fk.columns,
                    ref_columns: fk.ref_columns,
                    on_delete: fk.on_delete,
                });
            }
        }
    }
    Ok(inbound)
}

/// User table names in one schema (excludes `sqlite_%`), ordered by name.
/// Reused by the referenced-by scan.
fn user_table_names(conn: &Connection, schema: &str) -> Result<Vec<String>, AppError> {
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
    Ok(names)
}

/// The verbatim `CREATE TABLE` statement from `sqlite_schema`. `None` when the
/// stored SQL is NULL (existence is proven before this is called).
fn table_ddl(conn: &Connection, schema: &str, table: &str) -> Result<Option<String>, AppError> {
    conn.query_row(
        &format!(
            "SELECT sql FROM {}.sqlite_schema WHERE type = 'table' AND name = ?1",
            quote_ident(schema)
        ),
        [table],
        |row| row.get::<_, Option<String>>(0),
    )
    .map_err(|err| map_query_error(conn, err))
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
fn fetch_row_by_key_blocking(
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
fn column_stats_blocking(
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

/// Update a single cell on one row (M11 inline edit, DESIGN_SPEC §3.5):
/// `SET req.column = req.value WHERE <full pk>`.
///
/// # Safety (this MUTATES user data)
///
/// - Schema/table existence is checked first (the §5 messages); `column` is
///   validated against the table's real columns before being quoted.
/// - The `pk` predicate columns must match the table's REAL primary key
///   *exactly* — every pk column present, and no predicate naming a non-pk
///   column. A table with no primary key, a partial pk, or a non-pk predicate
///   column is a §5 error. This is the mass-update guard: a complete pk WHERE
///   clause matches at most one row.
/// - **Every value is bound**, never interpolated: the new value first
///   (`SET "c" = ?`), then each pk value (`WHERE "pk" = ?`). A `null` new value
///   binds as `SET "c" = NULL` correctly (a bound NULL is fine in a SET; only
///   `WHERE c = NULL` is the SQL trap). An injection payload binds as an inert
///   literal. The only interpolated identifiers are quoted via [`quote_ident`].
/// - A `null` pk value can never match (`= NULL` is `UNKNOWN`); we surface that
///   as the same "no row matched" result the affected-count guard produces.
/// - Executed inside a transaction. The affected-row count is asserted: `0` →
///   §5 "no row matched" (stale/deleted pk), nothing changed; `>1` → ROLLBACK
///   and a §5 error (defense in depth — impossible once the pk is validated,
///   but a bug must never silently mass-update); `1` → COMMIT. Any engine
///   error (e.g. a NOT NULL violation) rolls back, leaving the row untouched.
fn update_cell_blocking(
    conn: &Connection,
    req: &UpdateCellRequest,
) -> Result<UpdateResult, AppError> {
    // Existence first: unknown schema/table get the §5 human messages, and this
    // gives us the real column list (incl. pk membership) to validate against.
    let meta = table_meta_blocking(conn, &req.schema, &req.table)?;
    validate_column(&meta, &req.table, &req.column)?;

    // Enforce the full-primary-key policy (mass-update prevention). The pk
    // predicate set must equal the table's real pk column set exactly.
    validate_pk_predicates(&meta, &req.table, &req.pk)?;

    let qualified = format!("{}.{}", quote_ident(&req.schema), quote_ident(&req.table));
    let set_col = quote_ident(&req.column);

    // Bind order: the SET value first, then each pk value in predicate order.
    let mut params: Vec<SqlValue> = Vec::with_capacity(1 + req.pk.len());
    // The SET value is bound even when NULL — a bound NULL produces the correct
    // `SET col = NULL` (json_to_sql_value rejects NULL because it is written for
    // WHERE-equality; for the SET we want NULL, so map it directly here).
    // Binary columns (req.binary / predicate.binary) bind their `0x`-hex / UUID
    // value as a BLOB so the write and the WHERE match the bytes.
    params.push(if req.binary {
        json_to_blob_set(&req.value)?
    } else {
        json_to_set_value(&req.value)
    });

    // Build `WHERE "pk1" = ? AND "pk2" = ? …` in predicate order. A null pk
    // value never matches — short-circuit to the "no row matched" miss without
    // touching the database (binding a NULL into `= ?` would also never match,
    // but the explicit check keeps the intent and the message clear).
    let mut where_fragments: Vec<String> = Vec::with_capacity(req.pk.len());
    for predicate in &req.pk {
        if predicate.value.is_null() {
            return Err(no_row_matched_error());
        }
        params.push(if predicate.binary {
            json_to_blob_operand(&predicate.value)?
        } else {
            json_to_sql_value(&predicate.value)?
        });
        where_fragments.push(format!("{} = ?", quote_ident(&predicate.column)));
    }
    let where_sql = where_fragments.join(" AND ");

    let update_sql = format!("UPDATE {qualified} SET {set_col} = ? WHERE {where_sql}");

    // Transaction so the >1 guard can roll back; a busy timeout turns a transient
    // lock into a clear error rather than an immediate "database is locked".
    let _ = conn.busy_timeout(std::time::Duration::from_secs(5));
    conn.execute_batch("BEGIN")
        .map_err(|err| map_query_error(conn, err))?;

    let affected = match conn.execute(&update_sql, rusqlite::params_from_iter(params.iter())) {
        Ok(affected) => affected as u64,
        Err(err) => {
            // Roll back so the row is untouched, then surface the engine error
            // §5-style (e.g. a NOT NULL violation when setting NULL).
            let _ = conn.execute_batch("ROLLBACK");
            return Err(map_query_error(conn, err));
        }
    };

    if affected == 0 {
        // Nothing changed → no row matched the pk (stale value / deleted row).
        // ROLLBACK is a no-op here but keeps the transaction tidy.
        let _ = conn.execute_batch("ROLLBACK");
        return Err(no_row_matched_error());
    }
    if affected > 1 {
        // Defense in depth: a complete-pk WHERE should match at most one row, so
        // this is unreachable once the pk is validated — but never silently
        // mass-update on a bug or a non-unique "pk".
        let _ = conn.execute_batch("ROLLBACK");
        return Err(AppError::Database(format!(
            "Update would affect {affected} rows; expected exactly one. \
             No changes were applied."
        )));
    }

    conn.execute_batch("COMMIT")
        .map_err(|err| map_query_error(conn, err))?;

    Ok(UpdateResult {
        affected,
        statement: display_update_statement(&qualified, &req.column, &req.value, &req.pk),
    })
}

/// Empty a table, keeping its structure (M15 truncate). SQLite has no
/// `TRUNCATE`, so this runs `DELETE FROM "schema"."table"` inside a
/// transaction; the affected count is the number of rows removed (0 for an
/// already-empty table). The table must exist (a §5 error otherwise) — we
/// reuse `table_meta_blocking` for the same "Table 'x' does not exist…"
/// message the rest of the adapter produces.
fn truncate_table_blocking(conn: &Connection, schema: &str, table: &str) -> Result<u64, AppError> {
    // Existence + schema validation, identical message vocabulary to update.
    table_meta_blocking(conn, schema, table)?;

    let qualified = format!("{}.{}", quote_ident(schema), quote_ident(table));
    let delete_sql = format!("DELETE FROM {qualified}");

    let _ = conn.busy_timeout(std::time::Duration::from_secs(5));
    conn.execute_batch("BEGIN")
        .map_err(|err| map_query_error(conn, err))?;
    let affected = match conn.execute(&delete_sql, []) {
        Ok(affected) => affected as u64,
        Err(err) => {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(map_query_error(conn, err));
        }
    };
    conn.execute_batch("COMMIT")
        .map_err(|err| map_query_error(conn, err))?;
    Ok(affected)
}

/// Drop every user table in `schema`, leaving an empty schema (M15 drop-schema).
///
/// SQLite has no droppable schema or database — `main` IS the file, and we must
/// never delete the file. So "drop schema" is defined as dropping every
/// non-`sqlite_%` table in the schema, inside one `BEGIN`/`COMMIT` transaction
/// (all-or-nothing: any failure rolls back, leaving the schema untouched). The
/// schema must be one of the connection's databases (main/attached) — a §5
/// "does not exist" error otherwise.
///
/// `PRAGMA defer_foreign_keys = ON` for the transaction so the drop order does
/// not matter: foreign-key checks are deferred to COMMIT, and since every table
/// is gone by then there is nothing left to violate. The pragma resets at the
/// transaction's end.
fn drop_schema_blocking(conn: &Connection, schema: &str) -> Result<(), AppError> {
    ensure_schema_exists(conn, schema)?;

    let quoted_schema = quote_ident(schema);
    let names: Vec<String> = {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT name FROM {quoted_schema}.sqlite_schema \
                 WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
            ))
            .map_err(|err| map_query_error(conn, err))?;
        stmt.query_map([], |row| row.get::<_, String>(0))
            .and_then(Iterator::collect::<Result<Vec<String>, _>>)
            .map_err(|err| map_query_error(conn, err))?
    };

    let _ = conn.busy_timeout(std::time::Duration::from_secs(5));
    conn.execute_batch("BEGIN")
        .map_err(|err| map_query_error(conn, err))?;

    let run = || -> Result<(), AppError> {
        // Defer FK checks so drop order is irrelevant; everything is gone by COMMIT.
        conn.execute_batch("PRAGMA defer_foreign_keys = ON")
            .map_err(|err| map_query_error(conn, err))?;
        for name in &names {
            let drop_sql = format!("DROP TABLE {quoted_schema}.{}", quote_ident(name));
            conn.execute(&drop_sql, [])
                .map_err(|err| map_query_error(conn, err))?;
        }
        Ok(())
    };

    match run() {
        Ok(()) => {
            conn.execute_batch("COMMIT")
                .map_err(|err| map_query_error(conn, err))?;
            Ok(())
        }
        Err(err) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(err)
        }
    }
}

/// Run a whole multi-statement SQL script (a dump) into the connection (M15
/// import). The script is wrapped in `BEGIN`/`COMMIT` so the import is atomic:
/// any error rolls back, leaving no half-created tables. `execute_batch` runs
/// every `;`-separated statement in one call.
///
/// Schema note: SQLite has no "current schema" beyond `main` + attached
/// databases, so the `schema` argument cannot redirect unqualified `CREATE`s —
/// they land in `main`. Importing into a specific attached schema requires the
/// script itself to qualify names (out of scope, M15). We surface a §5 error
/// when the caller targets a schema that is not `main` and is not an attached
/// database, so the limitation fails loudly rather than silently writing to
/// `main`.
fn execute_script_blocking(
    conn: &Connection,
    schema: &str,
    sql: &str,
) -> Result<ImportResult, AppError> {
    // The schema must be one of the connection's databases (main/attached). We
    // cannot make unqualified statements target it, but rejecting an unknown
    // schema keeps the same vocabulary as the rest of the adapter.
    ensure_schema_exists(conn, schema)?;
    if schema != "main" {
        return Err(AppError::Unsupported(format!(
            "SQLite imports run into 'main'; importing into the attached schema \
             '{schema}' requires the script to qualify table names (e.g. \
             CREATE TABLE \"{schema}\".\"…\"). Re-run the import there, or qualify \
             the names in the .sql."
        )));
    }

    let statements = count_statements(sql);

    let _ = conn.busy_timeout(std::time::Duration::from_secs(5));
    conn.execute_batch("BEGIN")
        .map_err(|err| map_query_error(conn, err))?;
    if let Err(err) = conn.execute_batch(sql) {
        // Roll back so a partial dump leaves the database untouched.
        let _ = conn.execute_batch("ROLLBACK");
        return Err(map_query_error(conn, err));
    }
    conn.execute_batch("COMMIT")
        .map_err(|err| map_query_error(conn, err))?;

    Ok(ImportResult { statements })
}

/// The §5 "no row matched" error shared by the null-pk short-circuit and the
/// affected-count-zero case.
fn no_row_matched_error() -> AppError {
    AppError::Database(
        "No row matched (it may have been deleted or changed since you loaded it).".to_string(),
    )
}

/// Enforce the full-primary-key policy for an [`UpdateCellRequest`]: the `pk`
/// predicate columns must be exactly the table's real primary-key columns.
///
/// Rejected (all §5 errors): a table with NO primary key; a predicate naming a
/// non-pk (or unknown) column; a partial pk (some pk column missing); a
/// duplicate pk column in the predicates. This guarantees the WHERE clause
/// targets at most one row — the mass-update prevention the editor relies on.
fn validate_pk_predicates(
    meta: &TableMeta,
    table: &str,
    predicates: &[PkPredicate],
) -> Result<(), AppError> {
    let pk_columns: Vec<&str> = meta
        .columns
        .iter()
        .filter(|c| c.pk)
        .map(|c| c.name.as_str())
        .collect();

    if pk_columns.is_empty() {
        return Err(AppError::Database(format!(
            "Cannot update '{table}': it has no primary key, so a single row \
             cannot be safely targeted."
        )));
    }

    if predicates.is_empty() {
        return Err(AppError::Database(format!(
            "Updating a cell in '{table}' requires the full primary key \
             ({}).",
            pk_columns.join(", ")
        )));
    }

    // Every predicate must name a real pk column, with no duplicates.
    let mut seen: Vec<&str> = Vec::with_capacity(predicates.len());
    for predicate in predicates {
        let column = predicate.column.as_str();
        if !pk_columns.contains(&column) {
            // Distinguish "exists but not pk" from "unknown column" for a
            // clearer message; both are §5 errors.
            if meta.columns.iter().any(|c| c.name == column) {
                return Err(AppError::Database(format!(
                    "Column '{column}' is not part of the primary key of '{table}' \
                     (primary key: {}); an update must target the row by its primary key.",
                    pk_columns.join(", ")
                )));
            }
            return Err(validate_column(meta, table, column).expect_err("unknown pk column"));
        }
        if seen.contains(&column) {
            return Err(AppError::Database(format!(
                "Primary-key column '{column}' is given more than once in the update."
            )));
        }
        seen.push(column);
    }

    // And the predicate set must COVER the whole pk — no missing pk column.
    if let Some(missing) = pk_columns.iter().find(|c| !seen.contains(c)) {
        return Err(AppError::Database(format!(
            "Updating a cell in '{table}' requires the full primary key \
             ({}); '{missing}' is missing.",
            pk_columns.join(", ")
        )));
    }

    Ok(())
}

/// Map a JSON scalar to a bound SQLite value for a `SET col = ?` clause. Unlike
/// [`json_to_sql_value`] (written for WHERE-equality, where `= NULL` is a bug),
/// a NULL here is the legitimate "set the cell to NULL" case and binds as
/// [`SqlValue::Null`]. Non-null values reuse [`json_to_sql_value`]'s mapping;
/// nested arrays/objects (not valid scalars) fall back to their JSON text so
/// the engine — not a panic — decides (a NOT-a-scalar value is unusual for a
/// cell edit, but we never lose data or interpolate).
fn json_to_set_value(value: &serde_json::Value) -> SqlValue {
    match value {
        serde_json::Value::Null => SqlValue::Null,
        other => json_to_sql_value(other).unwrap_or_else(|_| SqlValue::Text(other.to_string())),
    }
}

/// Bind a binary-column operand (filter/pk) as a SQLite BLOB: the renderer's
/// `0x`-hex / UUID value decoded to raw bytes. NULL is rejected like any operand
/// NULL (use IS NULL / IS NOT NULL).
fn json_to_blob_operand(value: &serde_json::Value) -> Result<SqlValue, AppError> {
    match crate::shared::engine::parse_binary_value(value)? {
        Some(bytes) => Ok(SqlValue::Blob(bytes)),
        None => Err(AppError::Database(
            "Use IS NULL / IS NOT NULL to compare with NULL.".to_string(),
        )),
    }
}

/// Bind a binary-column `SET col = ?` value as a SQLite BLOB: decoded bytes, or
/// NULL when the renderer sends null.
fn json_to_blob_set(value: &serde_json::Value) -> Result<SqlValue, AppError> {
    Ok(match crate::shared::engine::parse_binary_value(value)? {
        Some(bytes) => SqlValue::Blob(bytes),
        None => SqlValue::Null,
    })
}

/// Render a human-readable, values-inlined UPDATE for the §3.5 toast. Cosmetic
/// only — the executed query binds every value (see [`UpdateResult`]); this
/// shows what the bound query does, with identifiers quoted and values rendered
/// as SQL literals so the toast reads naturally.
fn display_update_statement(
    qualified: &str,
    column: &str,
    value: &serde_json::Value,
    pk: &[PkPredicate],
) -> String {
    let set = format!("{} = {}", quote_ident(column), sql_literal(value));
    let where_sql = pk
        .iter()
        .map(|p| format!("{} = {}", quote_ident(&p.column), sql_literal(&p.value)))
        .collect::<Vec<_>>()
        .join(" AND ");
    format!("UPDATE {qualified} SET {set} WHERE {where_sql}")
}

/// Render a JSON scalar as a display SQL literal for the cosmetic toast string.
/// Strings are single-quoted with `'` doubled (so the displayed statement is
/// itself valid SQL); NULL/number/bool render verbatim. NOT for execution — the
/// real query binds (see [`display_update_statement`]).
fn sql_literal(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Null => "NULL".to_string(),
        serde_json::Value::Bool(b) => i64::from(*b).to_string(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::String(s) => format!("'{}'", s.replace('\'', "''")),
        // Arrays/objects are not valid cell scalars; show their JSON text quoted
        // so the toast still renders something truthful.
        other => format!("'{}'", other.to_string().replace('\'', "''")),
    }
}

/// Map a JSON `null` (SQLite NULL aggregate result) to `None`, anything else
/// to `Some`. Used for min/max which return SQL NULL over an empty/all-NULL set.
fn non_null(value: serde_json::Value) -> Option<serde_json::Value> {
    match value {
        serde_json::Value::Null => None,
        other => Some(other),
    }
}

/// Validate that `column` is a real column of the table (§5 error otherwise,
/// listing the available columns) — the shared check used by the FK peek and
/// column-stats lookups, identical to the sort/filter column validation.
fn validate_column(meta: &TableMeta, table: &str, column: &str) -> Result<(), AppError> {
    if meta.columns.iter().any(|c| c.name == column) {
        return Ok(());
    }
    let listing: Vec<&str> = meta.columns.iter().map(|c| c.name.as_str()).collect();
    Err(AppError::Database(format!(
        "Column '{column}' does not exist on '{table}' (columns: {}).",
        listing.join(", ")
    )))
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
    validate_column(meta, table, &condition.column)?;
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
            params.push(if condition.binary {
                json_to_blob_operand(value)?
            } else {
                json_to_sql_value(value)?
            });
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
                params.push(if condition.binary {
                    json_to_blob_operand(value)?
                } else {
                    json_to_sql_value(value)?
                });
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
    validate_column(meta, table, &sort.column)?;
    Ok(format!(
        "{} {}",
        quote_ident(&sort.column),
        sort.direction.sql_keyword()
    ))
}

/// SQLite value → JSON. Blobs become hex or a `"[N bytes]"` placeholder (see
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
        // Blobs: hex when small (UUID/key), `[N bytes]` placeholder when large.
        // Shared with MySQL/Postgres so binary renders identically everywhere.
        ValueRef::Blob(bytes) => crate::shared::engine::binary_to_json(bytes),
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

    async fn open_fixture(dir: &tempfile::TempDir) -> std::sync::Arc<dyn EngineConnection> {
        let path = dir.path().join("fixture.db");
        create_fixture_db(&path);
        SqliteConnector
            .open(&params_for(&path))
            .await
            .expect("open fixture db")
            .into_sql()
            .expect("sql connection")
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
                tls_mode: crate::shared::engine::TlsMode::Disable,
                ssh: None,
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
    async fn open_meta_fixture(dir: &tempfile::TempDir) -> std::sync::Arc<dyn EngineConnection> {
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
                     notes DEFAULT 'none'
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
            .into_sql()
            .expect("sql connection")
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
                default_value: None,
                fk: None,
            },
            ColumnInfo {
                name: "title".into(),
                data_type: "TEXT".into(),
                nullable: false,
                pk: false,
                default_value: None,
                fk: None,
            },
            ColumnInfo {
                name: "author_id".into(),
                data_type: "INTEGER".into(),
                nullable: false,
                pk: false,
                default_value: None,
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
                default_value: None,
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
                default_value: None,
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
                // DEFAULT expression surfaced verbatim from dflt_value.
                default_value: Some("'none'".into()),
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

    // -- table_meta structure view (M7 §3.6) --------------------------------

    /// A fixture exercising the structure-view facets: a parent table
    /// referenced by two children (one composite fk with `ON DELETE`), single
    /// and composite secondary indexes (unique and non-unique), and the
    /// implicit primary-key index.
    async fn open_structure_fixture(
        dir: &tempfile::TempDir,
    ) -> std::sync::Arc<dyn EngineConnection> {
        let path = dir.path().join("structure.db");
        {
            let conn = Connection::open(&path).expect("create db");
            conn.execute_batch(
                "CREATE TABLE authors (
                     id INTEGER PRIMARY KEY,
                     country TEXT,
                     name TEXT NOT NULL
                 );
                 CREATE UNIQUE INDEX idx_authors_name ON authors(name);
                 CREATE INDEX idx_authors_country_name ON authors(country, name);

                 CREATE TABLE books (
                     id INTEGER PRIMARY KEY,
                     author_id INTEGER REFERENCES authors(id) ON DELETE CASCADE,
                     title TEXT
                 );

                 -- A second child of authors, with a composite fk back to it.
                 CREATE TABLE coauthored (
                     book_id INTEGER,
                     primary_author INTEGER,
                     secondary_author INTEGER,
                     PRIMARY KEY (book_id, primary_author),
                     FOREIGN KEY (primary_author, secondary_author)
                         REFERENCES author_pairs(lead, support) ON DELETE SET NULL
                 );

                 -- A table with a composite fk so we can assert grouping/order.
                 CREATE TABLE author_pairs (
                     lead INTEGER,
                     support INTEGER,
                     PRIMARY KEY (lead, support)
                 );",
            )
            .expect("seed db");
        }
        SqliteConnector
            .open(&params_for(&path))
            .await
            .expect("open structure fixture")
            .into_sql()
            .expect("sql connection")
    }

    #[tokio::test]
    async fn table_meta_reports_indexes_with_ordered_columns_and_flags() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_structure_fixture(&dir).await;
        let meta = conn
            .table_meta("main", "authors")
            .await
            .expect("table meta");

        // `authors.id` is `INTEGER PRIMARY KEY` — an alias for the rowid, so
        // SQLite stores NO separate pk index for it (it lists nothing with
        // origin "pk"). The implicit pk index only materialises for a
        // *non-rowid* pk (composite / non-INTEGER) — asserted on author_pairs
        // below.
        assert!(
            !meta.indexes.iter().any(|i| i.primary),
            "an INTEGER PRIMARY KEY (rowid alias) has no separate pk index"
        );

        let pairs = conn
            .table_meta("main", "author_pairs")
            .await
            .expect("author_pairs meta");
        let pk = pairs
            .indexes
            .iter()
            .find(|i| i.primary)
            .expect("a composite pk has an implicit pk index");
        assert!(pk.unique, "the pk index is unique");
        assert_eq!(pk.origin.as_deref(), Some("pk"));
        assert_eq!(pk.columns, vec!["lead", "support"]);

        // The UNIQUE single-column index.
        let unique = meta
            .indexes
            .iter()
            .find(|i| i.name == "idx_authors_name")
            .expect("the unique index");
        assert!(unique.unique);
        assert!(!unique.primary);
        assert_eq!(unique.origin.as_deref(), Some("c"));
        assert_eq!(unique.columns, vec!["name"]);

        // The non-unique composite index keeps column order.
        let composite = meta
            .indexes
            .iter()
            .find(|i| i.name == "idx_authors_country_name")
            .expect("the composite index");
        assert!(!composite.unique);
        assert!(!composite.primary);
        assert_eq!(composite.columns, vec!["country", "name"]);
    }

    #[tokio::test]
    async fn table_meta_reports_table_level_foreign_keys_grouped_and_ordered() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_structure_fixture(&dir).await;

        // Single-column fk with ON DELETE captured.
        let books = conn.table_meta("main", "books").await.expect("books meta");
        assert_eq!(books.foreign_keys.len(), 1);
        let fk = &books.foreign_keys[0];
        assert_eq!(fk.name, None, "SQLite fks have no name");
        assert_eq!(fk.columns, vec!["author_id"]);
        assert_eq!(fk.ref_table, "authors");
        assert_eq!(fk.ref_columns, vec!["id"]);
        assert_eq!(fk.on_delete.as_deref(), Some("CASCADE"));

        // Composite fk: a single grouped entry with parallel, ordered columns.
        let coauthored = conn
            .table_meta("main", "coauthored")
            .await
            .expect("coauthored meta");
        assert_eq!(
            coauthored.foreign_keys.len(),
            1,
            "the composite fk is one grouped entry"
        );
        let composite = &coauthored.foreign_keys[0];
        assert_eq!(
            composite.columns,
            vec!["primary_author", "secondary_author"]
        );
        assert_eq!(composite.ref_table, "author_pairs");
        assert_eq!(composite.ref_columns, vec!["lead", "support"]);
        assert_eq!(composite.on_delete.as_deref(), Some("SET NULL"));
    }

    #[tokio::test]
    async fn table_meta_reports_inbound_foreign_keys_from_every_child() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_structure_fixture(&dir).await;

        // authors is referenced by `books` (author_id → id).
        let authors = conn
            .table_meta("main", "authors")
            .await
            .expect("authors meta");
        let inbound: Vec<&str> = authors
            .referenced_by
            .iter()
            .map(|f| f.table.as_str())
            .collect();
        assert_eq!(inbound, vec!["books"]);
        let from_books = &authors.referenced_by[0];
        assert_eq!(from_books.columns, vec!["author_id"]);
        assert_eq!(from_books.ref_columns, vec!["id"]);
        assert_eq!(from_books.on_delete.as_deref(), Some("CASCADE"));

        // author_pairs is referenced by `coauthored`'s composite fk.
        let pairs = conn
            .table_meta("main", "author_pairs")
            .await
            .expect("author_pairs meta");
        assert_eq!(pairs.referenced_by.len(), 1);
        let inbound = &pairs.referenced_by[0];
        assert_eq!(inbound.table, "coauthored");
        assert_eq!(inbound.columns, vec!["primary_author", "secondary_author"]);
        assert_eq!(inbound.ref_columns, vec!["lead", "support"]);
    }

    #[tokio::test]
    async fn table_meta_referenced_by_can_list_multiple_children() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("multi.db");
        {
            let conn = Connection::open(&path).expect("create db");
            conn.execute_batch(
                "CREATE TABLE parent (id INTEGER PRIMARY KEY);
                 CREATE TABLE child_a (id INTEGER PRIMARY KEY, pid INTEGER REFERENCES parent(id));
                 CREATE TABLE child_b (id INTEGER PRIMARY KEY, pid INTEGER REFERENCES parent(id) ON DELETE CASCADE);",
            )
            .expect("seed db");
        }
        let conn = SqliteConnector
            .open(&params_for(&path))
            .await
            .expect("open db")
            .into_sql()
            .expect("sql connection");
        let parent = conn
            .table_meta("main", "parent")
            .await
            .expect("parent meta");
        let mut children: Vec<&str> = parent
            .referenced_by
            .iter()
            .map(|f| f.table.as_str())
            .collect();
        children.sort_unstable();
        assert_eq!(children, vec!["child_a", "child_b"]);
        for inbound in &parent.referenced_by {
            assert_eq!(inbound.columns, vec!["pid"]);
            assert_eq!(inbound.ref_columns, vec!["id"]);
        }
        // The cascade child carries its ON DELETE.
        let cascade = parent
            .referenced_by
            .iter()
            .find(|f| f.table == "child_b")
            .expect("child_b");
        assert_eq!(cascade.on_delete.as_deref(), Some("CASCADE"));
    }

    #[tokio::test]
    async fn table_meta_ddl_is_returned_verbatim() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_structure_fixture(&dir).await;
        let meta = conn.table_meta("main", "books").await.expect("books meta");
        let ddl = meta.ddl.expect("ddl is present");
        assert!(
            ddl.contains("CREATE TABLE"),
            "ddl should be the CREATE TABLE statement: {ddl:?}"
        );
        assert!(ddl.contains("author_id"), "ddl is verbatim: {ddl:?}");
    }

    #[tokio::test]
    async fn table_meta_comment_is_none_for_sqlite() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_structure_fixture(&dir).await;
        let meta = conn.table_meta("main", "books").await.expect("books meta");
        assert_eq!(meta.comment, None);
    }

    #[tokio::test]
    async fn table_meta_for_unknown_table_still_errors_with_structure_fields() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_structure_fixture(&dir).await;
        let err = conn.table_meta("main", "ghosts").await.unwrap_err();
        assert!(matches!(err, AppError::Database(_)));
        assert!(
            err.to_string().contains("does not exist"),
            "unknown table is still a §5 error: {err}"
        );
    }

    #[tokio::test]
    async fn table_meta_handles_a_wide_64_column_table() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("wide.db");
        let column_defs: Vec<String> = (0..64).map(|i| format!("c{i} INTEGER")).collect();
        {
            let conn = Connection::open(&path).expect("create db");
            conn.execute_batch(&format!("CREATE TABLE wide ({});", column_defs.join(", ")))
                .expect("seed db");
        }
        let conn = SqliteConnector
            .open(&params_for(&path))
            .await
            .expect("open db")
            .into_sql()
            .expect("sql connection");
        let meta = conn.table_meta("main", "wide").await.expect("wide meta");
        assert_eq!(meta.columns.len(), 64, "all 64 columns are returned");
        let names: Vec<&str> = meta.columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names[0], "c0");
        assert_eq!(names[63], "c63");
        // A wide table with no constraints has no fks/indexes but valid ddl.
        assert!(meta.foreign_keys.is_empty());
        assert!(meta.referenced_by.is_empty());
        assert!(meta.ddl.expect("ddl").contains("CREATE TABLE"));
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

    #[test]
    fn escape_like_escapes_metacharacters_and_the_escape_char() {
        assert_eq!(escape_like("plain"), "plain");
        assert_eq!(escape_like("100%"), "100\\%");
        assert_eq!(escape_like("a_b"), "a\\_b");
        // The escape char itself is doubled so it cannot escape a real meta.
        assert_eq!(escape_like("a\\b"), "a\\\\b");
    }

    // -- fetch_row_by_key (M10 FK peek) -------------------------------------

    use crate::shared::engine::{ColumnStatsRequest, RowLookupRequest};

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

    // -- update_cell (M11 inline edit) -------------------------------------
    //
    // These drive `update_cell_blocking` directly against an in-memory
    // connection (the structure.rs convention) so the SQL behaviour and the
    // affected-count / pk guards are observable without IPC.

    /// An in-memory connection seeded with the given SQL batch.
    fn mem_db(setup: &str) -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(setup).expect("seed db");
        conn
    }

    fn pk(column: &str, value: serde_json::Value) -> PkPredicate {
        PkPredicate {
            column: column.into(),
            value,
            binary: false,
        }
    }

    fn update_req(
        table: &str,
        column: &str,
        value: serde_json::Value,
        pk: Vec<PkPredicate>,
    ) -> UpdateCellRequest {
        UpdateCellRequest {
            schema: "main".into(),
            table: table.into(),
            column: column.into(),
            value,
            pk,
            binary: false,
        }
    }

    /// Read one cell back as JSON for verification (via `value_to_json`, so it
    /// matches what the grid would see).
    fn cell(conn: &Connection, sql: &str) -> serde_json::Value {
        conn.query_row(sql, [], |row| Ok(value_to_json(row.get_ref(0)?)))
            .expect("read cell")
    }

    #[test]
    fn update_text_cell_persists_and_reports_one_affected() {
        let conn = mem_db(
            "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL); \
             INSERT INTO users VALUES (1, 'ada'), (2, 'grace');",
        );
        let result = update_cell_blocking(
            &conn,
            &update_req(
                "users",
                "name",
                serde_json::json!("Ada L"),
                vec![pk("id", serde_json::json!(1))],
            ),
        )
        .expect("update");
        assert_eq!(result.affected, 1);
        // Cosmetic statement reads as a sane, values-inlined UPDATE.
        assert_eq!(
            result.statement,
            r#"UPDATE "main"."users" SET "name" = 'Ada L' WHERE "id" = 1"#
        );
        // Value persisted; the other row is untouched.
        assert_eq!(
            cell(&conn, "SELECT name FROM users WHERE id = 1"),
            serde_json::json!("Ada L")
        );
        assert_eq!(
            cell(&conn, "SELECT name FROM users WHERE id = 2"),
            serde_json::json!("grace")
        );
    }

    #[test]
    fn update_number_cell_persists() {
        let conn = mem_db(
            "CREATE TABLE products (id INTEGER PRIMARY KEY, price REAL); \
             INSERT INTO products VALUES (1, 1.5);",
        );
        let result = update_cell_blocking(
            &conn,
            &update_req(
                "products",
                "price",
                serde_json::json!(9.99),
                vec![pk("id", serde_json::json!(1))],
            ),
        )
        .expect("update");
        assert_eq!(result.affected, 1);
        assert_eq!(
            cell(&conn, "SELECT price FROM products WHERE id = 1"),
            serde_json::json!(9.99)
        );
    }

    #[test]
    fn update_to_null_on_nullable_column_persists_null() {
        let conn = mem_db(
            "CREATE TABLE users (id INTEGER PRIMARY KEY, score REAL); \
             INSERT INTO users VALUES (1, 9.5);",
        );
        let result = update_cell_blocking(
            &conn,
            &update_req(
                "users",
                "score",
                serde_json::Value::Null,
                vec![pk("id", serde_json::json!(1))],
            ),
        )
        .expect("update to null");
        assert_eq!(result.affected, 1);
        assert_eq!(
            result.statement,
            r#"UPDATE "main"."users" SET "score" = NULL WHERE "id" = 1"#
        );
        // Stored as a real SQL NULL.
        assert_eq!(
            cell(&conn, "SELECT score FROM users WHERE id = 1"),
            serde_json::Value::Null
        );
        let nulls: i64 = conn
            .query_row("SELECT count(*) FROM users WHERE score IS NULL", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(nulls, 1);
    }

    #[test]
    fn update_composite_pk_targets_the_one_row() {
        let conn = mem_db(
            "CREATE TABLE t (a INTEGER, b TEXT, val TEXT, PRIMARY KEY (a, b)); \
             INSERT INTO t VALUES (1, 'x', 'old1'), (1, 'y', 'old2'), (2, 'x', 'old3');",
        );
        let result = update_cell_blocking(
            &conn,
            &update_req(
                "t",
                "val",
                serde_json::json!("new"),
                vec![
                    pk("a", serde_json::json!(1)),
                    pk("b", serde_json::json!("x")),
                ],
            ),
        )
        .expect("composite update");
        assert_eq!(result.affected, 1);
        // Only (1,'x') changed; the others are untouched.
        assert_eq!(
            cell(&conn, "SELECT val FROM t WHERE a = 1 AND b = 'x'"),
            serde_json::json!("new")
        );
        assert_eq!(
            cell(&conn, "SELECT val FROM t WHERE a = 1 AND b = 'y'"),
            serde_json::json!("old2")
        );
        assert_eq!(
            cell(&conn, "SELECT val FROM t WHERE a = 2 AND b = 'x'"),
            serde_json::json!("old3")
        );
    }

    #[test]
    fn update_composite_pk_partial_pk_is_rejected() {
        let conn = mem_db(
            "CREATE TABLE t (a INTEGER, b TEXT, val TEXT, PRIMARY KEY (a, b)); \
             INSERT INTO t VALUES (1, 'x', 'old');",
        );
        // Only one of the two pk columns given → partial pk → §5 error.
        let err = update_cell_blocking(
            &conn,
            &update_req(
                "t",
                "val",
                serde_json::json!("new"),
                vec![pk("a", serde_json::json!(1))],
            ),
        )
        .unwrap_err();
        assert!(matches!(err, AppError::Database(_)));
        assert!(err.to_string().contains("full primary key"), "got {err}");
        assert!(err.to_string().contains("'b' is missing"), "got {err}");
        // Table unchanged.
        assert_eq!(
            cell(&conn, "SELECT val FROM t WHERE a = 1 AND b = 'x'"),
            serde_json::json!("old")
        );
    }

    #[test]
    fn update_on_table_with_no_pk_is_rejected() {
        let conn = mem_db(
            "CREATE TABLE logs (msg TEXT, level TEXT); \
             INSERT INTO logs VALUES ('hi', 'info');",
        );
        let err = update_cell_blocking(
            &conn,
            &update_req(
                "logs",
                "msg",
                serde_json::json!("bye"),
                vec![pk("rowid", serde_json::json!(1))],
            ),
        )
        .unwrap_err();
        assert!(matches!(err, AppError::Database(_)));
        assert!(err.to_string().contains("no primary key"), "got {err}");
        // Table unchanged.
        assert_eq!(cell(&conn, "SELECT msg FROM logs"), serde_json::json!("hi"));
    }

    #[test]
    fn update_pk_predicate_on_non_pk_column_is_rejected() {
        let conn = mem_db(
            "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT); \
             INSERT INTO users VALUES (1, 'ada', 'a@b');",
        );
        // 'email' is a real column but not the pk → reject (must target by pk).
        let err = update_cell_blocking(
            &conn,
            &update_req(
                "users",
                "name",
                serde_json::json!("x"),
                vec![pk("email", serde_json::json!("a@b"))],
            ),
        )
        .unwrap_err();
        assert!(matches!(err, AppError::Database(_)));
        assert!(
            err.to_string().contains("not part of the primary key"),
            "got {err}"
        );
        assert_eq!(
            cell(&conn, "SELECT name FROM users WHERE id = 1"),
            serde_json::json!("ada")
        );
    }

    #[test]
    fn update_unknown_pk_column_is_a_human_error() {
        let conn = mem_db("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);");
        let err = update_cell_blocking(
            &conn,
            &update_req(
                "users",
                "name",
                serde_json::json!("x"),
                vec![pk("ghost", serde_json::json!(1))],
            ),
        )
        .unwrap_err();
        assert!(err.to_string().contains("does not exist"), "got {err}");
    }

    #[test]
    fn update_stale_pk_matches_no_row() {
        let conn = mem_db(
            "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT); \
             INSERT INTO users VALUES (1, 'ada');",
        );
        // id 999 does not exist → affected 0 → §5 "no row matched".
        let err = update_cell_blocking(
            &conn,
            &update_req(
                "users",
                "name",
                serde_json::json!("x"),
                vec![pk("id", serde_json::json!(999))],
            ),
        )
        .unwrap_err();
        assert!(matches!(err, AppError::Database(_)));
        assert!(err.to_string().contains("No row matched"), "got {err}");
        // Existing row untouched.
        assert_eq!(
            cell(&conn, "SELECT name FROM users WHERE id = 1"),
            serde_json::json!("ada")
        );
    }

    #[test]
    fn update_null_pk_value_matches_no_row() {
        let conn = mem_db(
            "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT); \
             INSERT INTO users VALUES (1, 'ada');",
        );
        // A null pk value can never match `= NULL` — short-circuits to "no row".
        let err = update_cell_blocking(
            &conn,
            &update_req(
                "users",
                "name",
                serde_json::json!("x"),
                vec![pk("id", serde_json::Value::Null)],
            ),
        )
        .unwrap_err();
        assert!(err.to_string().contains("No row matched"), "got {err}");
        assert_eq!(
            cell(&conn, "SELECT name FROM users WHERE id = 1"),
            serde_json::json!("ada")
        );
    }

    #[test]
    fn update_binds_injection_payload_as_a_literal() {
        let conn = mem_db(
            "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT); \
             INSERT INTO t VALUES (1, 'safe'), (2, 'other');",
        );
        let payload = "'; DROP TABLE t; --";
        let result = update_cell_blocking(
            &conn,
            // Both the new value AND a pk value carry injection text. The pk
            // value won't match row 1, so target row 1 by its real id and put
            // the payload only in the new value to assert the literal store; a
            // second call exercises an injection pk value matching nothing.
            &update_req(
                "t",
                "name",
                serde_json::json!(payload),
                vec![pk("id", serde_json::json!(1))],
            ),
        )
        .expect("update with injection payload");
        assert_eq!(result.affected, 1);
        // The table still exists and only row 1's cell holds the literal string.
        assert_eq!(
            cell(&conn, "SELECT name FROM t WHERE id = 1"),
            serde_json::json!(payload)
        );
        assert_eq!(
            cell(&conn, "SELECT name FROM t WHERE id = 2"),
            serde_json::json!("other")
        );
        let count: i64 = conn
            .query_row("SELECT count(*) FROM t", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 2, "table survived — payload was not executed");

        // An injection string as the PK value binds as a literal that matches
        // nothing (it is not a real id), and the table is untouched.
        let err = update_cell_blocking(
            &conn,
            &update_req(
                "t",
                "name",
                serde_json::json!("x"),
                vec![pk("id", serde_json::json!("1; DROP TABLE t; --"))],
            ),
        )
        .unwrap_err();
        assert!(err.to_string().contains("No row matched"), "got {err}");
        let count: i64 = conn
            .query_row("SELECT count(*) FROM t", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 2, "table survived the pk injection payload");
    }

    #[test]
    fn update_unknown_column_table_schema_are_human_errors() {
        let conn = mem_db("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);");
        // Unknown column.
        let err = update_cell_blocking(
            &conn,
            &update_req(
                "users",
                "ghost",
                serde_json::json!("x"),
                vec![pk("id", serde_json::json!(1))],
            ),
        )
        .unwrap_err();
        assert!(
            err.to_string().contains("Column 'ghost' does not exist"),
            "got {err}"
        );
        // Unknown table.
        let err = update_cell_blocking(
            &conn,
            &update_req(
                "ghosts",
                "name",
                serde_json::json!("x"),
                vec![pk("id", serde_json::json!(1))],
            ),
        )
        .unwrap_err();
        assert!(
            err.to_string().contains("Table 'ghosts' does not exist"),
            "got {err}"
        );
        // Unknown schema.
        let err = update_cell_blocking(
            &conn,
            &UpdateCellRequest {
                schema: "warehouse".into(),
                ..update_req(
                    "users",
                    "name",
                    serde_json::json!("x"),
                    vec![pk("id", serde_json::json!(1))],
                )
            },
        )
        .unwrap_err();
        assert!(err.to_string().contains("Schema 'warehouse'"), "got {err}");
    }

    #[test]
    fn update_not_null_violation_rolls_back_and_leaves_row_unchanged() {
        let conn = mem_db(
            "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL); \
             INSERT INTO users VALUES (1, 'ada');",
        );
        // Setting a NOT NULL column to NULL fails the constraint → §5 error,
        // transaction rolls back, the row keeps its old value.
        let err = update_cell_blocking(
            &conn,
            &update_req(
                "users",
                "name",
                serde_json::Value::Null,
                vec![pk("id", serde_json::json!(1))],
            ),
        )
        .unwrap_err();
        assert!(matches!(err, AppError::Database(_)));
        assert_eq!(
            cell(&conn, "SELECT name FROM users WHERE id = 1"),
            serde_json::json!("ada")
        );
        // And a subsequent valid update still works (the connection isn't stuck
        // in a half-open transaction after the rollback).
        update_cell_blocking(
            &conn,
            &update_req(
                "users",
                "name",
                serde_json::json!("grace"),
                vec![pk("id", serde_json::json!(1))],
            ),
        )
        .expect("update after rollback");
        assert_eq!(
            cell(&conn, "SELECT name FROM users WHERE id = 1"),
            serde_json::json!("grace")
        );
    }

    #[test]
    fn update_statement_quotes_identifiers_and_doubles_quotes_in_string_literals() {
        let conn = mem_db(
            "CREATE TABLE t (id INTEGER PRIMARY KEY, note TEXT); \
             INSERT INTO t VALUES (1, 'x');",
        );
        let result = update_cell_blocking(
            &conn,
            &update_req(
                "t",
                "note",
                serde_json::json!("O'Brien"),
                vec![pk("id", serde_json::json!(1))],
            ),
        )
        .expect("update");
        // The cosmetic statement doubles the single quote so it is itself valid
        // display SQL; the executed query bound the value (the cell is exact).
        assert_eq!(
            result.statement,
            r#"UPDATE "main"."t" SET "note" = 'O''Brien' WHERE "id" = 1"#
        );
        assert_eq!(
            cell(&conn, "SELECT note FROM t WHERE id = 1"),
            serde_json::json!("O'Brien")
        );
    }

    // ---- M15 truncate + identifier quoting ----

    #[test]
    fn quote_identifier_uses_double_quotes_and_doubles_embedded() {
        let conn = SqliteEngineConnection {
            conn: Arc::new(Mutex::new(Connection::open_in_memory().unwrap())),
            info: sqlite_engine_info(),
        };
        assert_eq!(conn.quote_identifier("users"), "\"users\"");
        assert_eq!(conn.quote_identifier("we\"ird"), "\"we\"\"ird\"");
    }

    #[tokio::test]
    async fn truncate_empties_a_table_and_reports_prior_count() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_fixture(&dir).await;
        // users has 3 rows.
        let affected = conn
            .truncate_table("main", "users")
            .await
            .expect("truncate");
        assert_eq!(affected, 3);
        let page = conn
            .fetch_rows(FetchRowsRequest {
                schema: "main".into(),
                table: "users".into(),
                sort: None,
                filter: None,
                offset: 0,
                limit: 100,
            })
            .await
            .expect("fetch after truncate");
        assert_eq!(page.total_rows, Some(0));
        assert!(page.rows.is_empty());
    }

    #[tokio::test]
    async fn truncate_empty_table_is_zero() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_fixture(&dir).await;
        // orders is created empty.
        let affected = conn
            .truncate_table("main", "orders")
            .await
            .expect("truncate");
        assert_eq!(affected, 0);
    }

    #[tokio::test]
    async fn truncate_unknown_table_is_a_human_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_fixture(&dir).await;
        let err = conn.truncate_table("main", "ghost").await.unwrap_err();
        assert!(matches!(err, AppError::Database(_)));
        assert!(err.to_string().contains("does not exist"));
    }

    // ---- M15 drop-schema (drop every user table; the file IS the schema) ----

    #[tokio::test]
    async fn drop_schema_drops_every_user_table_and_keeps_the_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("fixture.db");
        create_fixture_db(&path); // users (3 rows) + orders
        let conn = SqliteConnector
            .open(&params_for(&path))
            .await
            .expect("open fixture db")
            .into_sql()
            .expect("sql connection");

        // Two user tables before.
        let before = conn.list_tables("main").await.expect("list before");
        assert_eq!(before.len(), 2);

        conn.drop_schema("main").await.expect("drop schema");

        // Zero user tables after — but the schema (and file) still exist.
        let after = conn.list_tables("main").await.expect("list after");
        assert!(after.is_empty(), "schema must be emptied, got {after:?}");
        assert!(path.exists(), "the database file must NOT be deleted");

        // The empty schema is reusable: a fresh CREATE works.
        conn.run_query(
            "CREATE TABLE again (id INTEGER PRIMARY KEY)",
            QueryOptions::default(),
        )
        .await
        .expect("recreate a table in the emptied schema");
        let reborn = conn.list_tables("main").await.expect("list reborn");
        assert_eq!(reborn.len(), 1);
    }

    #[tokio::test]
    async fn drop_schema_handles_foreign_keys_regardless_of_order() {
        // FK parent/child: deferring FK checks lets us drop in any order without
        // a constraint violation, leaving an empty schema.
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("fk.db");
        {
            let raw = Connection::open(&path).expect("create db");
            raw.execute_batch(
                "CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
                 CREATE TABLE books (
                     id INTEGER PRIMARY KEY,
                     author_id INTEGER NOT NULL REFERENCES authors(id)
                 );
                 INSERT INTO authors (id, name) VALUES (1, 'ada');
                 INSERT INTO books (id, author_id) VALUES (10, 1);",
            )
            .expect("seed fk db");
        }
        let conn = SqliteConnector
            .open(&params_for(&path))
            .await
            .expect("open fk db")
            .into_sql()
            .expect("sql connection");

        conn.drop_schema("main")
            .await
            .expect("drop schema with FKs");
        let after = conn.list_tables("main").await.expect("list after");
        assert!(after.is_empty(), "all tables dropped, got {after:?}");
    }

    #[tokio::test]
    async fn drop_schema_on_an_empty_schema_is_a_no_op() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("empty.db");
        {
            let raw = Connection::open(&path).expect("create db");
            raw.execute_batch("CREATE TABLE t (id INTEGER PRIMARY KEY);")
                .expect("seed");
        }
        let conn = SqliteConnector
            .open(&params_for(&path))
            .await
            .expect("open db")
            .into_sql()
            .expect("sql connection");
        conn.drop_schema("main").await.expect("first drop");
        // Dropping an already-empty schema succeeds (nothing to drop).
        conn.drop_schema("main")
            .await
            .expect("second drop is a no-op");
        assert!(conn.list_tables("main").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn drop_schema_unknown_schema_is_a_human_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_fixture(&dir).await;
        let err = conn.drop_schema("ghost").await.unwrap_err();
        assert!(matches!(err, AppError::Database(_)));
        assert!(err.to_string().contains("does not exist"));
    }
}
