// Row lineage (M50): from what has loaded so far (`LineageData`) to what the
// canvas draws — the prototype's `build(schema, table, key)` minus the
// querying. Labels, hops and facts are worked out here on every render, so they
// follow data masking the moment it is switched (the caller passes `maskText`).

import type { CSSProperties } from "react";

import type { CellValue, ColumnInfo } from "../../shared/api/engine";
import { targetKey, type GroupNode, type LineageData, type ParentState } from "./load";
import { factCols, labelOf, lnHue, type RowLabel, type Row, type TableShape } from "./model";

/** `--tc`, the table colour every `.ln-*` rule reads. */
export const hueStyle = (table: string): CSSProperties =>
  ({ "--tc": lnHue(table) }) as CSSProperties;

type Show = (value: CellValue, col: string) => string;

/** One further place a related row points (the second hop, shown as text). */
export interface Hop {
  col: string;
  refTable: string;
  refCol: string;
  key: CellValue;
  label: string;
}

export interface ParentView {
  id: string;
  col: string;
  refTable: string;
  refCol: string;
  value: CellValue;
  state: ParentState;
  row: Row | null;
  /** The target row's primary key (what walking to it uses). */
  key: CellValue;
  pk: string | null;
  label: string;
  hops: Hop[];
}

export interface ChildRow {
  row: Row;
  key: CellValue;
  label: string;
  hops: Hop[];
  facts: string[];
}

export interface GroupView {
  id: string;
  /** Position in `LineageData.groups` (what Retry reloads). */
  index: number;
  table: string;
  col: string;
  refCol: string;
  value: CellValue;
  pk: string | null;
  status: GroupNode["status"];
  error?: string;
  /** Every matching row, when known. */
  count: number | null;
  countState: GroupNode["countState"];
  rows: ChildRow[];
}

export interface Graph {
  table: string;
  key: CellValue;
  pk: string;
  row: Row;
  label: RowLabel;
  columns: ColumnInfo[];
  fkCols: string[];
  /** Up to three plain columns for the centre card's fact pills. */
  facts: string[];
  parents: ParentView[];
  /** Stacks with rows (or still loading / failed), largest first. */
  children: GroupView[];
  /** References that exist in the schema but match no rows. */
  empty: { table: string; col: string }[];
  /** Rows pointed at, rows pointing here, broken references. */
  up: number;
  down: number;
  broken: number;
}

/** Where `row` (in `shape`) points, one hop per resolved foreign key, except
 *  through `skipCol` (the one pointing back at the centre). */
export function hopsOf(
  data: LineageData,
  shape: TableShape | undefined,
  row: Row,
  show: Show,
  skipCol?: string,
): Hop[] {
  if (!shape) return [];
  const hops: Hop[] = [];
  for (const f of shape.fks) {
    if (f.col === skipCol) continue;
    const v = row[f.col];
    if (v === null || v === undefined) continue;
    const target = data.targets[targetKey(f.refTable, f.refCol, v)];
    if (!target) continue;
    const ts = data.shapes[f.refTable];
    hops.push({
      col: f.col,
      refTable: f.refTable,
      refCol: f.refCol,
      key: ts?.pk ? (target[ts.pk] ?? null) : v,
      label: ts ? labelOf(ts.columns, target, show).text : "",
    });
  }
  return hops;
}

/** A stack's total for sorting and the link's width: the count when known,
 *  else the rows listed so far. */
export function groupTotal(g: { count: number | null; rows: unknown[] }): number {
  return g.count ?? g.rows.length;
}

/** The graph to draw, or null until the centre row has loaded. */
export function graphOf(data: LineageData, show: Show): Graph | null {
  const shape = data.shapes[data.table];
  if (data.status !== "ready" || !data.row || !shape?.pk) return null;
  const row = data.row;

  const parents: ParentView[] = data.parents.map((p) => {
    const target =
      p.state === "ok" ? (data.targets[targetKey(p.refTable, p.refCol, p.value)] ?? null) : null;
    const ts = data.shapes[p.refTable];
    const pk = ts?.pk ?? null;
    return {
      id: "up-" + p.col,
      col: p.col,
      refTable: p.refTable,
      refCol: p.refCol,
      value: p.value,
      state: p.state,
      row: target,
      key: target && pk ? (target[pk] ?? null) : p.value,
      pk,
      label: target && ts ? labelOf(ts.columns, target, show).text : "",
      hops: target ? hopsOf(data, ts, target, show) : [],
    };
  });

  const groups: GroupView[] = data.groups.map((g, index) => {
    const cs = data.shapes[g.table];
    const fkCols = cs ? cs.fks.map((f) => f.col) : [];
    return {
      id: "dn-" + g.table + "." + g.col,
      index,
      table: g.table,
      col: g.col,
      refCol: g.refCol,
      value: g.value,
      pk: cs?.pk ?? null,
      status: g.status,
      error: g.error,
      count: g.count,
      countState: g.countState,
      rows: g.rows.map((r) => {
        const label = cs ? labelOf(cs.columns, r, show) : { text: "", col: null };
        return {
          row: r,
          key: cs?.pk ? (r[cs.pk] ?? null) : null,
          label: label.text,
          hops: hopsOf(data, cs, r, show, g.col),
          facts: cs ? factCols(cs.columns, r, fkCols, label.col, 2, 40) : [],
        };
      }),
    };
  });
  const done = (g: GroupView) => g.status === "ready";
  const children = groups
    .filter((g) => !done(g) || g.rows.length > 0)
    // Loaded stacks largest first; ones still loading (or failed) after them.
    .sort((a, b) => (done(b) ? groupTotal(b) : -1) - (done(a) ? groupTotal(a) : -1));
  const empty = groups
    .filter((g) => done(g) && g.rows.length === 0)
    .map((g) => ({ table: g.table, col: g.col }));

  const fkCols = shape.fks.map((f) => f.col);
  const label = labelOf(shape.columns, row, show);
  return {
    table: data.table,
    key: row[shape.pk] ?? data.key,
    pk: shape.pk,
    row,
    label,
    columns: shape.columns,
    fkCols,
    facts: factCols(shape.columns, row, fkCols, label.col, 3, 28),
    parents,
    children,
    empty,
    up: parents.filter((p) => p.state === "ok").length,
    down: children.reduce((n, c) => n + groupTotal(c), 0),
    broken: parents.filter((p) => p.state === "missing").length,
  };
}
