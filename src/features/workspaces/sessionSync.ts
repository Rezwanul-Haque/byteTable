// Keeps each open workspace's session written to storage (the write half of
// session.ts; `openWorkspace` is the read half).
//
// A store subscription rather than a call in each action: tabs, the focused
// tab, the schema, SQL buffers, filters and sorts are mutated from ~25 places
// in the store, and every one of them lands in the same `workspaces` array. One
// listener catches all of them and cannot be forgotten by the next action added.
//
// Writes are debounced because the SQL editor commits its buffer on every
// keystroke — persisting synchronously there would put a JSON serialize of the
// whole session on the typing path.

import { useSettingsStore } from "../settings/state";
import { clearSessions, writeSession } from "./session";
import { useWorkspacesStore } from "./state";
import type { Workspace } from "./types";

/** Quiet period after the last change before a write. */
const DEBOUNCE_MS = 400;

let timer: ReturnType<typeof setTimeout> | null = null;
let pending: Workspace[] = [];

function flush(): void {
  timer = null;
  if (!useSettingsStore.getState().settings.restoreTabs) return;
  for (const ws of pending) {
    // A workspace with no registry id (an ad-hoc open that was not saved) has
    // nothing stable to key a session by.
    if (ws.saved.id) writeSession(ws.saved.id, ws.ui);
  }
  pending = [];
}

function schedule(workspaces: Workspace[]): void {
  pending = workspaces;
  if (timer !== null) return;
  timer = setTimeout(flush, DEBOUNCE_MS);
}

/**
 * Begin persisting workspace sessions. Call once, at app start; returns a
 * teardown for symmetry (and for tests).
 *
 * Turning the setting off clears what was already stored — a user who does not
 * want their tabs remembered should not find yesterday's SQL still on disk.
 */
export function startSessionPersistence(): () => void {
  let restoreWasOn = useSettingsStore.getState().settings.restoreTabs;

  const unsubscribeWorkspaces = useWorkspacesStore.subscribe((state, previous) => {
    if (state.workspaces === previous.workspaces) return;
    schedule(state.workspaces);
  });

  const unsubscribeSettings = useSettingsStore.subscribe((state) => {
    const on = state.settings.restoreTabs;
    if (restoreWasOn && !on) clearSessions();
    restoreWasOn = on;
  });

  // Last chance to persist a buffer typed in the final 400ms before the window
  // goes away. `beforeunload` fires on reload and on a Tauri window close.
  const onUnload = () => {
    if (timer !== null) {
      clearTimeout(timer);
      flush();
    }
  };
  window.addEventListener("beforeunload", onUnload);

  return () => {
    unsubscribeWorkspaces();
    unsubscribeSettings();
    window.removeEventListener("beforeunload", onUnload);
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
}
