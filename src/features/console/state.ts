// Docked terminal panel store (M14) — per-workspace, VS Code-style multi-session
// terminal panel state, keyed by workspace id. Separate from the workspaces
// slice on purpose: the panel is a shared composition point (ARCHITECTURE §11)
// used by BOTH the SQL workspace (WorkspaceShell) and the Redis workspace
// (RedisWorkspace), so its state must not live inside either engine's slice.
//
// PER-WORKSPACE BINDING. Every action takes a `workspaceId`; callers pass the
// ACTIVE workspace's id. State is a `Record<workspaceId, PanelState>`, so
// switching workspaces shows that workspace's own panel (open/closed, height,
// maximized, sessions + which one is active) and switching back restores it for
// free — the WorkspaceUiState rule, in a slice-neutral store. A workspace's
// entry is created lazily on first toggle/open and pruned when the workspace
// closes (a subscription on the workspaces store, mirroring sqlCounters).
//
// AUTHORITATIVE PROTOTYPE: ByteTable_latest/bytetable/terminal.jsx
// `TerminalPanel` (the multi-session chrome) + `SqlTerminalTab` (the REPL). The
// prototype keeps each session's REPL state (lines/history/buffer/timing) on a
// `tab` object lifted into the parent; this store is that lift, per workspace.

import { useEffect } from "react";
import { create } from "zustand";

import type { CellValue } from "../../shared/api/engine";

import type { Engine } from "../../shared/types";
import { useWorkspacesStore } from "../workspaces/state";

/**
 * Shell program name for a session title / banner, per engine. Matches the
 * prototype's `termConfig(engine).shell` (`psql`/`mysql`/`sqlite3`). Redis
 * (the next task) will add `redis-cli`. Kept here so the slice-neutral store
 * and the engine-agnostic chrome (WorkspaceShell, palettes) can seed session
 * titles without importing the SQL REPL component.
 */
export function shellLabel(engine: Engine): string {
  switch (engine) {
    case "mysql":
      return "mysql";
    case "mssql":
      return "sqlcmd";
    case "sqlite":
      return "sqlite3";
    case "redis":
      return "redis-cli";
    case "dynamodb":
      return "partiql";
    case "mongodb":
      return "mongosh";
    case "cassandra":
      return "cqlsh";
    case "clickhouse":
      return "clickhouse-client";
    // Typesense has no REPL — its console speaks raw HTTP against the search
    // API, so the session is titled for the protocol rather than a CLI binary.
    case "typesense":
      return "http";
    case "postgres":
    default:
      return "psql";
  }
}

/** Per-session command-history cap (prototype: `.slice(0, 80)`). */
export const TERM_HISTORY_MAX = 80;

/** Min panel height in px (prototype clamp lower bound). */
export const TERM_MIN_HEIGHT = 120;

/** Default panel height in px on first open (≈ a third of a tall window). */
export const TERM_DEFAULT_HEIGHT = 280;

/** Reserved chrome height the resize clamp keeps above the panel (prototype:
 *  `window.innerHeight - 160`). */
export const TERM_RESERVED_HEIGHT = 160;

/**
 * One rendered line of a session's REPL transcript.
 *
 * A TEXT line: `cls` is the CSS class that colors it like the engine shell
 * (`term-info`/`term-err`/`term-prompt`/`term-thead`/`term-rule`/`term-row`/
 * `term-meta`/`term-help`), `text` is the already-formatted line. Mirrors the
 * prototype's `{ cls, text }` line objects.
 *
 * A GRID line (`kind: "grid"`): a SELECT result rendered as a real HTML table
 * (M-terminal-table) instead of ASCII art — `columns` are the header names and
 * `rows` the positional cell values. Numbers right-align, NULLs italicize.
 */
export interface TermTextLine {
  cls: string;
  text: string;
}

export interface TermGridLine {
  kind: "grid";
  columns: string[];
  rows: CellValue[][];
}

export type TermLine = TermTextLine | TermGridLine;

/**
 * One terminal session inside a workspace's panel. The prototype's per-tab REPL
 * state, lifted here so it survives workspace switches + panel hide:
 * - `lines` — the scrolling transcript (banner + echoes + results).
 * - `history` — submitted lines, newest-first, capped at TERM_HISTORY_MAX.
 * - `buffer` — accumulated multi-line SQL until a `;` terminates it.
 * - `timing` — local `\timing` toggle (append "Time: N ms" after results).
 */
export interface TermSession {
  id: string;
  title: string;
  lines: TermLine[];
  history: string[];
  buffer: string;
  timing: boolean;
  /** Text handed to this session's prompt line from outside (the assistant's
   *  "Use in terminal"): the shell puts it on its input and clears this. Never
   *  run — the user presses Enter. `nonce` makes the same text twice count. */
  pendingInput?: { text: string; nonce: number };
}

/** One workspace's terminal-panel state. */
export interface PanelState {
  open: boolean;
  /** Full content-area height when true (prototype `.maximized`). */
  maximized: boolean;
  /** Panel height in px; 0 = "use TERM_DEFAULT_HEIGHT on next open". */
  height: number;
  /** Terminal sessions, left-to-right (tab order). */
  sessions: TermSession[];
  /** The visible session's id, or null when there are no sessions. */
  activeSessionId: string | null;
}

const EMPTY: PanelState = {
  open: false,
  maximized: false,
  height: 0,
  sessions: [],
  activeSessionId: null,
};

interface PanelFeatureState {
  /** Per-workspace panel state, keyed by workspace id. */
  byWorkspace: Record<string, PanelState>;
  /**
   * Toggle the panel for a workspace. Opening with no sessions seeds the first
   * one (`{shellLabel} 1`) — matches the task's "toggle opens panel + creates
   * the first session if none".
   */
  togglePanel: (workspaceId: string, shellLabel: string) => void;
  /** Open the panel (idempotent), seeding a first session if none exist. */
  openPanel: (workspaceId: string, shellLabel: string) => void;
  /** Hide the panel (the header ⌄ / Ctrl+`). Sessions are kept. */
  closePanel: (workspaceId: string) => void;
  /** Toggle the maximize (full content-area height) state. */
  toggleMax: (workspaceId: string) => void;
  /** Persist a dragged/clamped height (also clears `maximized`). */
  setHeight: (workspaceId: string, height: number) => void;
  /** Append a new session (`{shellLabel} N`) and make it active. */
  newSession: (workspaceId: string, shellLabel: string) => void;
  /** Open the panel and put `text` on the active session's prompt line (it is
   *  not run). Seeds a first session when there is none. */
  injectInput: (workspaceId: string, shellLabel: string, text: string) => void;
  /**
   * Kill a session. If it was the last one the panel hides (matches the
   * prototype: the panel has no empty state — closing the final session leaves
   * nothing to render, so we collapse it; re-opening seeds a fresh session).
   */
  closeSession: (workspaceId: string, sessionId: string) => void;
  /** Make a session active. */
  selectSession: (workspaceId: string, sessionId: string) => void;
  /** Patch one session's REPL state (lines/history/buffer/timing). */
  patchSession: (
    workspaceId: string,
    sessionId: string,
    patch: Partial<Omit<TermSession, "id" | "title">>,
  ) => void;
}

/** Read-or-default a workspace's panel state (never mutates). */
export function selectPanel(state: PanelFeatureState, workspaceId: string): PanelState {
  return state.byWorkspace[workspaceId] ?? EMPTY;
}

/** Apply a patch to one workspace's panel state, creating it lazily. */
function patch(
  state: PanelFeatureState,
  workspaceId: string,
  update: (cur: PanelState) => Partial<PanelState>,
): Pick<PanelFeatureState, "byWorkspace"> {
  const cur = state.byWorkspace[workspaceId] ?? EMPTY;
  return {
    byWorkspace: { ...state.byWorkspace, [workspaceId]: { ...cur, ...update(cur) } },
  };
}

/** Build a fresh session titled `{shellLabel} {n}` (1-based over existing). */
function makeSession(sessions: TermSession[], shellLabel: string): TermSession {
  return {
    id: crypto.randomUUID(),
    title: shellLabel + " " + (sessions.length + 1),
    lines: [],
    history: [],
    buffer: "",
    timing: false,
  };
}

/** Open the panel for `cur`, seeding a first session when there are none. */
function openWith(cur: PanelState, shellLabel: string): Partial<PanelState> {
  if (cur.sessions.length > 0) return { open: true };
  const first = makeSession([], shellLabel);
  return { open: true, sessions: [first], activeSessionId: first.id };
}

export const usePanelStore = create<PanelFeatureState>((set) => ({
  byWorkspace: {},

  togglePanel: (workspaceId, shellLabel) =>
    set((state) =>
      patch(state, workspaceId, (cur) => (cur.open ? { open: false } : openWith(cur, shellLabel))),
    ),

  openPanel: (workspaceId, shellLabel) =>
    set((state) => patch(state, workspaceId, (cur) => openWith(cur, shellLabel))),

  closePanel: (workspaceId) => set((state) => patch(state, workspaceId, () => ({ open: false }))),

  toggleMax: (workspaceId) =>
    set((state) => patch(state, workspaceId, (cur) => ({ maximized: !cur.maximized }))),

  // A drag implies "restore from maximized" (prototype cancels maximize on a
  // resize gesture) and pins an explicit height.
  setHeight: (workspaceId, height) =>
    set((state) => patch(state, workspaceId, () => ({ height, maximized: false }))),

  injectInput: (workspaceId, shellLabel, text) =>
    set((state) =>
      patch(state, workspaceId, (cur) => {
        const opened = { ...cur, ...openWith(cur, shellLabel) };
        const active = opened.activeSessionId ?? opened.sessions[0]?.id ?? null;
        return {
          ...opened,
          activeSessionId: active,
          sessions: opened.sessions.map((s) =>
            s.id === active ? { ...s, pendingInput: { text, nonce: Date.now() } } : s,
          ),
        };
      }),
    ),

  newSession: (workspaceId, shellLabel) =>
    set((state) =>
      patch(state, workspaceId, (cur) => {
        const s = makeSession(cur.sessions, shellLabel);
        return { sessions: [...cur.sessions, s], activeSessionId: s.id, open: true };
      }),
    ),

  closeSession: (workspaceId, sessionId) =>
    set((state) =>
      patch(state, workspaceId, (cur) => {
        const idx = cur.sessions.findIndex((s) => s.id === sessionId);
        if (idx < 0) return {};
        const sessions = cur.sessions.filter((s) => s.id !== sessionId);
        if (sessions.length === 0) {
          // Last session killed: collapse the panel (no empty state).
          return { sessions, activeSessionId: null, open: false };
        }
        // Keep the active session if it survived; else focus the neighbor.
        let activeSessionId = cur.activeSessionId;
        if (activeSessionId === sessionId) {
          const next = sessions[Math.min(idx, sessions.length - 1)] ?? sessions[0];
          activeSessionId = next?.id ?? null;
        }
        return { sessions, activeSessionId };
      }),
    ),

  selectSession: (workspaceId, sessionId) =>
    set((state) => patch(state, workspaceId, () => ({ activeSessionId: sessionId }))),

  patchSession: (workspaceId, sessionId, sessionPatch) =>
    set((state) =>
      patch(state, workspaceId, (cur) => ({
        sessions: cur.sessions.map((s) => (s.id === sessionId ? { ...s, ...sessionPatch } : s)),
      })),
    ),
}));

// Prune panel state for workspaces that no longer exist — mirrors the
// sqlCounters subscription in the workspaces slice. Cheap (workspace count is
// tiny) and keeps the actions pure.
useWorkspacesStore.subscribe((ws) => {
  const live = new Set(ws.workspaces.map((w) => w.id));
  const cur = usePanelStore.getState().byWorkspace;
  const stale = Object.keys(cur).filter((id) => !live.has(id));
  if (stale.length === 0) return;
  const next = { ...cur };
  for (const id of stale) delete next[id];
  usePanelStore.setState({ byWorkspace: next });
});

/**
 * Put a session's handed-in text (`pendingInput`) on its prompt line, once:
 * `apply` receives the text, then the field is cleared. Every shell's body
 * calls this with its own way of setting its input.
 */
export function usePendingInput(
  workspaceId: string,
  session: TermSession,
  apply: (text: string) => void,
): void {
  const patchSession = usePanelStore((s) => s.patchSession);
  const nonce = session.pendingInput?.nonce;
  useEffect(() => {
    const p = session.pendingInput;
    if (!p) return;
    apply(p.text);
    patchSession(workspaceId, session.id, { pendingInput: undefined });
    // Keyed on the nonce: each hand-off applies exactly once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce]);
}

/** Record a submitted command at the top of a panel session's history (newest
 *  first, capped) — for shells that keep their own history too, so every
 *  shell's last command is readable the same way (the assistant explains it). */
export function recordHistory(workspaceId: string, sessionId: string, cmd: string): void {
  const st = usePanelStore.getState();
  const cur = st.byWorkspace[workspaceId]?.sessions.find((x) => x.id === sessionId);
  if (!cur) return;
  st.patchSession(workspaceId, sessionId, {
    history: [cmd, ...cur.history.filter((h) => h !== cmd)].slice(0, TERM_HISTORY_MAX),
  });
}
