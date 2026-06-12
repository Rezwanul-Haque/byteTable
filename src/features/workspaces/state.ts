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

interface WorkspacesFeatureState {
  workspaces: Workspace[];
  /** null → no active workspace → the connect screen is shown. */
  activeWorkspaceId: string | null;
  /**
   * True while the user is adding another workspace — prototype app.jsx
   * `adding`. The rail's "+" tile sets it; opening or selecting a workspace
   * clears it. The connect screen shows when `adding || workspaces.length
   * === 0` (prototype `showConnect`), so the active workspace is preserved
   * while the user browses connections.
   */
  adding: boolean;
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
  /** Rail "+" tile: show the connect screen to open another workspace. */
  startAdding: () => void;
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

/**
 * Prototype app.jsx `showConnect`: the connect screen shows while the user is
 * adding another workspace or none are open. Shared by App (which screen
 * renders) and the rail (which tile lights up).
 */
export const selectShowConnect = (state: WorkspacesFeatureState): boolean =>
  state.adding || state.workspaces.length === 0;

export const useWorkspacesStore = create<WorkspacesFeatureState>((set) => ({
  workspaces: [],
  activeWorkspaceId: null,
  // Initially true, like the prototype — with no workspaces the connect
  // screen shows either way.
  adding: true,
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
        adding: false,
        colorCursor: state.colorCursor + 1,
      };
    }),

  closeWorkspace: (id) =>
    set((state) => {
      const idx = state.workspaces.findIndex((ws) => ws.id === id);
      if (idx === -1) return state;
      const workspaces = state.workspaces.filter((ws) => ws.id !== id);
      let activeWorkspaceId = state.activeWorkspaceId;
      let adding = state.adding;
      if (activeWorkspaceId === id) {
        const neighbour = workspaces[Math.max(0, idx - 1)];
        activeWorkspaceId = neighbour ? neighbour.id : null;
        // Closing the last workspace routes back to the connect screen
        // (prototype: setActiveWsId(null); setAdding(true)).
        if (!neighbour) adding = true;
      }
      return { workspaces, activeWorkspaceId, adding };
    }),

  setActive: (id) =>
    set((state) =>
      // Guard the invariant that activeWorkspaceId always references an
      // existing workspace (or is null). Selecting a tile also leaves the
      // connect screen (prototype rail onSelect: setAdding(false)).
      state.workspaces.some((ws) => ws.id === id)
        ? { activeWorkspaceId: id, adding: false }
        : state,
    ),

  startAdding: () => set({ adding: true }),

  renameWorkspace: (id, name) =>
    set((state) => ({ workspaces: patchWorkspace(state.workspaces, id, { name }) })),

  recolorWorkspace: (id, color) =>
    set((state) => ({ workspaces: patchWorkspace(state.workspaces, id, { color }) })),
}));
