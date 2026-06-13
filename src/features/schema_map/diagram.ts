// Pure geometry + layout helpers for the SVG schema-map diagram (M9 §3.8).
// No React, no DOM — just the maths the SchemaMap component renders. Kept
// separate so it is unit-reasonable and so Task 3 (movable edges + export)
// can reuse the same endpoint/bezier maths without forking it.
//
// COORDINATE SPACE: everything here is in the diagram's *world* coordinates
// (the space inside the pan/zoom `<g transform>`). The component converts
// pointer deltas to world units by dividing by `zoom`.

import type { TableMeta } from "../../shared/api/engine";

/** Card geometry — byte-exact to the prototype (schemamap.jsx / §3.8). */
export const CARD_W = 224;
export const HEAD_H = 36;
export const ROW_H = 21;
/** Columns shown before the "+N more columns…" truncation row. */
export const MAX_COLS = 12;
/** Bottom padding inside a card below the last row (prototype `+ 8`). */
export const CARD_PAD_B = 8;
/** Dot-grid spacing (§3.8: 22px). */
export const GRID = 22;

/** A table card's resolved geometry for one render. */
export interface CardModel {
  table: string;
  /** Top-left in world coords. */
  x: number;
  y: number;
  w: number;
  /** Full card height (header + shown rows + optional "more" row + pad). */
  h: number;
  /** Columns actually drawn (capped at MAX_COLS). */
  shownColumns: TableMeta["columns"];
  /** Count of columns hidden behind the "+N more" row (0 = none hidden). */
  hiddenCount: number;
  /** Approx row count for the header chip, when known. */
  rowCount: number | null;
}

/** One FK relationship, resolved to drawable endpoints. */
export interface EdgeModel {
  /**
   * Stable id keyed by child table + child columns + ref table. Task 3's
   * `EdgeWaypoint.id` keys on exactly this — do NOT change the scheme without
   * migrating saved waypoints. Format: `child.col1,col2->refTable`.
   */
  id: string;
  childTable: string;
  refTable: string;
  /** SVG path `d` for the bezier curve. */
  path: string;
  /** Source dot (at the child FK column row edge). */
  sx: number;
  sy: number;
  /** Target ring (at the ref table header). */
  tx: number;
  ty: number;
}

/** Height of a card given its column count + truncation. */
export function cardHeight(meta: TableMeta): number {
  const shown = Math.min(meta.columns.length, MAX_COLS);
  const moreRow = meta.columns.length > MAX_COLS ? 1 : 0;
  return HEAD_H + (shown + moreRow) * ROW_H + CARD_PAD_B;
}

/** Resolve a table to its drawable card model at a given position. */
export function cardModel(
  table: string,
  meta: TableMeta,
  pos: { x: number; y: number },
  rowCount: number | null,
): CardModel {
  const hiddenCount = Math.max(0, meta.columns.length - MAX_COLS);
  return {
    table,
    x: pos.x,
    y: pos.y,
    w: CARD_W,
    h: cardHeight(meta),
    shownColumns: meta.columns.slice(0, MAX_COLS),
    hiddenCount,
    rowCount,
  };
}

/** Stable edge id — see {@link EdgeModel.id}. */
export function edgeId(childTable: string, cols: string[], refTable: string): string {
  return `${childTable}.${cols.join(",")}->${refTable}`;
}

/**
 * Auto-layout: a tidy layered/columnar placement by FK *depth* (how far a
 * table sits from a root that references nothing in-schema). Roots (no
 * outbound FK to an in-schema table) form the left column; each referencing
 * table sits one column to the right of the deepest table it points at. This
 * reads well for an e-commerce-shaped schema (users/products on the left,
 * orders in the middle, order_items/payments on the right) while degrading to
 * a plain grid for schemas with no FKs (everything depth 0 → one tall column,
 * then wrapped). Cards in the same depth column stack vertically.
 *
 * Deterministic given the same metas, so a re-layout (reset) is stable.
 */
export function autoLayout(
  tables: string[],
  metas: Record<string, TableMeta>,
): Record<string, { x: number; y: number }> {
  const inSchema = new Set(tables);

  // FK adjacency (child -> set of in-schema ref tables), self-refs ignored.
  const refsOf = new Map<string, Set<string>>();
  for (const t of tables) {
    const set = new Set<string>();
    const meta = metas[t];
    if (meta) {
      for (const fk of meta.foreignKeys) {
        if (fk.refTable !== t && inSchema.has(fk.refTable)) set.add(fk.refTable);
      }
    }
    refsOf.set(t, set);
  }

  // Depth = 1 + max depth of referenced tables (roots = 0). Memoised with
  // cycle guard (a table on its own ancestor path stops recursing).
  const depthCache = new Map<string, number>();
  const computeDepth = (t: string, onPath: Set<string>): number => {
    const cached = depthCache.get(t);
    if (cached !== undefined) return cached;
    if (onPath.has(t)) return 0; // cycle — treat as a root to break it
    onPath.add(t);
    let d = 0;
    for (const ref of refsOf.get(t) ?? []) {
      d = Math.max(d, computeDepth(ref, onPath) + 1);
    }
    onPath.delete(t);
    depthCache.set(t, d);
    return d;
  };

  const byDepth = new Map<number, string[]>();
  let maxDepth = 0;
  for (const t of tables) {
    const d = computeDepth(t, new Set());
    maxDepth = Math.max(maxDepth, d);
    const arr = byDepth.get(d) ?? [];
    arr.push(t);
    byDepth.set(d, arr);
  }

  const COL_GAP = 96; // horizontal gap between depth columns
  const ROW_GAP = 40; // vertical gap between stacked cards
  const MARGIN = 40;

  // Cap a single column's height: with no FKs everything is depth 0, which
  // would be an unusable single tall column. Wrap such a column into a grid.
  const MAX_PER_COL = 8;

  const pos: Record<string, { x: number; y: number }> = {};

  if (maxDepth === 0) {
    // No (in-schema) FK structure → tidy grid.
    const perRow = Math.max(1, Math.ceil(Math.sqrt(tables.length)));
    tables.forEach((t, i) => {
      const col = i % perRow;
      const row = Math.floor(i / perRow);
      pos[t] = {
        x: MARGIN + col * (CARD_W + COL_GAP),
        y: MARGIN + row * (HEAD_H + 6 * ROW_H + ROW_GAP),
      };
    });
    return pos;
  }

  // Layered: x by depth column, y by stack index within the column. Sort each
  // column's tables alphabetically for a stable, readable order.
  let colX = MARGIN;
  for (let d = 0; d <= maxDepth; d++) {
    const col = (byDepth.get(d) ?? []).slice().sort((a, b) => a.localeCompare(b));
    // Sub-wrap an over-tall column into adjacent mini-columns.
    let y = MARGIN;
    let subCol = 0;
    let widest = CARD_W;
    col.forEach((t, i) => {
      if (i > 0 && i % MAX_PER_COL === 0) {
        subCol += 1;
        y = MARGIN;
      }
      const x = colX + subCol * (CARD_W + COL_GAP);
      pos[t] = { x, y };
      widest = Math.max(widest, (subCol + 1) * (CARD_W + COL_GAP) - COL_GAP);
      const meta = metas[t];
      y += (meta ? cardHeight(meta) : HEAD_H) + ROW_GAP;
    });
    colX += widest + COL_GAP;
  }
  return pos;
}

/**
 * Compute a bezier `<path>` between a child card's FK column row and a ref
 * card's header, plus the source/target marker anchors. Picks the card sides
 * by relative position (mirrors the prototype) so the curve exits toward the
 * target. `colIndex` is the FK column's row index (clamped to the shown rows).
 *
 * Task 3 SEAM: a movable edge applies its `EdgeWaypoint {dx,dy}` to the
 * midpoint here — i.e. route the path through `(midX+dx, midY+dy)` as a second
 * bezier segment. The endpoints + side-picking below stay; only the middle
 * gains a user-controlled control point. The dot/ring anchors are unchanged.
 */
export function edgeGeometry(
  child: CardModel,
  ref: CardModel,
  colIndex: number,
): { path: string; sx: number; sy: number; tx: number; ty: number } {
  const clamped = Math.min(Math.max(0, colIndex), MAX_COLS - 1);
  const sy = child.y + HEAD_H + clamped * ROW_H + ROW_H / 2;
  const ty = ref.y + HEAD_H / 2;
  const childRight = child.x + child.w;

  let sx: number;
  let tx: number;
  if (ref.x > childRight + 20) {
    sx = childRight;
    tx = ref.x;
  } else if (child.x > ref.x + ref.w + 20) {
    sx = child.x;
    tx = ref.x + ref.w;
  } else {
    sx = childRight;
    tx = ref.x + ref.w;
  }
  const dx = Math.max(40, Math.abs(tx - sx) / 2);
  const c1 = sx + (tx >= sx ? dx : -dx);
  const c2 = tx + (tx >= sx ? -dx : dx);
  const path = `M ${sx} ${sy} C ${c1} ${sy}, ${c2} ${ty}, ${tx} ${ty}`;
  return { path, sx, sy, tx, ty };
}

/** Resolved edges for the current card models (FK metadata → drawable). */
export function buildEdges(
  tables: string[],
  metas: Record<string, TableMeta>,
  cards: Record<string, CardModel>,
): EdgeModel[] {
  const inSchema = new Set(tables);
  const out: EdgeModel[] = [];
  for (const childTable of tables) {
    const meta = metas[childTable];
    const child = cards[childTable];
    if (!meta || !child) continue;
    for (const fk of meta.foreignKeys) {
      if (!inSchema.has(fk.refTable)) continue;
      const ref = cards[fk.refTable];
      if (!ref) continue;
      const colIndex = meta.columns.findIndex((c) => c.name === fk.columns[0]);
      const geo = edgeGeometry(child, ref, colIndex);
      out.push({
        id: edgeId(childTable, fk.columns, fk.refTable),
        childTable,
        refTable: fk.refTable,
        path: geo.path,
        sx: geo.sx,
        sy: geo.sy,
        tx: geo.tx,
        ty: geo.ty,
      });
    }
  }
  return out;
}

/** The world-space content bounds (for sizing the SVG viewBox / scroll area). */
export function contentExtent(cards: CardModel[]): { width: number; height: number } {
  let maxX = 0;
  let maxY = 0;
  for (const c of cards) {
    maxX = Math.max(maxX, c.x + c.w);
    maxY = Math.max(maxY, c.y + c.h);
  }
  return { width: maxX + 80, height: maxY + 80 };
}
