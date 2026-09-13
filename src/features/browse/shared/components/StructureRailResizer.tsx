// Draggable splitter for the Structure tab's right rail (indexes / foreign keys
// / referenced-by / DDL), mirroring the workspace sidebar's resizer: the rail's
// width is a CSS var, one handle drives it, the size persists to localStorage
// and is re-applied before paint, and a double-click restores the default.
//
// The var lives on :root rather than on the pane, so every engine's structure
// view reads the same width — the rail is one idea in one place, and resizing
// it in the SQL view should not leave Cassandra's at a different size.

import { useEffect, type MouseEvent as ReactMouseEvent } from "react";

import { useT } from "../../../../shared/i18n/useT";

const STORAGE_KEY = "bytetable.structureRail.w";
const CSS_VAR = "--struct-rail-w";
const DEFAULT_WIDTH = 348;
const MIN_WIDTH = 240;
const MAX_WIDTH = 760;

/** Apply the saved rail width to :root (no-op when nothing is saved). */
function applySavedWidth(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) document.documentElement.style.setProperty(CSS_VAR, raw);
  } catch {
    /* storage unavailable — fall back to the CSS default */
  }
}

// Apply once at module load so the rail opens at the user's size.
applySavedWidth();

export function StructureRailResizer() {
  const t = useT();
  useEffect(applySavedWidth, []);

  const onMouseDown = (e: ReactMouseEvent) => {
    e.preventDefault();
    const root = document.documentElement;
    const startX = e.clientX;
    const startW = parseFloat(getComputedStyle(root).getPropertyValue(CSS_VAR)) || DEFAULT_WIDTH;
    // The rail is the trailing pane, so dragging toward it (right, in LTR)
    // narrows it — the delta is inverted. An RTL locale mirrors the grid, which
    // flips it back.
    const rtl = document.body.classList.contains("bt-rtl");

    const onMove = (ev: globalThis.MouseEvent) => {
      const dx = (ev.clientX - startX) * (rtl ? 1 : -1);
      const w = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startW + dx));
      root.style.setProperty(CSS_VAR, w + "px");
    };

    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.classList.remove("col-resizing");
      try {
        localStorage.setItem(STORAGE_KEY, getComputedStyle(root).getPropertyValue(CSS_VAR).trim());
      } catch {
        /* ignore persistence failure — the live width still applies */
      }
    };

    document.body.classList.add("col-resizing");
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  /** Double-click restores the default width. */
  const onDoubleClick = () => {
    document.documentElement.style.removeProperty(CSS_VAR);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  };

  return (
    <div
      className="structure-rail-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={t("stv.railAria")}
      title={t("stv.railResizeHint")}
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
    />
  );
}
