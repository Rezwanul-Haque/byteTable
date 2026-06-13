// Workspaces slice types. M1's mock `Connection` is gone — a workspace now
// wraps a real open backend connection: the registry entry it came from plus
// the live handle and what opening it learned (M2).
//
// Cross-slice note: importing the connections slice's wire types here is the
// sanctioned direction (workspaces → connections public contract in api.ts);
// nothing in connections imports workspaces back.

import type { EngineInfo, SavedConnection, SchemaInfo } from "../connections/api";

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
}

/**
 * A table's view mode in its tab. `'data'` is the grid; `'structure'` is the
 * M7 schema editor — the segmented control renders both this milestone, but
 * selecting Structure toasts "arrives in M7" and the tab stays on `'data'`
 * (TableTab), so a persisted `'structure'` is not produced yet.
 */
export type TableTabMode = "data" | "structure";

/**
 * One open editor tab. Discriminated by `kind`; the union is closed so the
 * content router (WorkspaceContent) exhaustively switches on it.
 *
 * - **table** — a browsable table. `mode` defaults to `'data'`. Re-opening
 *   the same `schema`+`table` focuses the existing tab rather than
 *   duplicating (spec §3.4).
 * - **sql** — a SQL editor (M6). This milestone renders a placeholder; the
 *   tab mechanics (open/focus/close, ⌘T, "+") are real so M6 only fills the
 *   body. `title` is the assigned "Query N" label.
 * - **map** — a schema-map ER diagram (M9), one per schema. Placeholder this
 *   milestone.
 */
export type Tab =
  | { id: string; kind: "table"; schema: string; table: string; mode: TableTabMode }
  | { id: string; kind: "sql"; title: string }
  | { id: string; kind: "map"; schema: string };

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
