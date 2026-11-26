// Row lineage (M50): the pure half — how a table takes part in foreign keys,
// what a row is called, which colour a table wears, and where every card and
// link sits on the canvas. Ported from the prototype's `lineage.jsx`
// (`window.BT_LINEAGE`, `lnHue`, `LN_W`/`LN_STEP`/`lnHeight`, and the geometry
// inside `LineageTab`). Loading lives in `load.ts`; nothing here queries.
//
// Only DECLARED foreign keys count: everything is read from `TableMeta`'s
// constraint lists, never guessed from a column name. Composite keys (on either
// end) are out of scope this milestone and are simply left out.

import type { CellValue, ColumnInfo, TableMeta } from "../../shared/api/engine";
import type { CanvasView } from "../../shared/ui/canvasView";

/** One row, by column name. */
export type Row = Record<string, CellValue>;

/** A foreign key this table declares: `col` → `refTable.refCol`. */
export interface Fk {
  col: string;
  refTable: string;
  refCol: string;
}

/** A foreign key another table declares on this one: `table.col` → `refCol`. */
export interface InFk {
  table: string;
  col: string;
  refCol: string;
}

/** What lineage needs to know about one table. */
export interface TableShape {
  name: string;
  /** The single-column primary key; null for none or a composite one. */
  pk: string | null;
  columns: ColumnInfo[];
  fks: Fk[];
  refs: InFk[];
}

export function shapeOf(name: string, meta: TableMeta): TableShape {
  const pks = meta.columns.filter((c) => c.pk);
  return {
    name,
    pk: pks.length === 1 ? (pks[0]?.name ?? null) : null,
    columns: meta.columns,
    fks: meta.foreignKeys.flatMap((f) => {
      const [col, refCol] = [f.columns[0], f.refColumns[0]];
      return f.columns.length === 1 && col && refCol ? [{ col, refTable: f.refTable, refCol }] : [];
    }),
    refs: meta.referencedBy.flatMap((f) => {
      const [col, refCol] = [f.columns[0], f.refColumns[0]];
      return f.columns.length === 1 && col && refCol ? [{ table: f.table, col, refCol }] : [];
    }),
  };
}

/** Does this table take part in any foreign key, and can one of its rows be
 *  named? Decides whether the entry points show. */
export function isLinked(shape: TableShape | null | undefined): boolean {
  return !!shape && !!shape.pk && (shape.fks.length > 0 || shape.refs.length > 0);
}

/** Loose equality for key values: a big integer can arrive as a string. */
export function sameValue(a: CellValue | undefined, b: CellValue | undefined): boolean {
  return a !== null && a !== undefined && b !== null && b !== undefined && String(a) === String(b);
}

/** A row from a result page's parallel arrays. */
export function rowOf(columns: { name: string }[], values: CellValue[]): Row {
  const row: Row = {};
  columns.forEach((c, i) => {
    row[c.name] = values[i] ?? null;
  });
  return row;
}

// ---- naming ---------------------------------------------------------------

export const LABEL_COLS = [
  "name",
  "full_name",
  "title",
  "label",
  "public_id",
  "email",
  "username",
  "sku",
  "code",
  "customer_name",
];

export interface RowLabel {
  text: string;
  col: string | null;
}

const plainText = (v: CellValue): string => (typeof v === "object" ? JSON.stringify(v) : String(v));

/**
 * A short human name for a row: its first non-empty "name-like" column. `show`
 * is the masking entry point (`maskText`), so a masked email never names a row
 * in the clear. A UUID is a poor name, so only its first block is kept.
 */
export function labelOf(
  columns: { name: string }[],
  row: Row,
  show: (value: CellValue, col: string) => string = plainText,
): RowLabel {
  const names = new Set(columns.map((c) => c.name));
  const col = LABEL_COLS.find((c) => names.has(c) && row[c] != null && row[c] !== "");
  if (!col) return { text: "", col: null };
  const text = show(row[col] ?? null, col);
  return { text: /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(text) ? text.slice(0, 8) + "…" : text, col };
}

/**
 * Up to `max` plain columns that help tell rows apart: not the key, not a
 * foreign key, not the label column, not an object, shorter than `maxLen`.
 */
export function factCols(
  columns: ColumnInfo[],
  row: Row,
  fkCols: string[],
  labelCol: string | null,
  max: number,
  maxLen: number,
): string[] {
  return columns
    .filter((c) => {
      const v = row[c.name];
      return (
        !c.pk &&
        !fkCols.includes(c.name) &&
        c.name !== labelCol &&
        v !== null &&
        v !== undefined &&
        typeof v !== "object" &&
        String(v).length < maxLen
      );
    })
    .slice(0, max)
    .map((c) => c.name);
}

/** The full text of a key value, for tooltips and copying. */
export function keyFull(value: CellValue | undefined): string {
  if (value === null || value === undefined) return "";
  const s = typeof value === "object" ? JSON.stringify(value) : String(value);
  // A 16-byte binary key is a UUID stored as bytes: read it as one, like the grid.
  const hex = /^0x([0-9a-f]{32})$/i.exec(s)?.[1];
  return hex
    ? [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join(
        "-",
      )
    : s;
}

/** A key short enough for a pill: a UUID keeps its first block (as labels
 *  do), anything else long is cut. `keyFull` has the whole value. */
export function keyText(value: CellValue | undefined): string {
  const s = keyFull(value);
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s)) return s.slice(0, 8) + "…";
  return s.length > 16 ? s.slice(0, 12) + "…" : s;
}

// ---- colour ---------------------------------------------------------------

export const LN_HUES = [
  "#5aa7f5",
  "#2dd4a7",
  "#b08cff",
  "#f5b54a",
  "#f7768e",
  "#56b6c2",
  "#e5734f",
];

/** A steady colour per table name: the same table looks the same everywhere. */
export function lnHue(table: string): string {
  let h = 0;
  for (let i = 0; i < table.length; i++) h = (h * 31 + table.charCodeAt(i)) >>> 0;
  return LN_HUES[h % LN_HUES.length] ?? "#5aa7f5";
}

/** Two letters for a table's badge: initials of the first two words, else its
 *  first two letters (`order_items` → OI, `users` → US). */
export function badgeText(table: string): string {
  const [a, b] = table.split("_").filter(Boolean);
  return (a && b ? a.charAt(0) + b.charAt(0) : table.slice(0, 2)).toUpperCase();
}

// ---- the trail ------------------------------------------------------------

export interface LineageStop {
  table: string;
  key: CellValue;
}

/** Walk to a new centre row. Walking from the middle of the trail drops what
 *  came after; walking to the row already at the centre changes nothing. */
export function walk(
  trail: LineageStop[],
  at: number,
  stop: LineageStop,
): { trail: LineageStop[]; at: number } {
  const cur = trail[at];
  if (stop.key === null || (cur && cur.table === stop.table && sameValue(cur.key, stop.key))) {
    return { trail, at };
  }
  return { trail: [...trail.slice(0, at + 1), stop], at: at + 1 };
}

// ---- geometry (world coordinates) -----------------------------------------

/** The graph is laid out on a fixed-width world, then panned and zoomed. */
export const LN_W = 1040;
/** Vertical distance between neighbouring cards: room for a stack's lower
 *  cards (up to 32px fanned) plus a clear gap. */
export const LN_STEP = 158;
/** Card half-widths, matching `.ln-pn` / `.ln-hero` / `.ln-cl`. Links run
 *  edge to edge, not centre to centre where the cards would hide the bend. */
export const PN_HALF = 103;
export const HERO_HALF = 122;
export const CL_HALF = 107;
export const ZOOM_LIMITS = { min: 0.4, max: 2 };

export function worldHeight(nUp: number, nDn: number): number {
  return Math.max(480, Math.max(nUp, nDn) * LN_STEP + 110);
}

/** The x of the left (points at) and right (pointing here) columns. */
export function columnsX(w: number): { xUp: number; xDn: number } {
  return {
    xUp: Math.max(123, Math.round(w * 0.15)),
    xDn: w - Math.max(127, Math.round(w * 0.155)),
  };
}

/** The y of card `i` of `n` in a column: centred, LN_STEP apart. */
export function spread(n: number, i: number, h: number): number {
  return n <= 1 ? Math.round(h / 2) : Math.round(h / 2 + (i - (n - 1) / 2) * LN_STEP);
}

/** A cubic Bézier that leaves heading left and arrives from the right. */
export function curve(xa: number, ya: number, xb: number, yb: number): string {
  const t = Math.max(40, Math.abs(xb - xa) * 0.55);
  return `M${xa} ${ya} C${xa - t} ${ya} ${xb + t} ${yb} ${xb} ${yb}`;
}

/** Where link `i` of `n` meets the centre card's side: fanned out, at most
 *  22px apart, so no two links share a point. */
export function dock(n: number, i: number, hy: number): number {
  return hy + Math.round((i - (n - 1) / 2) * Math.min(22, 120 / Math.max(1, n - 1)));
}

/** A stack's link thickens with its row count. */
export function stackWidth(count: number): number {
  return 1.6 + Math.min(3, Math.log2(Math.max(1, count)));
}

export interface Offset {
  dx: number;
  dy: number;
}

/** A card's place: its layout position plus whatever the user dragged it by. */
export function put(
  moved: Record<string, Offset>,
  id: string,
  x: number,
  y: number,
): { x: number; y: number } {
  const o = moved[id];
  return o ? { x: Math.round(x + o.dx), y: Math.round(y + o.dy) } : { x, y };
}

/** The whole world in view, centred; never zoomed in past 100%. */
export function fitWorld(vw: number, vh: number, h: number): CanvasView {
  const k = Math.max(ZOOM_LIMITS.min, Math.min(1, vw / LN_W, vh / h));
  return { k, x: Math.round((vw - LN_W * k) / 2), y: Math.round((vh - h * k) / 2) };
}
