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

// ---------------------------------------------------------------------------
// Editor-only ops
// ---------------------------------------------------------------------------

/**
 * Redefine an existing index. NOT a wire op — no engine can redefine an index
 * in place (Postgres/MySQL `ALTER INDEX` only renames, SQLite has neither), so
 * `toWireBatch` expands this into `dropIndex` + `addIndex`.
 *
 * It exists as its own op because the expansion is NOT recoverable from the
 * pair afterwards: once the name is editable, a drop of `a` followed by an add
 * of `b` is indistinguishable from "drop a, and separately create b", and the
 * rail would show a deletion next to an unrelated creation. `from` is the link
 * the display needs, and keeping it means the editor never has to guess.
 */
export interface ReplaceIndexOp {
  op: "replaceIndex";
  /** The name the SERVER knows the index by — what gets dropped. */
  from: string;
  /** The new name. Equal to `from` when only the definition changed. */
  name: string;
  columns: string[];
  unique: boolean;
}

/** Redefine an existing foreign key. Expands to `dropForeignKey` +
 *  `addForeignKey`, for the same reason as {@link ReplaceIndexOp}.
 *  `fromColumns` is carried because that — not the name — is how SQLite
 *  identifies a constraint it never named. */
export interface ReplaceForeignKeyOp {
  op: "replaceForeignKey";
  from: string;
  fromColumns: string[];
  name: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  onDelete: string | null;
}

/**
 * What the structure editor accumulates and persists per tab: the wire ops plus
 * the two replace intents above. Everything downstream of `toWireBatch` is
 * plain `AlterOp` — the replaces never reach the backend.
 */
export type EditorOp = AlterOp | ReplaceIndexOp | ReplaceForeignKeyOp;

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

/** The MySQL / MariaDB type family offered in the Structure type menu. Grouped
 *  numerics → strings → date/time → binary → special. Lengths are baked into
 *  the types MySQL requires them on (`VARCHAR(n)`, `DECIMAL(p,s)`) so the ALTER
 *  is valid as-picked. `BOOLEAN` is a MySQL alias MySQL rewrites to `TINYINT(1)`
 *  (no native boolean); it's kept for convenience. */
export const MYSQL_TYPES = [
  // numerics
  "TINYINT",
  "SMALLINT",
  "MEDIUMINT",
  "INT",
  "BIGINT",
  "DECIMAL(10,2)",
  "FLOAT",
  "DOUBLE",
  "BIT",
  "BOOLEAN",
  // strings
  "CHAR",
  "VARCHAR(255)",
  "TINYTEXT",
  "TEXT",
  "MEDIUMTEXT",
  "LONGTEXT",
  "ENUM",
  "SET",
  // date / time
  "DATE",
  "TIME",
  "DATETIME",
  "TIMESTAMP",
  "YEAR",
  // binary
  "BINARY",
  "VARBINARY(255)",
  "TINYBLOB",
  "BLOB",
  "MEDIUMBLOB",
  "LONGBLOB",
  // special
  "JSON",
] as const;

/** The PostgreSQL type family offered in the Structure type menu. Grouped
 *  numerics → boolean → strings → date/time → binary → special. Uses the
 *  canonical Postgres spellings (`TIMESTAMPTZ`, `BYTEA`, `JSONB`, …). */
export const POSTGRES_TYPES = [
  // numerics
  "SMALLINT",
  "INTEGER",
  "BIGINT",
  "DECIMAL(10,2)",
  "NUMERIC(10,2)",
  "REAL",
  "DOUBLE PRECISION",
  "SERIAL",
  "BIGSERIAL",
  "MONEY",
  // boolean
  "BOOLEAN",
  // strings
  "CHAR",
  "VARCHAR(255)",
  "TEXT",
  // date / time
  "DATE",
  "TIME",
  "TIMESTAMP",
  "TIMESTAMPTZ",
  "INTERVAL",
  // binary
  "BYTEA",
  // special
  "UUID",
  "JSON",
  "JSONB",
  "INET",
  "CIDR",
  "MACADDR",
  "XML",
] as const;

/** The ClickHouse native type family (M25, prototype `ST_CLICKHOUSE_TYPES`)
 *  offered in the Structure type menu, grouped numerics → strings → date/time →
 *  containers/specials → nullable. `Nullable(...)` wrappers are offered directly
 *  since ClickHouse nullability is a type wrapper, not a column flag. */
export const CLICKHOUSE_TYPES = [
  // numerics
  "UInt8",
  "UInt16",
  "UInt32",
  "UInt64",
  "Int8",
  "Int16",
  "Int32",
  "Int64",
  "Float32",
  "Float64",
  "Decimal(18, 2)",
  "Bool",
  // strings
  "String",
  "FixedString(16)",
  "LowCardinality(String)",
  "UUID",
  // date / time
  "Date",
  "Date32",
  "DateTime",
  "DateTime64(3, 'UTC')",
  // containers / specials
  "Enum8()",
  "Array(String)",
  "Array(UInt64)",
  "Map(String, String)",
  "Tuple(String, UInt64)",
  "JSON",
  "IPv4",
  "IPv6",
  // nullable
  "Nullable(String)",
  "Nullable(Int64)",
  "Nullable(DateTime)",
] as const;

/** The Structure type-menu options for an engine (`stTypesFor`). SQL Server,
 *  MySQL, and Postgres each get their native type family; SQLite (and any other
 *  engine) keeps the SQLite-affinity list the structure editor has always
 *  offered. The current column type is prepended by the caller when missing, so
 *  a type outside its engine's list still shows. */
export function stTypesFor(engine: string): readonly string[] {
  switch (engine) {
    case "mssql":
      return MSSQL_TYPES;
    case "mysql":
      return MYSQL_TYPES;
    case "postgres":
      return POSTGRES_TYPES;
    case "clickhouse":
      return CLICKHOUSE_TYPES;
    default:
      return SQLITE_TYPES;
  }
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
  /** The column's comment / description, or null when it has none. */
  comment: string | null;
  fk: ColumnInfo["fk"];
  /** True when the engine assigns the value on insert (AUTO_INCREMENT / identity
   *  / serial / SQLite rowid alias). Read-only — shown as a badge. */
  autoIncrement: boolean;
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
export function applyOpsToColumns(columns: ColumnInfo[], ops: EditorOp[]): WorkingColumn[] {
  const working: WorkingColumn[] = columns.map((c) => ({
    name: c.name,
    dataType: c.dataType,
    nullable: c.nullable,
    pk: c.pk,
    default: c.default ?? null,
    comment: c.comment ?? null,
    fk: c.fk,
    autoIncrement: c.autoIncrement ?? false,
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
          comment: null,
          fk: null,
          // The editor cannot stage an auto-increment column.
          autoIncrement: false,
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
      case "setComment": {
        const col = find(op.column);
        if (col) col.comment = op.comment;
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
export function toWireBatch(ops: EditorOp[]): AlterOp[] {
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
      // The editor-only replaces expand here, and ONLY here — the drop lands in
      // the drop phase and the add in the add phase, so re-creating under the
      // same name cannot collide with itself.
      case "replaceIndex":
        structDrops.push({ op: "dropIndex", name: op.from });
        structAdds.push({
          op: "addIndex",
          name: op.name,
          columns: op.columns,
          unique: op.unique,
        });
        break;
      case "replaceForeignKey":
        structDrops.push({ op: "dropForeignKey", name: op.from, columns: op.fromColumns });
        structAdds.push({
          op: "addForeignKey",
          name: op.name,
          columns: op.columns,
          refTable: op.refTable,
          refColumns: op.refColumns,
          onDelete: op.onDelete,
        });
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
 *  staged add/drop/edit flags so the card shows accent-new / struck-drop /
 *  edited styling. */
export interface WorkingIndex {
  name: string;
  /** The WORKING definition — the staged one when `isEdited`, else the
   *  introspected one. */
  columns: string[];
  unique: boolean;
  primary: boolean;
  isNew: boolean;
  /** Staged for redefinition (a `replaceIndex` op). Never true together with
   *  `isNew` — a not-yet-applied index is edited by rewriting its own
   *  `addIndex` op, which needs no drop. */
  isEdited: boolean;
  /** What an edited index is replacing, for the card's "was (…)" line. Its
   *  `name` is also the identity every staged op for this card is filed under,
   *  so a staged RENAME cannot orphan them. Set only when `isEdited`. */
  was?: { name: string; columns: string[]; unique: boolean };
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
  /** Staged for redefinition (a `replaceForeignKey` op). */
  isEdited: boolean;
  /** What an edited foreign key is replacing — `name` + `columns` together are
   *  its identity, since SQLite matches on columns and server engines on name. */
  was?: {
    name: string;
    columns: string[];
    refTable: string;
    refColumns: string[];
    onDelete: string | null;
  };
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

/**
 * Replay `ops` over the introspected indexes to produce the rail's working
 * set: staged `addIndex`es appended (flagged new), `dropIndex`es kept but
 * flagged for drop (struck-through, matching the column affordance).
 *
 * A `replaceIndex` op shows as ONE card flagged `isEdited` carrying both
 * definitions — not as a drop next to an unrelated-looking creation, which is
 * what its `dropIndex` + `addIndex` expansion would otherwise look like.
 */
export function applyOpsToIndexes(indexes: IndexInfo[], ops: EditorOp[]): WorkingIndex[] {
  const working: WorkingIndex[] = indexes.map((ix) => ({
    name: ix.name,
    columns: ix.columns,
    unique: ix.unique,
    primary: ix.primary,
    isNew: false,
    isEdited: false,
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
        isEdited: false,
        markedForDrop: false,
      });
    } else if (op.op === "dropIndex") {
      const ix = working.find((w) => w.name === op.name);
      if (ix) ix.markedForDrop = true;
    } else if (op.op === "replaceIndex") {
      const ix = working.find((w) => w.name === op.from && !w.isNew);
      if (ix) {
        ix.was = { name: ix.name, columns: ix.columns, unique: ix.unique };
        ix.name = op.name;
        ix.columns = op.columns;
        ix.unique = op.unique;
        ix.isEdited = true;
      }
    }
  }
  return working;
}

/** The name the SERVER knows this index by. Every staged op for a card is filed
 *  under it, so a staged RENAME cannot orphan them (the card's own `name` is
 *  the new one the moment an edit is staged). */
function indexIdentity(ix: WorkingIndex): string {
  return ix.was?.name ?? ix.name;
}

/** Every staged op touching one index, dropped — the base each staging helper
 *  below builds on, so an index can never accumulate two adds or a stale drop.
 *  `isNew` indexes are keyed by their current name, which IS their add op's. */
function withoutIndexOps(ops: EditorOp[], ix: WorkingIndex): EditorOp[] {
  const id = indexIdentity(ix);
  return ops.filter((o) => {
    if (o.op === "addIndex") return o.name !== ix.name;
    if (o.op === "dropIndex") return o.name !== id;
    if (o.op === "replaceIndex") return o.from !== id;
    return true;
  });
}

/**
 * Stage a redefinition of `ix` — new name, columns and/or uniqueness.
 *
 * Three outcomes:
 *   - a not-yet-applied index (`isNew`) rewrites its own `addIndex` op — no
 *     drop, because there is nothing on the server to drop;
 *   - a definition equal to the introspected one clears the ops entirely, so
 *     editing back to where you started leaves no pending change, matching how
 *     column edits behave;
 *   - anything else stages one `replaceIndex`, which `toWireBatch` expands into
 *     `DROP INDEX <old>` + `CREATE INDEX <new>`.
 */
export function stageIndexEdit(
  ops: EditorOp[],
  ix: WorkingIndex,
  name: string,
  columns: string[],
  unique: boolean,
): EditorOp[] {
  const rest = withoutIndexOps(ops, ix);
  if (ix.isNew) return [...rest, { op: "addIndex", name, columns, unique }];
  // `was` holds the server's definition once an edit is staged; before that the
  // working definition IS the server's.
  const from = indexIdentity(ix);
  const original = ix.was ?? { name: ix.name, columns: ix.columns, unique: ix.unique };
  if (
    name === original.name &&
    sameColumns(original.columns, columns) &&
    original.unique === unique
  )
    return rest;
  return [...rest, { op: "replaceIndex", from, name, columns, unique }];
}

/** Stage dropping `ix`. A not-yet-applied index is simply forgotten; an edited
 *  one loses its staged redefinition too, leaving a plain drop of the original. */
export function stageIndexDrop(ops: EditorOp[], ix: WorkingIndex): EditorOp[] {
  if (ix.primary) return ops; // the primary-key index is protected
  const rest = withoutIndexOps(ops, ix);
  return ix.isNew ? rest : [...rest, { op: "dropIndex", name: indexIdentity(ix) }];
}

/** Undo whatever is staged for `ix` — undrop a dropped index, or revert an
 *  edited one to the server's definition. Both are "forget the ops". */
export function stageIndexRestore(ops: EditorOp[], ix: WorkingIndex): EditorOp[] {
  return withoutIndexOps(ops, ix);
}

/** Replay `ops` over the introspected foreign keys to produce the rail's
 *  working set. `dropForeignKey` ops are matched the same way the backend does:
 *  by synthetic name (server FKs) falling back to local-column equality
 *  (nameless SQLite FKs). */
export function applyOpsToForeignKeys(
  foreignKeys: ForeignKeyInfo[],
  ops: EditorOp[],
  table: string,
): WorkingForeignKey[] {
  const working: WorkingForeignKey[] = foreignKeys.map((fk) => ({
    name: foreignKeyName(fk, table),
    columns: fk.columns,
    refTable: fk.refTable,
    refColumns: fk.refColumns,
    onDelete: fk.onDelete,
    isNew: false,
    isEdited: false,
    markedForDrop: false,
  }));
  // Both lookups below use the backend's own matching rule: by name for server
  // engines, falling back to local columns for SQLite, whose `foreign_key_list`
  // exposes no constraint name.
  const match = (name: string, columns: string[]) =>
    working.find((w) => w.name === name) ?? working.find((w) => sameColumns(w.columns, columns));
  for (const op of ops) {
    if (op.op === "addForeignKey") {
      working.push({
        name: op.name,
        columns: op.columns,
        refTable: op.refTable,
        refColumns: op.refColumns,
        onDelete: op.onDelete,
        isNew: true,
        isEdited: false,
        markedForDrop: false,
      });
    } else if (op.op === "dropForeignKey") {
      const fk = match(op.name, op.columns);
      if (fk) fk.markedForDrop = true;
    } else if (op.op === "replaceForeignKey") {
      const fk = match(op.from, op.fromColumns);
      if (fk && !fk.isNew) {
        fk.was = {
          name: fk.name,
          columns: fk.columns,
          refTable: fk.refTable,
          refColumns: fk.refColumns,
          onDelete: fk.onDelete,
        };
        fk.name = op.name;
        fk.columns = op.columns;
        fk.refTable = op.refTable;
        fk.refColumns = op.refColumns;
        fk.onDelete = op.onDelete;
        fk.isEdited = true;
      }
    }
  }
  return working;
}

/** What the SERVER knows this foreign key by — name AND local columns, because
 *  which of the two identifies it depends on the engine. */
function foreignKeyIdentity(fk: WorkingForeignKey): { name: string; columns: string[] } {
  return fk.was
    ? { name: fk.was.name, columns: fk.was.columns }
    : { name: fk.name, columns: fk.columns };
}

/** Every staged op touching one foreign key, dropped. See `withoutIndexOps`. */
function withoutForeignKeyOps(ops: EditorOp[], fk: WorkingForeignKey): EditorOp[] {
  const id = foreignKeyIdentity(fk);
  const isSame = (name: string, columns: string[]) =>
    name === id.name || sameColumns(columns, id.columns);
  return ops.filter((o) => {
    if (o.op === "addForeignKey") return o.name !== fk.name;
    if (o.op === "dropForeignKey") return !isSame(o.name, o.columns);
    if (o.op === "replaceForeignKey") return !isSame(o.from, o.fromColumns);
    return true;
  });
}

/** Stage a redefinition of `fk` — name, local column, referenced table/column
 *  and/or ON DELETE. Mirrors {@link stageIndexEdit}, including clearing the ops
 *  when edited back to the server's definition. */
export function stageForeignKeyEdit(
  ops: EditorOp[],
  fk: WorkingForeignKey,
  next: {
    name: string;
    columns: string[];
    refTable: string;
    refColumns: string[];
    onDelete: string | null;
  },
): EditorOp[] {
  const rest = withoutForeignKeyOps(ops, fk);
  if (fk.isNew) return [...rest, { op: "addForeignKey", ...next }];
  const id = foreignKeyIdentity(fk);
  const original = fk.was ?? {
    name: fk.name,
    columns: fk.columns,
    refTable: fk.refTable,
    refColumns: fk.refColumns,
    onDelete: fk.onDelete,
  };
  if (
    next.name === original.name &&
    sameColumns(original.columns, next.columns) &&
    original.refTable === next.refTable &&
    sameColumns(original.refColumns, next.refColumns) &&
    original.onDelete === next.onDelete
  )
    return rest;
  return [...rest, { op: "replaceForeignKey", from: id.name, fromColumns: id.columns, ...next }];
}

/** Stage dropping `fk`; a not-yet-applied one is simply forgotten. */
export function stageForeignKeyDrop(ops: EditorOp[], fk: WorkingForeignKey): EditorOp[] {
  const rest = withoutForeignKeyOps(ops, fk);
  if (fk.isNew) return rest;
  const id = foreignKeyIdentity(fk);
  return [...rest, { op: "dropForeignKey", name: id.name, columns: id.columns }];
}

/** Undo whatever is staged for `fk` — undrop, or revert an edit. */
export function stageForeignKeyRestore(ops: EditorOp[], fk: WorkingForeignKey): EditorOp[] {
  return withoutForeignKeyOps(ops, fk);
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
