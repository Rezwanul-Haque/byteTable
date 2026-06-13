// Engine-level wire types — the TS mirrors of the Rust types in
// `src-tauri/src/shared/engine.rs`, shared by every slice that talks to a
// database connection. Field names are camelCase and enum values lowercase
// per the serde attributes on the Rust side — keep the two files in sync.
//
// `queryRun` lives here too as a temporary home matching the backend's
// placement (the `query_run` command is engine-shared, not connection
// bookkeeping). The M6 query feature will own query-execution UX, but the
// wire contract stays shared.

import { invoke } from "@tauri-apps/api/core";

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
  /** The foreign-key target, when this column references another table. */
  fk: FkRef | null;
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
 */
export type CellValue = string | number | null;

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

/** Column-level metadata for one table (the `table_meta` command). */
export function tableMeta(handleId: string, schema: string, table: string): Promise<TableMeta> {
  return invoke<TableMeta>("table_meta", { handleId, schema, table });
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
