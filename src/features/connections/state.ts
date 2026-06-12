// Zustand store for the saved-connection registry. Mutations (save/remove)
// go backend-first, then patch the in-memory list from the backend's reply —
// the registry file is the source of truth, never optimistic state.

import { create } from "zustand";

import { connectionDelete, connectionList, connectionSave, type SavedConnection } from "./api";

interface ConnectionsFeatureState {
  savedConnections: SavedConnection[];
  /** True once the first load() settled — gates the connect screen's empty state. */
  loaded: boolean;
  /** Fetch the registry from the backend. Safe to call on every mount. */
  load: () => Promise<void>;
  /**
   * Insert or update a saved connection (send id "" for new entries) and
   * return the stored value with its assigned id. Used by the file-open
   * auto-save now and the new-connection modal in Task 3. Rejections bubble
   * to the caller for inline display.
   */
  save: (connection: SavedConnection) => Promise<SavedConnection>;
  /** Delete a saved connection. Rejections bubble to the caller. */
  remove: (id: string) => Promise<void>;
}

export const useConnectionsStore = create<ConnectionsFeatureState>((set) => ({
  savedConnections: [],
  loaded: false,

  load: async () => {
    let savedConnections: SavedConnection[] = [];
    try {
      savedConnections = await connectionList();
    } catch {
      // Not running inside Tauri (plain browser dev) or the backend failed —
      // present an empty registry so the connect screen still renders
      // (pattern from features/preferences/state.ts).
    }
    set({ savedConnections, loaded: true });
  },

  save: async (connection) => {
    const stored = await connectionSave(connection);
    set((state) => ({
      savedConnections: state.savedConnections.some((c) => c.id === stored.id)
        ? state.savedConnections.map((c) => (c.id === stored.id ? stored : c))
        : [...state.savedConnections, stored],
      loaded: true,
    }));
    return stored;
  },

  remove: async (id) => {
    await connectionDelete(id);
    set((state) => ({
      savedConnections: state.savedConnections.filter((c) => c.id !== id),
    }));
  },
}));
