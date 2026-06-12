// Workspaces slice types — Connection mirrors the prototype's data.js
// connection objects field-for-field; Workspace mirrors app.jsx addWorkspace.

import type { Engine, Env } from "../../shared/types";

/**
 * A saved database connection. M1: hardcoded mocks (see mockConnections.ts);
 * M2 introduces the real connection manager (create/edit/persist).
 */
export interface Connection {
  id: string;
  name: string;
  engine: Engine;
  /** Display line — file path (sqlite) or "host:port · db" (server engines). */
  detail: string;
  env: Env;
  /** Server version string, shown in the sidebar header (M3). */
  version: string;
  /** Available schema names for this connection. */
  schemas: string[];
  /** Schema opened first when the workspace starts. */
  defaultSchema: string;
  /**
   * SSH tunnel description (e.g. "SSH · bastion.byteshop.dev"); presence marks
   * a tunneled connection (renders the `ssh` pill on the connect card).
   */
  tunnel?: string;
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
 * Empty for now — M1 is the shell only.
 *
 * Churn rule: only low-frequency state belongs here. High-frequency state
 * (scroll offsets, drag-in-progress) lives in refs/local component state and
 * is committed to `ui` only on tab/workspace switch or unmount — never on
 * every frame. M3/M4 components must select narrow slices from the store
 * (e.g. one `ui` field), not whole workspace objects, to avoid re-rendering
 * on unrelated `ui` writes.
 */
export type WorkspaceUiState = Record<string, never>;

/** An open workspace — one per connection the user has opened. */
export interface Workspace {
  id: string;
  connection: Connection;
  /** Display name; defaults to the connection name, user-renamable (rail). */
  name: string;
  /** Tile color, auto-assigned from the 8-color palette; user-recolorable. */
  color: string;
  ui: WorkspaceUiState;
}
