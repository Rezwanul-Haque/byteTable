// Per-workspace tab state for the Typesense workspace (M30), keyed by workspace
// id. The App renders only the ACTIVE workspace, so TypesenseWorkspace unmounts
// on every workspace switch — local `useState` tabs would be lost. Mirroring the
// Cassandra/Mongo workspaces, the open tabs, the active tab, and the selected
// collection live here so they survive switching workspaces (and only drop when
// the workspace is closed).
//
// Per-tab search state (query, controls, page) lives inside the `search` tab
// objects, so each collection's playground keeps its own settings.

import { create } from "zustand";

import type { TsTab } from "./components/TypesenseWorkspace";

export interface TsTabsState {
  /** Selected collection (drives the schema / documents / curation singletons). */
  coll: string;
  tabs: TsTab[];
  activeId: string;
}

/** A new workspace opens on the Cluster dashboard (MILESTONE_30 Task 5). */
export function initialTsTabs(): TsTabsState {
  return {
    coll: "",
    tabs: [{ id: "ts-dash", kind: "dashboard", title: "Cluster" }],
    activeId: "ts-dash",
  };
}

interface Store {
  byWorkspace: Record<string, TsTabsState>;
  /** Seed a workspace's tab state once (no-op if it already exists). */
  ensure: (workspaceId: string) => void;
  /** Patch a workspace's tab state. */
  patch: (workspaceId: string, patch: Partial<TsTabsState>) => void;
  /** Drop a workspace's tab state (called when the workspace is closed). */
  prune: (workspaceId: string) => void;
}

export const useTsTabsStore = create<Store>((set) => ({
  byWorkspace: {},
  ensure: (id) =>
    set((s) =>
      s.byWorkspace[id] ? s : { byWorkspace: { ...s.byWorkspace, [id]: initialTsTabs() } },
    ),
  patch: (id, patch) =>
    set((s) => {
      const cur = s.byWorkspace[id] ?? initialTsTabs();
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
