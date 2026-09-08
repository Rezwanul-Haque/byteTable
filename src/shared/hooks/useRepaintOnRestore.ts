import { useEffect } from "react";

// WebKitGTK (Linux) sometimes fails to repaint content layers when the window is
// restored from minimize / occlusion, leaving stale pixels — e.g. ghost cells
// from another tab painted under the data grid. Hovering a cell repaints that
// region, which confirms the DOM is correct and only the rasterized layer is
// stale. Force a full-document repaint by toggling the root's display (a reflow
// while hidden discards the stale raster). Gated to Linux so macOS/Windows never
// pay the reflow.
//
// Trigger on `visibilitychange`→visible ONLY, not on bare window `focus`. The
// raster is only discarded when the surface stops being painted (minimize / full
// occlusion), and those transitions fire `visibilitychange`. A plain refocus that
// never hid the webview keeps its raster intact, so repainting there is wasted
// work — and it was the source of a full-app repaint flash on every focus.
export function useRepaintOnRestore() {
  useEffect(() => {
    if (!navigator.userAgent.includes("Linux")) return;
    const repaint = () => {
      const root = document.getElementById("root") ?? document.body;
      if (!root) return;
      const prev = root.style.display;
      root.style.display = "none";
      void root.offsetHeight; // force a reflow while hidden, discarding stale paint
      root.style.display = prev;
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") repaint();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);
}
