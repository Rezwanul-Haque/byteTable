// Cross-window settings sync (M20.6, desktop only). When settings change in
// one window, broadcast a Tauri event so every other window re-applies them.
// All calls are guarded: outside Tauri (plain browser dev) emit/listen reject
// and we simply no-op, leaving localStorage as the single-window path.

import type { Settings } from "./api";

const EVENT = "settings-changed";

/** Broadcast changed settings to all windows. Best-effort; no-op off-desktop. */
export function broadcastSettings(settings: Settings): void {
  void import("@tauri-apps/api/event")
    .then(({ emit }) => emit(EVENT, settings))
    .catch(() => {
      /* not running inside Tauri, or no permission — single-window path */
    });
}

/** Subscribe to settings broadcasts from other windows. Returns an unsubscribe
 *  function. No-op (returns a noop unsubscribe) outside Tauri. */
export function subscribeSettings(onChange: (settings: Settings) => void): () => void {
  let unlisten: (() => void) | null = null;
  let cancelled = false;
  void import("@tauri-apps/api/event")
    .then(({ listen }) => listen<Settings>(EVENT, (event) => onChange(event.payload)))
    .then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    })
    .catch(() => {
      /* not running inside Tauri — nothing to subscribe to */
    });
  return () => {
    cancelled = true;
    unlisten?.();
  };
}
