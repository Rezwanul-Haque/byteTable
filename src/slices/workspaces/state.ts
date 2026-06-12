// Zustand store for the workspaces slice — ported from the prototype's
// app.jsx workspace state (addWorkspace / editWorkspace / closeWorkspace).
// UI-only milestone: no backend involvement; opening a workspace is purely a
// renderer-state change.

import { create } from "zustand";

import type { Connection, Workspace } from "./types";

/**
 * The 8-color workspace palette — prototype data.js `workspaceColors`,
 * normative per spec §1 (--ws-1 … --ws-8 in tokens.css).
 */
export const WORKSPACE_COLORS = [
  "#2dd4a7",
  "#5aa7f5",
  "#b08cff",
  "#f5b54a",
  "#e06c75",
  "#ef7fb1",
  "#8fce5a",
  "#8b93a3",
] as const;

interface WorkspacesSliceState {
  workspaces: Workspace[];
  /** null → no active workspace → the connect screen is shown. */
  activeWorkspaceId: string | null;
  /**
   * Internal: monotonic palette cursor. Matches the prototype's app.jsx
   * `colorIdx` ref — it only ever increments (cycling mod 8) and is never
   * rewound when a workspace closes.
   */
  colorCursor: number;
  /** Create a workspace from a connection (named after it) and activate it. */
  openWorkspace: (connection: Connection) => void;
  /**
   * Close a workspace. If it was active, the left neighbour becomes active
   * (prototype behavior); closing the last one sets activeWorkspaceId to
   * null, which routes back to the connect screen.
   */
  closeWorkspace: (id: string) => void;
  setActive: (id: string) => void;
  renameWorkspace: (id: string, name: string) => void;
  recolorWorkspace: (id: string, color: string) => void;
}

function patchWorkspace(
  workspaces: Workspace[],
  id: string,
  patch: Partial<Pick<Workspace, "name" | "color">>,
): Workspace[] {
  return workspaces.map((ws) => (ws.id === id ? { ...ws, ...patch } : ws));
}

export const useWorkspacesStore = create<WorkspacesSliceState>((set) => ({
  workspaces: [],
  activeWorkspaceId: null,
  colorCursor: 0,

  openWorkspace: (connection) =>
    set((state) => {
      const workspace: Workspace = {
        id: "ws-" + crypto.randomUUID(),
        connection,
        name: connection.name,
        // The modulo is always in range; the ?? fallback only satisfies
        // noUncheckedIndexedAccess.
        color: WORKSPACE_COLORS[state.colorCursor % WORKSPACE_COLORS.length] ?? WORKSPACE_COLORS[0],
        ui: {},
      };
      return {
        workspaces: [...state.workspaces, workspace],
        activeWorkspaceId: workspace.id,
        colorCursor: state.colorCursor + 1,
      };
    }),

  closeWorkspace: (id) =>
    set((state) => {
      const idx = state.workspaces.findIndex((ws) => ws.id === id);
      if (idx === -1) return state;
      const workspaces = state.workspaces.filter((ws) => ws.id !== id);
      let activeWorkspaceId = state.activeWorkspaceId;
      if (activeWorkspaceId === id) {
        const neighbour = workspaces[Math.max(0, idx - 1)];
        activeWorkspaceId = neighbour ? neighbour.id : null;
      }
      return { workspaces, activeWorkspaceId };
    }),

  setActive: (id) =>
    set((state) =>
      // Guard the invariant that activeWorkspaceId always references an
      // existing workspace (or is null).
      state.workspaces.some((ws) => ws.id === id) ? { activeWorkspaceId: id } : state,
    ),

  renameWorkspace: (id, name) =>
    set((state) => ({ workspaces: patchWorkspace(state.workspaces, id, { name }) })),

  recolorWorkspace: (id, color) =>
    set((state) => ({ workspaces: patchWorkspace(state.workspaces, id, { color }) })),
}));
