// Result compare (M51) — the comparison itself, ported from the prototype's
// `BT_COMPARE` (compare.jsx). Pure: no React, no invoke, so it runs in render,
// in the worker (`compare.worker.ts`) and in the tests alike.
//
// "A" is the query in the editor, "B" the version it is compared with. Rows are
// matched either by a KEY (a row in both whose other columns differ is CHANGED,
// cell by cell) or as WHOLE ROWS (that same row is one only in A and one only
// in B). Only the columns both sides return are compared; row order is noted
// and ignored unless `ordered` is on.

import type { CellValue } from "../../shared/api/engine";

/** Rows per side above which the comparison refuses instead of answering in part. */
export const MAX_ROWS = 100_000;
/** Rows drawn per list. */
export const SHOW_ROWS = 200;
/** Above this many rows (both sides together) the diff runs in the worker. */
export const OFF_THREAD_ROWS = 20_000;

/** One side's result, as the comparison reads it: column names + row-major cells. */
export interface Side {
  columns: string[];
  rows: CellValue[][];
}

/** A row in both, matched on the key, whose other shared columns differ. */
export interface ChangedRow {
  /** A's row, projected onto the shared columns. */
  a: CellValue[];
  /** B's row, projected onto the shared columns. */
  b: CellValue[];
  /** Indexes into `Diff.cols` of the columns that differ. */
  cols: number[];
}

export interface Diff {
  /** Columns both sides return, in A's order. Only these are compared. */
  cols: string[];
  onlyACols: string[];
  onlyBCols: string[];
  mode: "key" | "row";
  /** The key in use (shared columns only); empty in whole-row mode. */
  key: string[];
  /** Every list's rows are projected onto `cols`. */
  same: CellValue[][];
  changed: ChangedRow[];
  onlyA: CellValue[][];
  onlyB: CellValue[][];
  /** Rows on each side that share their key value with another row. */
  dupA: number;
  dupB: number;
  orderDiffers: boolean;
  noShared: boolean;
  rowsEqual: boolean;
  colsEqual: boolean;
  /** The verdict: no difference at all, given the order rule. */
  identical: boolean;
  counts: {
    a: number;
    b: number;
    same: number;
    changed: number;
    onlyA: number;
    onlyB: number;
  };
}

export interface DiffOptions {
  key?: string[];
  ordered?: boolean;
  /** Called now and then with the share of A's rows matched so far (0–1). */
  onProgress?: (share: number) => void;
}

// ---- equality ---------------------------------------------------------------

const NUMERIC_TEXT = /^-?\d+(\.\d+)?$/;

/**
 * One value as a comparable string: NULL is one marker (NULL equals NULL),
 * numbers by value (`1` equals `1.0`), text that is a plain number by value
 * (`'42'` equals `42`), other text exactly, JSON as its compact text.
 */
export function norm(v: unknown): string {
  if (v === null || v === undefined) return "\u0000null";
  if (typeof v === "number") return "n:" + v;
  if (typeof v === "boolean") return "b:" + v;
  if (typeof v === "object") return "j:" + JSON.stringify(v);
  const s = String(v);
  return NUMERIC_TEXT.test(s) && s.length < 16 ? "n:" + Number(s) : "s:" + s;
}

export function same(a: unknown, b: unknown): boolean {
  return norm(a) === norm(b);
}

const keyOf = (row: CellValue[], idx: number[]): string =>
  idx.map((i) => norm(row[i])).join("\u0001");

// ---- columns ----------------------------------------------------------------

/** Column name → its first position in a side. */
function positions(columns: string[]): Map<string, number> {
  const at = new Map<string, number>();
  columns.forEach((c, i) => {
    if (!at.has(c)) at.set(c, i);
  });
  return at;
}

/** Columns returned by both sides, in A's order (a name repeated in A counts once). */
export function sharedColumns(a: Side, b: Side): string[] {
  const inB = positions(b.columns);
  return [...positions(a.columns).keys()].filter((c) => inB.has(c));
}

/** How many rows share their value of `cols` with another row. */
export function dupes(rows: CellValue[][], idx: number[]): number {
  const seen = new Map<string, number>();
  for (const r of rows) {
    const k = keyOf(r, idx);
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  let n = 0;
  seen.forEach((c) => {
    if (c > 1) n += c;
  });
  return n;
}

// ---- key suggestion ---------------------------------------------------------

function rank(col: string): number {
  const n = (col.split(".").pop() ?? col).toLowerCase();
  if (n === "id") return 0;
  if (/(^|_)id$/.test(n)) return 1;
  if (/(code|sku|key|uuid|public_id|email|name|status)$/.test(n)) return 2;
  return 3;
}

/**
 * A column to match on: shared, never NULL and never repeated in BOTH
 * results. Prefers `id`, then `…_id`, then code-like names, then the leftmost.
 * Empty when nothing qualifies — match by whole row then.
 */
export function suggestKey(a: Side, b: Side): string[] {
  const shared = sharedColumns(a, b);
  const pa = positions(a.columns);
  const pb = positions(b.columns);
  const ok = (c: string) =>
    (
      [
        [a, pa.get(c)!],
        [b, pb.get(c)!],
      ] as const
    ).every(
      ([side, i]) =>
        side.rows.every((r) => r[i] !== null && r[i] !== undefined) && dupes(side.rows, [i]) === 0,
    );
  const cands = shared
    .filter(ok)
    .sort((x, y) => rank(x) - rank(y) || shared.indexOf(x) - shared.indexOf(y));
  return cands.length ? [cands[0]!] : [];
}

// ---- the comparison ---------------------------------------------------------

const PROGRESS_EVERY = 5_000;

/** Compare two results. See the module comment for the rules. */
export function diff(a: Side, b: Side, opts: DiffOptions = {}): Diff {
  const cols = sharedColumns(a, b);
  const pa = positions(a.columns);
  const pb = positions(b.columns);
  const ia = cols.map((c) => pa.get(c)!);
  const ib = cols.map((c) => pb.get(c)!);
  const projA = (r: CellValue[]) => ia.map((i) => r[i] ?? null);
  const projB = (r: CellValue[]) => ib.map((i) => r[i] ?? null);
  const shared = new Set(cols);
  const out: Diff = {
    cols,
    onlyACols: [...pa.keys()].filter((c) => !shared.has(c)),
    onlyBCols: [...pb.keys()].filter((c) => !shared.has(c)),
    mode: "row",
    key: [],
    same: [],
    changed: [],
    onlyA: [],
    onlyB: [],
    dupA: 0,
    dupB: 0,
    orderDiffers: false,
    noShared: false,
    rowsEqual: false,
    colsEqual: false,
    identical: false,
    counts: { a: 0, b: 0, same: 0, changed: 0, onlyA: 0, onlyB: 0 },
  };
  if (!cols.length) {
    // Nothing to compare row by row: every row is on its own side.
    out.noShared = true;
    out.onlyA = a.rows.map(() => []);
    out.onlyB = b.rows.map(() => []);
    return finish(out, a, b, opts);
  }

  const key = (opts.key ?? []).filter((c) => shared.has(c));
  // In whole-row mode the key is every shared column.
  const keyAt = (key.length ? key : cols).map((c) => cols.indexOf(c));
  const keyA = keyAt.map((k) => ia[k]!);
  const keyB = keyAt.map((k) => ib[k]!);
  if (key.length) {
    out.mode = "key";
    out.key = key;
    out.dupA = dupes(a.rows, keyA);
    out.dupB = dupes(b.rows, keyB);
  }
  const rest = key.length ? cols.map((_, k) => k).filter((k) => !keyAt.includes(k)) : [];

  // B's rows grouped by key, in order: a non-unique key pairs in the order the rows come.
  const bucket = new Map<string, { r: CellValue[]; i: number }[]>();
  b.rows.forEach((r, i) => {
    const k = keyOf(r, keyB);
    const list = bucket.get(k);
    if (list) list.push({ r, i });
    else bucket.set(k, [{ r, i }]);
  });
  // Where each pair sits in B, in A's order: going backwards means the order differs.
  let lastB = -1;
  a.rows.forEach((r, i) => {
    if (opts.onProgress && i % PROGRESS_EVERY === 0 && i > 0) opts.onProgress(i / a.rows.length);
    const list = bucket.get(keyOf(r, keyA));
    const m = list?.shift();
    if (!m) {
      out.onlyA.push(projA(r));
      return;
    }
    if (m.i < lastB) out.orderDiffers = true;
    lastB = m.i;
    if (!key.length) {
      out.same.push(projA(r));
      return;
    }
    const ra = projA(r);
    const rb = projB(m.r);
    const d = rest.filter((k) => !same(ra[k], rb[k]));
    if (d.length) out.changed.push({ a: ra, b: rb, cols: d });
    else out.same.push(ra);
  });
  // Unpaired B rows, in B's order.
  const left: { r: CellValue[]; i: number }[] = [];
  bucket.forEach((list) => left.push(...list));
  left.sort((x, y) => x.i - y.i);
  out.onlyB = left.map((m) => projB(m.r));
  return finish(out, a, b, opts);
}

function finish(out: Diff, a: Side, b: Side, opts: DiffOptions): Diff {
  out.counts = {
    a: a.rows.length,
    b: b.rows.length,
    same: out.same.length,
    changed: out.changed.length,
    onlyA: out.onlyA.length,
    onlyB: out.onlyB.length,
  };
  out.rowsEqual = !out.changed.length && !out.onlyA.length && !out.onlyB.length;
  out.colsEqual = !out.onlyACols.length && !out.onlyBCols.length;
  out.identical =
    !out.noShared && out.rowsEqual && out.colsEqual && !(opts.ordered && out.orderDiffers);
  return out;
}

// ---- verdict ----------------------------------------------------------------

export type VerdictKind = "noShared" | "same" | "colsDiffer" | "order" | "differ";

/** Which of the section-3 verdicts a comparison earns. */
export function verdictOf(d: Diff): VerdictKind {
  if (d.noShared) return "noShared";
  if (d.identical) return "same";
  if (d.rowsEqual && !d.colsEqual) return "colsDiffer";
  if (d.rowsEqual) return "order";
  return "differ";
}

/** The list to land on after a run: the first one that has rows. */
export function firstList(d: Diff): "changed" | "onlyA" | "onlyB" | "same" {
  if (d.counts.changed) return "changed";
  if (d.counts.onlyA) return "onlyA";
  if (d.counts.onlyB) return "onlyB";
  return "same";
}

/** The SQL as it is compared: trimmed, without a trailing `;`. */
export function stmtOf(sql: string): string {
  return sql.trim().replace(/;\s*$/, "").trim();
}
