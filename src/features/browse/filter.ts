// Filter compilation (M5 stackable filter builder, spec §3.5) — the bridge
// between the UI's editable `FilterDraft` and (a) the real wire `FilterSpec`
// the grid fetches with, and (b) the cosmetic WHERE string shown in the
// toolbar readout / pre-filled into raw mode.
//
// Two outputs, two trust levels:
//   - compileToSpec() builds the structured `FilterSpec`. In `conditions`
//     mode every value rides as a typed JSON param (string/number/bool/array)
//     — the backend binds them as parameters, so there is NO client-side SQL
//     assembly and nothing to inject (the displayed SQL below never feeds a
//     query). In `raw` mode the user's text is the WHERE body, a documented
//     power-user escape hatch (same trust level as the M6 query editor).
//   - draftToDisplaySql() builds the *cosmetic* WHERE string. It quotes/escapes
//     for human reading only (ported from the prototype's engine.js/filters.jsx
//     `condToSql`). It is shown in the readout and seeded into raw mode; it is
//     never sent as the query in `conditions` mode.

import type { ColumnInfo } from "../../shared/api/engine";
import type {
  CellValue,
  Condition,
  FilterOp,
  FilterSpec,
} from "../../shared/api/engine";
import type { FilterDraft, UiCondition } from "../workspaces/types";

/** One operator's display label + whether it takes a value input. */
export interface FilterOpDef {
  op: FilterOp;
  label: string;
  needsValue: boolean;
}

/**
 * The 13 operators in the prototype's order, with the design-spec labels.
 * The wire token (`op`) is what we send; the label is what the select shows.
 * (Prototype `filters.jsx` uses internal ids `neq`/`ncontains`/… — we use the
 * wire tokens directly, the mapping documented in engine.ts.)
 */
export const FILTER_OPS: FilterOpDef[] = [
  { op: "eq", label: "=", needsValue: true },
  { op: "ne", label: "≠", needsValue: true },
  { op: "gt", label: ">", needsValue: true },
  { op: "gte", label: "≥", needsValue: true },
  { op: "lt", label: "<", needsValue: true },
  { op: "lte", label: "≤", needsValue: true },
  { op: "contains", label: "contains", needsValue: true },
  { op: "notContains", label: "not contains", needsValue: true },
  { op: "beginsWith", label: "begins with", needsValue: true },
  { op: "endsWith", label: "ends with", needsValue: true },
  { op: "inList", label: "in list", needsValue: true },
  { op: "isNull", label: "is null", needsValue: false },
  { op: "isNotNull", label: "is not null", needsValue: false },
];

const NEEDS_VALUE = new Set<FilterOp>(
  FILTER_OPS.filter((o) => o.needsValue).map((o) => o.op),
);

/** Whether an operator takes a value input (false for the null checks). */
export function opNeedsValue(op: FilterOp): boolean {
  return NEEDS_VALUE.has(op);
}

const OP_LABELS = new Map<FilterOp, string>(FILTER_OPS.map((o) => [o.op, o.label]));

/** Lookup a column's declared type (for value typing + display quoting). */
function columnType(columns: ColumnInfo[], name: string): string {
  return (columns.find((c) => c.name === name)?.dataType ?? "").toUpperCase();
}

const NUMERIC_RE = /INT|NUMERIC|DECIMAL|REAL|DOUBLE|FLOAT/;
const BOOL_RE = /BOOL/;

/**
 * Type a single raw value for the wire, per the column's declared type
 * (prototype `condToSql` quoting *intent*): numeric columns → a `number` when
 * the text parses, else the trimmed string. The value rides as a JSON param —
 * typing only chooses which JSON type, never builds SQL.
 *
 * Since M12 `CellValue`/`FilterValue` carries a `boolean` arm (Postgres has a
 * native `boolean` type), so a boolean column's value is sent as a JSON `bool`
 * — Postgres binds it against the `bool` column directly. `true`/`t`/`1`/`yes`
 * (case-insensitive) read as `true`; anything else is `false`. SQLite has no
 * boolean type and stores 0/1, so its filters never hit this branch.
 */
function typedValue(raw: string, type: string): CellValue {
  const t = raw.trim();
  if (BOOL_RE.test(type)) return /^(true|t|1|yes|y)$/i.test(t);
  if (NUMERIC_RE.test(type) && t !== "" && !Number.isNaN(Number(t))) return Number(t);
  return t;
}

/**
 * Whether a condition contributes to the filter: enabled, with a non-empty
 * value when the operator needs one. Mirrors the prototype's `buildWhere`
 * filter so the "active" count and the compiled spec agree.
 */
function isActive(c: UiCondition): boolean {
  return c.enabled && (opNeedsValue(c.op) ? c.value.trim() !== "" : true);
}

/** Count of conditions that would contribute (the "n of m active" note). */
export function activeConditionCount(conditions: UiCondition[]): number {
  return conditions.filter(isActive).length;
}

/** Compile one active UI condition to its wire `Condition`. */
function toWireCondition(c: UiCondition, columns: ColumnInfo[]): Condition {
  if (!opNeedsValue(c.op)) {
    return { column: c.column, op: c.op, value: null };
  }
  const type = columnType(columns, c.column);
  if (c.op === "inList") {
    const items = c.value
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "")
      .map((s) => typedValue(s, type));
    return { column: c.column, op: c.op, value: items };
  }
  return { column: c.column, op: c.op, value: typedValue(c.value, type) };
}

/**
 * Compile a draft to the wire `FilterSpec`, or `null` when it carries no
 * filter (no active conditions, or empty raw SQL) — the grid then fetches the
 * whole table. In raw mode the trimmed `rawSql` is sent verbatim; in builder
 * mode only active (enabled, value-bearing) conditions are included.
 */
export function compileToSpec(draft: FilterDraft, columns: ColumnInfo[]): FilterSpec | null {
  if (draft.rawMode) {
    const sql = draft.rawSql.trim();
    return sql === "" ? null : { mode: "raw", sql };
  }
  const items = draft.conditions.filter(isActive).map((c) => toWireCondition(c, columns));
  if (items.length === 0) return null;
  return { mode: "conditions", items, combinator: draft.combinator };
}

// --- cosmetic display SQL (never sent in conditions mode) -----------------

/** Escape a string for the *display* SQL only (single-quote doubling). */
function escDisplay(v: string): string {
  return v.trim().replace(/'/g, "''");
}

/** Quote one value for display, matching the prototype's `condToSql.q`. */
function quoteDisplay(raw: string, type: string): string {
  const t = raw.trim();
  if (NUMERIC_RE.test(type) && t !== "" && !Number.isNaN(Number(t))) return t;
  if (BOOL_RE.test(type) && /^(true|false)$/i.test(t)) return t.toLowerCase();
  return "'" + escDisplay(t) + "'";
}

/** Cosmetic SQL for one condition (display + raw-mode prefill only). */
function condToDisplaySql(c: UiCondition, columns: ColumnInfo[]): string {
  const type = columnType(columns, c.column);
  const col = c.column;
  const q = (v: string) => quoteDisplay(v, type);
  switch (c.op) {
    case "eq":
      return col + " = " + q(c.value);
    case "ne":
      return col + " != " + q(c.value);
    case "gt":
      return col + " > " + q(c.value);
    case "gte":
      return col + " >= " + q(c.value);
    case "lt":
      return col + " < " + q(c.value);
    case "lte":
      return col + " <= " + q(c.value);
    case "contains":
      return col + " LIKE '%" + escDisplay(c.value) + "%'";
    case "notContains":
      return col + " NOT LIKE '%" + escDisplay(c.value) + "%'";
    case "beginsWith":
      return col + " LIKE '" + escDisplay(c.value) + "%'";
    case "endsWith":
      return col + " LIKE '%" + escDisplay(c.value) + "'";
    case "inList":
      return (
        col +
        " IN (" +
        c.value
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== "")
          .map(q)
          .join(", ") +
        ")"
      );
    case "isNull":
      return col + " IS NULL";
    case "isNotNull":
      return col + " IS NOT NULL";
    default:
      return "";
  }
}

/**
 * The cosmetic WHERE body for a draft (toolbar readout + raw-mode prefill). In
 * builder mode the active conditions joined by the combinator; in raw mode the
 * raw text as-is. Empty string when there is no effective filter.
 */
export function draftToDisplaySql(draft: FilterDraft, columns: ColumnInfo[]): string {
  if (draft.rawMode) return draft.rawSql.trim();
  const joiner = draft.combinator === "or" ? " OR " : " AND ";
  return draft.conditions
    .filter(isActive)
    .map((c) => condToDisplaySql(c, columns))
    .join(joiner);
}

/** The cosmetic WHERE for the *applied* filter (null → empty). */
export function appliedDisplaySql(
  applied: FilterDraft | null,
  columns: ColumnInfo[],
): string {
  return applied ? draftToDisplaySql(applied, columns) : "";
}

/** Display label for an operator (the select option text). */
export function opLabel(op: FilterOp): string {
  return OP_LABELS.get(op) ?? op;
}

let condSeq = 0;
/** A fresh blank condition row for a tab (first column, `eq`, enabled). */
export function newCondition(firstColumn: string): UiCondition {
  condSeq += 1;
  return {
    id: "fc-" + Date.now().toString(36) + "-" + condSeq.toString(36),
    enabled: true,
    column: firstColumn,
    op: "eq",
    value: "",
  };
}

/** The initial draft for a freshly opened filter panel. */
export function emptyDraft(firstColumn: string): FilterDraft {
  return {
    conditions: [newCondition(firstColumn)],
    combinator: "and",
    rawMode: false,
    rawSql: "",
  };
}
