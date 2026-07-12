// Per-workspace tab state for the MongoDB workspace (M18), keyed by workspace
// id. The App renders only the ACTIVE workspace, so MongoWorkspace unmounts on
// every workspace switch — local `useState` tabs would be lost. The SQL shell
// keeps its tabs in the workspaces store (`workspace.ui`); the Mongo workspace
// keeps the equivalent here so open tabs, the active tab, and the selected
// database survive switching workspaces (and only drop when the workspace is
// closed). Per-tab editing state (filter/projection/sort/stages) lives inside
// the tab objects, so it persists with them.

import { create } from "zustand";

import type { MongoTab } from "./components/MongoCollectionTab";
import type { MongoPipelineTabState } from "./components/MongoPipelineTab";

export type MongoWorkspaceTab =
  | { id: string; kind: "dashboard"; title: string }
  | { id: string; kind: "map"; title: string }
  | MongoTab
  | MongoPipelineTabState;

export interface MongoTabsState {
  /** Selected database (sidebar selector). */
  db: string;
  tabs: MongoWorkspaceTab[];
  activeId: string;
}

function initialState(): MongoTabsState {
  return {
    db: "",
    tabs: [{ id: "mg-dash", kind: "dashboard", title: "Dashboard" }],
    activeId: "mg-dash",
  };
}

interface Store {
  byWorkspace: Record<string, MongoTabsState>;
  /** Seed a workspace's tab state once (no-op if it already exists). */
  ensure: (workspaceId: string) => void;
  /** Patch a workspace's tab state. */
  patch: (workspaceId: string, patch: Partial<MongoTabsState>) => void;
  /** Drop a workspace's tab state (called when the workspace is closed). */
  prune: (workspaceId: string) => void;
}

export const useMongoTabsStore = create<Store>((set) => ({
  byWorkspace: {},
  ensure: (id) =>
    set((s) =>
      s.byWorkspace[id] ? s : { byWorkspace: { ...s.byWorkspace, [id]: initialState() } },
    ),
  patch: (id, patch) =>
    set((s) => {
      const cur = s.byWorkspace[id] ?? initialState();
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
