//! Engine abstraction: the port traits every database engine adapter
//! implements. Slices depend only on these traits; engine-specific SQL and
//! drivers live exclusively in adapter modules under `crate::engines`
//! (`engines::sqlite` today; `engines::mysql` / `engines::postgres` in M12).
//!
//! M2 note: the original `SchemaReader` / `QueryExecutor` stub traits were
//! folded into [`EngineConnection`] — introspection and query execution are
//! operations *on an open connection*, so one object owning the driver
//! handle is the natural seam. [`DdlDialect`] remains a stub until M8/M14.
//!
//! # Async commands rule
//!
//! Any slice that touches a database MUST expose `async fn` Tauri commands
//! and these port traits are async (`async_trait`). Sync commands run on the
//! main thread, so a slow query or connection attempt would freeze the
//! entire UI for its duration.
//!
//! Driver caveats:
//! - `rusqlite` is synchronous and its `Connection` is `!Sync` — the SQLite
//!   adapter wraps it in `Arc<std::sync::Mutex<…>>` and hops every operation
//!   through `tokio::task::spawn_blocking` so async executor threads never
//!   block (Tauri's async runtime *is* tokio).
//! - `sqlx` (MySQL/Postgres, M12) is natively async and can be awaited
//!   directly.
//!
//! The preferences slice is the one deliberate exception: it stays sync
//! because it only reads/writes a tiny local JSON file (see
//! `features::preferences`). Do not copy its sync commands into DB-touching
//! slices.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::shared::error::AppError;

/// Database engines ByteTable supports. Lowercase on the wire, matching the
/// renderer's `Engine` type in `src/shared/types.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    Sqlite,
    Mysql,
    Postgres,
}

impl Engine {
    /// Human display name for error messages and UI copy.
    pub fn display_name(self) -> &'static str {
        match self {
            Self::Sqlite => "SQLite",
            Self::Mysql => "MySQL",
            Self::Postgres => "PostgreSQL",
        }
    }
}

/// Everything needed to reach a database, per engine.
///
/// Internally tagged with `engine` (lowercase) so the wire shape is
/// `{ "engine": "sqlite", "path": "…" }` — the tag doubles as the engine
/// discriminant the renderer already uses.
///
/// Security: server variants intentionally have NO password field. Secrets
/// go to the OS keychain in M12; until then server engines are unsupported
/// and these variants exist only to fix the shape.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "engine",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum ConnectionParams {
    /// A SQLite database file on disk. No secrets involved.
    Sqlite { path: String },
    /// A MySQL server (M12). Password lives in the keychain, never here.
    Mysql {
        host: String,
        port: u16,
        database: String,
        user: String,
        tls: bool,
    },
    /// A PostgreSQL server (M12). Password lives in the keychain, never here.
    Postgres {
        host: String,
        port: u16,
        database: String,
        user: String,
        tls: bool,
    },
}

impl ConnectionParams {
    /// The engine these parameters target.
    pub fn engine(&self) -> Engine {
        match self {
            Self::Sqlite { .. } => Engine::Sqlite,
            Self::Mysql { .. } => Engine::Mysql,
            Self::Postgres { .. } => Engine::Postgres,
        }
    }
}

/// What a successful test/open learned about the target.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    pub engine: Engine,
    /// Display version string, e.g. "SQLite 3.46.0" (sidebar header, M3).
    pub server_version: String,
}

/// A schema (SQLite: `main` + attached databases; server engines: schemas).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaInfo {
    pub name: String,
    /// Number of user tables, when cheaply known.
    pub table_count: Option<u64>,
}

/// A table within a schema.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableInfo {
    pub name: String,
    /// Approximate row count, when cheaply known (may be an estimate for
    /// server engines; exact `COUNT(*)` for SQLite in M2).
    pub approx_row_count: Option<u64>,
}

/// Column-level metadata for one table, powering the M3 sidebar's
/// expandable column lists (pk/fk icons + type labels).
///
/// Deliberately minimal: the M7 structure view will extend this shape
/// (indexes, defaults, collation, …) — do not add fields speculatively.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableMeta {
    pub columns: Vec<ColumnInfo>,
}

/// One column of a table.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    /// Declared type as written in the DDL (may be empty — SQLite allows
    /// untyped columns). A display label, never for logic.
    pub data_type: String,
    /// True when the column has no NOT NULL constraint declared.
    pub nullable: bool,
    /// True when the column is part of the primary key (composite pks mark
    /// every member column).
    pub pk: bool,
    /// The foreign-key target, when this column references another table.
    pub fk: Option<FkRef>,
}

/// The target of a foreign-key reference: a column in another table.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FkRef {
    pub table: String,
    pub column: String,
}

/// Column metadata accompanying a query result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMeta {
    pub name: String,
    /// Best-effort type label (declared type for SQLite; may be empty for
    /// computed expressions). A hint for display, never for logic.
    pub type_hint: String,
}

/// Options for a single query execution.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct QueryOptions {
    /// Maximum rows to return; the adapter reads one extra row to set
    /// `QueryResult::truncated`.
    pub row_limit: usize,
    /// Schema context for unqualified names. Server engines apply it
    /// (search_path / USE) in M12; for SQLite it is advisory — unqualified
    /// names resolve per SQLite's own rules (`main` first, then attached).
    pub schema: Option<String>,
}

impl Default for QueryOptions {
    fn default() -> Self {
        Self {
            row_limit: 500,
            schema: None,
        }
    }
}

/// The outcome of a query: column metadata, JSON-mapped rows, and timing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub columns: Vec<ColumnMeta>,
    /// Row-major values. Engine values map to JSON: NULL → null,
    /// integers/reals → numbers, text → strings; integers beyond ±2^53
    /// (JavaScript's safe-integer range) arrive as strings to preserve
    /// precision. Engine-specific types (e.g. blobs) are mapped by the
    /// adapter and documented there.
    pub rows: Vec<Vec<serde_json::Value>>,
    pub row_count: usize,
    /// True when `row_limit` cut the result short.
    pub truncated: bool,
    pub elapsed_ms: u64,
}

/// Sort direction for a single column. Lowercase on the wire ("asc" /
/// "desc"), matching the renderer's `SortDirection` in
/// `src/shared/api/engine.ts`.
///
/// Security: this enum is the *only* thing that drives the ORDER BY
/// direction in [`EngineConnection::fetch_rows`] — adapters emit the literal
/// `ASC`/`DESC` keyword per variant and never interpolate any caller string
/// into the direction, so the sort clause carries no SQL-injection surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SortDirection {
    Asc,
    Desc,
}

impl SortDirection {
    /// The SQL keyword for this direction — a fixed string literal, never
    /// caller-derived (see the type docs on the injection guarantee).
    pub fn sql_keyword(self) -> &'static str {
        match self {
            Self::Asc => "ASC",
            Self::Desc => "DESC",
        }
    }
}

/// A single-column sort applied to a browsed table. `column` is a real
/// column name the adapter MUST validate against the table's columns before
/// quoting it into the SQL (an unknown column is a §5 error); `direction`
/// is enum-driven and never interpolated as text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SortSpec {
    pub column: String,
    pub direction: SortDirection,
}

/// A request for one page of rows from a table, powering the M4 data grid.
///
/// M4 scope: paging (`offset`/`limit`) plus an optional single-column sort.
/// Row filtering is M5 — there is deliberately no predicate field yet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchRowsRequest {
    pub schema: String,
    pub table: String,
    /// Optional single-column sort; `None` leaves row order to the engine.
    pub sort: Option<SortSpec>,
    /// Zero-based row offset of the page (bound as a parameter, never
    /// interpolated).
    pub offset: u64,
    /// Maximum rows in the page. Adapters clamp this to their page ceiling.
    pub limit: u32,
}

/// One page of rows from a table: column metadata, JSON-mapped values, the
/// page window, and timing — the data-grid counterpart of [`QueryResult`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowsPage {
    pub columns: Vec<ColumnMeta>,
    /// Row-major values, mapped to JSON exactly as [`QueryResult::rows`]
    /// (NULL → null, big integers → strings, blobs → placeholder, …).
    pub rows: Vec<Vec<serde_json::Value>>,
    /// The offset this page was fetched at (echoes the request after any
    /// clamping).
    pub offset: u64,
    /// The effective page size after clamping (echoes the request).
    pub limit: u32,
    /// Exact `COUNT(*)` of the table (unfiltered in M4 — filters are M5).
    ///
    /// Computed per fetch in M4 for correctness and simplicity; a later
    /// milestone may cache it or fall back to an engine estimate for very
    /// large tables, at which point this becomes `None` when unknown. `None`
    /// today means the count could not be obtained.
    pub total_rows: Option<u64>,
    pub elapsed_ms: u64,
}

/// Opens and tests connections for one engine. One implementation per
/// engine, registered by `Engine` in the composition root; the renderer
/// only ever sees opaque handle ids, never driver handles.
#[async_trait]
pub trait Connector: Send + Sync {
    /// Verify the target is reachable and really is this engine, without
    /// keeping a connection open.
    async fn test(&self, params: &ConnectionParams) -> Result<EngineInfo, AppError>;

    /// Open a live connection.
    async fn open(&self, params: &ConnectionParams) -> Result<Box<dyn EngineConnection>, AppError>;
}

/// A live connection to one database: introspection + query execution.
///
/// All errors carry human messages per DESIGN_SPEC §5 — adapters map driver
/// errors before they cross this boundary.
#[async_trait]
pub trait EngineConnection: Send + Sync {
    /// What `open` learned about the target (engine + version).
    fn engine_info(&self) -> EngineInfo;

    /// Schemas visible on this connection (SQLite: `main` + attached).
    async fn list_schemas(&self) -> Result<Vec<SchemaInfo>, AppError>;

    /// User tables in the given schema.
    async fn list_tables(&self, schema: &str) -> Result<Vec<TableInfo>, AppError>;

    /// Column-level metadata for one table (M3 sidebar). Unknown tables are
    /// a §5 human error ("Table 'x' does not exist. Available tables: …").
    async fn table_meta(&self, schema: &str, table: &str) -> Result<TableMeta, AppError>;

    /// Execute SQL verbatim with a row limit and timing. Read/write context
    /// enforcement is a higher-level concern (M6); the adapter runs what it
    /// is given but always enforces `row_limit`.
    async fn run_query(&self, sql: &str, options: QueryOptions) -> Result<QueryResult, AppError>;

    /// Fetch one page of rows from a table for the data grid (M4): paged
    /// (`offset`/`limit`) and optionally sorted by a single column, with an
    /// exact unfiltered `COUNT(*)` for the "N rows" status. The adapter
    /// validates `sort.column` against the table's columns, quotes every
    /// identifier, binds offset/limit as parameters, and emits the ORDER BY
    /// direction only as the enum-driven `ASC`/`DESC` keyword — see
    /// [`SortDirection`] for the no-injection guarantee. Unknown
    /// schema/table/sort-column are §5 human errors.
    async fn fetch_rows(&self, req: FetchRowsRequest) -> Result<RowsPage, AppError>;

    /// Release the underlying driver resources. For drop-managed drivers
    /// (rusqlite) this may be a no-op; server engines use it for an orderly
    /// goodbye.
    ///
    /// Concurrency: the manager hands out `Arc` clones of the connection,
    /// so `close` may be called while other clones are mid-operation (e.g.
    /// app teardown racing a slow query). Adapters must tolerate that —
    /// either by being a no-op and letting the last `Arc` drop do the real
    /// teardown (SQLite), or by serializing close against in-flight work.
    async fn close(&self) -> Result<(), AppError>;
}

/// Generates engine-specific DDL: ALTER dialects, identifier quoting,
/// type mappings. Still a deliberate stub — methods arrive with the
/// structure editor milestones (M8/M14).
pub trait DdlDialect {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_serializes_lowercase_matching_renderer() {
        assert_eq!(serde_json::to_value(Engine::Sqlite).unwrap(), "sqlite");
        assert_eq!(serde_json::to_value(Engine::Mysql).unwrap(), "mysql");
        assert_eq!(serde_json::to_value(Engine::Postgres).unwrap(), "postgres");
    }

    #[test]
    fn sqlite_params_wire_shape_is_engine_tagged_camel_case() {
        let params = ConnectionParams::Sqlite {
            path: "/tmp/db.sqlite".into(),
        };
        assert_eq!(
            serde_json::to_value(&params).unwrap(),
            serde_json::json!({ "engine": "sqlite", "path": "/tmp/db.sqlite" })
        );
    }

    #[test]
    fn server_params_round_trip_and_report_their_engine() {
        let params = ConnectionParams::Mysql {
            host: "db.internal".into(),
            port: 3306,
            database: "shop".into(),
            user: "app".into(),
            tls: true,
        };
        assert_eq!(params.engine(), Engine::Mysql);
        let json = serde_json::to_string(&params).unwrap();
        let back: ConnectionParams = serde_json::from_str(&json).unwrap();
        assert_eq!(back, params);
    }

    #[test]
    fn table_meta_wire_shape_is_camel_case_with_nullable_fk() {
        let meta = TableMeta {
            columns: vec![
                ColumnInfo {
                    name: "author_id".into(),
                    data_type: "INTEGER".into(),
                    nullable: false,
                    pk: false,
                    fk: Some(FkRef {
                        table: "authors".into(),
                        column: "id".into(),
                    }),
                },
                ColumnInfo {
                    name: "note".into(),
                    data_type: String::new(),
                    nullable: true,
                    pk: true,
                    fk: None,
                },
            ],
        };
        let json = serde_json::to_value(&meta).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "columns": [
                    {
                        "name": "author_id",
                        "dataType": "INTEGER",
                        "nullable": false,
                        "pk": false,
                        "fk": { "table": "authors", "column": "id" }
                    },
                    {
                        "name": "note",
                        "dataType": "",
                        "nullable": true,
                        "pk": true,
                        "fk": null
                    }
                ]
            })
        );
        // And the shape round-trips.
        let back: TableMeta = serde_json::from_value(json).unwrap();
        assert_eq!(back, meta);
    }

    #[test]
    fn query_options_default_limit_and_camel_case_wire_field() {
        let opts: QueryOptions = serde_json::from_str("{}").unwrap();
        assert_eq!(opts.row_limit, 500);
        assert_eq!(opts.schema, None);
        let opts: QueryOptions = serde_json::from_str(r#"{"rowLimit": 10}"#).unwrap();
        assert_eq!(opts.row_limit, 10);
    }

    #[test]
    fn sort_direction_serializes_lowercase_and_maps_to_sql_keywords() {
        assert_eq!(serde_json::to_value(SortDirection::Asc).unwrap(), "asc");
        assert_eq!(serde_json::to_value(SortDirection::Desc).unwrap(), "desc");
        assert_eq!(SortDirection::Asc.sql_keyword(), "ASC");
        assert_eq!(SortDirection::Desc.sql_keyword(), "DESC");
    }

    #[test]
    fn fetch_rows_request_wire_shape_is_camel_case_and_round_trips() {
        let req = FetchRowsRequest {
            schema: "main".into(),
            table: "users".into(),
            sort: Some(SortSpec {
                column: "name".into(),
                direction: SortDirection::Desc,
            }),
            offset: 100,
            limit: 50,
        };
        let json = serde_json::to_value(&req).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "schema": "main",
                "table": "users",
                "sort": { "column": "name", "direction": "desc" },
                "offset": 100,
                "limit": 50
            })
        );
        let back: FetchRowsRequest = serde_json::from_value(json).unwrap();
        assert_eq!(back, req);

        // A sortless request keeps `sort: null` on the wire and round-trips.
        let unsorted = FetchRowsRequest {
            sort: None,
            ..req.clone()
        };
        let json = serde_json::to_value(&unsorted).unwrap();
        assert_eq!(json["sort"], serde_json::Value::Null);
        let back: FetchRowsRequest = serde_json::from_value(json).unwrap();
        assert_eq!(back, unsorted);
    }

    #[test]
    fn rows_page_wire_shape_is_camel_case_and_round_trips() {
        let page = RowsPage {
            columns: vec![ColumnMeta {
                name: "id".into(),
                type_hint: "INTEGER".into(),
            }],
            rows: vec![vec![serde_json::json!(1)], vec![serde_json::json!(2)]],
            offset: 0,
            limit: 100,
            total_rows: Some(42),
            elapsed_ms: 3,
        };
        let json = serde_json::to_value(&page).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "columns": [{ "name": "id", "typeHint": "INTEGER" }],
                "rows": [[1], [2]],
                "offset": 0,
                "limit": 100,
                "totalRows": 42,
                "elapsedMs": 3
            })
        );
        let back: RowsPage = serde_json::from_value(json).unwrap();
        assert_eq!(back, page);
    }
}
