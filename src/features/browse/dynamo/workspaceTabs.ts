// Per-workspace tab state for the DynamoDB workspace (M17), keyed by workspace
// id. The App renders only the ACTIVE workspace, so DynamoWorkspace unmounts on
// every workspace switch — local `useState` tabs would be lost (the SQL shell
// keeps its tabs in the workspaces store). Persist them here so open tabs + the
// active tab survive switching workspaces and only drop when the workspace is
// closed.

import { create } from "zustand";

export interface DynamoWorkspaceTab {
  id: string;
  kind: "dashboard" | "table" | "map" | "query";
  title: string;
  table?: string;
  mode?: "scan" | "query" | "structure";
}

/**
 * Titles for the whole strip, in tab order. "Open in new tab" puts the same
 * table on the strip twice, which would render two identical titles; repeats are
 * numbered (`ShopApp`, `ShopApp (2)`) and anything unique is left untouched.
 * Mirrors the SQL shell's `tabLabels`.
 */
export function dynamoTabTitles(tabs: DynamoWorkspaceTab[]): string[] {
  const seen = new Map<string, number>();
  return tabs.map((tab) => {
    const nth = (seen.get(tab.title) ?? 0) + 1;
    seen.set(tab.title, nth);
    return nth > 1 ? tab.title + " (" + nth + ")" : tab.title;
  });
}

export interface DynamoTabsState {
  tabs: DynamoWorkspaceTab[];
  activeId: string;
}

function initialState(): DynamoTabsState {
  return {
    tabs: [{ id: "ddb-dash", kind: "dashboard", title: "Dashboard" }],
    activeId: "ddb-dash",
  };
}

interface Store {
  byWorkspace: Record<string, DynamoTabsState>;
  ensure: (workspaceId: string) => void;
  patch: (workspaceId: string, patch: Partial<DynamoTabsState>) => void;
  /** Drop a workspace's tab state (called when the workspace is closed). */
  prune: (workspaceId: string) => void;
}

export const useDynamoTabsStore = create<Store>((set) => ({
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
