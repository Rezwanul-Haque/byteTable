// mongosh scrollback store (M18). Persists each docked-panel session's REPL
// transcript (lines), command history, and current database, keyed by the
// TerminalPanel session id — so the scrollback survives hiding the panel and
// switching workspaces, exactly like the SQL/Redis terminals (which persist via
// the console `TermSession`). MongoDB's lines are richer than the shared
// `TermLine` (json + object-table variants), so they live in their own store
// rather than the typed console session.

import { create } from "zustand";

import type { MongoDoc } from "./api";

/** One rendered line of the mongosh transcript. */
export type ShellLine =
  | { kind: "text"; cls: string; text: string }
  | { kind: "json"; text: string }
  | { kind: "table"; rows: MongoDoc[]; cols: string[] };

interface ShellSession {
  lines: ShellLine[];
  history: string[];
  curDb: string;
}

interface MongoShellStore {
  sessions: Record<string, ShellSession>;
  /** Seed a session's initial state once (banner + starting db); no-op if it
   *  already exists, so reopening the panel restores the prior transcript. */
  ensure: (id: string, initial: ShellSession) => void;
  /** Patch one session's state (lines/history/curDb). */
  patch: (id: string, patch: Partial<ShellSession>) => void;
  /** Drop the given sessions (a closed workspace's mongosh sessions). */
  pruneSessions: (ids: string[]) => void;
}

export const useMongoShellStore = create<MongoShellStore>((set) => ({
  sessions: {},
  ensure: (id, initial) =>
    set((s) => (s.sessions[id] ? s : { sessions: { ...s.sessions, [id]: initial } })),
  patch: (id, patch) =>
    set((s) => {
      const cur = s.sessions[id];
      if (!cur) return s;
      return { sessions: { ...s.sessions, [id]: { ...cur, ...patch } } };
    }),
  pruneSessions: (ids) =>
    set((s) => {
      if (!ids.some((id) => s.sessions[id])) return s;
      const next = { ...s.sessions };
      for (const id of ids) delete next[id];
      return { sessions: next };
    }),
}));

interface ActiveDbStore {
  /** The currently-selected database per workspace (the sidebar selector). */
  byWorkspace: Record<string, string>;
  setDb: (workspaceId: string, db: string) => void;
  /** Drop a workspace's selection (called when the workspace is closed). */
  prune: (workspaceId: string) => void;
}

/** The sidebar's selected database, shared so the docked mongosh session can
 *  seed its prompt with the database the user actually picked (the
 *  TerminalPanel renders the session generically and otherwise can't see the
 *  Mongo workspace's local db state). */
export const useMongoActiveDbStore = create<ActiveDbStore>((set) => ({
  byWorkspace: {},
  setDb: (workspaceId, db) =>
    set((s) => ({ byWorkspace: { ...s.byWorkspace, [workspaceId]: db } })),
  prune: (workspaceId) =>
    set((s) => {
      if (!(workspaceId in s.byWorkspace)) return s;
      const next = { ...s.byWorkspace };
      delete next[workspaceId];
      return { byWorkspace: next };
    }),
}));
