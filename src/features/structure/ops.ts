// Structure-editor op accumulation + working-column derivation (M8 §3.6 / §4).
//
// EDITING-STATE MODEL
// ===================
// The user's inline edits accumulate as an ordered list of `AlterOp`
// (`pendingOps`, persisted per table tab in the workspace `ui`). The structure
// view never mutates the introspected truth — instead it derives a *working
// column set* on every render by replaying `pendingOps` over the introspected
// `ColumnInfo[]` (`applyOpsToColumns`), exactly mirroring the backend's
// `compute_target_columns` in `src-tauri/.../engines/sqlite/structure.rs`. So:
//
//   - pendingOps[]      → sent to alterPreview / alterApply (the wire batch)
//   - working columns   → UI display = introspected snapshot + ops replayed
//   - snapshot          → the introspected TableMeta in the cache (discard =
//                         clear pendingOps; the snapshot is re-derived for free)
//
// OP ACCUMULATION / DEDUP
// =======================
// Inline edits collapse so the batch stays minimal and each (column, kind) of
// in-place edit appears at most once (last-wins) — matching the prototype's
// intent of one staged change per cell. `stageOp` folds a new op into the list:
//
//   - changeType / setNullable / setDefault: keyed by (kind, ORIGINAL column).
//     A second edit of the same cell replaces the first (last-wins). An edit
//     that returns the cell to its introspected value REMOVES the op (so the
//     pending count and the working set reflect "no net change").
//   - renameColumn: keyed by the ORIGINAL column. Re-renaming the same column
//     replaces the prior rename's `to`; renaming back to the original name
//     removes the op.
//   - addColumn: keyed by the synthetic column name; editing a just-added
//     column's name/type/nullable/default updates the AddColumn op in place
//     (never produces a rename/changeType op for a column that does not yet
//     exist on the server).
//   - dropColumn: keyed by the column name; toggling drop off removes it.
//
// OP ORDERING (verified against Task 1's folding — see structure.rs)
// ==================================================================
// The backend validates EVERY op's target column against the ORIGINAL
// introspected columns (`validate_ops`), then replays ops IN ORDER to build the
// target set (`compute_target_columns`). Two consequences drive our ordering:
//
//   1. Every op (except addColumn, which introduces a new name) must reference
//      an ORIGINAL column name — never a name created mid-batch. We enforce
//      this by keying all in-place edits + renames by the original name, and by
//      forbidding rename/changeType/etc. on a not-yet-applied added column
//      (those edits mutate the AddColumn op instead).
//   2. A changeType/setNullable/setDefault on a column that is ALSO renamed in
//      the batch must run BEFORE the rename (after the rename the running column
//      set holds the new name, so `require_idx(originalName)` would fail). We
//      therefore emit ops in a fixed phase order on serialization:
//        drops → addColumns → in-place edits (type/nullable/default) → renames
//      Renames last guarantees a same-column edit+rename batch applies cleanly,
//      and since in-place edits reference original names they validate too.
//
// This makes the acceptance batch (add a column + rename a column + retype a
// column) a valid wire batch: add → retype → rename, all referencing original
// names, renames last.

import type { AlterOp, ColumnInfo, ForeignKeyInfo, IndexInfo } from "../../shared/api/engine";

/** The list of SQLite types offered in the type-change select (prototype list,
 *  adapted to SQLite-native affinities). The current type is prepended if not
 *  already present so the select always shows the column's real type. */
export const SQLITE_TYPES = [
  "TEXT",
  "INTEGER",
  "REAL",
  "NUMERIC",
  "BLOB",
  "BOOLEAN",
  "DATE",
  "TIMESTAMP",
] as const;

/** The full SQL Server (T-SQL) type family (M21 §22.2, `ST_MSSQL_TYPES`) offered
 *  in the Structure type menu — ~36 entries, which is why the menu is a capped,
 *  scrollable popup rather than a native `<select>`. Order groups numerics,
 *  strings, date/time, binary, then the specials. */
export const MSSQL_TYPES = [
  // numerics
  "INT",
  "BIGINT",
  "SMALLINT",
  "TINYINT",
  "BIT",
  "DECIMAL(18,2)",
  "NUMERIC(18,2)",
  "MONEY",
  "SMALLMONEY",
  "FLOAT",
  "REAL",
  // strings
  "CHAR",
  "VARCHAR",
  "VARCHAR(MAX)",
  "NCHAR",
  "NVARCHAR",
  "NVARCHAR(MAX)",
  "TEXT",
  "NTEXT",
  // date / time
  "DATE",
  "TIME",
  "DATETIME",
  "DATETIME2",
  "SMALLDATETIME",
  "DATETIMEOFFSET",
  // binary
  "BINARY",
  "VARBINARY",
  "VARBINARY(MAX)",
  "IMAGE",
  // specials
  "UNIQUEIDENTIFIER",
  "XML",
  "SQL_VARIANT",
  "GEOGRAPHY",
  "GEOMETRY",
  "HIERARCHYID",
  "ROWVERSION",
] as const;

/** The Oracle native type family (M23 §23.3, `ST_ORACLE_TYPES`) offered in the
 *  Structure type menu — like SQL Server, a long list that rides the same
 *  capped, scrollable popup. Order groups numerics, strings, date/time, then the
 *  binary/special types. */
export const ORACLE_TYPES = [
  // numerics
  "NUMBER",
  "NUMBER(10)",
  "NUMBER(19)",
  "NUMBER(10,2)",
  "FLOAT",
  "BINARY_FLOAT",
  "BINARY_DOUBLE",
  // strings
  "VARCHAR2(255)",
  "VARCHAR2(4000)",
  "NVARCHAR2(255)",
  "CHAR(10)",
  "NCHAR(10)",
  "CLOB",
  "NCLOB",
  "LONG",
  // date / time
  "DATE",
  "TIMESTAMP",
  "TIMESTAMP WITH TIME ZONE",
  "TIMESTAMP WITH LOCAL TIME ZONE",
  "INTERVAL YEAR TO MONTH",
  "INTERVAL DAY TO SECOND",
  // binary / special
  "BLOB",
  "RAW(16)",
  "LONG RAW",
  "BFILE",
  "ROWID",
  "UROWID",
  "JSON",
  "XMLTYPE",
] as const;

/** The Structure type-menu options for an engine (`stTypesFor`). SQL Server and
 *  Oracle get their full native families; every other engine keeps the
 *  SQLite-affinity list the structure editor has always offered (their shorter
 *  lists just don't scroll). */
export function stTypesFor(engine: string): readonly string[] {
  if (engine === "mssql") return MSSQL_TYPES;
  if (engine === "oracle") return ORACLE_TYPES;
  return SQLITE_TYPES;
}

/** A column in the working (post-edit) set the structure view renders. Carries
 *  the original introspected name (`origin`) so edit handlers can key ops by it
 *  even after a rename, plus flags for the new/dropped row styling. */
export interface WorkingColumn {
  /** Current (possibly edited) column name shown in the row. */
  name: string;
  dataType: string;
  nullable: boolean;
  pk: boolean;
  default: string | null;
  fk: ColumnInfo["fk"];
  /** The introspected name this row maps from, or null for a freshly added
   *  column. Edit handlers key ops by this (original) name. */
  origin: string | null;
  /** True for a column added in this batch (accent-tinted row). */
  isNew: boolean;
  /** True for a column marked for drop in this batch (struck-through row). */
  markedForDrop: boolean;
}

/** Replay `ops` over the introspected columns to produce the working set the
 *  view displays. Dropped columns are kept (flagged `markedForDrop`) so the row
 *  shows struck-through rather than vanishing — matching the prototype's
 *  "marked for drop" affordance. Mirrors the backend's `compute_target_columns`
 *  for everything else. */
export function applyOpsToColumns(columns: ColumnInfo[], ops: AlterOp[]): WorkingColumn[] {
  const working: WorkingColumn[] = columns.map((c) => ({
    name: c.name,
    dataType: c.dataType,
    nullable: c.nullable,
    pk: c.pk,
    default: c.default ?? null,
    fk: c.fk,
    origin: c.name,
    isNew: false,
    markedForDrop: false,
  }));

  const find = (name: string) => working.find((c) => c.name === name);

  for (const op of ops) {
    switch (op.op) {
      case "addColumn":
        working.push({
          name: op.name,
          dataType: op.dataType,
          nullable: op.nullable,
          pk: false,
          default: op.default,
          fk: null,
          origin: null,
          isNew: true,
          markedForDrop: false,
        });
        break;
      case "renameColumn": {
        const col = find(op.from);
        if (col) col.name = op.to;
        break;
      }
      case "changeType": {
        const col = find(op.column);
        if (col) col.dataType = op.newType;
        break;
      }
      case "setNullable": {
        const col = find(op.column);
        if (col) col.nullable = op.nullable;
        break;
      }
      case "setDefault": {
        const col = find(op.column);
        if (col) col.default = op.default;
        break;
      }
      case "dropColumn": {
        const col = find(op.name);
        if (col) col.markedForDrop = true;
        break;
      }
    }
  }
  return working;
}

/**
 * Serialize the accumulated ops into a wire batch in the backend-safe phase
 * order: drops → addColumns → in-place edits → renames → index/FK changes (see
 * the ordering note above). The ops the editor stores are already deduped/keyed;
 * this only reorders. Index and FK changes go last so they reference the final
 * column names (a column rename runs before a new index/FK over it), and FK/
 * index drops precede adds so a re-create in the same batch is well-ordered.
 */
export function toWireBatch(ops: AlterOp[]): AlterOp[] {
  const drops: AlterOp[] = [];
  const adds: AlterOp[] = [];
  const inPlace: AlterOp[] = [];
  const renames: AlterOp[] = [];
  const structDrops: AlterOp[] = []; // dropIndex / dropForeignKey
  const structAdds: AlterOp[] = []; // addForeignKey / addIndex
  for (const op of ops) {
    switch (op.op) {
      case "dropColumn":
        drops.push(op);
        break;
      case "addColumn":
        adds.push(op);
        break;
      case "renameColumn":
        renames.push(op);
        break;
      case "dropIndex":
      case "dropForeignKey":
        structDrops.push(op);
        break;
      case "addIndex":
      case "addForeignKey":
        structAdds.push(op);
        break;
      default:
        inPlace.push(op);
    }
  }
  return [...drops, ...adds, ...inPlace, ...renames, ...structDrops, ...structAdds];
}

// ---------------------------------------------------------------------------
// Index + foreign-key working sets (rail display) + name generation
// ---------------------------------------------------------------------------

/** An index in the working (post-edit) set the rail renders. Carries the
 *  staged add/drop flags so the card shows accent-new / struck-drop styling. */
export interface WorkingIndex {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
  isNew: boolean;
  markedForDrop: boolean;
}

/** A foreign key in the working (post-edit) set the rail renders. `name` is the
 *  display/identity name (synthetic for nameless SQLite FKs). */
export interface WorkingForeignKey {
  name: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  onDelete: string | null;
  isNew: boolean;
  markedForDrop: boolean;
}

/** A stable display/identity name for a foreign key. Server engines expose a
 *  real name; SQLite does not, so synthesize one from the local columns (this
 *  is also what a `dropForeignKey` op carries for matching on the backend). */
export function foreignKeyName(
  fk: { name: string | null; columns: string[] },
  table: string,
): string {
  return fk.name ?? `${table}_${fk.columns.join("_")}_fkey`;
}

/** Replay `ops` over the introspected indexes to produce the rail's working
 *  set: staged `addIndex`es appended (flagged new), `dropIndex`es kept but
 *  flagged for drop (struck-through, matching the column affordance). */
export function applyOpsToIndexes(indexes: IndexInfo[], ops: AlterOp[]): WorkingIndex[] {
  const working: WorkingIndex[] = indexes.map((ix) => ({
    name: ix.name,
    columns: ix.columns,
    unique: ix.unique,
    primary: ix.primary,
    isNew: false,
    markedForDrop: false,
  }));
  for (const op of ops) {
    if (op.op === "addIndex") {
      working.push({
        name: op.name,
        columns: op.columns,
        unique: op.unique,
        primary: false,
        isNew: true,
        markedForDrop: false,
      });
    } else if (op.op === "dropIndex") {
      const ix = working.find((w) => w.name === op.name);
      if (ix) ix.markedForDrop = true;
    }
  }
  return working;
}

/** Replay `ops` over the introspected foreign keys to produce the rail's
 *  working set. `dropForeignKey` ops are matched the same way the backend does:
 *  by synthetic name (server FKs) falling back to local-column equality
 *  (nameless SQLite FKs). */
export function applyOpsToForeignKeys(
  foreignKeys: ForeignKeyInfo[],
  ops: AlterOp[],
  table: string,
): WorkingForeignKey[] {
  const working: WorkingForeignKey[] = foreignKeys.map((fk) => ({
    name: foreignKeyName(fk, table),
    columns: fk.columns,
    refTable: fk.refTable,
    refColumns: fk.refColumns,
    onDelete: fk.onDelete,
    isNew: false,
    markedForDrop: false,
  }));
  for (const op of ops) {
    if (op.op === "addForeignKey") {
      working.push({
        name: op.name,
        columns: op.columns,
        refTable: op.refTable,
        refColumns: op.refColumns,
        onDelete: op.onDelete,
        isNew: true,
        markedForDrop: false,
      });
    } else if (op.op === "dropForeignKey") {
      const fk =
        working.find((w) => w.name === op.name) ??
        working.find((w) => sameColumns(w.columns, op.columns));
      if (fk) fk.markedForDrop = true;
    }
  }
  return working;
}

function sameColumns(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((c, i) => c === b[i]);
}

/** Generate a unique index name for a new index over `columns`, avoiding any
 *  name already present in `existing`. Mirrors the prototype's `idx_<t>_<cols>`
 *  scheme. */
export function generateIndexName(
  table: string,
  columns: string[],
  existing: Iterable<string>,
): string {
  const taken = new Set(existing);
  const base = `idx_${table}_${columns.join("_")}`;
  let name = base;
  let i = 2;
  while (taken.has(name)) name = `${base}_${i++}`;
  return name;
}

/** Generate a unique FK constraint name for a new FK over `columns`. Mirrors
 *  the prototype's `<table>_<cols>_fkey` scheme. */
export function generateForeignKeyName(
  table: string,
  columns: string[],
  existing: Iterable<string>,
): string {
  const taken = new Set(existing);
  const base = `${table}_${columns.join("_")}_fkey`;
  let name = base;
  let i = 2;
  while (taken.has(name)) name = `${base}_${i++}`;
  return name;
}
