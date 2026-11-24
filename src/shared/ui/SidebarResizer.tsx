// Draggable splitter that resizes the workspace sidebar. Every engine
// workspace (.workspace grid) reads its first column from --sidebar-w, so a
// single resizer + a CSS var resizes them all. Width persists to localStorage
// and is re-applied before paint. Double-click resets to the default.
//
// Collapsed (sidebarCollapse.ts), the seam sits on the window edge: drag it out
// past SNAP, double-click it, or click its tab to bring the sidebar back.

import { useEffect, type MouseEvent as ReactMouseEvent } from "react";

import { useT } from "../i18n/useT";
import { isSidebarCollapsed, setSidebarCollapsed, useSidebarCollapsed } from "./sidebarCollapse";
import "./SidebarResizer.css";

const STORAGE_KEY = "bytetable.sidebar.w";
const MIN_WIDTH = 180;
const MAX_WIDTH = 520;
// Dragging the seam this far below MIN_WIDTH snaps the sidebar shut; dragging
// a collapsed edge this far out opens it again (at MIN_WIDTH or wider).
const SNAP = 60;

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
  const t = useT();
  const collapsed = useSidebarCollapsed();
  useEffect(applySavedWidth, []);

  const onMouseDown = (e: ReactMouseEvent) => {
    e.preventDefault();
    const root = document.documentElement;
    const startX = e.clientX;
    const startCollapsed = isSidebarCollapsed();
    const startW = startCollapsed
      ? 0
      : parseFloat(getComputedStyle(root).getPropertyValue("--sidebar-w")) || 248;
    // When the sidebar sits on the right, dragging left (negative dx) widens
    // it, so the delta sign flips. An RTL locale mirrors the grid and flips it
    // again — the two cancel out, hence the XOR.
    const rightSide =
      document.body.classList.contains("bt-sidebar-right") !==
      document.body.classList.contains("bt-rtl");

    const onMove = (ev: globalThis.MouseEvent) => {
      const dx = (ev.clientX - startX) * (rightSide ? -1 : 1);
      const raw = startW + dx;
      if (raw < MIN_WIDTH - SNAP || (startCollapsed && raw < SNAP)) {
        setSidebarCollapsed(true);
        return;
      }
      setSidebarCollapsed(false);
      const w = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, raw));
      root.style.setProperty("--sidebar-w", w + "px");
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.classList.remove("col-resizing");
      // A collapsed drop keeps the last open width for when it comes back.
      if (isSidebarCollapsed()) return;
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

  // Double-click restores the default width (and opens a collapsed sidebar).
  const onDoubleClick = () => {
    setSidebarCollapsed(false);
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
      aria-label={t("uix.resize.aria")}
      title={collapsed ? t("uix.resize.collapsedHint") : t("uix.resize.hint")}
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
    >
      {collapsed ? (
        <button
          type="button"
          className="sidebar-expand"
          aria-label={t("uix.resize.expand")}
          title={t("uix.resize.expand") + " (⌘B)"}
          // Keep the seam's drag handler from seeing this click.
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => setSidebarCollapsed(false)}
        >
          <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true">
            <path
              d="M4.5 2.5 8 6l-3.5 3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      ) : null}
    </div>
  );
}
