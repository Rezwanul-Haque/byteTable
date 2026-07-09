// Workspaces slice types. M1's mock `Connection` is gone — a workspace now
// wraps a real open backend connection: the registry entry it came from plus
// the live handle and what opening it learned (M2).
//
// Cross-slice note: importing the connections slice's wire types here is the
// sanctioned direction (workspaces → connections public contract in api.ts);
// nothing in connections imports workspaces back.

import type {
  AlterOp,
  Combinator,
  DbObjectKind,
  FilterOp,
  QueryResult,
} from "../../shared/api/engine";
import type {
  ConnectionKind,
  EngineInfo,
  KeyspaceOverview,
  SavedConnection,
  SchemaInfo,
} from "../connections/api";

/**
 * One editing row in the filter builder (M5). The UI-side mirror of a wire
 * [`Condition`], plus a stable `id` (for React keys + edit targeting) and an
 * `enabled` flag (the per-row enable checkbox — disabled rows are skipped when
 * compiling to the wire filter). `value` is always a string here (what the
 * text input holds); compilation types it per the column's declared type and,
 * for `inList`, splits it on commas. `value` is ignored for the null-check
 * operators (`isNull` / `isNotNull`).
 */
export interface UiCondition {
  id: string;
  enabled: boolean;
  column: string;
  op: FilterOp;
  value: string;
}

/**
 * The editable filter state for one table tab — a "builder" mode (stacked
 * conditions + combinator) and a "raw" SQL mode, mirroring the wire
 * [`FilterSpec`] union. Both modes are kept so toggling between them does not
 * lose the other's content; the active `rawMode` flag selects which compiles.
 */
export interface FilterDraft {
  conditions: UiCondition[];
  combinator: Combinator;
  rawMode: boolean;
  rawSql: string;
}

/**
 * A table tab's filter state (M5 stackable filter builder), kept per tab so it
 * survives workspace switches (the WorkspaceUiState rule). Two slots:
 *
 * - `draft` — what the builder panel is currently editing. Column/operator/
 *   value edits mutate the draft without re-fetching (a dirty state).
 * - `applied` — what the grid actually fetches with; `null` means no filter.
 *   Pressing **Apply** (or toggling a row's enable checkbox, which re-applies
 *   immediately per §3.5) commits the draft into `applied`. The grid's reset
 *   machinery keys on `applied`, so committing re-windows + re-counts exactly
 *   like a sort change.
 *
 * Filter input is low-frequency (only on apply/toggle), so it belongs in the
 * persisted per-workspace `ui` — not the ephemeral tabMeta result store.
 */
export interface TabFilterState {
  draft: FilterDraft;
  applied: FilterDraft | null;
}

/**
 * The live-connection payload a workspace is opened with — produced by the
 * connect flow (`connect.ts`) from `connection_open`'s result.
 */
export interface WorkspaceConnection {
  /** The registry entry this workspace was opened from. */
  saved: SavedConnection;
  /** Opaque backend handle; every follow-up command takes it. */
  handleId: string;
  /** What opening learned about the target (engine + server version). */
  info: EngineInfo;
  /** Schemas visible on the connection (SQLite: `main` + attached). */
  schemas: SchemaInfo[];
  /**
   * The engine *family* (M13): `"sql"` → the relational workspace, `"kv"` →
   * the Redis workspace. The App routes on this; it is the connections-slice
   * discriminant carried straight off `OpenResult.kind` so the host never has
   * to sniff the engine string. SQL connections set `"sql"`.
   */
  kind: ConnectionKind;
  /**
   * The initial Redis keyspace overview (server identity + per-db key counts),
   * present only for `kind === "kv"` connections — the Redis workspace renders
   * its db switcher + dashboard header off it immediately, without a round trip.
   * Absent for SQL connections.
   */
  keyspace?: KeyspaceOverview;
}

/**
 * A table's view mode in its tab. `'data'` is the grid; `'structure'` is the
 * read-only M7 structure view (§3.6: columns + indexes/FKs/referenced-by/DDL).
 * The segmented control toggles between them and the mode persists per tab
 * across workspace switches. (Structure-mode editing is M8.)
 */
export type TableTabMode = "data" | "structure";

/**
 * One entry in a SQL tab's per-tab run history (M6, spec §3.7): the executed
 * SQL, whether it succeeded, and outcome details. Newest-first, deduplicated
 * by `sql`, capped at 20 (`SQL_HISTORY_MAX`). Clicking an entry reloads its
 * SQL into the editor.
 */
export interface SqlHistoryEntry {
  /** The executed SQL (trimmed), the dedup key. */
  sql: string;
  /** True when the run succeeded. */
  ok: boolean;
  /** Row count on success (absent for write statements / failures). */
  rowCount?: number;
  /** The §5 driver message on failure. */
  error?: string;
  /** Epoch ms the run finished. */
  ranAt: number;
}

/**
 * One executed statement's outcome, shown as a result tab. A multi-statement
 * run produces one `SqlRun` per statement, in order; `result` xor `error` is
 * set (success vs the §5 failure message).
 */
export interface SqlRun {
  /** Stable id within the tab's current run set (used as the result-tab key). */
  id: string;
  /** The statement that produced this outcome (also the tab's tooltip). */
  sql: string;
  /** The result set on success, or null when this statement failed. */
  result: QueryResult | null;
  /** The §5 driver message on failure, or null on success. */
  error: string | null;
}

/**
 * The editor state carried by one SQL tab (M6, spec §3.7). Lives on the tab
 * object (in the workspace's `ui`) so it survives workspace switches per the
 * WorkspaceUiState rule. `text` is the editor buffer (committed on change —
 * controlled at editor scale; see SqlEditorTab). `runs` holds one outcome per
 * executed statement (each rendered as a result tab); `activeRunId` is the
 * focused tab. `running` is transient and NOT persisted here — it is local to
 * the component, since an in-flight query cannot survive a switch anyway.
 */
export interface SqlTabState {
  /** Editor buffer. */
  text: string;
  /** One result tab per executed statement, in run order. Empty until a run. */
  runs: SqlRun[];
  /** The focused result tab's id (defaults to the first after each run). */
  activeRunId: string | null;
  /** Per-tab run history, newest-first, deduped, capped at 20. */
  history: SqlHistoryEntry[];
  /** Editor-pane height (px) from the editor/results splitter; null = CSS
   *  default (38%). Per-tab so each query keeps its own split. */
  editorHeight: number | null;
}

/**
 * One open editor tab. Discriminated by `kind`; the union is closed so the
 * content router (WorkspaceContent) exhaustively switches on it.
 *
 * - **table** — a browsable table. `mode` defaults to `'data'`. Re-opening
 *   the same `schema`+`table` focuses the existing tab rather than
 *   duplicating (spec §3.4).
 * - **sql** — a SQL editor (M6, spec §3.7). Carries its editor state inline
 *   (`text`/`result`/`error`/`history`) so each tab's query, results, and
 *   history are independent and survive workspace switches. `title` is the
 *   assigned "Query N" label.
 * - **map** — a schema-map ER diagram (M9), one per schema. Placeholder this
 *   milestone.
 */
export type Tab =
  | { id: string; kind: "table"; schema: string; table: string; mode: TableTabMode }
  | ({ id: string; kind: "sql"; title: string } & SqlTabState)
  | { id: string; kind: "map"; schema: string }
  // A schema object's read-only DDL viewer (+ browse-as-data for views).
  // Create/edit reuse the SQL editor (`sql` tab), not a dedicated kind.
  | {
      id: string;
      kind: "object";
      schema: string;
      objectKind: DbObjectKind;
      name: string;
      detail: string | null;
    }
  // The Object Explorer catalog (M22): one spacious, sortable/filterable grid of
  // all non-table objects in a schema. One per schema; `focusClass` selects the
  // facet the sidebar escalation landed on (`"all"` = the union facet).
  | {
      id: string;
      kind: "objexplorer";
      schema: string;
      focusClass: DbObjectKind | "all";
    };

/**
 * Per-workspace UI state, preserved across workspace switches (spec §2:
 * "switching workspaces must not lose any of it").
 *
 * Pattern: every piece of per-workspace UI state lives on the workspace
 * object under `ui`, keyed by workspace — so switching workspaces preserves
 * it for free and closing a workspace drops it with the object. Written via
 * the store's `patchWorkspaceUi(id, patch)` action. Tabs + the active tab
 * live here too (M4): switching workspaces preserves each workspace's open
 * tabs and which one is active for free. (Grid scroll offset per tab is the
 * grid's concern — Task 3 — and being high-frequency stays in refs, not
 * here; see the churn rule.)
 *
 * Churn rule: only low-frequency state belongs here. High-frequency state
 * (scroll offsets, drag-in-progress) lives in refs/local component state and
 * is committed to `ui` only on tab/workspace switch or unmount — never on
 * every frame. The sidebar's search text is deliberately NOT here: it is
 * transient per-keystroke state, local to the component (prototype
 * behavior).
 */
export interface WorkspaceUiState {
  /**
   * Schema selected in the sidebar's switcher. Unset until the user
   * switches — readers fall back to the first schema the connection listed
   * (SQLite: always `main`).
   */
  schemaName?: string;
  /** Sidebar tables whose inline column list is expanded. */
  expandedTables?: string[];
  /** Open editor tabs, left-to-right. Empty → the content area is EmptyState. */
  tabs?: Tab[];
  /**
   * The focused tab's id, or null when no tab is open. Always references a
   * tab in `tabs` (or null) — the store maintains this invariant on close.
   */
  activeTabId?: string | null;
  /**
   * Per-table-tab filter state (M5), keyed by tab id. Lives here (not in the
   * ephemeral tabMeta store) because it is low-frequency editing *input* that
   * must survive workspace switches per this contract. Sparse — only tabs the
   * user has opened the filter panel for. A closed tab's stale entry is
   * harmless; `closeTab` prunes it.
   */
  filters?: Record<string, TabFilterState>;
  /**
   * Per-table-tab structure-editor draft (M8 §3.6 / §4), keyed by tab id: the
   * accumulated {@link AlterOp} batch the pending-changes bar sends to
   * `alterApply`. The "snapshot for discard" is the introspected
   * {@link TableMeta} in the introspection cache (always re-derivable), so only
   * the ops live here — discard just clears this entry. The working column set
   * the structure view displays is derived on render from the introspected
   * columns + this batch (see `applyOpsToColumns`). Lives here (not local
   * component state) so a draft survives the Data↔Structure mode switch (which
   * unmounts the view) and workspace switches. Sparse — only tabs with edits.
   * `closeTab` prunes it.
   */
  structureEdits?: Record<string, AlterOp[]>;
}

/** An open workspace — one per live connection the user has opened. */
export interface Workspace extends WorkspaceConnection {
  id: string;
  /** Display name; defaults to the connection name, user-renamable (rail). */
  name: string;
  /** Tile color, auto-assigned from the 8-color palette; user-recolorable. */
  color: string;
  ui: WorkspaceUiState;
}
