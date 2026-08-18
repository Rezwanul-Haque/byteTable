// In-memory evaluation of the stackable filter builder against a parsed data
// file — the Data tab's counterpart to the browse grid's server-side WHERE.
//
// WHY NOT push it to the scratch database like the raw-WHERE escape hatch does:
// the builder's conditions are structured, so evaluating them here is exact,
// instant (no IPC round trip per Apply) and free of the quoting risk that
// assembling SQL from user text would carry. `draftToDisplaySql` exists for
// READING, and the module that owns it says so explicitly — this is the
// evaluator that keeps that promise on the data-file side.
//
// The operators, their labels and the "does this one take a value" rule are
// imported from the browse/sql slice rather than restated: one list, so the
// viewer's filter can never drift from the engine's.

import type { ColumnInfo, FilterOp } from "../../shared/api/engine";
import type { FilterDraft, UiCondition } from "../workspaces/types";
import { opNeedsValue } from "../browse/sql/filter";
import { TYPES, type ColumnProfile, type DataFileValue } from "./core";

/**
 * Whether a condition contributes: enabled, naming a real column, and carrying
 * a value when its operator needs one. Mirrors the browse slice's `isActive` so
 * the panel's "n of m active" note and what actually filters agree.
 */
function isActive(c: UiCondition, columns: Set<string>): boolean {
  if (!c.enabled || !columns.has(c.column)) return false;
  return opNeedsValue(c.op) ? c.value.trim() !== "" : true;
}

/**
 * Coerce the condition's typed-in text to compare against a column of `type`.
 * Numeric and boolean columns compare as numbers/booleans so `> 100` orders
 * properly and `= true` matches; everything else compares as text.
 *
 * A non-numeric value typed against a numeric column stays a string, which then
 * simply matches nothing — better than `NaN` comparisons that silently succeed.
 */
function typedValue(raw: string, type: ColumnProfile["type"]): DataFileValue {
  const t = raw.trim();
  if (type === "boolean") return /^(true|t|1|yes|y)$/i.test(t);
  if (TYPES[type].num && t !== "" && !Number.isNaN(Number(t))) return Number(t);
  return t;
}

/** Case-insensitive text form of a cell, for the string operators. */
function text(v: DataFileValue): string {
  return v === null ? "" : String(v).toLowerCase();
}

/**
 * Order two non-null values for the comparison operators: numbers and booleans
 * by value, everything else by natural-order text (so `item2` precedes
 * `item10`, matching the grid's own sort).
 */
const COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
function compare(a: DataFileValue, b: DataFileValue): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return COLLATOR.compare(String(a), String(b));
}

/** Evaluate one active condition against one row's coerced value. */
function matches(op: FilterOp, cell: DataFileValue, raw: string, col: ColumnProfile): boolean {
  // The null checks are the only operators that treat NULL as a value; every
  // other comparison against NULL is false, as it is in SQL.
  if (op === "isNull") return cell === null;
  if (op === "isNotNull") return cell !== null;
  if (cell === null) return false;

  switch (op) {
    case "contains":
      return text(cell).includes(raw.trim().toLowerCase());
    case "notContains":
      return !text(cell).includes(raw.trim().toLowerCase());
    case "beginsWith":
      return text(cell).startsWith(raw.trim().toLowerCase());
    case "endsWith":
      return text(cell).endsWith(raw.trim().toLowerCase());
    case "inList": {
      const items = raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "")
        .map((s) => typedValue(s, col.type));
      return items.some((v) => compare(cell, v) === 0);
    }
    default:
      break;
  }

  const value = typedValue(raw, col.type);
  const c = compare(cell, value);
  switch (op) {
    case "eq":
      return c === 0;
    case "ne":
      return c !== 0;
    case "gt":
      return c > 0;
    case "gte":
      return c >= 0;
    case "lt":
      return c < 0;
    case "lte":
      return c <= 0;
    default:
      return true;
  }
}

/**
 * The row indexes matching `draft`'s BUILDER conditions, or `null` when it
 * carries no effective filter (nothing active) — `null` means "the whole file",
 * which callers keep distinct from "matched nothing".
 *
 * Raw mode is NOT handled here: it goes to the scratch database
 * (`selectMatchingRows`), because only SQLite can evaluate arbitrary SQL.
 */
export function evaluateDraft(
  draft: FilterDraft,
  cols: ColumnProfile[],
  objects: Record<string, DataFileValue>[],
): number[] | null {
  const byName = new Map(cols.map((c) => [c.name, c]));
  const names = new Set(byName.keys());
  const active = draft.conditions.filter((c) => isActive(c, names));
  if (active.length === 0) return null;

  const out: number[] = [];
  for (let i = 0; i < objects.length; i++) {
    const row = objects[i]!;
    const results = active.map((c) => {
      const col = byName.get(c.column)!;
      return matches(c.op, row[c.column] ?? null, c.value, col);
    });
    const keep = draft.combinator === "or" ? results.some((r) => r) : results.every((r) => r);
    if (keep) out.push(i);
  }
  return out;
}

/**
 * The columns the filter panel's pickers show. The panel speaks the browse
 * slice's `ColumnInfo`, so a profiled column is adapted to it: the declared type
 * is the SQL type the scratch table really uses, which is also what drives the
 * panel's numeric-input and value-quoting decisions.
 */
export function filterColumns(cols: ColumnProfile[]): ColumnInfo[] {
  return cols.map((c) => ({
    name: c.name,
    dataType: TYPES[c.type].sql,
    nullable: c.nulls > 0,
    pk: false,
    fk: null,
  }));
}
