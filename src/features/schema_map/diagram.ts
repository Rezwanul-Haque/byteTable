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
  /** Bend-handle position: natural midpoint + any applied waypoint offset. */
  mx: number;
  my: number;
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

/** A movable edge's midpoint offset (relative to the live midpoint). */
export interface Waypoint {
  dx: number;
  dy: number;
}

/** What {@link edgeGeometry} resolves: the path, endpoints, and live midpoint. */
export interface EdgeGeometry {
  path: string;
  sx: number;
  sy: number;
  tx: number;
  ty: number;
  /**
   * The handle position: the natural midpoint plus any waypoint offset. This is
   * where the draggable bend handle sits and what the user grabs. Without a
   * waypoint it is the natural curve midpoint; with one it is `mid + (dx,dy)`.
   */
  mx: number;
  my: number;
}

/**
 * Compute a bezier `<path>` between a child card's FK column row and a ref
 * card's header, plus the source/target marker anchors and the bend handle.
 * Picks the card sides by relative position (mirrors the prototype) so the
 * curve exits toward the target. `colIndex` is the FK column's row index
 * (clamped to the shown rows).
 *
 * MOVABLE EDGES (Task 3): an optional `waypoint {dx,dy}` bends the curve. The
 * offset is applied to the *natural* midpoint — the point halfway along a
 * straight chord between the side anchors — so the handle position (`mx,my`)
 * and bend follow the cards as they move (the offset is relative, not
 * absolute). With a waypoint the curve is routed as two cubic segments that
 * both pass through `(mx,my)` with horizontal tangents at the endpoints and a
 * smooth tangent at the waypoint, giving a clean S/elbow that reads well. With
 * no waypoint (or a zero one) we emit the original single-cubic curve so
 * un-bent edges are byte-identical to Task 2.
 */
export function edgeGeometry(
  child: CardModel,
  ref: CardModel,
  colIndex: number,
  waypoint?: Waypoint | null,
): EdgeGeometry {
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

  // Natural midpoint of the straight chord — the anchor the waypoint offsets
  // from, so a bend tracks the cards as they move.
  const midX = (sx + tx) / 2;
  const midY = (sy + ty) / 2;
  const wx = waypoint?.dx ?? 0;
  const wy = waypoint?.dy ?? 0;
  const mx = midX + wx;
  const my = midY + wy;

  const dx = Math.max(40, Math.abs(tx - sx) / 2);
  const c1 = sx + (tx >= sx ? dx : -dx);
  const c2 = tx + (tx >= sx ? -dx : dx);

  // Unbent → original single cubic (preserves Task 2 visuals exactly).
  if (wx === 0 && wy === 0) {
    const path = `M ${sx} ${sy} C ${c1} ${sy}, ${c2} ${ty}, ${tx} ${ty}`;
    return { path, sx, sy, tx, ty, mx, my };
  }

  // Bent → two cubic segments meeting at (mx,my). Endpoints keep their
  // horizontal exit tangents (control points offset on x only); the join at the
  // waypoint uses a tangent parallel to the chord for a smooth, non-kinked
  // bend. Quarter-distance control handles keep the curve taut.
  const hx = (tx - sx) / 4;
  const hy = (ty - sy) / 4;
  const path =
    `M ${sx} ${sy} ` +
    `C ${sx + (tx >= sx ? dx : -dx)} ${sy}, ${mx - hx} ${my - hy}, ${mx} ${my} ` +
    `C ${mx + hx} ${my + hy}, ${tx + (tx >= sx ? -dx : dx)} ${ty}, ${tx} ${ty}`;
  return { path, sx, sy, tx, ty, mx, my };
}

/**
 * Resolved edges for the current card models (FK metadata → drawable). Applies
 * any saved/active waypoint offsets keyed by edge id so a bent edge re-routes
 * through its handle as the cards move.
 */
export function buildEdges(
  tables: string[],
  metas: Record<string, TableMeta>,
  cards: Record<string, CardModel>,
  waypoints?: Record<string, Waypoint>,
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
      const id = edgeId(childTable, fk.columns, fk.refTable);
      const geo = edgeGeometry(child, ref, colIndex, waypoints?.[id]);
      out.push({
        id,
        childTable,
        refTable: fk.refTable,
        path: geo.path,
        sx: geo.sx,
        sy: geo.sy,
        tx: geo.tx,
        ty: geo.ty,
        mx: geo.mx,
        my: geo.my,
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

/**
 * The tight world-space bounding box of all cards (used to frame an export so
 * the whole diagram is captured regardless of pan/zoom or how cards were
 * dragged). `pad` insets the box on every side. Edges live between cards so the
 * card box (plus padding) safely contains the visible curves too.
 */
export function contentBounds(
  cards: CardModel[],
  pad = 48,
): { x: number; y: number; width: number; height: number } {
  if (cards.length === 0) return { x: 0, y: 0, width: 2 * pad, height: 2 * pad };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of cards) {
    minX = Math.min(minX, c.x);
    minY = Math.min(minY, c.y);
    maxX = Math.max(maxX, c.x + c.w);
    maxY = Math.max(maxY, c.y + c.h);
  }
  return {
    x: minX - pad,
    y: minY - pad,
    width: maxX - minX + 2 * pad,
    height: maxY - minY + 2 * pad,
  };
}
