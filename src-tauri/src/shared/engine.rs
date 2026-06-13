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

/// Metadata for one table. Powers the M3 sidebar (`columns` with pk/fk icons
/// and type labels) and, since M7, the structure view's 348px rail
/// (DESIGN_SPEC §3.6): indexes, table-level and inbound foreign keys, plus the
/// `CREATE TABLE` DDL.
///
/// M7 additions (everything past `columns`) are additive — `columns` keeps
/// its M3 shape so the sidebar and the M4 grid headers, which read only
/// `columns`, are unaffected. New `Vec` fields are always present (empty when
/// none); `comment`/`ddl` are `Option` (always present on the wire, `null`
/// when absent). `Default` is derived so test fakes can build a bare
/// `TableMeta { columns, ..Default::default() }` without enumerating M7
/// fields, and so future additive fields do not break them.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableMeta {
    pub columns: Vec<ColumnInfo>,
    /// The table's comment/description, when the engine has one. SQLite has
    /// no table comments, so this is always `None` there; it is modelled now
    /// for the §3.6 header's "table comment" slot and for server engines
    /// (MySQL `COMMENT`, Postgres `COMMENT ON TABLE`) in M12.
    pub comment: Option<String>,
    /// Indexes declared on the table, including the implicit primary-key
    /// index (`primary == true`). Empty when the table has none.
    pub indexes: Vec<IndexInfo>,
    /// Foreign keys declared *on this table* (outbound), grouped per
    /// constraint so a composite fk is one entry with ordered column lists.
    /// `ColumnInfo.fk` carries the same targets per-column for the sidebar
    /// icon; this is the table-level view §3.6 renders.
    pub foreign_keys: Vec<ForeignKeyInfo>,
    /// Foreign keys *pointing at this table* (inbound) from other tables in
    /// the same schema — §3.6's "referenced by". Empty when nothing
    /// references it. See the SQLite adapter for the per-table scan cost note.
    pub referenced_by: Vec<InboundFkInfo>,
    /// The `CREATE TABLE` statement, verbatim, for the §3.6 DDL modal
    /// (rendered syntax-highlighted — verbatim is truthful). `None` when the
    /// engine cannot supply it.
    pub ddl: Option<String>,
}

/// One index on a table (§3.6 structure view).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexInfo {
    pub name: String,
    /// Indexed columns, in index order. May be empty for an expression index
    /// (SQLite reports expression members as unnamed).
    pub columns: Vec<String>,
    /// True for a UNIQUE index (includes the implicit primary-key index).
    pub unique: bool,
    /// True for the implicit primary-key index (SQLite `origin == "pk"`).
    pub primary: bool,
    /// How the index came to exist, when the engine reports it. SQLite uses
    /// `"c"` (CREATE INDEX), `"u"` (a UNIQUE constraint), or `"pk"` (the
    /// primary key); other engines leave this `None`.
    pub origin: Option<String>,
}

/// One foreign key declared on a table (outbound), grouped per constraint so
/// composite keys are a single entry with parallel, ordered column lists
/// (`columns[i]` references `ref_columns[i]`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyInfo {
    /// The constraint name, when the engine exposes one. SQLite's
    /// `foreign_key_list` has no name, so this is always `None` there; server
    /// engines populate it.
    pub name: Option<String>,
    /// Local columns of this table, in constraint order.
    pub columns: Vec<String>,
    pub ref_table: String,
    /// Referenced columns of `ref_table`, parallel to `columns`.
    pub ref_columns: Vec<String>,
    /// The `ON DELETE` action (e.g. `"CASCADE"`, `"SET NULL"`,
    /// `"NO ACTION"`), as the engine reports it; `None` if unknown.
    pub on_delete: Option<String>,
    /// The `ON UPDATE` action, as the engine reports it; `None` if unknown.
    pub on_update: Option<String>,
}

/// A foreign key from another table pointing *at* this table (§3.6
/// "referenced by"). Grouped per constraint like [`ForeignKeyInfo`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboundFkInfo {
    /// The child table that holds the foreign key.
    pub table: String,
    /// The child table's foreign-key columns, in constraint order.
    pub columns: Vec<String>,
    /// This table's referenced columns, parallel to `columns`.
    pub ref_columns: Vec<String>,
    /// The `ON DELETE` action on the child's constraint; `None` if unknown.
    pub on_delete: Option<String>,
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

/// The comparison applied by a single structured [`Condition`]. The wire
/// tokens are explicit camelCase strings the renderer's filter builder sends
/// — they map to (but are *not* identical to) the prototype's internal op ids
/// in `bytetable/filters.jsx`. The mapping the renderer must honour:
///
/// | prototype id (filters.jsx) | label        | wire token (this enum) | SQLite |
/// |----------------------------|--------------|------------------------|--------|
/// | `eq`                       | `=`          | `eq`                   | `"c" = ?` |
/// | `neq`                      | `≠`          | `ne`                   | `"c" <> ?` |
/// | `gt`                       | `>`          | `gt`                   | `"c" > ?` |
/// | `gte`                      | `≥`          | `gte`                  | `"c" >= ?` |
/// | `lt`                       | `<`          | `lt`                   | `"c" < ?` |
/// | `lte`                      | `≤`          | `lte`                  | `"c" <= ?` |
/// | `contains`                 | `contains`   | `contains`             | `"c" LIKE ? ESCAPE '\'` (`%v%`) |
/// | `ncontains`                | `not contains` | `notContains`        | `"c" NOT LIKE ? ESCAPE '\'` (`%v%`) |
/// | `begins`                   | `begins with` | `beginsWith`          | `"c" LIKE ? ESCAPE '\'` (`v%`) |
/// | `ends`                     | `ends with`  | `endsWith`             | `"c" LIKE ? ESCAPE '\'` (`%v`) |
/// | `in`                       | `in list`    | `inList`               | `"c" IN (?, ?, …)` |
/// | `null`                     | `is null`    | `isNull`               | `"c" IS NULL` |
/// | `nnull`                    | `is not null` | `isNotNull`           | `"c" IS NOT NULL` |
///
/// Security: this enum is the *only* thing that selects a comparison operator
/// in [`EngineConnection::fetch_rows`] — adapters emit fixed SQL fragments per
/// variant and bind the user's value as a parameter (`?`), never interpolating
/// it. The LIKE family escapes `%`/`_`/`\` in the bound value so user wildcards
/// match literally (see the SQLite adapter).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FilterOp {
    Eq,
    Ne,
    Gt,
    Gte,
    Lt,
    Lte,
    Contains,
    NotContains,
    BeginsWith,
    EndsWith,
    InList,
    IsNull,
    IsNotNull,
}

impl FilterOp {
    /// Whether this operator takes a value. The null checks do not; every
    /// other operator requires a non-null [`FilterValue`] (a §5 error
    /// otherwise — see the adapter).
    pub fn needs_value(self) -> bool {
        !matches!(self, Self::IsNull | Self::IsNotNull)
    }
}

/// The value a [`Condition`] compares against. Either a single JSON scalar
/// (string / number / bool) for the comparison and LIKE operators, or a list
/// of scalars for `inList`. `null` values inside are rejected by the adapter
/// with the §5 "use IS NULL / IS NOT NULL" message — SQL `= NULL` never
/// matches, so a NULL comparison is always a mistake.
///
/// Untagged on the wire: a JSON array deserializes to [`FilterValue::List`],
/// anything else (string/number/bool) to [`FilterValue::Scalar`]. Security:
/// every contained value is *bound* as a parameter, never interpolated.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum FilterValue {
    /// A list of scalars for `inList` (`IN (?, ?, …)`).
    List(Vec<serde_json::Value>),
    /// A single scalar for the comparison / LIKE operators.
    Scalar(serde_json::Value),
}

/// One structured filter row: a column, an operator, and (unless the operator
/// is a null check) a value. `column` is a real column name the adapter MUST
/// validate against the table's columns before quoting it — an unknown column
/// is a §5 error, identical to the sort-column check.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Condition {
    pub column: String,
    pub op: FilterOp,
    /// `None` for `isNull` / `isNotNull`; required for every other operator.
    pub value: Option<FilterValue>,
}

/// How structured [`Condition`]s combine into one WHERE clause. Lowercase on
/// the wire ("and" / "or"). The prototype's builder only renders `WHERE … AND
/// …` between rows, so the renderer defaults to `And`; `Or` is supported here
/// so the builder can offer it without a backend change. (Mixed/nested
/// boolean logic is the job of the raw "Edit as SQL" escape hatch.)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Combinator {
    And,
    Or,
}

impl Combinator {
    /// The SQL keyword joining conditions — a fixed literal, never
    /// caller-derived.
    pub fn sql_keyword(self) -> &'static str {
        match self {
            Self::And => "AND",
            Self::Or => "OR",
        }
    }
}

/// The filter applied to a browsed table (M5 stackable filter builder). Two
/// mutually exclusive modes, discriminated by `mode` on the wire:
///
/// - `{ "mode": "conditions", "items": [...], "combinator": "and" }` — the
///   structured builder. Every condition compiles to **bound-parameter** SQL;
///   there is no SQL-injection surface (operators are enum-driven, values are
///   bound).
/// - `{ "mode": "raw", "sql": "status = 'paid' AND total > 100" }` — the
///   "Edit as SQL" escape hatch. The string is the body of the WHERE clause
///   and is **interpolated verbatim** (wrapped in parentheses). See the
///   adapter for the explicit threat model: this is an intentional power-user
///   feature on a local-first single-user tool that already grants full SQL
///   access via the query editor (M6), so the only "validation" is execution
///   — a bad clause surfaces as a §5 error.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "lowercase")]
pub enum FilterSpec {
    /// The structured builder: parameterized conditions joined by one
    /// top-level combinator.
    Conditions {
        items: Vec<Condition>,
        combinator: Combinator,
    },
    /// The raw "Edit as SQL" WHERE body, interpolated verbatim (escape hatch).
    Raw { sql: String },
}

/// A request for one page of rows from a table, powering the M4 data grid and
/// the M5 filter builder.
///
/// Scope: paging (`offset`/`limit`), an optional single-column sort, and an
/// optional [`FilterSpec`] (M5). When a filter is present it applies to BOTH
/// the page query and the `COUNT(*)`, so `RowsPage::total_rows` is the
/// *filtered* row count (the "n of N rows" status shows the filtered total).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchRowsRequest {
    pub schema: String,
    pub table: String,
    /// Optional single-column sort; `None` leaves row order to the engine.
    pub sort: Option<SortSpec>,
    /// Optional row filter (M5); `None` returns the whole table. Structured
    /// conditions are fully parameterized; the raw mode is a documented
    /// escape hatch (see [`FilterSpec`]).
    #[serde(default)]
    pub filter: Option<FilterSpec>,
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
    /// Exact `COUNT(*)` matching the request: the whole table when the
    /// request carries no filter, the *filtered* count when
    /// [`FetchRowsRequest::filter`] is present (so the renderer's "n of N
    /// rows" status reflects the filter, §3.5).
    ///
    /// Computed per fetch for correctness and simplicity; a later milestone
    /// may cache it or fall back to an engine estimate for very large tables,
    /// at which point this becomes `None` when unknown. `None` today means the
    /// count could not be obtained.
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

    /// Fetch one page of rows from a table for the data grid (M4 + M5): paged
    /// (`offset`/`limit`), optionally sorted by a single column, and
    /// optionally filtered (M5), with an exact `COUNT(*)` for the row-count
    /// status — the *filtered* count when a filter applies (§3.5 "n of N
    /// rows"). The adapter validates `sort.column` and every filter column
    /// against the table's columns, quotes every identifier, binds
    /// offset/limit and structured filter values as parameters, and emits the
    /// ORDER BY direction only as the enum-driven `ASC`/`DESC` keyword — see
    /// [`SortDirection`] for the no-injection guarantee. The raw filter mode
    /// is a documented "Edit as SQL" escape hatch (see [`FilterSpec`]).
    /// Unknown schema/table/sort-column/filter-column are §5 human errors.
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
            ..Default::default()
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
                ],
                // M7 additions: always present on the wire, empty/null by default.
                "comment": null,
                "indexes": [],
                "foreignKeys": [],
                "referencedBy": [],
                "ddl": null
            })
        );
        // And the shape round-trips.
        let back: TableMeta = serde_json::from_value(json).unwrap();
        assert_eq!(back, meta);
    }

    #[test]
    fn table_meta_m7_structure_fields_wire_shape_round_trips() {
        let meta = TableMeta {
            columns: vec![ColumnInfo {
                name: "id".into(),
                data_type: "INTEGER".into(),
                nullable: true,
                pk: true,
                fk: None,
            }],
            comment: Some("the books table".into()),
            indexes: vec![
                IndexInfo {
                    name: "sqlite_autoindex_books_1".into(),
                    columns: vec!["id".into()],
                    unique: true,
                    primary: true,
                    origin: Some("pk".into()),
                },
                IndexInfo {
                    name: "idx_books_author_title".into(),
                    columns: vec!["author_id".into(), "title".into()],
                    unique: false,
                    primary: false,
                    origin: Some("c".into()),
                },
            ],
            foreign_keys: vec![ForeignKeyInfo {
                name: None,
                columns: vec!["author_id".into()],
                ref_table: "authors".into(),
                ref_columns: vec!["id".into()],
                on_delete: Some("CASCADE".into()),
                on_update: Some("NO ACTION".into()),
            }],
            referenced_by: vec![InboundFkInfo {
                table: "reviews".into(),
                columns: vec!["book_id".into()],
                ref_columns: vec!["id".into()],
                on_delete: Some("SET NULL".into()),
            }],
            ddl: Some("CREATE TABLE books (id INTEGER PRIMARY KEY)".into()),
        };
        let json = serde_json::to_value(&meta).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "columns": [
                    { "name": "id", "dataType": "INTEGER", "nullable": true, "pk": true, "fk": null }
                ],
                "comment": "the books table",
                "indexes": [
                    {
                        "name": "sqlite_autoindex_books_1",
                        "columns": ["id"],
                        "unique": true,
                        "primary": true,
                        "origin": "pk"
                    },
                    {
                        "name": "idx_books_author_title",
                        "columns": ["author_id", "title"],
                        "unique": false,
                        "primary": false,
                        "origin": "c"
                    }
                ],
                "foreignKeys": [
                    {
                        "name": null,
                        "columns": ["author_id"],
                        "refTable": "authors",
                        "refColumns": ["id"],
                        "onDelete": "CASCADE",
                        "onUpdate": "NO ACTION"
                    }
                ],
                "referencedBy": [
                    {
                        "table": "reviews",
                        "columns": ["book_id"],
                        "refColumns": ["id"],
                        "onDelete": "SET NULL"
                    }
                ],
                "ddl": "CREATE TABLE books (id INTEGER PRIMARY KEY)"
            })
        );
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
            filter: None,
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
                "filter": null,
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

        // `filter` is optional on the wire: an absent key deserializes to None.
        let no_filter_key: FetchRowsRequest = serde_json::from_value(serde_json::json!({
            "schema": "main",
            "table": "users",
            "sort": null,
            "offset": 0,
            "limit": 10
        }))
        .unwrap();
        assert_eq!(no_filter_key.filter, None);
    }

    #[test]
    fn filter_op_wire_tokens_are_camel_case_and_round_trip() {
        let cases = [
            (FilterOp::Eq, "eq"),
            (FilterOp::Ne, "ne"),
            (FilterOp::Gt, "gt"),
            (FilterOp::Gte, "gte"),
            (FilterOp::Lt, "lt"),
            (FilterOp::Lte, "lte"),
            (FilterOp::Contains, "contains"),
            (FilterOp::NotContains, "notContains"),
            (FilterOp::BeginsWith, "beginsWith"),
            (FilterOp::EndsWith, "endsWith"),
            (FilterOp::InList, "inList"),
            (FilterOp::IsNull, "isNull"),
            (FilterOp::IsNotNull, "isNotNull"),
        ];
        for (op, token) in cases {
            assert_eq!(serde_json::to_value(op).unwrap(), token);
            let back: FilterOp = serde_json::from_value(serde_json::json!(token)).unwrap();
            assert_eq!(back, op);
        }
        assert!(FilterOp::Eq.needs_value());
        assert!(!FilterOp::IsNull.needs_value());
        assert!(!FilterOp::IsNotNull.needs_value());
    }

    #[test]
    fn combinator_serializes_lowercase_and_maps_to_keywords() {
        assert_eq!(serde_json::to_value(Combinator::And).unwrap(), "and");
        assert_eq!(serde_json::to_value(Combinator::Or).unwrap(), "or");
        assert_eq!(Combinator::And.sql_keyword(), "AND");
        assert_eq!(Combinator::Or.sql_keyword(), "OR");
    }

    #[test]
    fn filter_value_untagged_distinguishes_scalar_from_list() {
        // A JSON array → List; a bare scalar → Scalar.
        let list: FilterValue = serde_json::from_value(serde_json::json!(["DE", "FR"])).unwrap();
        assert_eq!(
            list,
            FilterValue::List(vec![serde_json::json!("DE"), serde_json::json!("FR")])
        );
        let scalar: FilterValue = serde_json::from_value(serde_json::json!(42)).unwrap();
        assert_eq!(scalar, FilterValue::Scalar(serde_json::json!(42)));
        let text: FilterValue = serde_json::from_value(serde_json::json!("paid")).unwrap();
        assert_eq!(text, FilterValue::Scalar(serde_json::json!("paid")));
    }

    #[test]
    fn filter_spec_conditions_mode_wire_shape_round_trips() {
        let spec = FilterSpec::Conditions {
            items: vec![
                Condition {
                    column: "status".into(),
                    op: FilterOp::Eq,
                    value: Some(FilterValue::Scalar(serde_json::json!("paid"))),
                },
                Condition {
                    column: "deleted_at".into(),
                    op: FilterOp::IsNull,
                    value: None,
                },
                Condition {
                    column: "country".into(),
                    op: FilterOp::InList,
                    value: Some(FilterValue::List(vec![
                        serde_json::json!("DE"),
                        serde_json::json!("FR"),
                    ])),
                },
            ],
            combinator: Combinator::And,
        };
        let json = serde_json::to_value(&spec).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "mode": "conditions",
                "items": [
                    { "column": "status", "op": "eq", "value": "paid" },
                    { "column": "deleted_at", "op": "isNull", "value": null },
                    { "column": "country", "op": "inList", "value": ["DE", "FR"] }
                ],
                "combinator": "and"
            })
        );
        let back: FilterSpec = serde_json::from_value(json).unwrap();
        assert_eq!(back, spec);
    }

    #[test]
    fn filter_spec_raw_mode_wire_shape_round_trips() {
        let spec = FilterSpec::Raw {
            sql: "total > 100 AND country IN ('DE', 'FR')".into(),
        };
        let json = serde_json::to_value(&spec).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "mode": "raw",
                "sql": "total > 100 AND country IN ('DE', 'FR')"
            })
        );
        let back: FilterSpec = serde_json::from_value(json).unwrap();
        assert_eq!(back, spec);
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
