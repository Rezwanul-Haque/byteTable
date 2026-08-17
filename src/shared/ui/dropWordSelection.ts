// Undo WebKit's right-click word selection when opening a custom context menu.
//
// WHY: on a right-button press WebKit selects the word under the cursor, and it
// does so BEFORE `contextmenu` fires — so `preventDefault()` in the menu's
// handler is already too late, and `user-select: none` on the row does not stop
// it either (that only governs drag/double-click selection). The result is a
// tab label or table name left highlighted behind the menu. Chromium does not
// do this, so it only shows up in the Tauri/WKWebView build.
//
// Every custom menu in the app opens over text — tab strips, sidebar rows, the
// rail, connection cards — so the fix lives here rather than being re-derived
// at each call site.

/**
 * Collapse a selection WebKit just made inside `owner` (the element the menu
 * opened on). A selection anywhere ELSE is the user's and is left alone — a
 * right-click on a tab should not wipe text they highlighted in the grid.
 */
export function dropWordSelection(owner: Element | null | undefined): void {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return;
  if (owner && !owner.contains(selection.anchorNode)) return;
  selection.removeAllRanges();
}
