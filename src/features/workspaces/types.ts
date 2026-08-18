// Workspaces slice types. M1's mock `Connection` is gone — a workspace now
// wraps a real open backend connection: the registry entry it came from plus
// the live handle and what opening it learned (M2).
//
// Cross-slice note: importing the connections slice's wire types here is the
// sanctioned direction (workspaces → connections public contract in api.ts);
// nothing in connections imports workspaces back.

import type {
  AlterOp,
  CellValue,
  Combinator,
  DbObjectKind,
  FilterOp,
  PkPredicate,
  QueryResult,
  SortSpec,
} from "../../shared/api/engine";
import type {
  ConnectionKind,
  EngineInfo,
  KeyspaceOverview,
  SavedConnection,
  SchemaInfo,
} from "../connections/api";
import type { BadgeEngine } from "../../shared/types";

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
  /**
   * Whether the filter panel is expanded on this tab. Persisted per-tab so the
   * panel stays open after switching away and back (a table tab unmounts when
   * inactive, so a local flag would reset). Absent = closed.
   */
  open?: boolean;
}

/**
 * Per-table-tab *view* state that must survive the tab unmounting on a switch
 * (like {@link TabFilterState}, but for grid presentation rather than the
 * filter): the applied sort (ORDER BY) and which columns are hidden from the
 * Columns picker. Kept out of `TabFilterState` because it is not part of the
 * WHERE filter and is not reset by "Clear filters".
 */
export interface TabViewState {
  /** Applied single-column sort (drives the grid), or null/absent = unsorted. */
  sort?: SortSpec | null;
  /**
   * Staged ORDER BY from the filter panel — persisted live (like the filter
   * draft) so a not-yet-applied choice survives a tab switch. Reaches the grid
   * (→ `sort`) only when Apply is pressed. `undefined` = follow `sort`.
   */
  pendingSort?: SortSpec | null;
  /** Column names hidden by the Columns popover (display-only). */
  hiddenCols?: string[];
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
  // The live server process/session list with kill actions (M26). Singleton;
  // `schema` is the active schema shown in the DB column for a fresh listing.
  | { id: string; kind: "processes"; schema: string }
  // Schema Diff & Sync (M28): structural comparison against another SQL
  // connection. Singleton per workspace; the tab carries no state of its own —
  // which two schemas are compared lives in the component, and the workspace's
  // own connection is always the right-hand (target) side.
  | { id: string; kind: "diff" }
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
   * Per-table-tab view state (sort + hidden columns), keyed by tab id. Same
   * survives-the-unmount rationale as `filters`: a table tab unmounts when
   * inactive, so grid sort/column choices held in local component state would
   * reset on return. Sparse; `closeTab` prunes a closed tab's entry.
   */
  tableViews?: Record<string, TabViewState>;
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
  /**
   * Per-table-tab staged data-grid edits (the save bar's uncommitted batch),
   * keyed by tab id. Same survives-the-unmount rationale as `filters`, and it
   * has teeth here: an inactive tab is unmounted, so typed-but-unsaved cell
   * values held in the grid's local state were simply lost on a tab switch.
   * Sparse — only tabs with staged changes; `closeTab` prunes the entry, as does
   * a successful save or Discard.
   */
  gridEdits?: Record<string, TabGridEdits>;
}

/**
 * One table tab's staged (uncommitted) data-grid changes — what the save bar
 * would send. Deliberately JSON-shaped (arrays, not the grid's `Map`s) because
 * this rides on {@link WorkspaceUiState}; the grid converts on the way in and
 * out. Dropped by `forStorage`, so staged edits never outlive the app session —
 * committing values typed against a previous session's rows would be a footgun.
 */
export interface TabGridEdits {
  /**
   * Staged edits to EXISTING rows. `key` is the row's primary-key string (the
   * grid's own row identity), `pk` the predicate for the `UPDATE … WHERE`, and
   * `cells` only the columns that actually changed, by column index.
   */
  rows: { key: string; pk: PkPredicate[]; cells: { col: number; value: CellValue }[] }[];
  /** Staged inserts in display order (newest first — they ride atop page 0). */
  newRows: { key: number; values: CellValue[] }[];
}

/**
 * The tabs holding work that is not in the database yet: staged data-grid rows /
 * cells ({@link WorkspaceUiState.gridEdits}) or a pending structure batch
 * ({@link WorkspaceUiState.structureEdits}). Closing such a tab throws that work
 * away, so this one definition drives both the strip's unsaved dot and the
 * confirm-on-close. SQL tabs never qualify — their buffer is persisted, so
 * closing one loses nothing.
 */
export function unsavedTabIds(ui: WorkspaceUiState): Set<string> {
  const ids = new Set<string>();
  for (const [tabId, edits] of Object.entries(ui.gridEdits ?? {})) {
    if (edits.rows.length > 0 || edits.newRows.length > 0) ids.add(tabId);
  }
  for (const [tabId, ops] of Object.entries(ui.structureEdits ?? {})) {
    if (ops.length > 0) ids.add(tabId);
  }
  return ids;
}

/**
 * What closing tab `tabId` would discard, as a human phrase — "2 edited rows, 1
 * new row", "3 structure changes". Empty string when the tab is clean. Used by
 * the close confirm so the prompt says what is at stake rather than just
 * "unsaved changes".
 */
export function unsavedSummary(ui: WorkspaceUiState, tabId: string): string {
  const plural = (n: number, noun: string) => n + " " + noun + (n === 1 ? "" : "s");
  const parts: string[] = [];
  const grid = ui.gridEdits?.[tabId];
  if (grid && grid.rows.length > 0) parts.push(plural(grid.rows.length, "edited row"));
  if (grid && grid.newRows.length > 0) parts.push(plural(grid.newRows.length, "new row"));
  const ops = ui.structureEdits?.[tabId]?.length ?? 0;
  if (ops > 0) parts.push(plural(ops, "structure change"));
  return parts.join(", ");
}

/**
 * The delimited file a data-file workspace (M35) is showing. Its presence on a
 * {@link Workspace} is what makes that workspace the CSV viewer/editor rather
 * than one of the engine shells — see {@link isDataFileWorkspace}.
 *
 * The text is held in memory for the workspace's lifetime because every view
 * derives from it: re-parsing on a delimiter change must not require re-reading
 * the file, and the profile/issue passes work on the parsed rows, not the disk.
 */
export interface DataFileRef {
  /** File name as shown everywhere (no path). */
  name: string;
  /** Absolute path, when the file came from the native picker; else null. */
  path: string | null;
  /** Size in bytes, for the sidebar/status bar readouts. */
  size: number;
  /** The whole file, decoded as UTF-8. */
  text: string;
  /** The parse options the user committed in the open sheet. */
  opts: DataFileParseOpts;
}

/**
 * The parse options a {@link DataFileRef} was opened with. A structural mirror
 * of the core's resolved options, narrowed to the three the sheet exposes plus
 * the quote character, so this module does not depend on the data-file slice.
 */
export interface DataFileParseOpts {
  delimiter: string;
  header: boolean;
  trim: boolean;
}

/** An open workspace — one per live connection the user has opened. */
export interface Workspace extends WorkspaceConnection {
  id: string;
  /** Display name; defaults to the connection name, user-renamable (rail). */
  name: string;
  /** Tile color, auto-assigned from the 8-color palette; user-recolorable. */
  color: string;
  ui: WorkspaceUiState;

  // --- Schema sub-workspaces (M32) --------------------------------------
  // Three optional fields; a workspace without them is an ordinary top-level
  // one and behaves exactly as before. A sub-workspace scopes the SAME
  // connection to one schema and nests under its parent in the rail.
  /**
   * The top-level workspace this one hangs off, or absent for a top-level
   * workspace. Always a top-level id: nesting is **one level only**, so
   * opening a schema from inside a sub-workspace attaches the new one to the
   * same parent rather than creating a grandchild.
   */
  parentId?: string | null;
  /**
   * The schema this workspace is scoped to. Only the *initial* binding — the
   * schema switcher stays enabled inside a sub-workspace, and switching does
   * not rewrite this (the rail tile keeps its own name).
   */
  schema?: string | null;
  /**
   * True until the user keeps it. A temporary sub-workspace closes with its
   * parent and is not restored on restart; keeping it clears this and
   * promotes it to a first-class workspace.
   */
  temp?: boolean;

  // --- Data-file workspace (M35) -----------------------------------------
  /**
   * The delimited file this workspace is a view of, and can edit. Present only for
   * a data-file workspace; its `saved`/`handleId` still point at a real (but
   * private, in-memory) SQLite connection holding the file's rows, which is how
   * the SQL tab runs through the ordinary query path.
   */
  file?: DataFileRef;
}

/** True when `workspace` is the data-file viewer rather than an
 *  engine workspace. One predicate so the App, rail and title bar agree. */
export function isDataFileWorkspace(
  workspace: Pick<Workspace, "file">,
): workspace is Pick<Workspace, "file"> & { file: DataFileRef } {
  return workspace.file !== undefined;
}

/**
 * What to badge a workspace as. A data-file workspace shows `csv` rather than
 * the SQLite database its rows happen to be loaded into — the user opened a
 * file, and the rail tile, title bar and sidebar should all say so.
 */
export function workspaceBadge(workspace: Pick<Workspace, "file" | "saved">): BadgeEngine {
  return isDataFileWorkspace(workspace) ? "csv" : workspace.saved.engine;
}

/** The deterministic id of a schema sub-workspace, so opening the same schema
 *  twice focuses the existing one instead of duplicating it. */
export function schemaWorkspaceId(parentId: string, schema: string): string {
  return "ws-" + parentId + "-" + schema;
}

/**
 * The schema a workspace should default to — its own `schema` for a sub-workspace
 * (M32), otherwise the connection's first schema.
 *
 * This is the FALLBACK, not an override: `ui.schemaName` still wins, because the
 * schema switcher stays enabled inside a sub-workspace and switching must stick.
 * It only decides where a workspace lands when nothing has been chosen yet — a
 * freshly opened child, or a restored session that never recorded one. Without
 * it a child would boot on `schemas[0]` and need a manual switch to reach the
 * schema it was opened for.
 */
export function homeSchema(workspace: Pick<Workspace, "schema" | "schemas">): string | undefined {
  const own = workspace.schema;
  if (own && workspace.schemas.some((s) => s.name === own)) return own;
  return workspace.schemas[0]?.name;
}

/**
 * The schema a workspace is CURRENTLY on — what the sidebar's schema switcher
 * shows: the user's `ui.schemaName` when it still exists on the connection
 * (a refresh may have dropped it out-of-band, and introspecting a ghost is
 * worse than falling back), else {@link homeSchema}.
 *
 * The sidebar and the tab strip must agree on this: tab titles drop the schema
 * prefix for the selected schema, so if the two disagreed every tab would carry
 * a redundant `schema.` prefix. Callers apply their own last-resort default
 * (SQLite's "main"), which is why this can still return undefined.
 */
export function selectedSchema(
  workspace: Pick<Workspace, "schema" | "schemas" | "ui">,
): string | undefined {
  const chosen = workspace.ui.schemaName;
  if (chosen !== undefined && workspace.schemas.some((s) => s.name === chosen)) return chosen;
  return homeSchema(workspace);
}
