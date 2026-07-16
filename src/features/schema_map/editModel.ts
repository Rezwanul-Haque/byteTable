// Schema-map EDIT mode model + staged-DDL helpers (Schema_Visual_Edit.md).
//
// Edit mode turns the read-only ER map into a visual DDL editor. Every edit
// does two things: (1) mutates an in-memory, editable copy of the schema so the
// diagram updates instantly, and (2) pushes a SQL string onto a pending
// migration. The user reviews the accumulated statements and commits them in a
// single transaction (production commits gated behind a typed phrase).
//
// This module is the PURE half (no React, no DOM): the editable schema shape,
// a builder that clones the real introspected `TableMeta`s into it, the staged
// SQL string each operation emits, and the destructiveness rule that drives the
// warning UI + production gate. The stateful half lives in `useSchemaEditor`.
//
// DDL DIALECT: the staged statements are engine-aware — see `ddlFor(engine)`
// below. Postgres is the baseline (`ALTER COLUMN … TYPE`, `DROP CONSTRAINT`);
// MySQL uses `MODIFY COLUMN` + `DROP PRIMARY KEY`/`DROP FOREIGN KEY`; SQL Server
// uses `ALTER COLUMN <type>`. SQLite cannot express in-place retype/PK changes
// and those ops error at commit (add/drop/rename + FK changes work everywhere).
// These strings are what the Review/Commit lists display and run through
// `executeScriptText`. Caveat: MySQL implicitly commits each DDL statement, so
// a mid-batch failure is NOT rolled back — a server limitation, not ours.

import type { Engine } from "../../shared/types";
import type { TableMeta } from "../../shared/api/engine";

/** A column in the editable schema. `fk` is a `"refTable.refCol"` string (the
 *  prototype's shape) or null — the diagram reads it to brighten FK columns. */
export interface EditCol {
  name: string;
  type: string;
  pk: boolean;
  nullable: boolean;
  default: string | null;
  fk: string | null;
}

/** One index in the editable schema (kept in sync so renames repoint them). */
export interface EditIndex {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
}

/** One outbound foreign key in the editable schema. `name` is always present
 *  (synthesised for nameless SQLite FKs) so a DROP CONSTRAINT can target it. */
export interface EditFk {
  name: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  onDelete: string | null;
}

/** One editable table. */
export interface EditMeta {
  columns: EditCol[];
  indexes: EditIndex[];
  foreignKeys: EditFk[];
}

/** The whole editable schema. `order` preserves a stable table render order
 *  (introspected order, with added tables appended). */
export interface EditSchema {
  meta: Record<string, EditMeta>;
  order: string[];
}

/** Synthesise a stable FK name when the engine exposes none (SQLite). Mirrors
 *  the structure editor's `foreignKeyName`. */
function fkName(name: string | null, table: string, columns: string[]): string {
  return name ?? `${table}_${columns.join("_")}_fkey`;
}

/** Clone the introspected `TableMeta`s into the editable model. Deep enough
 *  that every later mutation/snapshot is independent of the introspection
 *  cache (which must stay untouched until a successful commit re-introspects). */
export function buildEditSchema(metas: Record<string, TableMeta>): EditSchema {
  const order = Object.keys(metas);
  const meta: Record<string, EditMeta> = {};
  for (const table of order) {
    const m = metas[table];
    if (!m) continue;
    meta[table] = {
      columns: m.columns.map((c) => ({
        name: c.name,
        type: c.dataType,
        pk: c.pk,
        nullable: c.nullable,
        default: c.default ?? null,
        fk: c.fk ? `${c.fk.table}.${c.fk.column}` : null,
      })),
      indexes: m.indexes.map((ix) => ({
        name: ix.name,
        columns: [...ix.columns],
        unique: ix.unique,
        primary: ix.primary,
      })),
      foreignKeys: m.foreignKeys.map((fk) => ({
        name: fkName(fk.name, table, fk.columns),
        columns: [...fk.columns],
        refTable: fk.refTable,
        refColumns: [...fk.refColumns],
        onDelete: fk.onDelete,
      })),
    };
  }
  return { meta, order };
}

/** Deep clone an editable schema (for the discard snapshot). */
export function cloneEditSchema(schema: EditSchema): EditSchema {
  return JSON.parse(JSON.stringify(schema)) as EditSchema;
}

/** Restore `target` from `snap` IN PLACE so the object identity React closures
 *  captured stays valid (mirrors the prototype's in-place discard). */
export function restoreEditSchema(target: EditSchema, snap: EditSchema): void {
  for (const k of Object.keys(target.meta)) delete target.meta[k];
  Object.assign(target.meta, JSON.parse(JSON.stringify(snap.meta)));
  target.order = [...snap.order];
}

// --- editable column types per engine ---------------------------------------

/** Postgres/MySQL type menu (the prototype's `MAP_EDIT_TYPES`). */
const SQL_EDIT_TYPES = [
  "INTEGER",
  "BIGINT",
  "TEXT",
  "VARCHAR(255)",
  "NUMERIC(10,2)",
  "BOOLEAN",
  "TIMESTAMP",
  "DATE",
  "CHAR(2)",
  "JSONB",
  "UUID",
] as const;

/** SQLite affinity-friendly menu (mirrors the structure editor's `SQLITE_TYPES`). */
const SQLITE_EDIT_TYPES = [
  "TEXT",
  "INTEGER",
  "REAL",
  "NUMERIC",
  "BLOB",
  "BOOLEAN",
  "DATE",
  "TIMESTAMP",
] as const;

/** The type menu for the per-column type select, by engine. */
export function editTypesFor(engine: Engine): string[] {
  return engine === "sqlite" ? [...SQLITE_EDIT_TYPES] : [...SQL_EDIT_TYPES];
}

/** Sanitise a typed identifier: trim, collapse non-word runs to `_`, lowercase
 *  (the prototype's rename/add rule). */
export function sanitizeName(raw: string): string {
  return (raw || "").trim().replace(/\W+/g, "_").toLowerCase();
}

/**
 * An edit is "destructive" if it can lose data or break references — a DROP of
 * a column/table/constraint, an in-place column retype, or any rename. Drives
 * the red affordances, the commit warning banner, and (with env) the gate.
 */
export function isDestructive(sql: string): boolean {
  return (
    /\bDROP\s+(COLUMN|TABLE|CONSTRAINT)\b/i.test(sql) ||
    /\bALTER\s+COLUMN\b.*\bTYPE\b/i.test(sql) ||
    /\bRENAME\b/i.test(sql)
  );
}

// --- staged DDL string builders (one per operation, engine-aware) -----------

/** The staged-DDL builders for one engine. Same shape for every engine; the
 *  bodies differ where dialects diverge (in-place retype, nullability, PK/FK
 *  drops). `setNullable`/`changeType` take the column's type because MySQL and
 *  SQL Server restate the full column definition to alter it. */
export interface Ddl {
  addColumn: (t: string, name: string) => string;
  renameColumn: (t: string, from: string, to: string) => string;
  changeType: (t: string, col: string, type: string) => string;
  setNullable: (t: string, col: string, nullable: boolean, type: string) => string;
  addPrimaryKey: (t: string, col: string) => string;
  dropPrimaryKey: (t: string) => string;
  dropColumn: (t: string, col: string) => string;
  addForeignKey: (t: string, name: string, col: string, refTable: string, refCol: string) => string;
  dropForeignKey: (t: string, name: string) => string;
  createTable: (name: string) => string;
  renameTable: (from: string, to: string) => string;
  dropTable: (t: string) => string;
}

/**
 * Engine-specific staged-DDL builders.
 *
 * Postgres is the baseline (`ALTER COLUMN … TYPE`, `DROP CONSTRAINT …`). MySQL
 * needs `MODIFY COLUMN` for retype/nullability, `DROP PRIMARY KEY`, and `DROP
 * FOREIGN KEY`. SQL Server uses `ALTER COLUMN <type>` (no `TYPE` keyword).
 * SQLite cannot express in-place retype/PK changes, so those still emit the
 * Postgres form and error at commit (add/drop/rename + FK add/drop work).
 *
 * NOTE: MySQL implicitly commits each DDL statement, so a mid-batch failure is
 * NOT rolled back — this is a server limitation, not something the builders can
 * fix. The commit modal's "single transaction" framing holds only for Postgres.
 */
export function ddlFor(engine: Engine): Ddl {
  const mysql = engine === "mysql";
  const mssql = engine === "mssql";
  return {
    addColumn: (t, name) => `ALTER TABLE ${t} ADD COLUMN ${name} TEXT;`,
    renameColumn: (t, from, to) => `ALTER TABLE ${t} RENAME COLUMN ${from} TO ${to};`,
    changeType: (t, col, type) =>
      mysql
        ? `ALTER TABLE ${t} MODIFY COLUMN ${col} ${type};`
        : mssql
          ? `ALTER TABLE ${t} ALTER COLUMN ${col} ${type};`
          : `ALTER TABLE ${t} ALTER COLUMN ${col} TYPE ${type};`,
    setNullable: (t, col, nullable, type) =>
      mysql
        ? `ALTER TABLE ${t} MODIFY COLUMN ${col} ${type} ${nullable ? "NULL" : "NOT NULL"};`
        : mssql
          ? `ALTER TABLE ${t} ALTER COLUMN ${col} ${type} ${nullable ? "NULL" : "NOT NULL"};`
          : `ALTER TABLE ${t} ALTER COLUMN ${col} ${nullable ? "DROP NOT NULL" : "SET NOT NULL"};`,
    addPrimaryKey: (t, col) => `ALTER TABLE ${t} ADD PRIMARY KEY (${col});`,
    dropPrimaryKey: (t) =>
      mysql ? `ALTER TABLE ${t} DROP PRIMARY KEY;` : `ALTER TABLE ${t} DROP CONSTRAINT ${t}_pkey;`,
    dropColumn: (t, col) => `ALTER TABLE ${t} DROP COLUMN ${col};`,
    addForeignKey: (t, name, col, refTable, refCol) =>
      `ALTER TABLE ${t} ADD CONSTRAINT ${name} FOREIGN KEY (${col}) REFERENCES ${refTable}(${refCol}) ON DELETE RESTRICT;`,
    dropForeignKey: (t, name) =>
      mysql
        ? `ALTER TABLE ${t} DROP FOREIGN KEY ${name};`
        : `ALTER TABLE ${t} DROP CONSTRAINT ${name};`,
    createTable: (name) => `CREATE TABLE ${name} (\n  id INTEGER PRIMARY KEY\n);`,
    renameTable: (from, to) => `ALTER TABLE ${from} RENAME TO ${to};`,
    dropTable: (t) => `DROP TABLE ${t};`,
  };
}
