// Shared auto-refresh hook (M20 settings-driven). Calls `refresh` on an
// interval while Settings → Data grid → Auto-refresh is on. Each engine passes
// a callback that reloads ONLY its sidebar object list (tables / collections /
// keyspaces) — not the active data grid — so the refresh never interrupts
// scrolling or in-progress edits. Redis is the exception: it bumps its own
// version (richer keyspace refresh) through this same hook.

import { useEffect, useRef, useState } from "react";

import { useSettingsStore } from "./state";

/** One full rotation of the refresh icon per tick (matches the Redis sync). */
const SPIN_MS = 700;

/**
 * Settings-driven auto-refresh. Calls `refresh` every N seconds while the
 * Auto-refresh setting is on. Returns a `spinning` flag that pulses once per
 * tick so callers can animate their refresh icon (like the Redis sync icon).
 */
export function useAutoRefresh(refresh: () => void): boolean {
  const enabled = useSettingsStore((s) => s.settings.autoRefresh);
  const seconds = useSettingsStore((s) => s.settings.autoRefreshSec);

  // Keep the latest callback in a ref so a new callback identity each render
  // doesn't restart the interval (only the toggle / interval should).
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  const [spinning, setSpinning] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let spinTimer: ReturnType<typeof setTimeout>;
    const id = setInterval(() => {
      // setState here runs from the timer callback (not synchronously in the
      // effect body), so it pulses the icon without a cascading-render lint.
      refreshRef.current();
      setSpinning(true);
      clearTimeout(spinTimer);
      spinTimer = setTimeout(() => setSpinning(false), SPIN_MS);
    }, seconds * 1000);
    return () => {
      clearInterval(id);
      clearTimeout(spinTimer);
    };
  }, [enabled, seconds]);

  return spinning;
}
