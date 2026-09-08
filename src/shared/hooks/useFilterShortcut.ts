// ⌘F / Ctrl+F opens (and focuses) the filter panel of whatever is on screen.
//
// One hook rather than a copy per workspace: the SQL, Cassandra and data-file
// browsers all put a "Filters" toggle in the same place, and the shortcut for it
// should not drift between them.
//
// `enabled` is the whole safety story. The SQL workspace mounts only the active
// tab, but the Cassandra and data-file workspaces keep inactive tabs mounted
// (display:none) to preserve their state — so without a gate every mounted tab
// would register a listener and one keypress would toggle all of them, most
// invisibly. Callers pass "this surface is the visible one, and it has a filter
// panel to open".

import { useEffect, useRef } from "react";

/**
 * Bind ⌘F / Ctrl+F to `toggle` while `enabled`.
 *
 * Plain ⌘F only: Alt or Shift held means a different command (and ⌘⇧F is the
 * editor's format binding), so those pass through untouched. The event is
 * consumed either way — a webview has no native find bar to fall back to, so
 * letting it through would do nothing at all.
 *
 * `toggle` is read from a ref, so a caller may pass a fresh closure each render
 * without the listener being torn down and re-added every time.
 */
export function useFilterShortcut(enabled: boolean, toggle: () => void): void {
  const toggleRef = useRef(toggle);
  // Synced in an effect, not during render: writing a ref while rendering is
  // the anti-pattern react-hooks/refs flags, and after-commit is soon enough —
  // the only reader is a keydown handler, which cannot run mid-render.
  useEffect(() => {
    toggleRef.current = toggle;
  }, [toggle]);

  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "f" && event.key !== "F") return;
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      event.preventDefault();
      toggleRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}
