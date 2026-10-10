// Board geometry (M37 Task 2): object bounds, edge routing, freehand smoothing
// and the volume→stroke-width scale. Pure maths in WORLD coordinates — the view
// transform is applied by CSS on `.bb-world`, never here.

import type { BoardObject, BoardSizes, Point } from "./model";

/** An axis-aligned box in world coordinates. */
export interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** A routed edge: its path plus the bezier midpoint, where the label sits. */
export interface EdgeGeometry {
  d: string;
  mx: number;
  my: number;
}

/**
 * An object's bounds. Width/height come from the MEASURED size (filled after
 * render), because most objects size themselves to their content — a sticky
 * grows with its text and a table card with its columns, and an edge anchored
 * on a guessed box visibly misses. Frames carry their own w/h (they are
 * resized, not measured) and ink is the bounding box of its points.
 *
 * The fallback only applies on the very first paint, before measurement.
 */
export function boxOf(object: BoardObject | undefined, sizes: BoardSizes): Box | null {
  if (!object) return null;
  if (object.type === "ink") {
    if (object.points.length === 0) return null;
    const xs = object.points.map((p) => p[0]);
    const ys = object.points.map((p) => p[1]);
    return {
      x1: Math.min(...xs),
      y1: Math.min(...ys),
      x2: Math.max(...xs),
      y2: Math.max(...ys),
    };
  }
  const measured =
    object.type === "frame"
      ? { w: object.w, h: object.h }
      : (sizes[object.id] ?? { w: "w" in object ? object.w : 150, h: 60 });
  return {
    x1: object.x,
    y1: object.y,
    x2: object.x + measured.w,
    y2: object.y + measured.h,
  };
}

/** The union of several boxes, or null when there are none. */
export function unionBox(boxes: readonly Box[]): Box | null {
  if (boxes.length === 0) return null;
  return {
    x1: Math.min(...boxes.map((b) => b.x1)),
    y1: Math.min(...boxes.map((b) => b.y1)),
    x2: Math.max(...boxes.map((b) => b.x2)),
    y2: Math.max(...boxes.map((b) => b.y2)),
  };
}

/**
 * Route a bezier between two boxes. The DOMINANT AXIS decides the anchoring:
 * mostly-horizontal pairs leave from facing side edges with horizontal control
 * handles, mostly-vertical pairs from top/bottom with vertical ones — so a
 * stack of flow nodes gets clean vertical drops instead of S-curves. The 0.8
 * bias keeps diagonal pairs horizontal, which reads better for left-to-right
 * diagrams.
 *
 * Returns the cubic's midpoint too (the standard t=0.5 evaluation), which is
 * where the edge's label pill and its hit target centre.
 */
export function edgePath(a: Box, b: Box): EdgeGeometry {
  const ac = { x: (a.x1 + a.x2) / 2, y: (a.y1 + a.y2) / 2 };
  const bc = { x: (b.x1 + b.x2) / 2, y: (b.y1 + b.y2) / 2 };
  const dx = bc.x - ac.x;
  const dy = bc.y - ac.y;
  let start: { x: number; y: number };
  let end: { x: number; y: number };
  let c1: { x: number; y: number };
  let c2: { x: number; y: number };
  if (Math.abs(dx) >= Math.abs(dy) * 0.8) {
    const sign = dx >= 0 ? 1 : -1;
    start = { x: sign > 0 ? a.x2 : a.x1, y: ac.y };
    end = { x: sign > 0 ? b.x1 : b.x2, y: bc.y };
    const handle = Math.max(28, Math.abs(end.x - start.x) / 2) * sign;
    c1 = { x: start.x + handle, y: start.y };
    c2 = { x: end.x - handle, y: end.y };
  } else {
    const sign = dy >= 0 ? 1 : -1;
    start = { x: ac.x, y: sign > 0 ? a.y2 : a.y1 };
    end = { x: bc.x, y: sign > 0 ? b.y1 : b.y2 };
    const handle = Math.max(28, Math.abs(end.y - start.y) / 2) * sign;
    c1 = { x: start.x, y: start.y + handle };
    c2 = { x: end.x, y: end.y - handle };
  }
  return {
    d: `M${start.x} ${start.y} C${c1.x} ${c1.y} ${c2.x} ${c2.y} ${end.x} ${end.y}`,
    mx: (start.x + 3 * c1.x + 3 * c2.x + end.x) / 8,
    my: (start.y + 3 * c1.y + 3 * c2.y + end.y) / 8,
  };
}

/**
 * Smooth a freehand stroke: quadratic segments whose control points are the
 * sampled points and whose endpoints are the midpoints between them. That is
 * the cheap, standard trick for ink — it rounds every corner without needing a
 * fitting pass, and it keeps the path length proportional to the sample count.
 */
export function inkPath(points: readonly Point[]): string {
  const first = points[0];
  if (!first) return "";
  let d = `M${first[0]} ${first[1]}`;
  for (let i = 1; i < points.length - 1; i += 1) {
    const control = points[i]!;
    const next = points[i + 1]!;
    const mx = (control[0] + next[0]) / 2;
    const my = (control[1] + next[1]) / 2;
    d += ` Q${control[0]} ${control[1]} ${mx} ${my}`;
  }
  const last = points[points.length - 1]!;
  return d + ` L${last[0]} ${last[1]}`;
}

/**
 * Stroke width for a flow edge from its volume label, log-scaled into 1.3–5px
 * so "3000 rps" reads visibly heavier than "2 /min" without a 1000× line. The
 * first number in the label wins; a trailing `k` multiplies by 1000. A label
 * with no number (or none at all) keeps the default weight.
 */
export function volumeWidth(label: string | undefined): number {
  const match = String(label ?? "")
    .replace(/,/g, "")
    .match(/(\d+(\.\d+)?)\s*(k)?/i);
  if (!match?.[1]) return 1.5;
  const n = parseFloat(match[1]) * (match[3] ? 1000 : 1);
  return Math.min(5, 1.3 + Math.log10(n + 1) * 0.95);
}

/** Clamp a zoom factor into the board's range. */
export function clampZoom(k: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, k));
}
