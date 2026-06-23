// Draggable splitter that resizes the workspace sidebar. Every engine
// workspace (.workspace grid) reads its first column from --sidebar-w, so a
// single resizer + a CSS var resizes them all. Width persists to localStorage
// and is re-applied before paint. Double-click resets to the default.

import { useEffect, type MouseEvent as ReactMouseEvent } from "react";

import "./SidebarResizer.css";

const STORAGE_KEY = "bytetable.sidebar.w";
const MIN_WIDTH = 180;
const MAX_WIDTH = 520;

/** Apply the saved sidebar width to :root (no-op when nothing is saved). */
function applySavedWidth(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) document.documentElement.style.setProperty("--sidebar-w", raw);
  } catch {
    /* storage unavailable — fall back to the CSS default */
  }
}

// Apply once at module load so the sidebar opens at the user's size.
applySavedWidth();

export function SidebarResizer() {
  useEffect(applySavedWidth, []);

  const onMouseDown = (e: ReactMouseEvent) => {
    e.preventDefault();
    const root = document.documentElement;
    const startX = e.clientX;
    const startW = parseFloat(getComputedStyle(root).getPropertyValue("--sidebar-w")) || 248;

    const onMove = (ev: globalThis.MouseEvent) => {
      const w = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startW + (ev.clientX - startX)));
      root.style.setProperty("--sidebar-w", w + "px");
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.classList.remove("col-resizing");
      try {
        localStorage.setItem(
          STORAGE_KEY,
          getComputedStyle(root).getPropertyValue("--sidebar-w").trim(),
        );
      } catch {
        /* ignore persistence failure — the live width still applies */
      }
    };

    document.body.classList.add("col-resizing");
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // Double-click restores the default width.
  const onDoubleClick = () => {
    document.documentElement.style.removeProperty("--sidebar-w");
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  };

  return (
    <div
      className="sidebar-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      title="Drag to resize · double-click to reset"
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
    />
  );
}
