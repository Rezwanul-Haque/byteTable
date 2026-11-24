// The workspace sidebar's collapsed state. `body.bt-sidebar-collapsed` drops
// the sidebar column to 0 (App.css) and leaves the SidebarResizer seam as the
// edge you drag or click to bring it back. ⌘B and View → Toggle Sidebar flip
// it too. One app-wide flag, persisted to localStorage — not per workspace.

import { useSyncExternalStore } from "react";

const STORAGE_KEY = "bytetable.sidebar.collapsed";
const CLASS = "bt-sidebar-collapsed";

const listeners = new Set<() => void>();

export function isSidebarCollapsed(): boolean {
  return document.body.classList.contains(CLASS);
}

export function setSidebarCollapsed(collapsed: boolean): void {
  if (collapsed === isSidebarCollapsed()) return;
  document.body.classList.toggle(CLASS, collapsed);
  try {
    if (collapsed) localStorage.setItem(STORAGE_KEY, "1");
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore persistence failure — the live state still applies */
  }
  listeners.forEach((fn) => fn());
}

export function toggleSidebar(): void {
  setSidebarCollapsed(!isSidebarCollapsed());
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Re-renders the caller whenever the sidebar collapses or opens. */
export function useSidebarCollapsed(): boolean {
  return useSyncExternalStore(subscribe, isSidebarCollapsed);
}

// Restore at module load so the sidebar opens in the user's last state.
try {
  if (localStorage.getItem(STORAGE_KEY) === "1") document.body.classList.add(CLASS);
} catch {
  /* storage unavailable — start expanded */
}

// ⌘B / Ctrl+B — one window-level listener for the whole app (the VS Code
// convention). Only acts while a workspace seam is on screen, so it stays out
// of the connect screen's way.
window.addEventListener("keydown", (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
  if (e.key.toLowerCase() !== "b") return;
  if (!document.querySelector(".workspace .sidebar-resizer")) return;
  e.preventDefault();
  toggleSidebar();
});
