// Connect-time secrets and the SQL port traits (`Connector`, `EngineConnection`,
// `DdlDialect`) every relational adapter implements. The cross-family
// `OpenConnection` seam lives on the neutral `ports` parent and is re-exported
// via `super::*`.

use async_trait::async_trait;

use crate::features::structure::domain::AlterOp;
use crate::shared::error::AppError;

use super::*;

/// Transient connection secrets that the command layer carries to
/// `test`/`open` *without persisting them*. [`ConnectionParams`] is
/// deliberately secret-free for storage; server engines need secrets only at
/// connect time, so they travel separately as this short-lived value.
///
/// Two distinct secrets, both optional:
/// - `password` — the database password (Postgres/MySQL `connect_options`).
/// - `ssh` — the SSH secret for a tunnelled connection: the private-key
///   *passphrase* (key auth) or the bastion *password* (password auth). `None`
///   for agent auth or a direct (non-tunnelled) connection.
///
/// # M12 secret-threading seam (Task 1 → Task 3)
///
/// In Task 1/2 only `password` existed, originating as an optional `password`
/// argument on the commands and threaded through the use-cases into
/// [`Connector::open_with_secret`] / [`Connector::test_with_secret`]. Task 3
/// adds the `ssh` arm and replaces the *source* of both with the OS keychain
/// (looked up by saved-connection id: account `{id}` for the db password,
/// `{id}:ssh` for the SSH secret). The connector seam is unchanged in shape;
/// only where the values come from changed. Secrets are never written to disk
/// and never put on [`ConnectionParams`].
#[derive(Clone, Default)]
pub struct ConnectSecret {
    password: Option<String>,
    ssh: Option<String>,
}

impl std::fmt::Debug for ConnectSecret {
    /// Never leak the secrets in logs / panic messages.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConnectSecret")
            .field("password", &self.password.as_ref().map(|_| "***"))
            .field("ssh", &self.ssh.as_ref().map(|_| "***"))
            .finish()
    }
}

impl ConnectSecret {
    /// A secret carrying only a database password (the common server case,
    /// and the Task 1/2 shape — `ConnectSecret::new(p)` mirrors the old
    /// tuple-struct constructor).
    pub fn new(password: impl Into<String>) -> Self {
        Self {
            password: Some(password.into()),
            ssh: None,
        }
    }

    /// A secret carrying a database password and/or an SSH secret. Either may
    /// be `None` (e.g. SSH-agent auth needs no SSH secret).
    pub fn with_ssh(password: Option<String>, ssh: Option<String>) -> Self {
        Self { password, ssh }
    }

    /// The database password, if any. Only the connector at connect time
    /// should read this.
    pub fn password(&self) -> Option<&str> {
        self.password.as_deref()
    }

    /// The SSH secret (key passphrase or bastion password), if any.
    pub fn ssh(&self) -> Option<&str> {
        self.ssh.as_deref()
    }
}

/// Opens and tests connections for one engine. One implementation per
/// engine, registered by `Engine` in the composition root; the renderer
/// only ever sees opaque handle ids, never driver handles.
///
/// Progress callback for long-running operations — `(done, total)`. Export
/// reports rows (per table) or tables (per schema dump) written; import reports
/// statements executed. The command layer forwards each call to a Tauri
/// `Channel` so the renderer can drive a progress bar. `Send + Sync` so it can
/// be held across `await` points in the async command future.
pub type ProgressCallback<'a> = &'a (dyn Fn(u64, u64) + Send + Sync);

/// M13: `open` now yields an [`OpenConnection`] (the SQL/KV kind seam) rather
/// than a bare `Box<dyn EngineConnection>`. SQL connectors wrap their
/// connection in [`OpenConnection::Sql`]; the Redis connector returns
/// [`OpenConnection::Kv`].
#[async_trait]
pub trait Connector: Send + Sync {
    /// Verify the target is reachable and really is this engine, without
    /// keeping a connection open. The secretless form — used by engines with
    /// no password (SQLite) and by callers that have no secret. Server engines
    /// override [`Self::test_with_secret`] and route this through it with no
    /// secret.
    async fn test(&self, params: &ConnectionParams) -> Result<EngineInfo, AppError>;

    /// Open a live connection (secretless form — see [`Self::test`]). Returns
    /// the [`OpenConnection`] kind enum so a SQL or key-value connection can
    /// flow through the same manager.
    async fn open(&self, params: &ConnectionParams) -> Result<OpenConnection, AppError>;

    /// Verify the target, carrying an optional transient [`ConnectSecret`]
    /// (a password for server engines). Default impl ignores the secret and
    /// delegates to [`Self::test`], so SQLite and every existing test fake are
    /// unaffected; the Postgres connector overrides it to use the password.
    /// See [`ConnectSecret`] for the M12 password-threading seam.
    async fn test_with_secret(
        &self,
        params: &ConnectionParams,
        _secret: Option<&ConnectSecret>,
    ) -> Result<EngineInfo, AppError> {
        self.test(params).await
    }

    /// Open a live connection, carrying an optional transient [`ConnectSecret`].
    /// Default impl ignores the secret and delegates to [`Self::open`].
    async fn open_with_secret(
        &self,
        params: &ConnectionParams,
        _secret: Option<&ConnectSecret>,
    ) -> Result<OpenConnection, AppError> {
        self.open(params).await
    }
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

    // ----- schema objects (views / matviews / routines / triggers) -----
    // Default impls make an engine opt in: an engine that does not override
    // these reports no object kinds and lists nothing, so the sidebar shows no
    // object groups for it.

    /// Object kinds this engine supports (drives sidebar gating).
    fn object_kinds(&self) -> &'static [DbObjectKind] {
        &[]
    }

    /// Objects of `kind` in `schema` (empty when the engine does not support it).
    async fn list_objects(
        &self,
        _schema: &str,
        _kind: DbObjectKind,
    ) -> Result<Vec<DbObjectInfo>, AppError> {
        Ok(Vec::new())
    }

    /// The `CREATE …` DDL for one object. `detail` is the matching
    /// [`DbObjectInfo::detail`] echoed back so adapters that need the owning
    /// table or routine arg-signature to resolve it can.
    async fn object_definition(
        &self,
        _schema: &str,
        _kind: DbObjectKind,
        _name: &str,
        _detail: Option<&str>,
    ) -> Result<DbObjectDefinition, AppError> {
        Err(AppError::Unsupported(
            "This engine has no such object.".into(),
        ))
    }

    /// A precise `DROP …` statement for one object (engine builds the exact
    /// form — PG functions need arg types, triggers need `ON <table>`, matviews
    /// differ). Pure (no I/O); the command layer runs the returned SQL.
    fn drop_object_sql(
        &self,
        _schema: &str,
        _kind: DbObjectKind,
        _name: &str,
        _detail: Option<&str>,
    ) -> Result<String, AppError> {
        Err(AppError::Unsupported(
            "This engine cannot drop that object.".into(),
        ))
    }

    /// Run object-DDL statements VERBATIM (no `;`-splitting — each string is one
    /// whole statement; a routine/trigger body's inner `;` must never be
    /// parsed). Wrapped in a transaction where the engine supports DDL
    /// transactions (Postgres/SQLite); MySQL DDL auto-commits, so a mid-list
    /// failure leaves earlier statements applied. The default runs each via
    /// `run_query` sequentially with no transaction.
    async fn run_statements(&self, statements: &[String]) -> Result<(), AppError> {
        for stmt in statements {
            self.run_query(stmt, QueryOptions::default()).await?;
        }
        Ok(())
    }

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

    /// Look up the row(s) where `column = value` (M10 "FK peek", §3.5): click
    /// a foreign-key cell to peek at the referenced row. The adapter validates
    /// `column` against the table's columns (a §5 error otherwise), quotes the
    /// identifier, and *binds* `value` as a parameter — never interpolated, so
    /// an injection payload simply matches nothing. Returns the first matching
    /// row (the key is usually unique → 0 or 1) plus `match_count` so the UI
    /// can flag a non-unique key. A null key matches nothing (FK keys are
    /// non-null in normal use — see [`RowLookupRequest::value`]). Columns are
    /// always returned, even when nothing matched. Unknown schema/table/column
    /// are §5 human errors.
    ///
    /// Default impl: `Unsupported` — only engines that implement it override
    /// it (SQLite in M10; server engines later).
    async fn fetch_row_by_key(&self, _req: RowLookupRequest) -> Result<RowLookup, AppError> {
        Err(AppError::Unsupported(
            "Row lookup is not supported for this engine yet.".into(),
        ))
    }

    /// Compute per-column statistics over the current filtered set (M10
    /// "column insights", §3.5): total/distinct/null counts, min/max, avg (for
    /// numeric columns), and the top-5 most frequent values. The adapter
    /// validates `column` (a §5 error otherwise), quotes the identifier, and
    /// reuses the same parameterized [`FilterSpec`] compilation as
    /// [`fetch_rows`] so the stats reflect the grid's visible filtered set.
    /// Unknown schema/table/column are §5 human errors.
    ///
    /// Default impl: `Unsupported` — only engines that implement it override
    /// it (SQLite in M10; server engines later).
    async fn column_stats(&self, _req: ColumnStatsRequest) -> Result<ColumnStats, AppError> {
        Err(AppError::Unsupported(
            "Column statistics are not supported for this engine yet.".into(),
        ))
    }

    /// Preview or apply a batch of staged structure edits ([`AlterOp`]) against
    /// one table (M8 structure editor, DESIGN_SPEC §3.6).
    ///
    /// - `apply == false` ⇒ **preview only**: generate the SQL statement strings
    ///   the batch implies and return them in [`AlterResult::statements`] with
    ///   `applied: false`. This MUST NOT mutate the database (it may read schema
    ///   metadata to validate ops and compute the target column set).
    /// - `apply == true` ⇒ **execute**: realize the batch transactionally and
    ///   return the same statements with `applied: true`. On ANY failure the
    ///   adapter rolls back fully so the table is untouched, and returns the
    ///   engine error §5-style.
    ///
    /// Errors (both modes): unknown schema/table/column, dropping or retyping a
    /// primary-key column, and — for SQLite apply — a table-rebuild that would
    /// lose features it cannot reconstruct (CHECK, generated columns,
    /// AUTOINCREMENT, WITHOUT ROWID, COLLATE, triggers) are all §5 human errors.
    ///
    /// Default impl: `Unsupported` — only engines that implement structure
    /// editing override it (SQLite in M8; server engines later).
    async fn alter_table(
        &self,
        _schema: &str,
        _table: &str,
        _ops: &[AlterOp],
        _apply: bool,
    ) -> Result<AlterResult, AppError> {
        Err(AppError::Unsupported(
            "Structure editing is not supported for this engine yet.".into(),
        ))
    }

    /// Update a single cell on one row (M11 inline edit, DESIGN_SPEC §3.5):
    /// `SET req.column = req.value` on the row identified by `req.pk`.
    ///
    /// **Mutates user data.** Safety contract (the adapter MUST enforce it):
    ///
    /// - Validate `column` against the table (a §5 error for an unknown column,
    ///   identical to the browse/insights column checks).
    /// - Require the FULL primary key: the `pk` predicate columns must be
    ///   exactly the table's primary-key columns — no missing pk column, and
    ///   every named column must actually be part of the pk. A table with no pk
    ///   is rejected. This is what guarantees the WHERE clause targets at most
    ///   one row (mass-update prevention), so the update is safe.
    /// - **Bind everything:** the new value AND every pk value are bound
    ///   parameters (`SET "c" = ? WHERE "pk" = ?`), never interpolated. An
    ///   injection payload stores/compares as an inert literal. A `null` `value`
    ///   is a valid `SET "c" = NULL` (the bound NULL works; only `WHERE c = NULL`
    ///   is the SQL trap, and pk values are non-null in normal use → a null pk
    ///   value matches nothing).
    /// - Execute transactionally and assert the affected count: `0` → the row
    ///   was not found (stale/deleted pk) → §5 error, nothing changed; `>1` →
    ///   roll back and §5 error (defense in depth — should be impossible once
    ///   the pk is validated, but a bug must never silently mass-update); `1` →
    ///   commit and return [`UpdateResult`] with the cosmetic statement string.
    ///
    /// Engine constraint failures (e.g. a NOT NULL violation when setting NULL)
    /// surface as §5 errors and roll back, leaving the row untouched.
    ///
    /// Default impl: `Unsupported` — only engines that implement it override it
    /// (SQLite in M11; server engines later).
    async fn update_cell(&self, _req: UpdateCellRequest) -> Result<UpdateResult, AppError> {
        Err(AppError::Unsupported(
            "Editing cells is not supported for this engine yet.".into(),
        ))
    }

    /// Delete a set of whole rows by primary key (grid multi-select bulk delete).
    /// Same safety contract as [`Self::update_cell`]: pk columns are validated,
    /// every value is bound, each row's `DELETE` is guarded to affect at most one
    /// row, and the whole batch runs in one transaction. Rows that already
    /// vanished count as 0, not an error. Returns the number actually deleted.
    ///
    /// Default impl: `Unsupported`.
    async fn delete_rows(&self, _req: DeleteRowsRequest) -> Result<DeleteRowsResult, AppError> {
        Err(AppError::Unsupported(
            "Deleting rows is not supported for this engine yet.".into(),
        ))
    }

    /// Quote a single SQL identifier (column / table / schema name) the way
    /// THIS engine requires, doubling any embedded quote character (M15 export).
    ///
    /// The export use-cases run in the engine-agnostic application layer but
    /// must emit engine-correct `INSERT` statements (Postgres/SQLite wrap in
    /// double quotes, MySQL in backticks). Rather than leak per-engine quoting
    /// up the stack, the application layer asks the open connection to quote.
    /// This is a pure, synchronous string transform — no driver I/O — so it is
    /// a plain method, not `async`.
    ///
    /// Default impl: ANSI double-quoting (`"name"`, embedded `"` doubled),
    /// which is correct for SQLite and Postgres; MySQL overrides it to use
    /// backticks. Test fakes inherit the default unchanged.
    fn quote_identifier(&self, ident: &str) -> String {
        format!("\"{}\"", ident.replace('"', "\"\""))
    }

    /// Render `hex` (lowercase hex digits, no `0x`/`X` prefix; may be empty) as
    /// an engine-correct binary literal for a SQL dump's INSERT values, so a
    /// binary column round-trips. Default: the SQL-standard `X'..'` blob literal
    /// — correct for SQLite and accepted by MySQL. Postgres overrides it to a
    /// `bytea` literal.
    fn binary_literal(&self, hex: &str) -> String {
        format!("X'{hex}'")
    }

    /// Empty a table of all rows, keeping its structure (M15 truncate).
    ///
    /// **Mutates user data.** Engine-aware: Postgres/MySQL run `TRUNCATE TABLE`;
    /// SQLite, which has no `TRUNCATE`, runs `DELETE FROM …` inside a
    /// transaction (so `affected` reflects the prior row count). The adapter
    /// validates the table exists (a §5 error otherwise) and quotes both
    /// identifiers. Returns the number of rows removed — exact for SQLite's
    /// `DELETE`; for the server engines `TRUNCATE` does not report a row count,
    /// so the adapter counts the rows first and returns that (0 for an
    /// already-empty table).
    ///
    /// Default impl: `Unsupported` — only engines that implement it override it.
    async fn truncate_table(&self, _schema: &str, _table: &str) -> Result<u64, AppError> {
        Err(AppError::Unsupported(
            "Truncating tables is not supported for this engine yet.".into(),
        ))
    }

    /// Drop every table in a schema and leave that schema empty, ready to
    /// recreate / re-import (M15 SQL enhancements — "drop schema").
    ///
    /// **Mutates user data — destructive.** The semantics are "drop + recreate
    /// an empty schema", engine-aware:
    ///
    /// - **Postgres** runs `DROP SCHEMA "x" CASCADE; CREATE SCHEMA "x";` inside
    ///   one transaction — Postgres has transactional DDL, so this is atomic and
    ///   leaves an empty schema even if interrupted.
    /// - **MySQL** treats schema == database: `DROP DATABASE \`x\`;
    ///   CREATE DATABASE \`x\`;`. **MySQL DDL auto-commits**, so this is NOT
    ///   atomic — the drop commits before the recreate runs; the adapter
    ///   recreates immediately so a successful call always leaves an empty
    ///   database.
    /// - **SQLite** has no droppable schema/database (`main` is the file
    ///   itself), so "drop schema" is defined as **drop every user table** in
    ///   that schema (`DROP TABLE` each non-`sqlite_%` table) inside a
    ///   transaction, leaving an empty schema. The database file is never
    ///   deleted.
    ///
    /// The adapter validates the schema exists where applicable (a §5 error
    /// otherwise) and quotes the identifier per engine. Returns `()` — the table
    /// list afterwards is empty by construction.
    ///
    /// Default impl: `Unsupported` — only engines that implement it override it.
    async fn drop_schema(&self, _schema: &str) -> Result<(), AppError> {
        Err(AppError::Unsupported(
            "Dropping a schema is not supported for this engine yet.".into(),
        ))
    }

    /// Create a new empty schema/database. Engine-aware: Postgres `CREATE
    /// SCHEMA "x"`, MySQL `CREATE DATABASE \`x\``. **SQLite has no notion of
    /// creating a schema** (a "schema" there is an ATTACHed database file), so it
    /// stays `Unsupported`. The adapter quotes the identifier per engine; a
    /// duplicate name surfaces the engine's §5 error.
    ///
    /// Default impl: `Unsupported` — only engines that implement it override it.
    async fn create_schema(&self, _schema: &str) -> Result<(), AppError> {
        Err(AppError::Unsupported(
            "Creating a schema is not supported for this engine.".into(),
        ))
    }

    /// Run a whole multi-statement SQL script (a dump: `CREATE TABLE` + `INSERT`
    /// + …) into the given schema (M15 import — the I/O counterpart of export).
    ///
    /// Unlike [`run_query`](Self::run_query), which runs a SINGLE statement, this
    /// executes the entire `;`-separated script in one go and returns the number
    /// of statements executed ([`ImportResult`]). It is engine-aware:
    ///
    /// - **SQLite** wraps the script in a `BEGIN`/`COMMIT` and runs it via
    ///   `execute_batch`; any error rolls the whole import back so a table is
    ///   never left half-created. SQLite has no "current schema" beyond
    ///   `main` + attached databases, so unqualified `CREATE`s land in `main`;
    ///   importing into a specific attached schema requires the script itself to
    ///   qualify names (out of scope — the SQLite adapter documents this).
    /// - **Postgres** prefixes `SET search_path` for the target schema and runs
    ///   the script through sqlx's multi-statement path, whose simple-query
    ///   protocol wraps the statements in an implicit transaction — a mid-script
    ///   failure rolls all of them back (atomic).
    /// - **MySQL** sets the database (`USE`) then runs the script. **MySQL DDL
    ///   auto-commits**, so a multi-statement import is NOT atomic: on a
    ///   mid-script failure the statements before it have already landed and
    ///   cannot be rolled back — the §5 error says how far it got.
    ///
    /// On any error the engine error surfaces as a §5 human sentence; the adapter
    /// rolls back where the engine allows. Unknown-schema and the engine's own
    /// SQL errors are §5 messages.
    ///
    /// `on_progress(done, total)` is called after each statement so the importer
    /// can drive a progress bar (see [`ProgressCallback`]).
    ///
    /// Default impl: `Unsupported` — only engines that implement it override it.
    async fn execute_script(
        &self,
        _schema: &str,
        _sql: &str,
        _on_progress: ProgressCallback<'_>,
    ) -> Result<ImportResult, AppError> {
        Err(AppError::Unsupported(
            "Importing SQL is not supported for this engine yet.".into(),
        ))
    }

    /// Insert many pre-generated rows into one table (M16 generate). **Mutates
    /// user data — append only.** `columns` names the inserted columns; each row
    /// in `rows` is parallel to `columns` (`serde_json::Value`; `Null` → SQL
    /// NULL). `binary` is parallel to `columns`: a `true` entry marks a binary
    /// column whose values arrive as `0x`-hex strings and MUST be bound as raw
    /// bytes (BLOB / bytea / BINARY), so a `binary(n)` value round-trips instead
    /// of being stored as its hex text. The adapter quotes identifiers per
    /// engine, binds every value as a parameter, and runs the batch inside a
    /// transaction (multi-row `INSERT … VALUES (…),(…)` on Postgres/MySQL; a
    /// batched prepared insert in a transaction on SQLite). Returns rows inserted.
    ///
    /// Default impl: `Unsupported` — only the SQL engines override it.
    async fn bulk_insert(
        &self,
        _schema: &str,
        _table: &str,
        _columns: &[String],
        _binary: &[bool],
        _rows: &[Vec<serde_json::Value>],
    ) -> Result<u64, AppError> {
        Err(AppError::Unsupported(
            "Bulk insert is not supported for this engine yet.".into(),
        ))
    }

    /// Read up to `cap` existing key tuples from a table for FK sourcing and
    /// append-uniqueness baselining (M16 generate). Returns each row as the
    /// values of `columns`, in arbitrary order, capped to bound memory on large
    /// parent tables.
    ///
    /// Default impl: `Unsupported` — only the SQL engines override it.
    async fn fetch_pk_pool(
        &self,
        _schema: &str,
        _table: &str,
        _columns: &[String],
        _cap: u64,
    ) -> Result<Vec<Vec<serde_json::Value>>, AppError> {
        Err(AppError::Unsupported(
            "Reading a key pool is not supported for this engine yet.".into(),
        ))
    }

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
