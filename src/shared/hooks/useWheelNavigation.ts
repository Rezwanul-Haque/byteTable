// Wheel input for a `CanvasView` canvas (see shared/ui/canvasView.ts): a plain
// wheel or two-finger scroll pans, ⌘/Ctrl-wheel or a trackpad pinch zooms
// around the cursor. Lifted from the brainstorm board so the schema map
// navigates identically.
//
// Every event works from `view` AS OF THE LAST RENDER, not one advanced by each
// event. A pinch fires several wheel events per frame; scaling each from the
// same rendered view means the last one in a frame wins, which is what keeps a
// fast pinch to one smooth step per frame instead of compounding them.
//
// Registered natively because it must be non-passive to preventDefault — React
// attaches wheel listeners as passive, which would let the webview page-zoom or
// scroll instead.

import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

import {
  clampZoom,
  WHEEL_ZOOM_RATE,
  zoomAt,
  type CanvasView,
  type ZoomLimits,
} from "../ui/canvasView";

export function useWheelNavigation(
  viewportRef: RefObject<HTMLElement | null>,
  view: CanvasView,
  setView: (view: CanvasView) => void,
  limits: ZoomLimits,
  enabled = true,
) {
  // The listener is registered once; it reaches the rendered view and the
  // caller's latest setter through a ref instead of re-subscribing per render.
  const live = useRef({ view, setView });
  useLayoutEffect(() => {
    live.current = { view, setView };
  });

  const { min, max } = limits;
  const limitsRef = useRef({ min, max });
  useLayoutEffect(() => {
    limitsRef.current = { min, max };
  });

  // Attach to whatever element the ref holds AFTER EACH RENDER, not just on
  // mount: a host can render without its viewport first (the schema map shows a
  // loading state), and an effect keyed on the ref object would run once, find
  // nothing, and never look again — leaving wheel pan and zoom dead.
  const attached = useRef<{ el: HTMLElement; onWheel: (e: WheelEvent) => void } | null>(null);
  useEffect(() => {
    const el = enabled ? viewportRef.current : null;
    if (attached.current?.el === el) return;
    if (attached.current) {
      attached.current.el.removeEventListener("wheel", attached.current.onWheel);
      attached.current = null;
    }
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = live.current.view;
      if (e.ctrlKey || e.metaKey) {
        const rect = el.getBoundingClientRect();
        const k = clampZoom(v.k * Math.exp(-e.deltaY * WHEEL_ZOOM_RATE), limitsRef.current);
        live.current.setView(zoomAt(v, k, e.clientX - rect.left, e.clientY - rect.top));
      } else {
        live.current.setView({ k: v.k, x: v.x - e.deltaX, y: v.y - e.deltaY });
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    attached.current = { el, onWheel };
  });
  useEffect(
    () => () => {
      attached.current?.el.removeEventListener("wheel", attached.current.onWheel);
      attached.current = null;
    },
    [],
  );
}
