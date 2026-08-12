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
import { useSettingsStore } from "../settings/state";
import { newCondition } from "../browse/sql/filter";
import { readKeptSchemas, readSchemaColor, readSchemaSession, readSession } from "./session";
import type { CellValue } from "../../shared/api/engine";
import type { AlterOp, DbObjectInfo, DbObjectKind, SortSpec } from "../../shared/api/engine";
import type {
  SqlHistoryEntry,
  SqlRun,
  Tab,
  TableTabMode,
  TabFilterState,
  TabGridEdits,
  TabViewState,
  Workspace,
  WorkspaceConnection,
  WorkspaceUiState,
} from "./types";
import { schemaWorkspaceId } from "./types";

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

/** Extra behaviour for {@link WorkspacesFeatureState.openTableTab}. */
export interface OpenTableTabOptions {
  /**
   * Open a SECOND tab for a table that already has one instead of focusing the
   * existing tab — the sidebar's "Open in new tab" (and ⌘/middle-click). Lets
   * one table be viewed under two different filters / sorts / pages at once.
   */
  newTab?: boolean;
}

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
  /**
   * Open `schema` as a sub-workspace of `parentId` (M32) — create-or-focus.
   *
   * The child SHARES the parent's backend handle rather than opening a second
   * connection: the whole point is to work across schemas without connecting
   * repeatedly. `closeWorkspace` is refcounted accordingly.
   *
   * Nesting is one level: callers pass `ws.parentId ?? ws.id`, so opening a
   * schema from inside a sub-workspace yields a sibling, never a grandchild.
   */
  openSchemaWorkspace: (parentId: string, schema: string) => void;
  /** Clear a sub-workspace's `temp` flag so it survives its parent closing. */
  keepWorkspace: (id: string) => void;
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
   * (spec §3.4) — pass `{ newTab: true }` to add a second copy anyway. `mode`
   * is the view mode to open/switch to (default `'data'`); the sidebar's
   * "View structure" passes `'structure'`, which also switches an already-open
   * tab to structure mode.
   */
  openTableTab: (
    schema: string,
    table: string,
    mode?: TableTabMode,
    options?: OpenTableTabOptions,
  ) => void;
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
   * Open (or focus) the singleton Processes tab (M26) — the live server session
   * list with kill actions. `schema` seeds the DB column for a fresh listing.
   */
  openProcessesTab: (schema: string) => void;
  /**
   * Open (or focus) the singleton Schema diff tab (M28) — the structural
   * comparison between this workspace's schema and another SQL connection's.
   */
  openDiffTab: () => void;
  /**
   * Open the Object Explorer catalog tab for `schema` (one per schema) focused
   * on `focusClass` (`"all"` = the union facet). If already open, re-point its
   * focus and focus the tab.
   */
  openObjExplorer: (schema: string, focusClass: DbObjectKind | "all") => void;
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
  /**
   * Persist just the filter panel's open/closed flag for a tab, merged into its
   * existing filter entry. No-op when the tab has no filter entry yet (nothing
   * to remember) — the open paths always seed one first via `setTabFilter`.
   */
  setTabFilterOpen: (tabId: string, open: boolean) => void;
  /**
   * Persist a table tab's applied sort (ORDER BY) so it survives the tab
   * unmounting on a switch. `null` clears it. Merged into the tab's view entry.
   */
  setTabSort: (tabId: string, sort: SortSpec | null) => void;
  /**
   * Persist a table tab's *staged* ORDER BY (the filter panel's not-yet-applied
   * sort) so it survives a tab switch. Merged into the tab's view entry.
   */
  setTabPendingSort: (tabId: string, pendingSort: SortSpec | null) => void;
  /**
   * Persist a table tab's hidden-column set (the Columns picker) so column
   * visibility survives a tab switch. Merged into the tab's view entry.
   */
  setTabHiddenCols: (tabId: string, hiddenCols: string[]) => void;
  /**
   * Persist a table tab's staged data-grid batch (uncommitted cell edits +
   * staged new rows) so it survives the tab unmounting on a switch. `null` — or
   * an empty batch — clears the entry, which is what a successful save and
   * Discard do. The tab strip reads the presence of an entry to mark the tab
   * unsaved.
   */
  setTabGridEdits: (tabId: string, edits: TabGridEdits | null) => void;
  /**
   * Drop every staged batch — grid edits AND pending structure ops — for `tabIds`
   * in one update (the tab bar's "discard staged changes", after its confirm).
   * A mounted grid also holds its batch in local state, so the caller pairs this
   * with `tabMeta.requestDiscard` to clear that copy; this alone is enough for
   * the tabs that are not currently rendered.
   */
  discardTabEdits: (tabIds: string[]) => void;

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
/**
 * Start "Query N" numbering above the highest restored title, so a session that
 * came back with "Query 3" does not hand out "Query 1" again.
 */
function seedSqlCounter(workspaceId: string, tabs: Tab[]): void {
  let highest = 0;
  for (const tab of tabs) {
    if (tab.kind !== "sql") continue;
    const n = Number(/^Query (\d+)$/.exec(tab.title)?.[1]);
    if (Number.isFinite(n) && n > highest) highest = n;
  }
  if (highest > 0) sqlCounters.set(workspaceId, highest);
}

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

/**
 * The open tab showing `schema.table`, preferring the ACTIVE one when more than
 * one is open (the sidebar's "Open in new tab" allows duplicates). Focus-or-open
 * and the FK hop both resolve a table to a tab through this, so those actions
 * land on the copy the user is looking at rather than the oldest one — the FK
 * hop *replaces* the target's filter, which would be jarring on a tab that is
 * not on screen.
 */
function findTableTab(
  tabs: Tab[],
  activeTabId: string | null | undefined,
  schema: string,
  table: string,
): Tab | undefined {
  const isMatch = (tab: Tab) =>
    tab.kind === "table" && tab.schema === schema && tab.table === table;
  const active = tabs.find((tab) => tab.id === activeTabId);
  if (active && isMatch(active)) return active;
  return tabs.find(isMatch);
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
/**
 * A palette colour for a new schema sub-workspace (M32).
 *
 * Random, as asked — but never one already worn by the parent or a sibling of
 * the same parent, because the whole reason to colour a sub-workspace is to
 * tell it apart from them. Once every palette slot on that branch is taken the
 * constraint is dropped rather than failing.
 */
function pickSchemaColor(parentColor: string, siblingColors: string[]): string {
  const taken = new Set([parentColor, ...siblingColors]);
  const free = WORKSPACE_COLORS.filter((color) => !taken.has(color));
  const pool = free.length > 0 ? free : WORKSPACE_COLORS;
  // The index is always in range; the ?? only satisfies noUncheckedIndexedAccess.
  return pool[Math.floor(Math.random() * pool.length)] ?? WORKSPACE_COLORS[0];
}

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
      // Restore this connection's last session (Settings › Behavior ›
      // "Restore tabs"). Read at open time, so toggling the setting takes
      // effect on the next connect without any re-wiring.
      const restored = useSettingsStore.getState().settings.restoreTabs
        ? readSession(connection.saved.id)
        : null;
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
        ui: restored ?? {},
      };
      // "Query N" numbering continues past the restored tabs instead of
      // colliding with them (the counter is keyed by the fresh workspace id).
      seedSqlCounter(workspace.id, workspace.ui.tabs ?? []);

      // M32: bring back the schema sub-workspaces the user KEPT, nested under
      // this parent. Temporary ones are deliberately not restored — that is
      // what "temporary" means — so only `schemas` entries exist to read.
      // They share the parent's handle, exactly as `openSchemaWorkspace` does.
      const kept: Workspace[] = (restored ? readKeptSchemas(connection.saved.id) : []).map(
        (schema) => {
          const child: Workspace = {
            ...connection,
            id: schemaWorkspaceId(workspace.id, schema),
            name: schema,
            // The colour it was last seen wearing (its own pick, or a
            // recolour); only fall back to a fresh pick if none was stored.
            color:
              readSchemaColor(connection.saved.id, schema) ?? pickSchemaColor(workspace.color, []),
            parentId: workspace.id,
            schema,
            temp: false,
            ui: readSchemaSession(connection.saved.id, schema) ?? { schemaName: schema },
          };
          seedSqlCounter(child.id, child.ui.tabs ?? []);
          return child;
        },
      );

      return {
        // Children sit directly after their parent, matching the rail order
        // `openSchemaWorkspace` maintains.
        workspaces: [...state.workspaces, workspace, ...kept],
        // Focus the parent, not a restored child: reconnecting should land
        // where the user connected.
        activeWorkspaceId: workspace.id,
        adding: false,
        colorCursor: savedColor ? state.colorCursor : state.colorCursor + 1,
      };
    }),

  openSchemaWorkspace: (parentId, schema) =>
    set((state) => {
      const parent = state.workspaces.find((ws) => ws.id === parentId);
      if (!parent) return state;

      const id = schemaWorkspaceId(parentId, schema);
      // Create-or-focus: re-opening the same schema must not duplicate.
      if (state.workspaces.some((ws) => ws.id === id)) {
        return { activeWorkspaceId: id, adding: false };
      }

      const child: Workspace = {
        // Inherits the connection wholesale — same handle, same schemas, same
        // engine info — so no second connection is opened.
        ...parent,
        id,
        name: schema,
        // Its own palette colour rather than the parent's, so sibling schemas
        // of one connection are distinguishable at a glance in the rail.
        color: pickSchemaColor(
          parent.color,
          state.workspaces.filter((ws) => ws.parentId === parentId).map((ws) => ws.color),
        ),
        parentId,
        schema,
        temp: true,
        // Its own tabs from the first frame: sharing the parent's `ui` object
        // would make every tab action write to both.
        ui: readSchemaSession(parent.saved.id, schema) ?? { schemaName: schema },
      };
      seedSqlCounter(child.id, child.ui.tabs ?? []);

      // Children sit directly after their parent and after existing siblings,
      // so the rail always reads parent, child, child, ..., next parent.
      const parentIdx = state.workspaces.findIndex((ws) => ws.id === parentId);
      let at = parentIdx + 1;
      while (at < state.workspaces.length && state.workspaces[at]?.parentId === parentId) at++;

      return {
        workspaces: [...state.workspaces.slice(0, at), child, ...state.workspaces.slice(at)],
        activeWorkspaceId: id,
        adding: false,
      };
    }),

  keepWorkspace: (id) =>
    set((state) => ({
      workspaces: state.workspaces.map((ws) => (ws.id === id ? { ...ws, temp: false } : ws)),
    })),

  closeWorkspace: (id) => {
    const before = get().workspaces;
    const idx = before.findIndex((ws) => ws.id === id);
    if (idx === -1) return;

    // M32 cascade: closing a parent also closes its TEMPORARY children; kept
    // children survive and are promoted to top level, so no workspace is ever
    // left pointing at a parentId that no longer exists.
    const dropped = new Set<string>([id]);
    for (const ws of before) {
      if (ws.parentId === id && ws.temp) dropped.add(ws.id);
    }
    const workspaces = before
      .filter((ws) => !dropped.has(ws.id))
      .map((ws) => (ws.parentId === id ? { ...ws, parentId: null, schema: ws.schema } : ws));

    // Release the backend connection fire-and-forget: the UI must not wait
    // on driver teardown, and races are benign — the backend treats closing
    // an unknown handle (already closed, or drained by shutdown's close_all)
    // as a no-op Ok, and errors here have no surface worth a toast.
    //
    // REFCOUNTED since M32: a schema sub-workspace shares its parent's handle,
    // so closing either one must not pull the connection out from under the
    // other. Only handles no longer referenced by ANY surviving workspace are
    // closed.
    const stillUsed = new Set(workspaces.map((ws) => ws.handleId));
    const releasing = new Set(before.filter((ws) => dropped.has(ws.id)).map((ws) => ws.handleId));
    for (const handleId of releasing) {
      if (stillUsed.has(handleId)) continue;
      connectionClose(handleId).catch((err: unknown) => {
        console.warn("connection_close failed", err);
      });
      // Handles are never reused, so the introspection cache for this one
      // is dead weight — drop it (sanctioned cross-slice call: state.ts is
      // the introspection slice's public contract).
      useIntrospectionStore.getState().invalidate(handleId);
    }

    set((state) => {
      let activeWorkspaceId = state.activeWorkspaceId;
      let adding = state.adding;
      // Focus moves only when the ACTIVE workspace was in the closed set —
      // closing a background workspace must not steal focus.
      if (activeWorkspaceId !== null && dropped.has(activeWorkspaceId)) {
        const neighbour = workspaces[Math.max(0, Math.min(idx, workspaces.length - 1))];
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

  openTableTab: (schema, table, mode = "data", options) =>
    set((state) => ({
      workspaces: patchActiveUi(state, (ui) => {
        const tabs = ui.tabs ?? [];
        // `newTab` skips the focus-existing lookup, so the table opens a second
        // (third, …) time. Everything that makes a tab a tab — filter, sort,
        // hidden columns, paging, staged edits — is keyed by tab id, so the
        // copies are fully independent.
        const existing = options?.newTab
          ? undefined
          : findTableTab(tabs, ui.activeTabId, schema, table);
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

        const existing = findTableTab(tabs, ui.activeTabId, schema, table);
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

  openProcessesTab: (schema) =>
    set((state) => ({
      workspaces: patchActiveUi(state, (ui) => {
        const tabs = ui.tabs ?? [];
        // Singleton: one Processes tab per workspace, regardless of schema.
        const existing = tabs.find((t) => t.kind === "processes");
        if (existing) return { activeTabId: existing.id };
        const tab: Tab = { id: newTabId("processes"), kind: "processes", schema };
        return { tabs: [...tabs, tab], activeTabId: tab.id };
      }),
    })),

  openDiffTab: () =>
    set((state) => ({
      workspaces: patchActiveUi(state, (ui) => {
        const tabs = ui.tabs ?? [];
        // Singleton: one Schema diff tab per workspace — the two compared
        // schemas are picked inside it, not by the opener.
        const existing = tabs.find((t) => t.kind === "diff");
        if (existing) return { activeTabId: existing.id };
        const tab: Tab = { id: newTabId("diff"), kind: "diff" };
        return { tabs: [...tabs, tab], activeTabId: tab.id };
      }),
    })),

  openObjExplorer: (schema, focusClass) =>
    set((state) => ({
      workspaces: patchActiveUi(state, (ui) => {
        const tabs = ui.tabs ?? [];
        const existing = tabs.find((t) => t.kind === "objexplorer" && t.schema === schema);
        if (existing) {
          // Re-point the open Explorer at the requested facet and focus it.
          return {
            tabs: tabs.map((t) => (t.id === existing.id ? { ...t, focusClass } : t)),
            activeTabId: existing.id,
          };
        }
        const tab: Tab = { id: newTabId("objexplorer"), kind: "objexplorer", schema, focusClass };
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
        // Likewise its view state (sort + hidden columns).
        let tableViews = ui.tableViews;
        if (tableViews && tabId in tableViews) {
          tableViews = { ...tableViews };
          delete tableViews[tabId];
        }
        // Likewise its staged grid edits — closing a tab discards them (the
        // strip's unsaved dot is the warning that they are there).
        let gridEdits = ui.gridEdits;
        if (gridEdits && tabId in gridEdits) {
          gridEdits = { ...gridEdits };
          delete gridEdits[tabId];
        }
        return { tabs: next, activeTabId, filters, structureEdits, tableViews, gridEdits };
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

  setTabFilterOpen: (tabId, open) =>
    set((state) => ({
      workspaces: patchActiveUi(state, (ui) => {
        const existing = ui.filters?.[tabId];
        // Nothing to remember for a tab that never opened its filter, and no
        // write when the flag is unchanged (avoids a needless state churn).
        if (!existing || existing.open === open) return {};
        return { filters: { ...ui.filters, [tabId]: { ...existing, open } } };
      }),
    })),

  setTabSort: (tabId, sort) =>
    set((state) => ({
      workspaces: patchActiveUi(state, (ui) => {
        const existing: TabViewState = ui.tableViews?.[tabId] ?? {};
        // Committing a sort also syncs the staged value, so the ORDER BY control
        // reflects an applied sort (header click / Apply) rather than drifting.
        return {
          tableViews: {
            ...(ui.tableViews ?? {}),
            [tabId]: { ...existing, sort, pendingSort: sort },
          },
        };
      }),
    })),

  setTabPendingSort: (tabId, pendingSort) =>
    set((state) => ({
      workspaces: patchActiveUi(state, (ui) => {
        const existing: TabViewState = ui.tableViews?.[tabId] ?? {};
        return {
          tableViews: { ...(ui.tableViews ?? {}), [tabId]: { ...existing, pendingSort } },
        };
      }),
    })),

  setTabHiddenCols: (tabId, hiddenCols) =>
    set((state) => ({
      workspaces: patchActiveUi(state, (ui) => {
        const existing: TabViewState = ui.tableViews?.[tabId] ?? {};
        // Skip the write when unchanged — the mirroring effect re-runs on mount
        // with the value it just restored.
        const same =
          (existing.hiddenCols ?? []).length === hiddenCols.length &&
          (existing.hiddenCols ?? []).every((c, i) => c === hiddenCols[i]);
        if (same) return {};
        return { tableViews: { ...(ui.tableViews ?? {}), [tabId]: { ...existing, hiddenCols } } };
      }),
    })),

  setTabGridEdits: (tabId, edits) =>
    set((state) => ({
      workspaces: patchActiveUi(state, (ui) => {
        const empty = !edits || (edits.rows.length === 0 && edits.newRows.length === 0);
        // Nothing staged and nothing stored: skip the write entirely, or the
        // grid's mirroring effect would churn the store on every mount.
        if (empty && !(ui.gridEdits && tabId in ui.gridEdits)) return {};
        const next = { ...(ui.gridEdits ?? {}) };
        if (empty) delete next[tabId];
        else next[tabId] = edits;
        return { gridEdits: next };
      }),
    })),

  discardTabEdits: (tabIds) =>
    set((state) => ({
      workspaces: patchActiveUi(state, (ui) => {
        const gridEdits = { ...(ui.gridEdits ?? {}) };
        const structureEdits = { ...(ui.structureEdits ?? {}) };
        let touched = false;
        for (const tabId of tabIds) {
          if (tabId in gridEdits) {
            delete gridEdits[tabId];
            touched = true;
          }
          if (tabId in structureEdits) {
            delete structureEdits[tabId];
            touched = true;
          }
        }
        return touched ? { gridEdits, structureEdits } : {};
      }),
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
 * The staged data-grid batch stored for `tabId`, or undefined when that tab has
 * nothing staged. Reads the ACTIVE workspace, matching where `setTabGridEdits`
 * writes. A one-shot read (not a hook): the data grid seeds its working `Map`s
 * from this when it mounts and is itself the only writer, so subscribing would
 * only feed it its own updates.
 */
export function storedTabGridEdits(tabId: string): TabGridEdits | undefined {
  const state = useWorkspacesStore.getState();
  return state.workspaces.find((ws) => ws.id === state.activeWorkspaceId)?.ui.gridEdits?.[tabId];
}

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
