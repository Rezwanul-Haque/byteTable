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

/**
 * Column-level metadata for one table. Deliberately minimal — the M7
 * structure view will extend this shape (indexes, defaults, …).
 */
export interface TableMeta {
  columns: ColumnInfo[];
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
 * A request for one page of rows from a table (M4 data grid). M4 scope:
 * paging plus an optional single-column sort — row filtering is M5, so there
 * is no predicate field yet.
 */
export interface FetchRowsRequest {
  schema: string;
  table: string;
  /** Optional single-column sort; `null` leaves order to the engine. */
  sort: SortSpec | null;
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
   * Exact `COUNT(*)` of the table (unfiltered in M4 — filters are M5).
   * Computed per fetch in M4; `null` when the count could not be obtained
   * (a later milestone may also return `null` for an estimate fallback).
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
