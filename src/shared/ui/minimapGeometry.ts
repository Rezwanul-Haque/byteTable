// Minimap geometry: the pure half of `Minimap.tsx`. A canvas hands the minimap
// world-space rectangles and the world rect its viewport currently shows; this
// module fits all of it into the minimap's fixed box and maps points both ways.

export interface MinimapRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** World → minimap is `m = w * scale + offset`, per axis. */
export interface MinimapFrame {
  scale: number;
  offsetX: number;
  offsetY: number;
}

/** The smallest rect holding every input; null when there are none. */
export function unionRects(rects: readonly (MinimapRect | null | undefined)[]): MinimapRect | null {
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const r of rects) {
    if (!r) continue;
    x1 = Math.min(x1, r.x);
    y1 = Math.min(y1, r.y);
    x2 = Math.max(x2, r.x + r.w);
    y2 = Math.max(y2, r.y + r.h);
  }
  return x1 === Infinity ? null : { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/**
 * Fit `bounds` inside a `width × height` box less `pad` on every side, keeping
 * the aspect ratio and centring the slack. A zero-sized bounds (one point)
 * still yields a finite scale.
 */
export function minimapFrame(
  bounds: MinimapRect,
  width: number,
  height: number,
  pad: number,
): MinimapFrame {
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const scale = Math.min(innerW / Math.max(bounds.w, 1), innerH / Math.max(bounds.h, 1));
  return {
    scale,
    offsetX: pad + (innerW - bounds.w * scale) / 2 - bounds.x * scale,
    offsetY: pad + (innerH - bounds.h * scale) / 2 - bounds.y * scale,
  };
}

export function toMinimap(frame: MinimapFrame, r: MinimapRect): MinimapRect {
  return {
    x: r.x * frame.scale + frame.offsetX,
    y: r.y * frame.scale + frame.offsetY,
    w: r.w * frame.scale,
    h: r.h * frame.scale,
  };
}

export function toWorld(frame: MinimapFrame, mx: number, my: number): { x: number; y: number } {
  return { x: (mx - frame.offsetX) / frame.scale, y: (my - frame.offsetY) / frame.scale };
}

export function containsPoint(r: MinimapRect, x: number, y: number): boolean {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}
