import { useEffect } from "react";

// WebKitGTK (Linux) sometimes fails to repaint content layers when the window is
// restored / refocused from another app, leaving stale pixels — e.g. ghost cells
// from another tab painted under the data grid. Hovering a cell repaints that
// region, which confirms the DOM is correct and only the rasterized layer is
// stale. Force a full-document repaint on focus / visibility-restore by toggling
// the root's display (a reflow while hidden discards the stale raster). Gated to
// Linux so macOS/Windows never pay the (tiny) reflow on every focus.
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
    const onFocus = () => repaint();
    const onVisible = () => {
      if (document.visibilityState === "visible") repaint();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
}
