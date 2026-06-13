// Docked console panel store (M14) — per-workspace console state, keyed by
// workspace id. Separate from the workspaces slice on purpose: the panel is a
// shared composition point (ARCHITECTURE §11) used by BOTH the SQL workspace
// (WorkspaceShell) and the Redis workspace (Task 2, RedisWorkspace), so its
// state must not live inside either engine's slice. Keeping it here also keeps
// the workspaces `ui` shape unchanged.
//
// PER-WORKSPACE BINDING. Every action takes a `workspaceId`; callers pass the
// ACTIVE workspace's id. State is a `Record<workspaceId, ConsoleState>`, so
// switching workspaces shows that workspace's own console (open/closed, height,
// history, log) and switching back restores it for free — exactly the
// WorkspaceUiState rule, but in a slice-neutral store. A workspace's entry is
// created lazily on first toggle/open and pruned when the workspace closes
// (a subscription on the workspaces store, mirroring state.ts's sqlCounters).

import { create } from "zustand";

import type { QueryResult } from "../../shared/api/engine";
import { useWorkspacesStore } from "../workspaces/state";

/** Per-workspace command-history cap (spec §3 "capped"; matches the M13 cli). */
export const CONSOLE_HISTORY_MAX = 50;

/** Min panel height in px (spec §3 "min height ~120px"). */
export const CONSOLE_MIN_HEIGHT = 120;

/** Default panel height as a fraction of content height (spec §3 "~33%"). */
export const CONSOLE_DEFAULT_FRACTION = 0.33;

/** Max panel height as a fraction of content height (clamp). */
export const CONSOLE_MAX_FRACTION = 0.7;

/**
 * One echoed command + its outcome in the console log. The shape covers SQL
 * (this task) — `result` carries a row-returning QueryResult for the inline
 * grid; `error` carries a §5 message; both null on a non-row "Query OK".
 * Redis (Task 2) reuses the same envelope with its own status text.
 */
export interface ConsoleEntry {
  /** Monotonic id for React keys (commands can repeat verbatim). */
  id: string;
  /** The echoed command text (without the prompt prefix). */
  command: string;
  /** Outcome category — drives the status-line color/icon. */
  status: "ok" | "error";
  /**
   * A row-returning QueryResult to render as a compact inline grid. Absent for
   * non-SELECT / "Query OK" runs and for errors.
   */
  result?: QueryResult;
  /** The §5 error message when `status === "error"`. */
  error?: string;
  /**
   * The schema the command ran against (SQL), shown in the status line. Absent
   * for engines/contexts without one.
   */
  schema?: string;
}

/** One workspace's console state. */
export interface ConsoleState {
  open: boolean;
  /** Panel height in px; 0 = "use the default fraction on next open". */
  height: number;
  /** Command history, newest-first, capped at CONSOLE_HISTORY_MAX. */
  history: string[];
  /** The scrolling output log, oldest-first. */
  log: ConsoleEntry[];
}

const EMPTY: ConsoleState = { open: false, height: 0, history: [], log: [] };

interface ConsoleFeatureState {
  /** Per-workspace console state, keyed by workspace id. */
  byWorkspace: Record<string, ConsoleState>;
  /** Toggle the panel open/closed for a workspace. */
  togglePanel: (workspaceId: string) => void;
  /** Open the panel (idempotent) — used by the toggle button + ⌃`. */
  openPanel: (workspaceId: string) => void;
  /** Close the panel (the header × ). */
  closePanel: (workspaceId: string) => void;
  /** Persist a dragged/clamped height for a workspace. */
  setHeight: (workspaceId: string, height: number) => void;
  /** Push a command onto a workspace's history (deduped at head, capped). */
  pushHistory: (workspaceId: string, command: string) => void;
  /** Append an entry to a workspace's output log. */
  pushEntry: (workspaceId: string, entry: ConsoleEntry) => void;
  /** Clear a workspace's output log (the header clear button / Ctrl+L). */
  clearLog: (workspaceId: string) => void;
}

/** Read-or-default a workspace's console state (never mutates). */
export function selectConsole(state: ConsoleFeatureState, workspaceId: string): ConsoleState {
  return state.byWorkspace[workspaceId] ?? EMPTY;
}

/** Apply a patch to one workspace's console state, creating it lazily. */
function patch(
  state: ConsoleFeatureState,
  workspaceId: string,
  update: (cur: ConsoleState) => Partial<ConsoleState>,
): Pick<ConsoleFeatureState, "byWorkspace"> {
  const cur = state.byWorkspace[workspaceId] ?? EMPTY;
  return {
    byWorkspace: { ...state.byWorkspace, [workspaceId]: { ...cur, ...update(cur) } },
  };
}

export const useConsoleStore = create<ConsoleFeatureState>((set) => ({
  byWorkspace: {},

  togglePanel: (workspaceId) =>
    set((state) => patch(state, workspaceId, (cur) => ({ open: !cur.open }))),

  openPanel: (workspaceId) => set((state) => patch(state, workspaceId, () => ({ open: true }))),

  closePanel: (workspaceId) => set((state) => patch(state, workspaceId, () => ({ open: false }))),

  setHeight: (workspaceId, height) => set((state) => patch(state, workspaceId, () => ({ height }))),

  pushHistory: (workspaceId, command) =>
    set((state) =>
      patch(state, workspaceId, (cur) => ({
        history: [command, ...cur.history.filter((h) => h !== command)].slice(
          0,
          CONSOLE_HISTORY_MAX,
        ),
      })),
    ),

  pushEntry: (workspaceId, entry) =>
    set((state) => patch(state, workspaceId, (cur) => ({ log: [...cur.log, entry] }))),

  clearLog: (workspaceId) => set((state) => patch(state, workspaceId, () => ({ log: [] }))),
}));

// Prune console state for workspaces that no longer exist — mirrors the
// sqlCounters subscription in the workspaces slice. Cheap (workspace count is
// tiny) and keeps the actions pure.
useWorkspacesStore.subscribe((ws) => {
  const live = new Set(ws.workspaces.map((w) => w.id));
  const cur = useConsoleStore.getState().byWorkspace;
  const stale = Object.keys(cur).filter((id) => !live.has(id));
  if (stale.length === 0) return;
  const next = { ...cur };
  for (const id of stale) delete next[id];
  useConsoleStore.setState({ byWorkspace: next });
});
