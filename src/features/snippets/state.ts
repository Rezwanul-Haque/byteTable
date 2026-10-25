// Zustand store for the global snippet library. Mutations (save/remove) go
// backend-first, then patch the in-memory list from the backend's reply — the
// JSON store is the source of truth, never optimistic state.
//
// GLOBAL store, not per-workspace: there is one instance for the whole app,
// holding ALL snippets regardless of engine restriction. This store does no
// filtering — `selectSnippetsForEngine` below is what the editor and the
// manager use to narrow the list.
//
// Mirrors features/saved_queries/state.ts deliberately: same load-once gate,
// same "not running inside Tauri" fallback, same bubbling of save/remove
// rejections to the caller for inline display.

import { create } from "zustand";

import { isAppErrorPayload } from "../../shared/api/error";
import type { Engine } from "../../shared/types";
import { snippetDelete, snippetList, snippetSave, type Snippet, type SnippetInput } from "./api";

interface SnippetsFeatureState {
  snippets: Snippet[];
  /** True once the first load() settled — gates empty-state rendering. */
  loaded: boolean;
  /**
   * Human message when the backend itself failed to read the store
   * (structured AppError, e.g. a corrupt file) — null when load succeeded or
   * there is no Tauri at all (plain browser dev).
   */
  loadError: string | null;
  /** Fetch the library from the backend. Safe to call on every mount. */
  load: () => Promise<void>;
  /**
   * Insert or update a snippet (omit id / send "" for new entries) and return
   * the stored value with its assigned id. Rejections bubble to the caller.
   */
  save: (snippet: SnippetInput) => Promise<Snippet>;
  /** Delete a snippet. Rejections bubble to the caller. */
  remove: (id: string) => Promise<void>;
}

export const useSnippetsStore = create<SnippetsFeatureState>((set, get) => ({
  snippets: [],
  loaded: false,
  loadError: null,

  load: async () => {
    // Idempotent: a settled load short-circuits, so callers (every SQL-tab
    // mount, every manager open) can call this freely without redundant IPC.
    if (get().loaded) return;
    try {
      const snippets = await snippetList();
      set({ snippets, loaded: true, loadError: null });
    } catch (error) {
      if (isAppErrorPayload(error)) {
        // The backend is there but could not read the store (corrupt file, I/O
        // failure) — be honest about it instead of presenting a
        // convincing-but-false empty library.
        set({ snippets: [], loaded: true, loadError: error.message });
      } else {
        // Not running inside Tauri (plain browser dev) — present an empty list
        // so the UI still renders.
        set({ snippets: [], loaded: true, loadError: null });
      }
    }
  },

  save: async (snippet) => {
    const stored = await snippetSave(snippet);
    set((state) => ({
      snippets: state.snippets.some((s) => s.id === stored.id)
        ? state.snippets.map((s) => (s.id === stored.id ? stored : s))
        : [...state.snippets, stored],
      // A successful save proves the backend store is reachable, so the
      // empty-state gate may open even if load() hasn't settled yet.
      loaded: true,
    }));
    return stored;
  },

  remove: async (id) => {
    await snippetDelete(id);
    set((state) => ({ snippets: state.snippets.filter((s) => s.id !== id) }));
  },
}));

/**
 * Snippets offered in a given engine's workspace: the unrestricted ones plus
 * those restricted to that engine.
 *
 * The engine field is a DIALECT filter, so the rule is the mirror image of
 * saved queries' workspace attachment: `SHOW CREATE TABLE` belongs in a MySQL
 * workspace and would only be noise in a Postgres one.
 */
export function selectSnippetsForEngine(snippets: Snippet[], engine: Engine): Snippet[] {
  return snippets.filter((s) => s.engine == null || s.engine === engine);
}
