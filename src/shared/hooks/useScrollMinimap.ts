// The `Minimap` wiring for a canvas that navigates by native scroll over a
// `scale(zoom)` inner layer with no other offset (the Mongo, DynamoDB and
// Cassandra schema maps). World point (x, y) sits at scroll offset (x·zoom, y·zoom).

import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";

export function useScrollMinimap(
  wrapRef: RefObject<HTMLElement | null>,
  zoom: number,
  setZoom: (zoom: number) => void,
) {
  // A jump that zooms in can only scroll once the canvas has grown to the new
  // zoom's size — a scrollTo issued earlier is clamped to the old extent. The
  // layout effect flushes it in the commit that applies the zoom.
  const pendingScroll = useRef<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const next = pendingScroll.current;
    if (!next) return;
    pendingScroll.current = null;
    wrapRef.current?.scrollTo(next);
  });

  const getViewport = useCallback(() => {
    const wrap = wrapRef.current;
    if (!wrap || wrap.clientWidth === 0) return null;
    return {
      x: wrap.scrollLeft / zoom,
      y: wrap.scrollTop / zoom,
      w: wrap.clientWidth / zoom,
      h: wrap.clientHeight / zoom,
    };
  }, [wrapRef, zoom]);

  /** Centre the view on a world point; a click also zooms a zoomed-out map in to 100%. */
  const onNavigate = useCallback(
    (p: { x: number; y: number }, gesture: "jump" | "drag") => {
      const wrap = wrapRef.current;
      if (!wrap) return;
      const z = gesture === "jump" && zoom < 1 ? 1 : zoom;
      const target = {
        left: Math.max(0, p.x * z - wrap.clientWidth / 2),
        top: Math.max(0, p.y * z - wrap.clientHeight / 2),
      };
      if (z === zoom) {
        wrap.scrollTo(target);
        return;
      }
      pendingScroll.current = target;
      setZoom(z);
    },
    [wrapRef, zoom, setZoom],
  );

  return { getViewport, onNavigate };
}
