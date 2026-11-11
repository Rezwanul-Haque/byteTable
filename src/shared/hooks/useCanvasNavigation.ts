// Board-style navigation for an HTML card map (the Mongo, DynamoDB and
// Cassandra schema maps): a fixed viewport over a world drawn under one
// `translate(x, y) scale(k)` transform, exactly as the brainstorm board and the
// relational schema map navigate. Wheel/two-finger scroll and dragging empty
// canvas pan; ⌘/Ctrl-wheel or pinch zooms around the cursor; the zoom buttons
// and ⌘/Ctrl + / − multiply by ZOOM_FACTOR around the middle of the view.
//
// The host renders `transform` on its world layer, spreads `gridStyle` on the
// viewport (so the dot grid moves with the content), and wires `onPanStart` to
// the viewport's onPointerDown. `noPan` is a selector for elements that own
// their own drag (cards), which must not also pan.

import { useCallback, useEffect, useState, type RefObject } from "react";

import {
  centreOn,
  clampZoom,
  DEFAULT_ZOOM_LIMITS,
  visibleWorld,
  ZOOM_FACTOR,
  zoomAt,
  zoomKeyStep,
  type CanvasView,
} from "../ui/canvasView";
import { useWheelNavigation } from "./useWheelNavigation";

const HOME: CanvasView = { x: 0, y: 0, k: 1 };
/** The dot grid's tile at 100%. */
const GRID = 22;

export function useCanvasNavigation(viewportRef: RefObject<HTMLElement | null>, noPan: string) {
  const [view, setView] = useState<CanvasView>(HOME);

  useWheelNavigation(viewportRef, view, setView, DEFAULT_ZOOM_LIMITS);

  const zoomBy = useCallback(
    (factor: number) => {
      const el = viewportRef.current;
      if (!el) return;
      const k = clampZoom(view.k * factor, DEFAULT_ZOOM_LIMITS);
      setView(zoomAt(view, k, el.clientWidth / 2, el.clientHeight / 2));
    },
    [viewportRef, view],
  );

  // ⌘/Ctrl + / −. The card maps' workspaces keep every tab mounted and hide the
  // inactive ones with `display: none`, so every open map hears this window
  // listener — only the one actually on screen (its viewport has a layout box)
  // may act, or ⌘+ would zoom maps you cannot see. preventDefault keeps the
  // webview's own page zoom out of it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const step = zoomKeyStep(e);
      const el = viewportRef.current;
      if (!step || !el || el.getClientRects().length === 0) return;
      e.preventDefault();
      zoomBy(step > 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewportRef, zoomBy]);

  const reset = useCallback(() => setView(HOME), []);

  /** Drag on empty canvas pans. Window listeners, so a drag that leaves the
   *  viewport still tracks and still ends. */
  const onPanStart = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as Element).closest(noPan)) return;
    e.preventDefault();
    const sx = e.clientX;
    const sy = e.clientY;
    const { x: ox, y: oy } = view;
    const onMove = (me: PointerEvent) => {
      const x = ox + me.clientX - sx;
      const y = oy + me.clientY - sy;
      setView((v) => ({ ...v, x, y }));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  /** For `<Minimap getViewport onNavigate>`. A click on the minimap also zooms a
   *  zoomed-out map in to 100%, so a jump lands somewhere readable. */
  const getViewport = useCallback(() => {
    const el = viewportRef.current;
    if (!el || el.clientWidth === 0) return null;
    return visibleWorld(view, el.clientWidth, el.clientHeight);
  }, [viewportRef, view]);
  const onNavigate = useCallback(
    (p: { x: number; y: number }, gesture: "jump" | "drag") => {
      const el = viewportRef.current;
      if (!el) return;
      const k = gesture === "jump" && view.k < 1 ? 1 : view.k;
      setView(centreOn(p.x, p.y, k, el.clientWidth, el.clientHeight));
    },
    [viewportRef, view.k],
  );

  return {
    view,
    zoomBy,
    reset,
    onPanStart,
    getViewport,
    onNavigate,
    transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`,
    gridStyle: {
      backgroundSize: `${GRID * view.k}px ${GRID * view.k}px`,
      backgroundPosition: `${view.x}px ${view.y}px`,
    },
  };
}
