// Zustand store for the global saved-query list. Mutations (save/remove) go
// backend-first, then patch the in-memory list from the backend's reply — the
// JSON store is the source of truth, never optimistic state.
//
// GLOBAL store, not per-workspace: there is one instance for the whole app,
// holding ALL queries regardless of attachment. A query may carry an OPTIONAL
// `connectionId` (the persisted SavedConnection id) attaching it to one
// workspace; `connectionId` null/absent means global. This store does no
// attachment filtering — the renderer (Task 2) decides visibility per
// workspace via the `selectQueriesForConnection` helper below.

import { create } from "zustand";

import { isAppErrorPayload } from "../../shared/api/error";
import {
  savedQueryDelete,
  savedQueryList,
  savedQuerySave,
  type SavedQuery,
  type SavedQueryInput,
} from "./api";

interface SavedQueriesFeatureState {
  savedQueries: SavedQuery[];
  /** True once the first load() settled — gates empty-state rendering. */
  loaded: boolean;
  /**
   * Human message when the backend itself failed to read the store
   * (structured AppError, e.g. a corrupt file) — null when load succeeded or
   * there is no Tauri at all (plain browser dev).
   */
  loadError: string | null;
  /** Fetch the store from the backend. Safe to call on every mount. */
  load: () => Promise<void>;
  /**
   * Insert or update a saved query (omit id / send "" for new entries) and
   * return the stored value with its assigned id. Rejections bubble to the
   * caller for inline display.
   */
  save: (query: SavedQueryInput) => Promise<SavedQuery>;
  /** Delete a saved query. Rejections bubble to the caller. */
  remove: (id: string) => Promise<void>;
}

export const useSavedQueriesStore = create<SavedQueriesFeatureState>((set) => ({
  savedQueries: [],
  loaded: false,
  loadError: null,

  load: async () => {
    try {
      const savedQueries = await savedQueryList();
      set({ savedQueries, loaded: true, loadError: null });
    } catch (error) {
      if (isAppErrorPayload(error)) {
        // The backend is there but could not read the store (corrupt file,
        // I/O failure) — be honest about it instead of presenting a
        // convincing-but-false empty list.
        set({ savedQueries: [], loaded: true, loadError: error.message });
      } else {
        // Not running inside Tauri (plain browser dev) — present an empty
        // list so the UI still renders (pattern from
        // features/connections/state.ts).
        set({ savedQueries: [], loaded: true, loadError: null });
      }
    }
  },

  save: async (query) => {
    const stored = await savedQuerySave(query);
    set((state) => ({
      savedQueries: state.savedQueries.some((q) => q.id === stored.id)
        ? state.savedQueries.map((q) => (q.id === stored.id ? stored : q))
        : [...state.savedQueries, stored],
      // A successful save proves the backend store is reachable, so the
      // empty-state gate may open even if load() hasn't settled yet.
      loaded: true,
    }));
    return stored;
  },

  remove: async (id) => {
    await savedQueryDelete(id);
    set((state) => ({
      savedQueries: state.savedQueries.filter((q) => q.id !== id),
    }));
  },
}));

/**
 * Queries visible from a given workspace: every GLOBAL query (null/absent
 * `connectionId`) plus those attached to that workspace's saved connection.
 *
 * Pass `workspace.saved.id` (the persisted SavedConnection id) as
 * `connectionId`. A query is included when it is global OR its `connectionId`
 * matches. This is a pure selector over the full list — Task 2's renderer
 * calls it; the store itself keeps holding ALL queries.
 */
export function selectQueriesForConnection(
  queries: SavedQuery[],
  connectionId: string,
): SavedQuery[] {
  return queries.filter((q) => q.connectionId == null || q.connectionId === connectionId);
}
