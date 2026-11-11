// Pan/zoom view math for an infinite canvas: a fixed viewport over a world
// drawn under one `translate(x, y) scale(k)` transform. A world point (wx, wy)
// sits at viewport pixel (x + wx·k, y + wy·k). The brainstorm board and the
// schema map both navigate this way; `useWheelNavigation` is the input half.

export interface CanvasView {
  x: number;
  y: number;
  k: number;
}

export interface ZoomLimits {
  min: number;
  max: number;
}

/** The brainstorm board's range, which the card maps share. */
export const DEFAULT_ZOOM_LIMITS: ZoomLimits = { min: 0.25, max: 2.5 };

/** One zoom-button click: multiply (in) or divide (out) by this. */
export const ZOOM_FACTOR = 1.2;

/** ⌘/Ctrl-wheel and pinch: the scale factor per pixel of wheel delta. */
export const WHEEL_ZOOM_RATE = 0.0018;

/**
 * ⌘/Ctrl with + or − as a zoom step: 1 (in), -1 (out), or 0 (not a zoom key).
 * Both the character and the physical key are checked: "+" needs shift on most
 * layouts, and the numeric keypad sends its own keys entirely. ⌥ is left alone.
 */
export function zoomKeyStep(e: {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}): 1 | -1 | 0 {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return 0;
  if (e.key === "+" || e.key === "=" || e.code === "Equal" || e.code === "NumpadAdd") return 1;
  if (e.key === "-" || e.key === "_" || e.code === "Minus" || e.code === "NumpadSubtract")
    return -1;
  return 0;
}

export function clampZoom(k: number, limits: ZoomLimits): number {
  return Math.max(limits.min, Math.min(limits.max, k));
}

/** Zoom to `k`, keeping the world point under viewport pixel (mx, my) fixed. */
export function zoomAt(view: CanvasView, k: number, mx: number, my: number): CanvasView {
  return {
    k,
    x: mx - ((mx - view.x) * k) / view.k,
    y: my - ((my - view.y) * k) / view.k,
  };
}

/** The world rect the viewport shows. */
export function visibleWorld(view: CanvasView, width: number, height: number) {
  return { x: -view.x / view.k, y: -view.y / view.k, w: width / view.k, h: height / view.k };
}

/** Put world point (wx, wy) at the centre of a `width × height` viewport at zoom `k`. */
export function centreOn(
  wx: number,
  wy: number,
  k: number,
  width: number,
  height: number,
): CanvasView {
  return { k, x: width / 2 - wx * k, y: height / 2 - wy * k };
}

/**
 * The view that shows `box` (world coords) whole, centred, with `pad` screen
 * pixels clear on every side. The zoom is clamped to `limits`, so a tiny
 * diagram is not blown up past `limits.max` and a huge one stops at
 * `limits.min` (centred, overflowing).
 */
export function fitView(
  box: { x: number; y: number; w: number; h: number },
  width: number,
  height: number,
  pad: number,
  limits: ZoomLimits,
): CanvasView {
  const k = clampZoom(
    Math.min((width - pad * 2) / Math.max(box.w, 1), (height - pad * 2) / Math.max(box.h, 1)),
    limits,
  );
  return {
    k,
    x: (width - box.w * k) / 2 - box.x * k,
    y: (height - box.h * k) / 2 - box.y * k,
  };
}
