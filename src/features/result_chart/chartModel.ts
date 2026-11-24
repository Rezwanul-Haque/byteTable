// Chart from a result (M46) — the data logic, ported from the prototype's
// chart.jsx (`window.BT_CHART`). Pure: no React, no IO, so it runs in tests
// and in the chart worker alike.
//
// It charts exactly the rows the result already holds; nothing is re-queried.
// When several rows share a label they are combined (sum by default) and the
// view says so. Columns are addressed by INDEX, not name: `SELECT *` across a
// join returns two columns called `id`.

import type { CellValue, ColumnMeta } from "../../shared/api/engine";
import { fmtNumber } from "../../shared/i18n";

export type ColKind = "number" | "time" | "bool" | "text";

export interface ColProfile {
  index: number;
  name: string;
  kind: ColKind;
  /** `id`, or ending in `_id` / `.id`: never the first value column unless it
   *  is the only number. */
  idLike: boolean;
}

export type ChartType = "bar" | "line" | "donut";
export type Agg = "sum" | "avg" | "min" | "max";
export type SortMode = "asis" | "value";

/** What is drawn. `x` null = one point per row ("row 1", "row 2"…). */
export interface ChartCfg {
  type: ChartType;
  x: number | null;
  /** Up to four number columns. */
  ys: number[];
  /** Chart how many rows share each label instead of a value column. */
  count: boolean;
  agg: Agg;
  sort: SortMode;
}

export interface ChartPoint {
  label: string;
  /** Rows behind this point. */
  n: number;
  /** One per series, in `names` order. */
  values: number[];
}

export interface ChartSeries {
  /** Series names, in colour order. */
  names: string[];
  points: ChartPoint[];
  /** Some label holds more than one row, so values were combined. */
  grouped: boolean;
  /** Points before any cap. */
  total: number;
  /** Two or more series whose peaks differ more than 20×. */
  lopsided: { big: string; small: string } | null;
}

/** Series 1 is the theme accent; 2–4 are the accent alternates. */
export const SERIES = ["var(--accent)", "#5aa7f5", "#f5b54a", "#b08cff"] as const;
export const MAX_BARS = 40;
export const MAX_SERIES = 4;
/** Slice colours: the series colours, then two more. "Other" is neutral. */
export const SLICES = [...SERIES, "#4fc9a7", "#ef7b8b"] as const;
/** Above this many rows the series is built in a worker. */
export const OFF_THREAD_ROWS = 5000;
/** A missing label, drawn as itself rather than dropped. */
export const NULL_LABEL = "∅ null";
/** Most slices a donut draws before folding the rest into "Other". */
export const MAX_SLICES = 6;
/** Slice colours: the series colours, two more, then a neutral for "Other". */
export const OTHER_COLOR = "var(--text-faint)";

const TEMPORAL = /^\d{4}-\d\d(-\d\d)?([ T]\d\d:\d\d(:\d\d)?)?/;
// Driver type names for booleans: Postgres `bool`, SQL Server `bit`, and
// MySQL's TINYINT — MySQL has no boolean, and `BOOL` columns are TINYINT(1).
// A TINYINT only counts as one when every value is 0 or 1.
const BOOL_HINT = /^(bool(ean)?|bit|tinyint(\(\d+\))?)$/i;
const NUMERIC_STRING = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;
// Driver type names, across the engines: INT8, BIGINT, UInt64, NUMERIC(10,2),
// Nullable(Float64), DOUBLE PRECISION, MONEY…
const NUMBER_HINT =
  /\b(u?int(eger)?\d*|tinyint|smallint|mediumint|bigint|numeric|(new)?decimal\d*|real|float\d*|double|(small)?money|(small|big)?serial\d*|number|dec)\b/i;

/** A cell as a number, when it is one: numbers, and numeric strings (big
 *  integers and exact decimals arrive as strings to keep their precision). */
export function numOf(v: CellValue): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && NUMERIC_STRING.test(v)) return Number(v);
  return null;
}

/**
 * What kind of values each column holds. The driver's type name decides when
 * it is clear; otherwise — expressions, SQLite's loose typing — the values do.
 */
export function profile(columns: ColumnMeta[], rows: CellValue[][]): ColProfile[] {
  return columns.map((c, index) => {
    let filled = 0;
    let nums = 0;
    let times = 0;
    for (const r of rows) {
      const v = r[index];
      if (v === null || v === undefined) continue;
      filled++;
      if (typeof v === "number" || (typeof v === "string" && NUMERIC_STRING.test(v))) nums++;
      if (typeof v === "string" && TEMPORAL.test(v)) times++;
    }
    const hint = c.typeHint ?? "";
    // A numeric string only counts as a number when the driver says the
    // column is numeric: `'007'` in a text column is a code, not seven.
    const numericByHint = NUMBER_HINT.test(hint) && filled > 0 && nums === filled;
    const numericByValue =
      filled > 0 && rows.every((r) => r[index] == null || typeof r[index] === "number");
    // true / false: a label with two values, never a number to add up. SQL
    // Server's `bit` and MySQL's TINYINT arrive as 0 / 1, so the type name
    // says which it is.
    const isBool = (v: CellValue | undefined) =>
      v == null || typeof v === "boolean" || (BOOL_HINT.test(hint) && (v === 0 || v === 1));
    let kind: ColKind = "text";
    if (filled > 0 && rows.every((r) => isBool(r[index]))) kind = "bool";
    else if (numericByHint || numericByValue) kind = "number";
    else if (filled > 0 && times === filled) kind = "time";
    return { index, name: c.name, kind, idLike: /(^|[._])id$/i.test(c.name) };
  });
}

/** A sensible first chart, so the view is useful before anything is touched. */
export function infer(cols: ColProfile[], rows: CellValue[][]): Omit<ChartCfg, "agg" | "sort"> {
  const time = cols.find((c) => c.kind === "time");
  // Booleans label like text: true / false are categories.
  const texts = cols.filter((c) => c.kind === "text" || c.kind === "bool");
  const nums = cols.filter((c) => c.kind === "number");
  const values = nums.filter((c) => !c.idLike);
  const firstValue = (values[0] ?? nums[0])!;

  // Nothing to measure: count rows per label, on the text column that repeats most.
  if (nums.length === 0) {
    const distinct = (c: ColProfile) => new Set(rows.map((r) => r[c.index])).size;
    const x = [...texts].sort((p, q) => distinct(p) - distinct(q))[0] ?? time ?? cols[0];
    // Counting a yes/no or a handful of statuses asks "what share is each?" —
    // a donut answers that at a glance. Anything else stays a bar.
    const few = x != null && (x.kind === "bool" || (distinct(x) >= 2 && distinct(x) <= 4));
    return { type: few ? "donut" : "bar", x: x ? x.index : null, ys: [], count: true };
  }
  // Only numbers: one bar per row, or the ID-like (else first) labels the next.
  if (!time && texts.length === 0) {
    if (nums.length === 1) return { type: "bar", x: null, ys: [nums[0]!.index], count: false };
    const x = nums.find((c) => c.idLike) ?? nums[0]!;
    const y = nums.find((c) => c.index !== x.index)!;
    return { type: "bar", x: x.index, ys: [y.index], count: false };
  }
  // One value to start: two on different scales flatten each other.
  const x = (time ?? texts[0])!;
  return { type: time ? "line" : "bar", x: x.index, ys: [firstValue.index], count: false };
}

const AGG: Record<Agg, (a: number[]) => number> = {
  sum: (a) => a.reduce((s, v) => s + v, 0),
  avg: (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0),
  min: (a) => (a.length ? Math.min(...a) : 0),
  max: (a) => (a.length ? Math.max(...a) : 0),
};

/** How a point is labelled when there is no label column, and the row-count
 *  series' name — passed in because both are translated. */
export interface SeriesText {
  rowLabel: (n: number) => string;
  countName: string;
  colName: (index: number) => string;
}

/** Rows → one point per distinct label (steps 1–5 of the brief's §3). */
export function series(
  rows: CellValue[][],
  cfg: ChartCfg,
  xKind: ColKind | undefined,
  text: SeriesText,
): ChartSeries {
  const groups = new Map<string, CellValue[][]>();
  rows.forEach((r, i) => {
    const raw = cfg.x == null ? text.rowLabel(i + 1) : r[cfg.x];
    const key = raw === null || raw === undefined ? NULL_LABEL : String(raw);
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  });
  const names = cfg.count ? [text.countName] : cfg.ys.map(text.colName);
  const points: ChartPoint[] = [...groups.entries()].map(([label, rs]) => ({
    label,
    n: rs.length,
    values: cfg.count
      ? [rs.length]
      : cfg.ys.map((y) =>
          AGG[cfg.agg](rs.map((r) => numOf(r[y] ?? null)).filter((v): v is number => v !== null)),
        ),
  }));
  const grouped = points.some((p) => p.n > 1);

  if (cfg.x != null && xKind === "number") {
    points.sort((a, b) => Number(a.label) - Number(b.label));
  } else if (cfg.x != null && xKind === "time") {
    points.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  } else if (cfg.sort === "value") {
    points.sort((a, b) => (b.values[0] ?? 0) - (a.values[0] ?? 0));
  }

  // Series on very different scales share one axis badly: say so.
  const peaks = names.map((_, i) => Math.max(0, ...points.map((p) => Math.abs(p.values[i] ?? 0))));
  const big = Math.max(...peaks);
  const small = Math.min(...peaks);
  const lopsided =
    names.length > 1 && small > 0 && big / small > 20
      ? { big: names[peaks.indexOf(big)]!, small: names[peaks.indexOf(small)]! }
      : null;
  return { names, points, grouped, total: points.length, lopsided };
}

/** Axis ticks on 1 / 2 / 5 × 10ⁿ steps, covering `[lo, hi]`. */
export function ticks(lo: number, hi: number, want: number): number[] {
  if (lo === hi) hi = lo + 1;
  const raw = (hi - lo) / Math.max(1, want);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const a = Math.floor(lo / step) * step;
  const b = Math.ceil(hi / step) * step;
  const out: number[] = [];
  for (let v = a; v <= b + step / 2; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

/** A value: two decimals at most, grouped thousands, in the app's locale. */
export function fmt(v: number): string {
  return Math.abs(v) >= 1000
    ? fmtNumber(Math.round(v))
    : fmtNumber(v, { maximumFractionDigits: 2 });
}

/** An axis label: k / M / B from 10,000 up. */
export function short(v: number): string {
  const a = Math.abs(v);
  const one = (n: number) => fmtNumber(n, { maximumFractionDigits: 1 });
  if (a >= 1e9) return one(v / 1e9) + "B";
  if (a >= 1e6) return one(v / 1e6) + "M";
  if (a >= 1e4) return one(v / 1e3) + "k";
  return fmt(v);
}

/** The settings a fresh result starts from. */
export function firstCfg(cols: ColProfile[], rows: CellValue[][]): ChartCfg {
  return { ...infer(cols, rows), agg: "sum", sort: "asis" };
}

/** A signature of the column list: settings survive a re-run that keeps it. */
export function columnsSig(columns: ColumnMeta[]): string {
  return columns.map((c) => c.name).join("\u0000");
}

/**
 * Why a donut cannot show this series, or null when it can. A part-of-whole
 * chart needs one series of totals that add up: a row count or a sum, never
 * an average, and nothing negative.
 */
export function donutUnfit(
  data: ChartSeries,
  cfg: ChartCfg,
): "series" | "agg" | "negative" | "empty" | null {
  if (data.names.length !== 1) return "series";
  if (!cfg.count && cfg.agg !== "sum") return "agg";
  if (data.points.some((p) => (p.values[0] ?? 0) < 0)) return "negative";
  if (!data.points.some((p) => (p.values[0] ?? 0) > 0)) return "empty";
  return null;
}

export interface Slice {
  label: string;
  value: number;
  /** Of the whole, 0–1. */
  share: number;
  /** The folded remainder. */
  other: boolean;
}

/** The donut's slices: the largest MAX_SLICES, then "Other" for the rest. */
export function donutSlices(
  data: ChartSeries,
  otherLabel: string,
): { slices: Slice[]; total: number; folded: number } {
  const all = data.points
    .map((p) => ({ label: p.label, value: p.values[0] ?? 0 }))
    .filter((p) => p.value > 0)
    .sort((a, b) => b.value - a.value);
  const total = all.reduce((s, p) => s + p.value, 0) || 1;
  const kept = all.slice(0, MAX_SLICES);
  const rest = all.slice(MAX_SLICES);
  const slices: Slice[] = kept.map((p) => ({ ...p, share: p.value / total, other: false }));
  if (rest.length) {
    const value = rest.reduce((s, p) => s + p.value, 0);
    slices.push({ label: otherLabel, value, share: value / total, other: true });
  }
  return { slices, total, folded: rest.length };
}
