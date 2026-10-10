// Typed invoke() wrappers for the saved-queries slice's Tauri commands, plus
// the TS mirror of the Rust wire type. Field names are camelCase per the
// serde attributes on the Rust side — keep in sync with
// `src-tauri/src/features/saved_queries/domain/mod.rs`.
//
// Saved queries are a GLOBAL store: the same entries are visible from every
// workspace (save in workspace A, load from workspace B).
//
// ARCHITECTURE pattern: this module (with state.ts) is the slice's public
// contract — cross-feature consumption of another feature's `api.ts` /
// `state.ts` is sanctioned; reaching into a feature's internals (components,
// hooks) is not.

import { invoke } from "@tauri-apps/api/core";

/**
 * A named SQL snippet the user has saved. Mirrors Rust's `SavedQuery`:
 * `id` is assigned on first save (send "" for new entries), `savedAt` is
 * epoch milliseconds and is assigned/refreshed by the backend on save.
 *
 * `connectionId` is the OPTIONAL workspace attachment. It mirrors Rust's
 * `Option<String>`, which is omitted from the wire when `None`, so it arrives
 * as `undefined` for global queries — typed `?: string | null` to tolerate
 * both absent and an explicit null. null/absent = global (visible in every
 * workspace); set = attached to that saved connection's workspace (the value
 * is the persisted `SavedConnection.id`, i.e. `workspace.saved.id`).
 */
export interface SavedQuery {
  id: string;
  name: string;
  sql: string;
  savedAt: number;
  connectionId?: string | null;
}

/**
 * What the renderer supplies to save: id is optional ("" or omitted = new).
 * `connectionId` is the optional workspace attachment — omit / null for a
 * global query, or set to a `SavedConnection.id` to scope it to that
 * connection's workspace.
 */
export interface SavedQueryInput {
  id?: string;
  name: string;
  sql: string;
  connectionId?: string | null;
  /**
   * The entry's existing `savedAt`, for an UPDATE. The backend keeps whatever
   * it is handed on an update (it only assigns one to brand-new entries), so
   * re-saving without this would overwrite a real timestamp with 0. Omit for a
   * new query.
   */
  savedAt?: number;
}

export function savedQueryList(): Promise<SavedQuery[]> {
  return invoke<SavedQuery[]>("saved_query_list");
}

/**
 * Insert or update; returns the stored value (with assigned id/savedAt).
 * A fresh save sends 0 and the backend fills `savedAt` in; an update sends the
 * entry's own timestamp back, which the backend keeps.
 */
export function savedQuerySave(query: SavedQueryInput): Promise<SavedQuery> {
  const payload: SavedQuery = {
    id: query.id ?? "",
    name: query.name,
    sql: query.sql,
    savedAt: query.savedAt ?? 0,
    // Pass the attachment through. Rust's Option deserializes from absent or
    // null, so a global query (null/undefined) is fine either way.
    connectionId: query.connectionId ?? null,
  };
  return invoke<SavedQuery>("saved_query_save", { query: payload });
}

export function savedQueryDelete(id: string): Promise<void> {
  return invoke("saved_query_delete", { id });
}
