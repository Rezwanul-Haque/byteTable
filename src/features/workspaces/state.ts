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
import { newCondition } from "../browse/filter";
import type { CellValue } from "../../shared/api/engine";
import type { AlterOp, DbObjectInfo } from "../../shared/api/engine";
import type {
  SqlHistoryEntry,
  SqlRun,
  Tab,
  TableTabMode,
  TabFilterState,
  Workspace,
  WorkspaceConnection,
  WorkspaceUiState,
} from "./types";

/** Per-tab SQL run-history cap (spec §3.7: "20 dedup"). */
export const SQL_HISTORY_MAX = 20;

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
   * Open `schema.table` as a table tab and focus it. If a table tab for the
   * same schema+table is already open, focus it instead of duplicating
   * (spec §3.4). `mode` is the view mode to open/switch to (default `'data'`);
   * the sidebar's "View structure" passes `'structure'`, which also switches
   * an already-open tab to structure mode.
   */
  openTableTab: (schema: string, table: string, mode?: TableTabMode) => void;
  /**
   * Open (or focus) `schema.table` as a data tab and seed its filter with a
   * single applied `column = value` equality condition — the M10 "FK hop /
   * Open in {table}" action (§3.5). When the tab already exists it is focused,
   * switched to data mode, and its filter is *replaced* with the seeded
   * condition so the grid re-fetches showing the referenced row(s). The seed
   * sets both `applied` (what the grid fetches) and `draft` (so the filter
   * panel shows the same condition if opened).
   */
  openTableTabWithFilter: (schema: string, table: string, column: string, value: CellValue) => void;
  /** Open (or focus) a schema object's read-only viewer tab. */
  openObjectTab: (schema: string, object: DbObjectInfo) => void;
  /** Open a fresh SQL editor tab ("Query N") and focus it. */
  openSqlTab: () => void;
  /**
   * Open a fresh SQL editor tab pre-loaded with `sql` and focus it (command
   * palette: load a saved query). Like `openSqlTab` but seeds the buffer
   * instead of the starter SQL.
   */
  openSqlTabWith: (sql: string) => void;
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

  // --- Structure editor (M8) ---------------------------------------------
  /**
   * Replace a table tab's pending structure-edit batch on the active
   * workspace's `ui` (creating the `structureEdits` map lazily). An empty
   * array clears the entry. Persists per tab so a draft survives the
   * Data↔Structure mode switch and workspace switches. No-op when there is no
   * active workspace.
   */
  setTabStructureOps: (tabId: string, ops: AlterOp[]) => void;

  // --- SQL editor (M6) ---------------------------------------------------
  // All operate on the active workspace's `ui` tabs and are no-ops when the
  // target is not a SQL tab. Editor state lives on the tab so it survives
  // workspace switches (the WorkspaceUiState rule).
  /** Set a SQL tab's editor buffer (committed on change — see SqlEditorTab). */
  setSqlText: (tabId: string, text: string) => void;
  /** Replace a SQL tab's result set with one run-outcome per executed
   *  statement, focusing the first (the × dismiss clears them). */
  setSqlRuns: (tabId: string, runs: SqlRun[]) => void;
  /** Focus a result tab by id. */
  setActiveRun: (tabId: string, runId: string) => void;
  /** Close one result tab; if it was focused, focus a neighbour. */
  closeRun: (tabId: string, runId: string) => void;
  /** Dismiss the results pane: clear all runs (the × button). */
  clearSqlRuns: (tabId: string) => void;
  /** Set the editor-pane height (px) from the editor/results splitter; null
   *  resets to the CSS default. */
  setSqlEditorHeight: (tabId: string, height: number | null) => void;
  /**
   * Push a run onto the tab's history (newest-first, deduped by sql, capped
   * at SQL_HISTORY_MAX). Re-running an identical statement moves it to the
   * top rather than duplicating.
   */
  pushSqlHistory: (tabId: string, entry: SqlHistoryEntry) => void;
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

/** Stringify an FK seed value for a UI filter condition (null → empty). */
function stringifySeed(value: CellValue): string {
  return value === null ? "" : String(value);
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
      // The connection's own color (m15 env picker) wins; otherwise cycle the
      // 8-color palette. The cursor only advances when the palette is actually
      // used, so a run of color-bearing connections doesn't skip palette slots
      // for the un-colored ones interleaved with them.
      const savedColor = connection.saved.color;
      const workspace: Workspace = {
        id: "ws-" + crypto.randomUUID(),
        ...connection,
        name: connection.saved.name,
        // The modulo is always in range; the ?? fallback only satisfies
        // noUncheckedIndexedAccess.
        color:
          savedColor ??
          WORKSPACE_COLORS[state.colorCursor % WORKSPACE_COLORS.length] ??
          WORKSPACE_COLORS[0],
        ui: {},
      };
      return {
        workspaces: [...state.workspaces, workspace],
        activeWorkspaceId: workspace.id,
        adding: false,
        colorCursor: savedColor ? state.colorCursor : state.colorCursor + 1,
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

  openTableTab: (schema, table, mode = "data") =>
    set((state) => ({
      workspaces: patchActiveUi(state, (ui) => {
        const tabs = ui.tabs ?? [];
        const existing = tabs.find(
          (t) => t.kind === "table" && t.schema === schema && t.table === table,
        );
        if (existing) {
          // Focus the existing tab; switch its mode if the caller asked for a
          // specific one (e.g. "View structure" on an already-open data tab).
          const nextTabs =
            existing.kind === "table" && existing.mode !== mode
              ? tabs.map((t) => (t.id === existing.id ? { ...t, mode } : t))
              : tabs;
          return { tabs: nextTabs, activeTabId: existing.id };
        }
        const tab: Tab = { id: newTabId("table"), kind: "table", schema, table, mode };
        return { tabs: [...tabs, tab], activeTabId: tab.id };
      }),
    })),

  openObjectTab: (schema, object) =>
    set((state) => ({
      workspaces: patchActiveUi(state, (ui) => {
        const tabs = ui.tabs ?? [];
        const existing = tabs.find(
          (t) =>
            t.kind === "object" &&
            t.schema === schema &&
            t.objectKind === object.kind &&
            t.name === object.name,
        );
        if (existing) return { tabs, activeTabId: existing.id };
        const tab: Tab = {
          id: newTabId("object"),
          kind: "object",
          schema,
          objectKind: object.kind,
          name: object.name,
          detail: object.detail,
        };
        return { tabs: [...tabs, tab], activeTabId: tab.id };
      }),
    })),

  openTableTabWithFilter: (schema, table, column, value) =>
    set((state) => ({
      workspaces: patchActiveUi(state, (ui) => {
        const tabs = ui.tabs ?? [];
        // Build the seeded filter: one applied `column = value` eq condition.
        // The value rides as a string in the UI draft; compileToSpec retypes it
        // per the column's declared type at fetch time and marks binary columns
        // so the backend binds the key as bytes.
        const cond = { ...newCondition(column), op: "eq" as const, value: stringifySeed(value) };
        const draft = {
          conditions: [cond],
          combinator: "and" as const,
          rawMode: false,
          rawSql: "",
        };
        const seeded: TabFilterState = { draft, applied: draft };

        const existing = tabs.find(
          (t) => t.kind === "table" && t.schema === schema && t.table === table,
        );
        if (existing) {
          // Focus it, force data mode, and replace its filter with the seed.
          const nextTabs = tabs.map((t) =>
            t.id === existing.id && t.kind === "table" ? { ...t, mode: "data" as const } : t,
          );
          return {
            tabs: nextTabs,
            activeTabId: existing.id,
            filters: { ...(ui.filters ?? {}), [existing.id]: seeded },
          };
        }
        const tab: Tab = { id: newTabId("table"), kind: "table", schema, table, mode: "data" };
        return {
          tabs: [...tabs, tab],
          activeTabId: tab.id,
          filters: { ...(ui.filters ?? {}), [tab.id]: seeded },
        };
      }),
    })),

  openSqlTab: () =>
    set((state) => {
      const id = state.activeWorkspaceId;
      if (id === null) return state;
      const title = nextSqlTitle(id);
      return {
        workspaces: patchActiveUi(state, (ui) => {
          const tab: Tab = {
            id: newTabId("sql"),
            kind: "sql",
            title,
            // A fresh tab opens empty — no starter SQL.
            text: "",
            runs: [],
            activeRunId: null,
            history: [],
            editorHeight: null,
          };
          return { tabs: [...(ui.tabs ?? []), tab], activeTabId: tab.id };
        }),
      };
    }),

  openSqlTabWith: (sql) =>
    set((state) => {
      const id = state.activeWorkspaceId;
      if (id === null) return state;
      const title = nextSqlTitle(id);
      return {
        workspaces: patchActiveUi(state, (ui) => {
          const tab: Tab = {
            id: newTabId("sql"),
            kind: "sql",
            title,
            text: sql,
            runs: [],
            activeRunId: null,
            history: [],
            editorHeight: null,
          };
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
          ui.activeTabId === tabId ? (next[Math.max(0, idx - 1)]?.id ?? null) : ui.activeTabId;
        // Drop the closed tab's filter state (if any) so it does not linger.
        let filters = ui.filters;
        if (filters && tabId in filters) {
          filters = { ...filters };
          delete filters[tabId];
        }
        // Likewise its pending structure edits (M8).
        let structureEdits = ui.structureEdits;
        if (structureEdits && tabId in structureEdits) {
          structureEdits = { ...structureEdits };
          delete structureEdits[tabId];
        }
        return { tabs: next, activeTabId, filters, structureEdits };
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

  setTabStructureOps: (tabId, ops) =>
    set((state) => ({
      workspaces: patchActiveUi(state, (ui) => {
        const next = { ...(ui.structureEdits ?? {}) };
        if (ops.length === 0) delete next[tabId];
        else next[tabId] = ops;
        return { structureEdits: next };
      }),
    })),

  setSqlText: (tabId, text) =>
    set((state) => ({ workspaces: patchSqlTab(state, tabId, () => ({ text })) })),

  setSqlRuns: (tabId, runs) =>
    set((state) => ({
      workspaces: patchSqlTab(state, tabId, () => ({ runs, activeRunId: runs[0]?.id ?? null })),
    })),

  setActiveRun: (tabId, runId) =>
    set((state) => ({ workspaces: patchSqlTab(state, tabId, () => ({ activeRunId: runId })) })),

  closeRun: (tabId, runId) =>
    set((state) => ({
      workspaces: patchSqlTab(state, tabId, (t) => {
        const idx = t.runs.findIndex((r) => r.id === runId);
        if (idx === -1) return {};
        const runs = t.runs.filter((r) => r.id !== runId);
        // If the closed tab was focused, fall to the next tab (or the previous
        // when it was the last); null when none remain (pane closes).
        const activeRunId =
          t.activeRunId === runId
            ? ((runs[idx] ?? runs[idx - 1] ?? null)?.id ?? null)
            : t.activeRunId;
        return { runs, activeRunId };
      }),
    })),

  clearSqlRuns: (tabId) =>
    set((state) => ({
      workspaces: patchSqlTab(state, tabId, () => ({ runs: [], activeRunId: null })),
    })),

  setSqlEditorHeight: (tabId, height) =>
    set((state) => ({
      workspaces: patchSqlTab(state, tabId, () => ({ editorHeight: height })),
    })),

  pushSqlHistory: (tabId, entry) =>
    set((state) => ({
      workspaces: patchSqlTab(state, tabId, (tab) => ({
        history: [entry, ...tab.history.filter((h) => h.sql !== entry.sql)].slice(
          0,
          SQL_HISTORY_MAX,
        ),
      })),
    })),
}));

/**
 * Apply a partial-state update to one SQL tab on the active workspace's `ui`,
 * returning the new workspaces array. No-op when the target tab is absent or
 * is not a SQL tab — keeps the SQL actions from touching table/map tabs.
 */
function patchSqlTab(
  state: WorkspacesFeatureState,
  tabId: string,
  update: (tab: Extract<Tab, { kind: "sql" }>) => Partial<Extract<Tab, { kind: "sql" }>>,
): Workspace[] {
  return patchActiveUi(state, (ui) => ({
    tabs: (ui.tabs ?? []).map((t) =>
      t.id === tabId && t.kind === "sql" ? { ...t, ...update(t) } : t,
    ),
  }));
}

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
