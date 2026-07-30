// Typed invoke() wrappers for the schema-diff slice's Tauri commands (M28),
// plus the TS mirrors of the Rust wire types. Field names are camelCase and
// enum values are the marker glyphs / kebab-case strings the Rust `serde`
// attributes produce — keep in sync with
// `src-tauri/src/features/schema_diff/domain/mod.rs`.
//
// Three moves, matching the backend:
//   1. `schemaSnapshot` — read one schema's structure (columns + indexes).
//      READ-ONLY: the command cannot return row data.
//   2. `schemaDiffCompare` — diff two snapshots and plan the migration. Pure,
//      so swapping direction re-diffs without touching either database.
//   3. `schemaDiffApply` — run the selected statements against the target.
//
// ARCHITECTURE pattern: this module is the slice's public contract —
// cross-feature consumption of another feature's api.ts / state.ts is
// sanctioned; reaching into its components is not.

import { invoke } from "@tauri-apps/api/core";

import type { Engine } from "../../shared/types";

/** One column of a structural snapshot. `type` is the declared type verbatim. */
export interface ColumnSchema {
  name: string;
  type: string;
  pk: boolean;
  nullable: boolean;
}

/** One index of a structural snapshot. `primary` = the implicit pk index. */
export interface IndexSchema {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
}

/** One table's structure. Views / matviews are never snapshotted. */
export interface TableSchema {
  name: string;
  columns: ColumnSchema[];
  indexes: IndexSchema[];
}

/** The structure of one schema on one connection — what the differ consumes. */
export interface SchemaSnapshot {
  schema: string;
  tables: TableSchema[];
}

/**
 * How one table differs, always phrased as *what the target needs* to match the
 * source: `new` = create it, `only-target` = a sync would drop it.
 */
export type TableStatus = "new" | "changed" | "only-target" | "same";

/** Per-row marker: column added / retyped / dropped / unchanged, or an index. */
export type ColumnMark = "+" | "~" | "-" | "=" | "+idx" | "-idx";

/** One row of an expanded table diff (a column, or an index for `±idx`). */
export interface ColumnDiff {
  mk: ColumnMark;
  name: string;
  /** The source's type; for an index row, its `(col, col)` list. */
  type: string;
  /** The target's current type — only on `~` rows (`old → new`). */
  old?: string;
  pk: boolean;
}

/** One table's diff entry. `delta` ("N cols") is set for tables in both sides. */
export interface TableDiff {
  name: string;
  status: TableStatus;
  cols: ColumnDiff[];
  delta?: string;
}

/** What a statement does — drives the summary chips. */
export type StatementKind =
  | "create"
  | "drop"
  | "col-add"
  | "col-drop"
  | "col-alter"
  | "index"
  | "index-drop";

/**
 * One planned statement. `destructive` marks the ones that remove structure
 * (and any data those objects hold) — the UI starts them unchecked.
 */
export interface MigrationStatement {
  id: number;
  kind: StatementKind;
  sql: string;
  table: string;
  destructive: boolean;
}

/** What one comparison produced. */
export interface SchemaComparison {
  tables: TableDiff[];
  statements: MigrationStatement[];
}

/**
 * The structure of `schema` on an open SQL connection: every base table with
 * its columns and indexes. **Reads no rows** — the backend port cannot return
 * any.
 */
export function schemaSnapshot(handleId: string, schema: string): Promise<SchemaSnapshot> {
  return invoke<SchemaSnapshot>("schema_snapshot", { handleId, schema });
}

/**
 * Diff two snapshots and plan the migration that makes `target` match
 * `source`, in the **target** engine's dialect. Pure on the backend — no
 * database access, so direction swaps are free.
 */
export function schemaDiffCompare(
  source: SchemaSnapshot,
  target: SchemaSnapshot,
  targetEngine: Engine,
): Promise<SchemaComparison> {
  return invoke<SchemaComparison>("schema_diff_compare", { source, target, targetEngine });
}

/**
 * Run the selected statements against `schema` on the target connection, as one
 * script — atomic on Postgres/SQLite; MySQL DDL auto-commits, so a mid-run
 * failure there leaves earlier statements applied. **Mutates schema, never row
 * data.** Resolves with the number of statements sent.
 */
export function schemaDiffApply(
  handleId: string,
  schema: string,
  statements: MigrationStatement[],
): Promise<number> {
  return invoke<number>("schema_diff_apply", { handleId, schema, statements });
}
