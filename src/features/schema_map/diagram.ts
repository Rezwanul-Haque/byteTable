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
/** Bottom padding inside a card below the last row (prototype `+ 8`). */
export const CARD_PAD_B = 8;
/** Top padding of the column area, below the header (rows start at HEAD_H+4).
 *  Edge endpoints must include it to center on a column row. */
export const CARD_PAD_T = 4;
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
  /** Columns actually drawn (all of them — no truncation). */
  shownColumns: TableMeta["columns"];
  /** Retained for the export path; always 0 now that all columns are drawn. */
  hiddenCount: number;
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
  /** Cardinality marker kind at each endpoint (crow's-foot notation). Child end
   *  is `many` for a normal 1:N, `one` for a 1:1 (unique/PK FK column); parent
   *  end is always `one`. A derived M:N edge is `many` at both ends. */
  childEnd: EndKind;
  parentEnd: EndKind;
  /** Direction the line leaves each card (from edge into line) — orients the
   *  markers. +1 = card's right side, -1 = its left side. */
  sOut: 1 | -1;
  tOut: 1 | -1;
  /** True for a derived M:N edge (junction table) — drawn dashed, no FK. */
  derived?: boolean;
}

/** A relationship endpoint's cardinality: exactly one, or many (crow's foot). */
export type EndKind = "one" | "many";

/** Height of a card given its column count (all columns shown, no truncation). */
export function cardHeight(meta: TableMeta): number {
  return HEAD_H + meta.columns.length * ROW_H + CARD_PAD_B;
}

/** Resolve a table to its drawable card model at a given position. `width`
 *  overrides the default {@link CARD_W} (read-mode resizable cards); callers
 *  pass the user-resized width, or omit it for the default. */
export function cardModel(
  table: string,
  meta: TableMeta,
  pos: { x: number; y: number },
  width?: number,
): CardModel {
  return {
    table,
    x: pos.x,
    y: pos.y,
    w: width ?? CARD_W,
    h: cardHeight(meta),
    shownColumns: meta.columns,
    hiddenCount: 0,
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
  /** Direction the line leaves each endpoint (from the card edge INTO the line):
   *  +1 = the card's right side, -1 = its left side. Orients the cardinality
   *  markers so their prongs/tick sit against the card. */
  sOut: 1 | -1;
  tOut: 1 | -1;
}

/**
 * Compute a bezier `<path>` between a child card's FK column row and the ref
 * card's referenced column row, plus the source/target marker anchors and the
 * bend handle. Picks the card sides by relative position (mirrors the
 * prototype) so the curve exits toward the target. `colIndex` is the FK
 * column's row index and `refColIndex` the referenced column's row index (both
 * clamped to the shown rows).
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
  refColIndex: number,
  waypoint?: Waypoint | null,
): EdgeGeometry {
  // Clamp the FK dot to the card's real row range — all columns are drawn now,
  // so an out-of-range index just pins to the last row.
  const clamped = Math.min(Math.max(0, colIndex), Math.max(0, child.shownColumns.length - 1));
  const clampedRef = Math.min(Math.max(0, refColIndex), Math.max(0, ref.shownColumns.length - 1));
  const sy = child.y + HEAD_H + CARD_PAD_T + clamped * ROW_H + ROW_H / 2;
  const ty = ref.y + HEAD_H + CARD_PAD_T + clampedRef * ROW_H + ROW_H / 2;
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

  // Which side of each card the line leaves (for orienting cardinality markers).
  const sOut: 1 | -1 = sx === childRight ? 1 : -1;
  const tOut: 1 | -1 = tx === ref.x ? -1 : 1;

  // Vertically-dominant edges route as a tidy rounded orthogonal bracket (out →
  // along → in) rather than a tall squished bezier. This covers both same-side
  // endpoints (stacked cards, vertical run OUTSIDE that side) and facing
  // endpoints with a narrow horizontal gap (vertical run IN the gap between the
  // cards). Horizontally-adjacent edges keep the smooth bezier below.
  const hGap = Math.abs(tx - sx);
  const vGap = Math.abs(ty - sy);
  const sameSide = sOut === tOut;
  if (sameSide || vGap > hGap + 60) {
    const reach = 46;
    const baseRunX = sameSide
      ? sOut > 0
        ? Math.max(sx, tx) + reach
        : Math.min(sx, tx) - reach
      : (sx + tx) / 2;
    const runX = baseRunX + wx;
    const runMy = midY + wy;
    const vy = ty >= sy ? 1 : -1;
    const r = Math.max(2, Math.min(12, vGap / 2));
    const path =
      `M ${sx} ${sy} L ${runX - sOut * r} ${sy} ` +
      `Q ${runX} ${sy} ${runX} ${sy + vy * r} ` +
      `L ${runX} ${ty - vy * r} ` +
      `Q ${runX} ${ty} ${runX - tOut * r} ${ty} ` +
      `L ${tx} ${ty}`;
    return { path, sx, sy, tx, ty, mx: runX, my: runMy, sOut, tOut };
  }

  const dx = Math.max(40, Math.abs(tx - sx) / 2);
  // Each control handle extends OUTWARD from its own endpoint (by that side's
  // direction), so two same-side endpoints (vertically-stacked cards) both bulge
  // out cleanly instead of one looping back into the card.
  const c1 = sx + sOut * dx;
  const c2 = tx + tOut * dx;

  // Unbent → original single cubic (preserves Task 2 visuals exactly).
  if (wx === 0 && wy === 0) {
    const path = `M ${sx} ${sy} C ${c1} ${sy}, ${c2} ${ty}, ${tx} ${ty}`;
    return { path, sx, sy, tx, ty, mx, my, sOut, tOut };
  }

  // Bent → two cubic segments meeting at (mx,my). Endpoints keep their
  // horizontal exit tangents (control points offset on x only); the join at the
  // waypoint uses a tangent parallel to the chord for a smooth, non-kinked
  // bend. Quarter-distance control handles keep the curve taut.
  const hx = (tx - sx) / 4;
  const hy = (ty - sy) / 4;
  const path =
    `M ${sx} ${sy} ` +
    `C ${c1} ${sy}, ${mx - hx} ${my - hy}, ${mx} ${my} ` +
    `C ${mx + hx} ${my + hy}, ${c2} ${ty}, ${tx} ${ty}`;
  return { path, sx, sy, tx, ty, mx, my, sOut, tOut };
}

// --- cardinality (crow's-foot notation) -------------------------------------

/** Marker geometry, relative to the endpoint at the card edge. */
const FOOT_LEN = 13; // how far the crow's-foot apex sits out along the line
const FOOT_SPREAD = 6; // half the fork's opening at the card edge
const TICK_OFF = 8; // how far the "one" tick sits off the card edge
const TICK_H = 5; // half the tick's height

/**
 * SVG path `d` for a cardinality marker at `(ex,ey)` on a card edge. `outX` is
 * the direction the line leaves the card (+1 right, -1 left). `one` draws a
 * single perpendicular tick out along the line; `many` draws a 3-prong crow's
 * foot whose prongs touch the card edge and converge to an apex out on the line.
 */
export function crowFoot(ex: number, ey: number, outX: 1 | -1, kind: EndKind): string {
  if (kind === "one") {
    const bx = ex + outX * TICK_OFF;
    return `M ${bx} ${ey - TICK_H} L ${bx} ${ey + TICK_H}`;
  }
  const ax = ex + outX * FOOT_LEN;
  return (
    `M ${ax} ${ey} L ${ex} ${ey - FOOT_SPREAD} ` +
    `M ${ax} ${ey} L ${ex} ${ey} ` +
    `M ${ax} ${ey} L ${ex} ${ey + FOOT_SPREAD}`
  );
}

/** Set-equal by membership (order-insensitive). */
function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
}

/** True when `cols` are unique in `meta` — i.e. the whole PK, or exactly the
 *  columns of some UNIQUE index. A unique child FK column makes the edge 1:1. */
function colsAreUnique(meta: TableMeta, cols: string[]): boolean {
  const pkCols = meta.columns.filter((c) => c.pk).map((c) => c.name);
  if (pkCols.length > 0 && sameSet(pkCols, cols)) return true;
  return meta.indexes.some((ix) => ix.unique && sameSet(ix.columns, cols));
}

/** The child end's cardinality for one FK: `one` (1:1) when the FK column(s)
 *  are unique in the child, else `many` (1:N). Parent end is always `one`. */
export function childEndFor(childMeta: TableMeta, fkColumns: string[]): EndKind {
  return colsAreUnique(childMeta, fkColumns) ? "one" : "many";
}

/** A detected junction (associative) table: exactly two FKs to two distinct
 *  tables, with the table's PK equal to exactly those two FK columns. Implies an
 *  M:N between `a` and `b`. */
export interface Junction {
  table: string;
  a: string;
  b: string;
}

/** Find junction tables among `tables` → the M:N relationships they encode. */
export function detectJunctions(tables: string[], metas: Record<string, TableMeta>): Junction[] {
  const out: Junction[] = [];
  for (const t of tables) {
    const m = metas[t];
    if (!m || m.foreignKeys.length !== 2) continue;
    const [f1, f2] = m.foreignKeys;
    if (!f1 || !f2 || f1.refTable === f2.refTable) continue;
    const pkCols = m.columns.filter((c) => c.pk).map((c) => c.name);
    const fkCols = [...f1.columns, ...f2.columns];
    if (pkCols.length > 0 && sameSet(pkCols, fkCols)) {
      out.push({ table: t, a: f1.refTable, b: f2.refTable });
    }
  }
  return out;
}

/** Stable id for a derived M:N edge between two tables (order-insensitive). */
export function mnEdgeId(a: string, b: string): string {
  return `mn:${[a, b].sort().join("--")}`;
}

/** A manual cardinality override value (mirrors the frontend `CardinalityKind`). */
export type CardinalityKind = "1:1" | "1:N" | "M:N";

/** Map an override kind to the two endpoint markers (child end, parent end). */
export function endsForKind(kind: CardinalityKind): { child: EndKind; parent: EndKind } {
  switch (kind) {
    case "1:1":
      return { child: "one", parent: "one" };
    case "M:N":
      return { child: "many", parent: "many" };
    default:
      return { child: "many", parent: "one" }; // 1:N
  }
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
  overrides?: Record<string, CardinalityKind>,
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
      const refColIndex =
        metas[fk.refTable]?.columns.findIndex((c) => c.name === fk.refColumns[0]) ?? 0;
      const id = edgeId(childTable, fk.columns, fk.refTable);
      const geo = edgeGeometry(child, ref, colIndex, refColIndex, waypoints?.[id]);
      const override = overrides?.[id];
      const ends = override
        ? endsForKind(override)
        : { child: childEndFor(meta, fk.columns), parent: "one" as EndKind };
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
        childEnd: ends.child,
        parentEnd: ends.parent,
        sOut: geo.sOut,
        tOut: geo.tOut,
      });
    }
  }
  // Derived M:N edges: one dashed edge between the two tables each junction
  // links (both ends many). Deduped by the order-insensitive edge id.
  const seen = new Set<string>();
  for (const j of detectJunctions(tables, metas)) {
    const a = cards[j.a];
    const b = cards[j.b];
    if (!a || !b) continue;
    const id = mnEdgeId(j.a, j.b);
    if (seen.has(id)) continue;
    seen.add(id);
    const geo = edgeGeometry(a, b, 0, 0, waypoints?.[id]);
    out.push({
      id,
      childTable: j.a,
      refTable: j.b,
      path: geo.path,
      sx: geo.sx,
      sy: geo.sy,
      tx: geo.tx,
      ty: geo.ty,
      mx: geo.mx,
      my: geo.my,
      childEnd: "many",
      parentEnd: "many",
      sOut: geo.sOut,
      tOut: geo.tOut,
      derived: true,
    });
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
