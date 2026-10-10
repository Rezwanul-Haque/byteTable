// Live-schema diff + DDL generation (M37 Task 7).
//
// The board compares its table cards against a live schema by NAME: a card the
// live schema doesn't have is a CREATE; one it does have is compared column by
// column and becomes an ALTER when anything differs. Card `origin` plays no part
// — a `live` reference card the user added a column to is just as much an ALTER
// as a draft one that happens to share a real table's name.
//
// CREATEs come out in FK order (referenced tables first) so the generated script
// runs top to bottom without forward references.
//
// NOTHING here touches the database. `boardDdl` returns text; the DDL sheet
// shows it, copies it, or opens it in a SQL tab for the user to run.

import { t } from "../../shared/i18n";
import type { BoardColumn, BoardDoc, LiveSchema, TableObject } from "./model";
import { boardTables } from "./model";

/** One table that exists upstream and differs from its board card. */
export interface BoardAlter {
  table: TableObject;
  /** Columns on the card that the live table lacks. */
  adds: BoardColumn[];
  /** Columns the live table has that the card dropped. */
  drops: BoardColumn[];
  /** Columns present in both whose declared type changed. */
  types: { column: BoardColumn; from: string }[];
}

/** The whole comparison. `count` is what the diff bar's button enables on. */
export interface BoardDiff {
  /** Board tables missing upstream, ordered so references resolve. */
  creates: TableObject[];
  alters: BoardAlter[];
  count: number;
}

/** An empty diff — what a standalone board (`liveSource: "none"`) reports. */
export const EMPTY_DIFF: BoardDiff = { creates: [], alters: [], count: 0 };

/**
 * Order pending CREATEs so every table comes after the ones it references.
 * A table is emittable once each of its FK targets is already upstream, already
 * emitted, or not being created at all (a dangling reference the user will fix —
 * it must not deadlock the ordering). Self-references are fine.
 *
 * Progress is guaranteed: when nothing qualifies (a genuine cycle) the first
 * remaining table is emitted anyway, so a cyclic schema still produces a
 * complete script rather than silently dropping tables.
 */
function orderCreates(pending: TableObject[], live: LiveSchema): TableObject[] {
  const remaining = [...pending];
  const ordered: TableObject[] = [];
  const done = new Set(Object.keys(live));
  while (remaining.length > 0) {
    const index = remaining.findIndex((t) =>
      t.columns.every(
        (c) =>
          !c.fk ||
          done.has(c.fk) ||
          c.fk === t.name ||
          !remaining.some((other) => other.name === c.fk),
      ),
    );
    const [next] = remaining.splice(index < 0 ? 0 : index, 1);
    if (!next) break;
    ordered.push(next);
    done.add(next.name);
  }
  return ordered;
}

/** Compare every table card on `doc` against `live`. */
export function diffBoard(doc: BoardDoc, live: LiveSchema): BoardDiff {
  const creates: TableObject[] = [];
  const alters: BoardAlter[] = [];

  for (const table of boardTables(doc)) {
    const base = live[table.name];
    if (!base) {
      creates.push(table);
      continue;
    }
    const upstream = new Map(base.map((c) => [c.name, c]));
    const current = new Set(table.columns.map((c) => c.name));
    const adds = table.columns.filter((c) => !upstream.has(c.name));
    const drops = base.filter((c) => !current.has(c.name));
    const types = table.columns
      .filter((c) => upstream.has(c.name) && upstream.get(c.name)!.type !== c.type)
      .map((c) => ({ column: c, from: upstream.get(c.name)!.type }));
    if (adds.length > 0 || drops.length > 0 || types.length > 0) {
      alters.push({ table, adds, drops, types });
    }
  }

  const ordered = orderCreates(creates, live);
  return { creates: ordered, alters, count: ordered.length + alters.length };
}

/** One column's DDL fragment, as it appears inside CREATE or after ADD COLUMN. */
function columnSql(column: BoardColumn): string {
  let sql = "  " + column.name + " " + column.type;
  if (column.pk) sql += " PRIMARY KEY";
  else if (!column.nullable) sql += " NOT NULL";
  if (column.fk) sql += " REFERENCES " + column.fk + "(id)";
  return sql;
}

/**
 * The diff as a SQL script: CREATEs in dependency order, then one ALTER per
 * changed table (adds, then type changes, then drops — the order that leaves the
 * table usable longest if the script is run statement by statement).
 *
 * A clean board returns a comment rather than an empty string, so the DDL sheet
 * always has something to say.
 */
export function boardDdl(diff: BoardDiff): string {
  const out: string[] = [];
  for (const table of diff.creates) {
    out.push(
      "CREATE TABLE " + table.name + " (\n" + table.columns.map(columnSql).join(",\n") + "\n);",
    );
  }
  for (const alter of diff.alters) {
    const parts: string[] = [];
    for (const column of alter.adds) parts.push("  ADD COLUMN " + columnSql(column).trim());
    for (const change of alter.types) {
      parts.push("  ALTER COLUMN " + change.column.name + " TYPE " + change.column.type);
    }
    for (const column of alter.drops) parts.push("  DROP COLUMN " + column.name);
    out.push("ALTER TABLE " + alter.table.name + "\n" + parts.join(",\n") + ";");
  }
  return out.join("\n\n") || "-- No changes: the board matches the live schema.";
}

/** Per-card diff state the canvas and inspector paint from: the header pill,
 *  the accent outline on added columns and the amber one on changed types. */
export interface BoardDiffInfo {
  /** Card id → `"create"` (new upstream) or `"changed"` (becomes an ALTER). */
  status: Record<string, "create" | "changed">;
  /** Card id → names of columns the live table lacks. */
  added: Record<string, Set<string>>;
  /** Card id → names of columns whose type differs from live. */
  typed: Record<string, Set<string>>;
}

export const EMPTY_DIFF_INFO: BoardDiffInfo = { status: {}, added: {}, typed: {} };

/** Index a {@link BoardDiff} by card id for the renderers. */
export function diffInfoOf(diff: BoardDiff): BoardDiffInfo {
  const info: BoardDiffInfo = { status: {}, added: {}, typed: {} };
  for (const table of diff.creates) info.status[table.id] = "create";
  for (const alter of diff.alters) {
    info.status[alter.table.id] = "changed";
    info.added[alter.table.id] = new Set(alter.adds.map((c) => c.name));
    info.typed[alter.table.id] = new Set(alter.types.map((t) => t.column.name));
  }
  return info;
}

/** The header pill on a table card: how it relates to the live schema. */
export function tableStateLabel(
  table: TableObject,
  status: "create" | "changed" | undefined,
): string {
  if (table.origin === "live") {
    return status === "changed" ? t("board.table.liveChanged") : t("board.table.live");
  }
  if (status === "create") return t("board.table.draftNew");
  if (status === "changed") return t("board.table.draftAlter");
  return t("board.table.draft");
}
