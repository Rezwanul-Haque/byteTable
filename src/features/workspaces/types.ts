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
 * Per-workspace UI state, preserved across workspace switches (spec §2:
 * "switching workspaces must not lose any of it").
 *
 * Pattern: every piece of per-workspace UI state lives on the workspace
 * object under `ui`, keyed by workspace — so switching workspaces preserves
 * it for free and closing a workspace drops it with the object. Later
 * milestones extend this type (M3: sidebar — selected schema, table filter,
 * expanded tables; M4: open tabs + active tab) and add a
 * `patchWorkspaceUi(id, patch)` action alongside rename/recolor.
 * Empty for now — M2 still renders only a minimal table list.
 *
 * Churn rule: only low-frequency state belongs here. High-frequency state
 * (scroll offsets, drag-in-progress) lives in refs/local component state and
 * is committed to `ui` only on tab/workspace switch or unmount — never on
 * every frame. M3/M4 components must select narrow slices from the store
 * (e.g. one `ui` field), not whole workspace objects, to avoid re-rendering
 * on unrelated `ui` writes.
 */
export type WorkspaceUiState = Record<string, never>;

/** An open workspace — one per live connection the user has opened. */
export interface Workspace extends WorkspaceConnection {
  id: string;
  /** Display name; defaults to the connection name, user-renamable (rail). */
  name: string;
  /** Tile color, auto-assigned from the 8-color palette; user-recolorable. */
  color: string;
  ui: WorkspaceUiState;
}
