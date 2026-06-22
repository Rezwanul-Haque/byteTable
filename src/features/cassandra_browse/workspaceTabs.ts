// Per-workspace tab state for the Cassandra workspace (M19), keyed by workspace
// id. The App renders only the ACTIVE workspace, so CassandraWorkspace unmounts
// on every workspace switch — local `useState` tabs would be lost. Mirroring the
// Mongo workspace, the open tabs, the active tab, and the selected keyspace live
// here so they survive switching workspaces (and only drop when the workspace is
// closed). Per-tab state (table tab mode) lives inside the tab objects.

import { create } from "zustand";

import type { CassTab } from "./components/CassandraWorkspace";

export interface CassTabsState {
  /** Selected keyspace (sidebar selector). */
  ks: string;
  tabs: CassTab[];
  activeId: string;
}

export function initialCassTabs(): CassTabsState {
  return {
    ks: "",
    tabs: [{ id: "cs-dash", kind: "dashboard", title: "Dashboard" }],
    activeId: "cs-dash",
  };
}

interface Store {
  byWorkspace: Record<string, CassTabsState>;
  /** Seed a workspace's tab state once (no-op if it already exists). */
  ensure: (workspaceId: string) => void;
  /** Patch a workspace's tab state. */
  patch: (workspaceId: string, patch: Partial<CassTabsState>) => void;
  /** Drop a workspace's tab state (called when the workspace is closed). */
  prune: (workspaceId: string) => void;
}

export const useCassTabsStore = create<Store>((set) => ({
  byWorkspace: {},
  ensure: (id) =>
    set((s) =>
      s.byWorkspace[id] ? s : { byWorkspace: { ...s.byWorkspace, [id]: initialCassTabs() } },
    ),
  patch: (id, patch) =>
    set((s) => {
      const cur = s.byWorkspace[id] ?? initialCassTabs();
      return { byWorkspace: { ...s.byWorkspace, [id]: { ...cur, ...patch } } };
    }),
  prune: (id) =>
    set((s) => {
      if (!s.byWorkspace[id]) return s;
      const next = { ...s.byWorkspace };
      delete next[id];
      return { byWorkspace: next };
    }),
}));
