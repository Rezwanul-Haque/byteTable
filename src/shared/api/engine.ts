// Engine-level wire types — the TS mirrors of the Rust types in
// `src-tauri/src/shared/engine.rs`, shared by every slice that talks to a
// database connection. Field names are camelCase and enum values lowercase
// per the serde attributes on the Rust side — keep the two files in sync.
//
// `queryRun` lives here too as a temporary home matching the backend's
// placement (the `query_run` command is engine-shared, not connection
// bookkeeping). The M6 query feature will own query-execution UX, but the
// wire contract stays shared.

import { Channel, invoke } from "@tauri-apps/api/core";

import type { Engine } from "../types";

/** What a successful test/open learned about the target. */
export interface EngineInfo {
  engine: Engine;
  /** Display version string, e.g. "SQLite 3.46.0". */
  serverVersion: string;
}

/** A schema (SQLite: `main` + attached databases). */
export interface SchemaInfo {
  name: string;
  /** Number of user tables, when cheaply known (`null` otherwise). */
  tableCount: number | null;
}

/** A table within a schema. */
export interface TableInfo {
  name: string;
  /** Approximate row count, when cheaply known (`null` otherwise). */
  approxRowCount: number | null;
}

/** The target of a foreign-key reference: a column in another table. */
export interface FkRef {
  table: string;
  /**
   * Empty string when the engine could not resolve an implicit fk target
   * (e.g. SQLite `REFERENCES t` to a table without a resolvable pk).
   */
  column: string;
}

/** One column of a table (M3 sidebar: pk/fk icons + type labels). */
export interface ColumnInfo {
  name: string;
  /** Declared type as written in the DDL (may be empty). Display only. */
  dataType: string;
  /** True when the column has no NOT NULL constraint declared. */
  nullable: boolean;
  /** True when part of the primary key (every member of a composite pk). */
  pk: boolean;
  /**
   * The column's DEFAULT expression, verbatim as the engine reports it (SQLite
   * `dflt_value`), or `null`/absent when the column has no default. Literal SQL
   * text (e.g. `"0"`, `"'pending'"`, `"CURRENT_TIMESTAMP"`) — display/round-trip
   * only, never re-quoted. Powers the M8 structure editor's "Default" cell.
   */
  default?: string | null;
  /** The foreign-key target, when this column references another table. */
  fk: FkRef | null;
  /** The column's comment / description, when the engine records one (Postgres
   *  `COMMENT ON COLUMN`, MySQL `COLUMN_COMMENT`). `null`/absent otherwise
   *  (incl. SQLite, which has no column comments). The structure editor's
   *  "Comment" cell reads + edits this. */
  comment?: string | null;
}

/** One index on a table (M7 structure view §3.6). */
export interface IndexInfo {
  name: string;
  /** Indexed columns, in index order (may be empty for an expression index). */
  columns: string[];
  /** True for a UNIQUE index (includes the implicit primary-key index). */
  unique: boolean;
  /** True for the implicit primary-key index (SQLite `origin == "pk"`). */
  primary: boolean;
  /**
   * How the index came to exist, when known. SQLite: `"c"` (CREATE INDEX),
   * `"u"` (a UNIQUE constraint), or `"pk"` (the primary key). `null` for
   * engines that do not report it.
   */
  origin: string | null;
}

/**
 * One foreign key declared on a table (outbound), grouped per constraint so a
 * composite key is one entry with parallel column lists (`columns[i]`
 * references `refColumns[i]`).
 */
export interface ForeignKeyInfo {
  /** The constraint name, when the engine exposes one. SQLite: always `null`. */
  name: string | null;
  /** Local columns of this table, in constraint order. */
  columns: string[];
  refTable: string;
  /** Referenced columns of `refTable`, parallel to `columns`. */
  refColumns: string[];
  /** The `ON DELETE` action (e.g. "CASCADE", "SET NULL"); `null` if unknown. */
  onDelete: string | null;
  /** The `ON UPDATE` action; `null` if unknown. */
  onUpdate: string | null;
}

/**
 * A foreign key pointing *at* this table from another table in the same
 * schema (M7 §3.6 "referenced by"). Grouped per constraint like
 * {@link ForeignKeyInfo}.
 */
export interface InboundFkInfo {
  /** The child table that holds the foreign key. */
  table: string;
  /** The child table's foreign-key columns, in constraint order. */
  columns: string[];
  /** This table's referenced columns, parallel to `columns`. */
  refColumns: string[];
  /** The `ON DELETE` action on the child's constraint; `null` if unknown. */
  onDelete: string | null;
}

/**
 * Metadata for one table. `columns` powers the M3 sidebar / M4 grid headers
 * (its shape is unchanged); the rest powers the M7 structure view (§3.6):
 * indexes, outbound + inbound foreign keys, and the CREATE TABLE DDL. The
 * `Vec` fields are always present (empty when none); `comment`/`ddl` are
 * `null` when absent.
 */
export interface TableMeta {
  columns: ColumnInfo[];
  /**
   * The table's comment, when the engine has one. SQLite has none (always
   * `null`); modelled for the §3.6 header and server engines (M12).
   */
  comment?: string | null;
  /** Indexes, including the implicit primary-key index (`primary: true`). */
  indexes: IndexInfo[];
  /** Foreign keys declared on this table (outbound), grouped per constraint. */
  foreignKeys: ForeignKeyInfo[];
  /** Foreign keys pointing at this table (inbound) from the same schema. */
  referencedBy: InboundFkInfo[];
  /** The verbatim CREATE TABLE statement for the §3.6 DDL modal; `null` if absent. */
  ddl?: string | null;
}

/** Column metadata accompanying a query result. */
export interface ColumnMeta {
  name: string;
  /** Best-effort type label — a display hint, never for logic. */
  typeHint: string;
}

/** Options for a single query execution (backend defaults: rowLimit 500). */
export interface QueryOptions {
  rowLimit?: number;
  schema?: string;
}

/**
 * One result cell. Engine values map to JSON: NULL → null, integers/reals →
 * numbers, text → strings; integers beyond ±2^53 arrive as strings to
 * preserve precision (see the SQLite adapter docs).
 *
 * `boolean` is reachable since M12: Postgres has a native `boolean` type and
 * the Postgres adapter maps it to a JSON bool (SQLite has no boolean type and
 * never emits one — it stores 0/1 integers). This widening is what activates
 * GridCell's green/red boolean rendering.
 */
export type CellValue = string | number | boolean | null;

/** The outcome of a query: column metadata, row-major values, timing. */
export interface QueryResult {
  columns: ColumnMeta[];
  rows: CellValue[][];
  rowCount: number;
  truncated: boolean;
  elapsedMs: number;
}

/** Sort direction for a single column. Lowercase on the wire ("asc"/"desc"). */
export type SortDirection = "asc" | "desc";

/** A single-column sort applied to a browsed table. */
export interface SortSpec {
  column: string;
  direction: SortDirection;
}

/**
 * The comparison applied by one structured filter [`Condition`] (M5). Wire
 * tokens are camelCase, matching the Rust `FilterOp` serde. The prototype's
 * internal op ids in `bytetable/filters.jsx` differ — the builder maps them:
 * `neq`→`ne`, `ncontains`→`notContains`, `begins`→`beginsWith`,
 * `ends`→`endsWith`, `in`→`inList`, `null`→`isNull`, `nnull`→`isNotNull`;
 * the rest (`eq`/`gt`/`gte`/`lt`/`lte`/`contains`) are unchanged.
 */
export type FilterOp =
  | "eq"
  | "ne"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains"
  | "notContains"
  | "beginsWith"
  | "endsWith"
  | "inList"
  | "isNull"
  | "isNotNull";

/** How structured conditions combine. Lowercase on the wire ("and"/"or"). */
export type Combinator = "and" | "or";

/**
 * The value a condition compares against: a single scalar for the comparison
 * and LIKE operators, or an array for `inList`. Untagged on the wire — an
 * array is the list form, anything else is the scalar form. `null` values are
 * rejected by the backend (use `isNull` / `isNotNull` instead).
 */
export type FilterValue = CellValue | CellValue[];

/**
 * One structured filter row: a column, an operator, and (unless the operator
 * is a null check) a value. `value` is `null` for `isNull` / `isNotNull`.
 */
export interface Condition {
  column: string;
  op: FilterOp;
  value: FilterValue | null;
  /**
   * Set when `column` is a binary type (BINARY/VARBINARY/BLOB/BYTEA) so the
   * backend binds the value (a `0x`-hex or UUID string) as raw bytes — matching
   * bytes-to-bytes instead of as text that would never match. Omit/false for
   * normal columns.
   */
  binary?: boolean;
}

/**
 * The filter applied to a browsed table (M5 stackable filter builder). Two
 * mutually exclusive modes, discriminated by `mode`:
 *
 * - `conditions` — the structured builder. Every condition compiles to
 *   bound-parameter SQL on the backend; no SQL-injection surface.
 * - `raw` — the "Edit as SQL" escape hatch. `sql` is the WHERE body,
 *   interpolated verbatim by the backend (a documented power-user feature,
 *   same trust level as the M6 query editor).
 */
export type FilterSpec =
  | { mode: "conditions"; items: Condition[]; combinator: Combinator }
  | { mode: "raw"; sql: string };

/**
 * A request for one page of rows from a table (M4 data grid + M5 filters):
 * paging, an optional single-column sort, and an optional filter. When a
 * filter is present it applies to both the page query and the count, so
 * `RowsPage.totalRows` is the *filtered* total ("n of N rows").
 */
export interface FetchRowsRequest {
  schema: string;
  table: string;
  /** Optional single-column sort; `null` leaves order to the engine. */
  sort: SortSpec | null;
  /** Optional row filter (M5); omit or `null` to return the whole table. */
  filter?: FilterSpec | null;
  /** Zero-based row offset of the page. */
  offset: number;
  /** Maximum rows in the page. The backend clamps this to its page ceiling. */
  limit: number;
}

/** One page of rows from a table: column metadata, values, window, timing. */
export interface RowsPage {
  columns: ColumnMeta[];
  rows: CellValue[][];
  /** The offset this page was fetched at (echoes the request). */
  offset: number;
  /** The effective page size after clamping (echoes the request). */
  limit: number;
  /**
   * Exact `COUNT(*)` matching the request: the whole table when no filter is
   * set, the *filtered* count when `FetchRowsRequest.filter` is present (this
   * drives the "n of N rows" status). Computed per fetch; `null` when the
   * count could not be obtained (a later milestone may also return `null` for
   * an estimate fallback).
   */
  totalRows: number | null;
  elapsedMs: number;
}

/**
 * A single-row lookup by key (M10 "FK peek", §3.5): find the row(s) where
 * `column = value`. Driven by clicking a foreign-key cell to peek at the
 * referenced row — `column` is the referenced column (usually a pk/unique
 * key), so the match is normally 0 or 1 row. The backend validates `column`
 * and *binds* `value` (no injection surface); a `null` value never matches.
 */
export interface RowLookupRequest {
  schema: string;
  table: string;
  /** The column to match on (the referenced column for an FK peek). */
  column: string;
  /** The key value to look up. Bound as a parameter; `null` matches nothing. */
  value: CellValue;
  /** Set when `column` is binary so the value binds as raw bytes (FK peek on a
   *  binary key). Omit/false otherwise. */
  binary?: boolean;
}

/**
 * The result of a {@link RowLookupRequest} (M10 "FK peek"): the matching row
 * (if any) plus column metadata for field labels and the total match count.
 */
export interface RowLookup {
  /** Always returned (even on a miss) so the UI can label empty fields. */
  columns: ColumnMeta[];
  /** The first matching row, or `null` when nothing matched. */
  row: CellValue[] | null;
  /** Total rows matching `column = value` (so the UI can flag "1 of N"). */
  matchCount: number;
}

/**
 * One primary-key predicate in an {@link UpdateCellRequest}: a pk column and
 * the value identifying the target row. A composite primary key needs one
 * `PkPredicate` per pk column; the backend ANDs them so the WHERE clause
 * matches exactly one row. `value` is *bound* (no injection surface).
 */
export interface PkPredicate {
  column: string;
  /** The pk value identifying the row. Bound as a parameter. */
  value: CellValue;
  /** Set when this pk column is binary so its value binds as raw bytes (so
   *  `WHERE pk = ?` matches a binary key). Omit/false otherwise. */
  binary?: boolean;
}

/**
 * A request to update a single cell (M11 inline edit, §3.5): set `column` to
 * `value` on the one row identified by the full primary key.
 *
 * **Mutates user data.** The backend enforces the safety contract: `pk` must
 * cover the table's FULL primary key (a table with no pk, a partial pk, or a
 * non-pk predicate column is an error — mass-update prevention); `value` is
 * *bound* (`SET col = ?`, so `null` sets the cell to NULL and any string is
 * stored literally, never executed); every pk value is likewise bound.
 */
export interface UpdateCellRequest {
  schema: string;
  table: string;
  /** The column whose cell is updated. */
  column: string;
  /** The new value. Bound as a parameter; `null` sets the cell to NULL. */
  value: CellValue;
  /** Set when `column` is binary so `value` (a `0x`-hex / UUID string) binds as
   *  raw bytes. Omit/false otherwise. */
  binary?: boolean;
  /** The full primary key of the target row, one predicate per pk column. */
  pk: PkPredicate[];
}

/**
 * The outcome of a {@link rowUpdate} call (M11 inline edit): the number of rows
 * changed (always `1` on success) and a cosmetic statement string for the §3.5
 * "toast with the executed statement".
 *
 * `statement` is a **display** rendering with values inlined (e.g.
 * `UPDATE "main"."users" SET "name" = 'Ada' WHERE "id" = 42`) so the toast
 * reads naturally — it is NOT the verbatim query sent to the engine, which is
 * fully parameterized (`SET "name" = ? WHERE "id" = ?`) with every value bound.
 */
export interface UpdateResult {
  /** Rows changed — exactly `1` on success. */
  affected: number;
  /** A human-readable, values-inlined rendering of the statement (cosmetic). */
  statement: string;
}

/** One value/frequency pair in a column's top-values list ({@link ColumnStats}). */
export interface FreqEntry {
  value: CellValue;
  /** How many rows (within the filtered set) hold this value. */
  count: number;
}

/**
 * A request for per-column statistics (M10 "column insights", §3.5), computed
 * over the grid's current filtered set so insights match what the user sees.
 * The backend validates `column` and reuses the same parameterized filter
 * compilation as `rowsFetch`.
 */
export interface ColumnStatsRequest {
  schema: string;
  table: string;
  column: string;
  /** The grid's current filter; omit or `null` for the whole table. */
  filter?: FilterSpec | null;
}

/**
 * Per-column statistics over a (possibly filtered) row set (M10 "column
 * insights"). All counts respect the request's filter. `min`/`max` are always
 * returned (lexicographic for text — the UI decides display); `avg` is only
 * meaningful (and non-null) for numeric columns. `numeric` tells the UI
 * whether to render min/max/avg as numbers.
 */
export interface ColumnStats {
  /** Total rows in the (filtered) set, including NULLs. */
  total: number;
  /** Distinct non-NULL values. */
  distinct: number;
  /** Rows whose value is NULL. */
  nulls: number;
  /** The minimum value, or `null` when the set has no non-NULL values. */
  min: CellValue;
  /** The maximum value, or `null` when the set has no non-NULL values. */
  max: CellValue;
  /** The average, only when `numeric` (else `null`). */
  avg: number | null;
  /** Whether the column holds numeric data (drives numeric display). */
  numeric: boolean;
  /** The up-to-five most frequent non-NULL values, most frequent first. */
  top: FreqEntry[];
}

/** Column-level metadata for one table (the `table_meta` command). */
export function tableMeta(handleId: string, schema: string, table: string): Promise<TableMeta> {
  return invoke<TableMeta>("table_meta", { handleId, schema, table });
}

// ---------------------------------------------------------------------------
// Schema objects (views / materialized views / functions / procedures /
// triggers). Mirrors the Rust `DbObject*` wire types + the introspection
// slice's object commands. Each SQL engine exposes the kinds it supports
// (see {@link OBJECT_CAPS}); CRUD runs whole DDL statements verbatim via
// {@link runObjectDdl} (never the `;`-splitting script path).
// ---------------------------------------------------------------------------

/** A schema object's kind. Snake_case on the wire (Rust `DbObjectKind`). */
export type DbObjectKind = "view" | "materialized_view" | "function" | "procedure" | "trigger";

/** One object in a schema (sidebar row + Object Explorer grid row). */
export interface DbObjectInfo {
  name: string;
  kind: DbObjectKind;
  /** Owning table (triggers) / identity args (PG routines); else null. */
  detail: string | null;
  // Object Explorer grid metadata (M22). Best-effort per engine — null/[] when
  // the engine can't source it cheaply; the sidebar ignores these fields.
  owner: string | null;
  modified: string | null;
  returns: string | null;
  language: string | null;
  volatility: string | null;
  argCount: number | null;
  table: string | null;
  timing: string | null;
  events: string[];
  enabled: boolean | null;
  approxRows: number | null;
  size: string | null;
  dependsOn: string[];
}

/** One routine argument (function/procedure) for the viewer's args table. */
export interface RoutineArg {
  /** `IN`/`OUT`/`INOUT` (MySQL); null for Postgres (defaults to IN). */
  mode: string | null;
  name: string;
  dataType: string;
}

/** The `CREATE …` DDL for one object + best-effort viewer metadata. Metadata
 *  fields are optional/engine-dependent; each chip renders only when present. */
export interface DbObjectDefinition {
  name: string;
  kind: DbObjectKind;
  ddl: string;
  comment: string | null;
  // routines
  returns: string | null;
  language: string | null;
  volatility: string | null;
  args: RoutineArg[];
  // triggers
  table: string | null;
  timing: string | null;
  events: string[];
  level: string | null;
  enabled: boolean | null;
  // materialized views
  populated: boolean | null;
  approxRows: number | null;
  size: string | null;
  // views / matviews
  dependsOn: string[];
}

/** Which object kinds each engine exposes — mirrors the Rust capability matrix.
 *  Drives sidebar gating so unsupported groups never appear. */
export const OBJECT_CAPS: Record<Engine, DbObjectKind[]> = {
  postgres: ["view", "materialized_view", "function", "procedure", "trigger"],
  mysql: ["view", "function", "procedure", "trigger"],
  sqlite: ["view", "trigger"],
  // SQL Server (M21): full set; `materialized_view` = indexed view.
  mssql: ["view", "materialized_view", "function", "procedure", "trigger"],
  redis: [],
  dynamodb: [],
  mongodb: [],
  cassandra: [],
};

/** Objects of one kind in a schema (the `list_objects` command). */
export function listObjects(
  handleId: string,
  schema: string,
  kind: DbObjectKind,
): Promise<DbObjectInfo[]> {
  return invoke<DbObjectInfo[]>("list_objects", { handleId, schema, kind });
}

/** The `CREATE …` DDL for one object (the `object_definition` command). */
export function objectDefinition(
  handleId: string,
  schema: string,
  kind: DbObjectKind,
  name: string,
  detail?: string | null,
): Promise<DbObjectDefinition> {
  return invoke<DbObjectDefinition>("object_definition", {
    handleId,
    schema,
    kind,
    name,
    detail: detail ?? null,
  });
}

/** Drop one object (the `drop_object` command). **Mutates the schema.** */
export function dropObject(
  handleId: string,
  schema: string,
  kind: DbObjectKind,
  name: string,
  detail?: string | null,
): Promise<void> {
  return invoke("drop_object", { handleId, schema, kind, name, detail: detail ?? null });
}

/** Run whole object-DDL statements verbatim, in order (the `run_object_ddl`
 *  command). Each element is one complete statement — the caller separated DROP
 *  from CREATE; the backend never `;`-splits. Statements are fully
 *  schema-qualified, so no schema context is passed. **Mutates the schema.** */
export function runObjectDdl(handleId: string, statements: string[]): Promise<void> {
  return invoke("run_object_ddl", { handleId, statements });
}

/**
 * Single-row lookup by key for M10 "FK peek" (the `row_lookup` command): click
 * a foreign-key value to fetch the referenced row. Returns the first match
 * plus a total match count; unknown schema/table/column surface as
 * `{ kind, message }` errors.
 */
export function rowLookup(handleId: string, req: RowLookupRequest): Promise<RowLookup> {
  return invoke<RowLookup>("row_lookup", { handleId, req });
}

/**
 * Per-column statistics over the current filtered set for M10 "column
 * insights" (the `column_stats` command): distinct/null counts, min/max, avg
 * for numerics, and the top-5 most frequent values. Unknown
 * schema/table/column surface as `{ kind, message }` errors.
 */
export function columnStats(handleId: string, req: ColumnStatsRequest): Promise<ColumnStats> {
  return invoke<ColumnStats>("column_stats", { handleId, req });
}

/**
 * One page of rows for the M4 data grid (the `rows_fetch` command): paged
 * and optionally sorted, with an exact unfiltered row count.
 */
export function rowsFetch(handleId: string, req: FetchRowsRequest): Promise<RowsPage> {
  return invoke<RowsPage>("rows_fetch", { handleId, req });
}

export function queryRun(
  handleId: string,
  sql: string,
  options?: QueryOptions,
): Promise<QueryResult> {
  return invoke<QueryResult>("query_run", { handleId, sql, options });
}

/**
 * Update a single cell for M11 inline editing (the `row_update` command): set
 * one column to a new value on the row identified by its full primary key.
 * **Mutates user data.** Returns the affected count (always 1 on success) plus
 * a cosmetic statement string for the §3.5 toast. Unknown schema/table/column,
 * a missing/partial primary key, a stale pk, and engine constraint failures
 * surface as `{ kind, message }` errors. The new value and every pk value are
 * bound server-side — there is no SQL-injection surface.
 */
export function rowUpdate(handleId: string, req: UpdateCellRequest): Promise<UpdateResult> {
  return invoke<UpdateResult>("row_update", { handleId, req });
}

/**
 * A request to delete a set of whole rows by primary key (grid multi-select bulk
 * delete) — mirrors Rust's `DeleteRowsRequest`. Each entry in `rows` is the full
 * primary key of one target row, so every DELETE matches at most one row.
 */
export interface DeleteRowsRequest {
  schema: string;
  table: string;
  rows: PkPredicate[][];
}

/** Outcome of `rowsDelete` — the number of rows actually removed. */
export interface DeleteRowsResult {
  deleted: number;
}

/**
 * Delete a set of whole rows by primary key (grid multi-select bulk delete, the
 * `rows_delete` command). **Mutates user data.** The backend enforces the same
 * safety contract as `rowUpdate` (full-pk targeting, bound values, per-row
 * at-most-one guard, single transaction). Returns the number deleted.
 */
export function rowsDelete(handleId: string, req: DeleteRowsRequest): Promise<DeleteRowsResult> {
  return invoke<DeleteRowsResult>("rows_delete", { handleId, req });
}

// ---------------------------------------------------------------------------
// Export + truncate (M15, DESIGN_SPEC §3.5/§3.6).
//
// Export generates text in the Rust backend (the prototype downloaded via a
// browser Blob; ByteTable produces the text server-side and writes it through
// the native save dialog). `exportTable` / `exportSchema` return the text;
// `exportSave` writes it to the path the renderer obtained from the save
// dialog. `truncateTable` empties a table (engine-aware server-side: Postgres/
// MySQL `TRUNCATE`, SQLite `DELETE` in a transaction). The Task-2 UI (table-
// actions menu, sidebar entries, column popover, TruncateModal) consumes these
// wrappers; the save-dialog → `exportSave` flow is the export download path.
// ---------------------------------------------------------------------------

/** The export output format (`csv` / `sql`). Lowercase, matching the Rust enum. */
export type ExportFormat = "csv" | "sql";

/**
 * What a SQL dump should contain (the export "middleware" picker, prototype
 * `export-progress.jsx` `EXPORT_CONTENTS`): structure only, data only, or both.
 * Lowercase, matching the Rust `ExportScope` enum. Only affects SQL output —
 * CSV is always data, so it ignores the scope.
 */
export type ExportScope = "schema" | "data" | "both";

/** The outcome of {@link truncateTable}: the number of rows removed. */
export interface TruncateResult {
  affected: number;
}

/** The outcome of {@link importSql}: the number of statements executed. */
export interface ImportResult {
  statements: number;
}

/** A progress tick from a long export/import: `done` of `total` units. */
export interface ImportExportProgress {
  done: number;
  total: number;
}

/** Progress callback for export/import: `(done, total)`. */
export type ProgressFn = (done: number, total: number) => void;

/**
 * Build the Tauri `Channel` the export/import commands stream progress through.
 * Always returns a channel (the commands require the arg); when no callback is
 * given the messages are simply ignored.
 */
function progressChannel(onProgress?: ProgressFn): Channel<ImportExportProgress> {
  const channel = new Channel<ImportExportProgress>();
  if (onProgress) channel.onmessage = (m) => onProgress(m.done, m.total);
  return channel;
}

/**
 * Generate the export text for one table (`export_table` command). `format`
 * picks CSV (header + every row, prototype `csvVal` escaping) or SQL (the
 * `CREATE TABLE` DDL + one INSERT per row, prototype `sqlVal` literals,
 * engine-correct identifier quoting). Unknown schema/table surface as
 * `{ kind, message }` §5 errors. The text is built from ALL rows (not the
 * grid's page). `scope` (SQL only) picks structure-only / data-only / both;
 * CSV ignores it.
 */
export function exportTable(
  handleId: string,
  schema: string,
  table: string,
  format: ExportFormat,
  scope: ExportScope,
  onProgress?: ProgressFn,
): Promise<string> {
  return invoke<string>("export_table", {
    handleId,
    schema,
    table,
    format,
    scope,
    onProgress: progressChannel(onProgress),
  });
}

/**
 * Generate a SQL dump (DDL + data) for every base table in a schema
 * (`export_schema` command), concatenated under a header comment. Tables are
 * dumped in listing order, not foreign-key order (the dump notes a restore may
 * need FK checks disabled). `scope` picks structure-only / data-only / both.
 */
export function exportSchema(
  handleId: string,
  schema: string,
  scope: ExportScope,
  onProgress?: ProgressFn,
): Promise<string> {
  return invoke<string>("export_schema", {
    handleId,
    schema,
    scope,
    onProgress: progressChannel(onProgress),
  });
}

/**
 * Write generated export text to a user-chosen path (`export_save` command).
 * The `path` comes from the native save dialog (the `dialog:allow-save`
 * capability). IO failures surface a §5 error naming the path.
 */
export function exportSave(path: string, contents: string): Promise<void> {
  return invoke<void>("export_save", { path, contents });
}

/**
 * Import a `.sql` dump into a schema (`import_sql` command — the I/O
 * counterpart of {@link exportSave}). The backend reads the file at `path`
 * (obtained from the native open dialog — the `dialog:allow-open` capability;
 * the user's choice is the consent) and runs the whole multi-statement script
 * into `schema`. Engine-aware atomicity: SQLite/Postgres roll the import back on
 * any error; MySQL DDL auto-commits, so a mid-script failure is NOT rolled back
 * and the §5 error names how far it got. A missing/unreadable file or a script
 * failure surfaces a `{ kind, message }` §5 error. Returns `{ statements }`, the
 * number of statements executed.
 */
export function importSql(
  handleId: string,
  schema: string,
  path: string,
  onProgress?: ProgressFn,
): Promise<ImportResult> {
  return invoke<ImportResult>("import_sql", {
    handleId,
    schema,
    path,
    onProgress: progressChannel(onProgress),
  });
}

/**
 * Read a user-picked text file (CSV or `.sql`) for preview/parse (the
 * `read_text_file` command). The `path` comes from the native open dialog (the
 * `dialog:allow-open` capability — the user's choice is the consent). A
 * missing/unreadable file surfaces a `{ kind, message }` §5 IO error naming the
 * path. Used by the import modals to load a file before previewing it client-
 * side (CSV columns / INSERT statements).
 */
export function readTextFile(path: string): Promise<string> {
  return invoke<string>("read_text_file", { path });
}

/**
 * Run a multi-statement SQL script given as TEXT into a schema (the
 * `execute_script_text` command — the in-memory counterpart of
 * {@link importSql}). Lets the renderer apply generated SQL (e.g. INSERTs built
 * from a parsed CSV) without a temp file. Engine-aware atomicity matches
 * {@link importSql}; a script failure surfaces a `{ kind, message }` §5 error.
 * Returns `{ statements }`, the number of statements executed.
 */
export function executeScriptText(
  handleId: string,
  schema: string,
  sql: string,
  onProgress?: ProgressFn,
): Promise<ImportResult> {
  return invoke<ImportResult>("execute_script_text", {
    handleId,
    schema,
    sql,
    onProgress: progressChannel(onProgress),
  });
}

/**
 * Empty a table of all rows, keeping its structure (`truncate_table` command).
 * **Mutates user data.** Engine-aware server-side (Postgres/MySQL `TRUNCATE`,
 * SQLite `DELETE` in a transaction). Returns `{ affected }`, the number of rows
 * removed. Unknown schema/table surface as `{ kind, message }` §5 errors. The
 * production-confirm dialog (TruncateModal) is the caller's responsibility.
 */
export function truncateTable(
  handleId: string,
  schema: string,
  table: string,
): Promise<TruncateResult> {
  return invoke<TruncateResult>("truncate_table", { handleId, schema, table });
}

/**
 * Drop every table in a schema, leaving it empty (`drop_schema` command).
 * **Mutates user data — destructive.** Engine-aware server-side: Postgres
 * `DROP SCHEMA … CASCADE; CREATE SCHEMA …` (atomic); MySQL `DROP DATABASE;
 * CREATE DATABASE` (NOT atomic — DDL auto-commits); SQLite drops every user
 * table in a transaction (the file IS the schema). Resolves on success; the
 * schema is empty afterward. Unknown schema surfaces as a `{ kind, message }`
 * §5 error. The production-confirm dialog (DropSchemaModal) is the caller's
 * responsibility.
 */
export function dropSchema(handleId: string, schema: string): Promise<void> {
  return invoke<void>("drop_schema", { handleId, schema });
}

/**
 * Create a new empty schema/database (`create_schema` command). Engine-aware:
 * Postgres `CREATE SCHEMA`, MySQL `CREATE DATABASE`; **SQLite is unsupported**
 * (a "schema" there is an ATTACHed file). A duplicate name surfaces the
 * engine's `{ kind, message }` §5 error.
 */
export function createSchema(handleId: string, schema: string): Promise<void> {
  return invoke<void>("create_schema", { handleId, schema });
}

// ---------------------------------------------------------------------------
// Structure editing (M8, DESIGN_SPEC §3.6) — staged ALTER pipeline.
//
// One inline edit = one staged `AlterOp`. The structure view accumulates a
// batch and sends it to `alterPreview` (get the "Review SQL" statements,
// pure — no DB writes) and `alterApply` (execute transactionally). Mirrors the
// Rust `AlterOp` enum in `src-tauri/src/features/structure/domain` — internally
// tagged on `op`, camelCase tokens/fields. The `default` fields carry the
// verbatim default expression (`null` = no default / DROP DEFAULT).
// ---------------------------------------------------------------------------

/**
 * One staged structure edit. Ten kinds matching §3.6's editing operations
 * (six column ops plus index and foreign-key add/drop).
 *
 * - `setNullable.nullable`: `true` ⇒ DROP NOT NULL, `false` ⇒ SET NOT NULL.
 * - `setDefault.default` / `addColumn.default`: `null` ⇒ no default (DROP
 *   DEFAULT), otherwise the verbatim default SQL expression.
 *
 * Preview shows the logical intent (e.g. `ALTER TABLE … ALTER COLUMN … TYPE …`);
 * on SQLite, type/nullable/default changes are executed via a table rebuild
 * (see the adapter). Dropping or retyping a primary-key column is rejected.
 */
export type AlterOp =
  | { op: "addColumn"; name: string; dataType: string; nullable: boolean; default: string | null }
  | { op: "renameColumn"; from: string; to: string }
  | { op: "changeType"; column: string; newType: string }
  | { op: "setNullable"; column: string; nullable: boolean }
  | { op: "setDefault"; column: string; default: string | null }
  | { op: "setComment"; column: string; comment: string | null }
  | { op: "dropColumn"; name: string }
  | { op: "addIndex"; name: string; columns: string[]; unique: boolean }
  | { op: "dropIndex"; name: string }
  | {
      op: "addForeignKey";
      name: string;
      columns: string[];
      refTable: string;
      refColumns: string[];
      onDelete: string | null;
    }
  | { op: "dropForeignKey"; name: string; columns: string[] };

/**
 * The outcome of an `alterPreview` / `alterApply` call: the SQL statement
 * strings the batch implies (the "Review SQL" list — same for preview and
 * apply) and whether they were executed (`false` for a preview).
 */
export interface AlterResult {
  statements: string[];
  applied: boolean;
}

/**
 * Preview the SQL a batch of staged edits implies (the `alter_preview`
 * command). Pure: never mutates the database. Unknown schema/table/column and
 * pk-protected ops surface as `{ kind, message }` errors.
 */
export function alterPreview(
  handleId: string,
  schema: string,
  table: string,
  ops: AlterOp[],
): Promise<AlterResult> {
  return invoke<AlterResult>("alter_preview", { handleId, schema, table, ops });
}

/**
 * Apply a batch of staged edits transactionally (the `alter_apply` command).
 * Rolls back fully on any failure and returns the engine error §5-style. After
 * a successful apply the caller should re-introspect (nothing is cached
 * server-side).
 */
export function alterApply(
  handleId: string,
  schema: string,
  table: string,
  ops: AlterOp[],
): Promise<AlterResult> {
  return invoke<AlterResult>("alter_apply", { handleId, schema, table, ops });
}
