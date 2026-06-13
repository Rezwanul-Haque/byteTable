// Zustand store for the workspaces slice — ported from the prototype's
// app.jsx workspace state (addWorkspace / editWorkspace / closeWorkspace).
//
// The store stays synchronous: the async connect flow (Tauri commands) lives
// in connect.ts, which calls `openWorkspace` only once a real backend
// connection exists. The one backend touch here is closeWorkspace's
// fire-and-forget `connection_close` — see the note there.

import { create } from "zustand";

import type { SchemaInfo } from "../connections/api";
import { connectionClose } from "../connections/api";
import { useIntrospectionStore } from "../introspection/state";
import type {
  Tab,
  TableTabMode,
  TabFilterState,
  Workspace,
  WorkspaceConnection,
  WorkspaceUiState,
} from "./types";

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
  /**
   * Create a workspace around an already-open backend connection (named
   * after its registry entry) and activate it. Callers go through the
   * connect flow in connect.ts, never invoke the backend from here.
   */
  openWorkspace: (connection: WorkspaceConnection) => void;
  /**
   * Close a workspace. If it was active, the left neighbour becomes active
   * (prototype behavior); closing the last one sets activeWorkspaceId to
   * null, which routes back to the connect screen. Also releases the
   * backend connection (fire-and-forget).
   */
  closeWorkspace: (id: string) => void;
  setActive: (id: string) => void;
  /** Rail "+" tile: show the connect screen to open another workspace. */
  startAdding: () => void;
  renameWorkspace: (id: string, name: string) => void;
  recolorWorkspace: (id: string, color: string) => void;
  /**
   * Merge a patch into a workspace's per-workspace UI state (`ui`) — the
   * action the WorkspaceUiState doc promises (M3: sidebar schema +
   * expanded tables).
   */
  patchWorkspaceUi: (id: string, patch: Partial<WorkspaceUiState>) => void;
  /**
   * Replace a workspace's schema list — the sidebar's refresh re-runs
   * `connection_schemas` so out-of-band attach/detach shows up.
   */
  setWorkspaceSchemas: (id: string, schemas: SchemaInfo[]) => void;

  // --- Tabs (M4) ---------------------------------------------------------
  // All tab actions operate on the *active* workspace's `ui` (the only
  // workspace with a visible tab strip) and go through patchWorkspaceUi, so
  // each workspace's tabs + active tab are preserved across switches for
  // free. They are no-ops when there is no active workspace. Synchronous —
  // opening a tab never touches the backend (the grid fetches lazily once
  // mounted, Task 3).
  /**
   * Open `schema.table` as a data tab and focus it. If a table tab for the
   * same schema+table is already open, focus it instead of duplicating
   * (spec §3.4) — without changing its mode.
   */
  openTableTab: (schema: string, table: string) => void;
  /** Open a fresh SQL editor tab ("Query N") and focus it. */
  openSqlTab: () => void;
  /**
   * Open the schema-map tab for `schema` (one per schema) and focus it; if
   * already open, focus the existing one.
   */
  openMapTab: (schema: string) => void;
  /**
   * Close a tab. The neighbour (left, else right) becomes active when the
   * closed tab was active; closing the last tab sets activeTabId to null,
   * routing the content area back to EmptyState.
   */
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  /**
   * Set a table tab's view mode. NOTE (M4): the Structure view is M7, so
   * TableTab does not call this with `'structure'` yet — it toasts instead
   * and stays on data. The action persists whatever mode it is given so M7
   * can wire it without a store change.
   */
  setTableTabMode: (tabId: string, mode: TableTabMode) => void;

  // --- Filters (M5) ------------------------------------------------------
  /**
   * Replace a table tab's filter state on the active workspace's `ui`
   * (creating the `filters` map lazily). The FilterPanel owns the draft-vs-
   * applied shape; this action just persists it per tab so it survives
   * workspace switches. No-op when there is no active workspace.
   */
  setTabFilter: (tabId: string, filter: TabFilterState) => void;
}

/**
 * SQL tab title counter. Per-workspace "Query N" numbering that only ever
 * increments (prototype workspace.jsx `sqlCounter` — never rewound when a
 * tab closes). Module-local, keyed by workspace id: it is naming state, not
 * renderable UI, so it stays out of the store (and out of the persisted
 * `ui`, which would otherwise reset numbering oddly on reload).
 */
const sqlCounters = new Map<string, number>();
function nextSqlTitle(workspaceId: string): string {
  const n = (sqlCounters.get(workspaceId) ?? 0) + 1;
  sqlCounters.set(workspaceId, n);
  return "Query " + n;
}

/**
 * Apply a function to the active workspace's `ui`, returning the new
 * workspaces array (or the same one when there is no active workspace).
 * Shared by every tab action so the active-only + immutability rules live
 * in one place.
 */
function patchActiveUi(
  state: WorkspacesFeatureState,
  update: (ui: WorkspaceUiState) => Partial<WorkspaceUiState>,
): Workspace[] {
  const id = state.activeWorkspaceId;
  if (id === null) return state.workspaces;
  return state.workspaces.map((ws) =>
    ws.id === id ? { ...ws, ui: { ...ws.ui, ...update(ws.ui) } } : ws,
  );
}

/** A workspace-scoped unique tab id. */
function newTabId(kind: Tab["kind"]): string {
  return "tab-" + kind + "-" + crypto.randomUUID();
}

function patchWorkspace(
  workspaces: Workspace[],
  id: string,
  patch: Partial<Pick<Workspace, "name" | "color" | "schemas">>,
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

export const useWorkspacesStore = create<WorkspacesFeatureState>((set, get) => ({
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
        ...connection,
        name: connection.saved.name,
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

  closeWorkspace: (id) => {
    // Release the backend connection fire-and-forget: the UI must not wait
    // on driver teardown, and races are benign — the backend treats closing
    // an unknown handle (already closed, or drained by shutdown's close_all)
    // as a no-op Ok, and errors here have no surface worth a toast.
    const closing = get().workspaces.find((ws) => ws.id === id);
    if (closing) {
      connectionClose(closing.handleId).catch((err: unknown) => {
        console.warn("connection_close failed", err);
      });
      // Handles are never reused, so the introspection cache for this one
      // is dead weight — drop it (sanctioned cross-slice call: state.ts is
      // the introspection slice's public contract).
      useIntrospectionStore.getState().invalidate(closing.handleId);
    }
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
    });
  },

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

  patchWorkspaceUi: (id, patch) =>
    set((state) => ({
      workspaces: state.workspaces.map((ws) =>
        ws.id === id ? { ...ws, ui: { ...ws.ui, ...patch } } : ws,
      ),
    })),

  setWorkspaceSchemas: (id, schemas) =>
    set((state) => ({ workspaces: patchWorkspace(state.workspaces, id, { schemas }) })),

  openTableTab: (schema, table) =>
    set((state) => ({
      workspaces: patchActiveUi(state, (ui) => {
        const tabs = ui.tabs ?? [];
        const existing = tabs.find(
          (t) => t.kind === "table" && t.schema === schema && t.table === table,
        );
        if (existing) return { activeTabId: existing.id };
        const tab: Tab = { id: newTabId("table"), kind: "table", schema, table, mode: "data" };
        return { tabs: [...tabs, tab], activeTabId: tab.id };
      }),
    })),

  openSqlTab: () =>
    set((state) => {
      const id = state.activeWorkspaceId;
      if (id === null) return state;
      const title = nextSqlTitle(id);
      return {
        workspaces: patchActiveUi(state, (ui) => {
          const tab: Tab = { id: newTabId("sql"), kind: "sql", title };
          return { tabs: [...(ui.tabs ?? []), tab], activeTabId: tab.id };
        }),
      };
    }),

  openMapTab: (schema) =>
    set((state) => ({
      workspaces: patchActiveUi(state, (ui) => {
        const tabs = ui.tabs ?? [];
        const existing = tabs.find((t) => t.kind === "map" && t.schema === schema);
        if (existing) return { activeTabId: existing.id };
        const tab: Tab = { id: newTabId("map"), kind: "map", schema };
        return { tabs: [...tabs, tab], activeTabId: tab.id };
      }),
    })),

  closeTab: (tabId) =>
    set((state) => ({
      workspaces: patchActiveUi(state, (ui) => {
        const tabs = ui.tabs ?? [];
        const idx = tabs.findIndex((t) => t.id === tabId);
        if (idx === -1) return {};
        const next = tabs.filter((t) => t.id !== tabId);
        // Only re-pick the active tab when the closed one was active. Left
        // neighbour, else right (now at the same index), else null (last
        // tab closed → EmptyState).
        const activeTabId =
          ui.activeTabId === tabId
            ? (next[Math.max(0, idx - 1)]?.id ?? null)
            : ui.activeTabId;
        // Drop the closed tab's filter state (if any) so it does not linger.
        let filters = ui.filters;
        if (filters && tabId in filters) {
          filters = { ...filters };
          delete filters[tabId];
        }
        return { tabs: next, activeTabId, filters };
      }),
    })),

  setActiveTab: (tabId) =>
    set((state) => ({
      workspaces: patchActiveUi(state, (ui) =>
        (ui.tabs ?? []).some((t) => t.id === tabId) ? { activeTabId: tabId } : {},
      ),
    })),

  setTableTabMode: (tabId, mode) =>
    set((state) => ({
      workspaces: patchActiveUi(state, (ui) => ({
        tabs: (ui.tabs ?? []).map((t) =>
          t.id === tabId && t.kind === "table" ? { ...t, mode } : t,
        ),
      })),
    })),

  setTabFilter: (tabId, filter) =>
    set((state) => ({
      workspaces: patchActiveUi(state, (ui) => ({
        filters: { ...(ui.filters ?? {}), [tabId]: filter },
      })),
    })),
}));

// Closing a workspace should drop its SQL numbering so a reopened
// connection starts fresh. closeWorkspace lives above as a method; rather
// than thread this through, subscribe once to prune counters for ids that
// no longer exist. Cheap (workspace count is tiny) and keeps the action
// pure.
useWorkspacesStore.subscribe((state) => {
  if (sqlCounters.size === 0) return;
  const live = new Set(state.workspaces.map((ws) => ws.id));
  for (const id of sqlCounters.keys()) {
    if (!live.has(id)) sqlCounters.delete(id);
  }
});
