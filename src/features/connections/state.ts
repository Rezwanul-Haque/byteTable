// Zustand store for the saved-connection registry. Mutations (save/remove)
// go backend-first, then patch the in-memory list from the backend's reply —
// the registry file is the source of truth, never optimistic state.

import { create } from "zustand";

import { isAppErrorPayload } from "../../shared/api/error";
import { normalizeEnv } from "../../shared/types";
import { connectionDelete, connectionList, connectionSave, type SavedConnection } from "./api";

/**
 * Read-boundary migration: map any persisted env onto the canonical set
 * (`local` → `dev`, pre-m15). Applied to everything the backend returns
 * (load + save reply) so the rest of the app only ever sees canonical envs.
 */
function migrate(connection: SavedConnection): SavedConnection {
  const env = normalizeEnv(connection.env);
  return env === connection.env ? connection : { ...connection, env };
}

interface ConnectionsFeatureState {
  savedConnections: SavedConnection[];
  /** True once the first load() settled — gates the connect screen's empty state. */
  loaded: boolean;
  /**
   * Human message when the backend itself failed to read the registry
   * (structured AppError) — null when load succeeded or there is no Tauri at
   * all (plain browser dev). The connect screen renders it instead of the
   * empty-state copy.
   */
  loadError: string | null;
  /** Fetch the registry from the backend. Safe to call on every mount. */
  load: () => Promise<void>;
  /**
   * Insert or update a saved connection (send id "" for new entries) and
   * return the stored value with its assigned id. `secrets` are the transient
   * db password / SSH secret the new-connection modal typed (M12 Task 3) —
   * stored in the OS keychain by the backend, never in the registry file;
   * omitted (e.g. the SQLite file-open auto-save) when there are none.
   * Rejections bubble to the caller for inline display.
   */
  save: (
    connection: SavedConnection,
    secrets?: { password?: string; sshSecret?: string },
  ) => Promise<SavedConnection>;
  /** Delete a saved connection. Rejections bubble to the caller. */
  remove: (id: string) => Promise<void>;
}

export const useConnectionsStore = create<ConnectionsFeatureState>((set) => ({
  savedConnections: [],
  loaded: false,
  loadError: null,

  load: async () => {
    try {
      const savedConnections = (await connectionList()).map(migrate);
      set({ savedConnections, loaded: true, loadError: null });
    } catch (error) {
      if (isAppErrorPayload(error)) {
        // The backend is there but could not read the registry (corrupt
        // file, I/O failure) — be honest about it instead of presenting a
        // convincing-but-false empty registry.
        set({ savedConnections: [], loaded: true, loadError: error.message });
      } else {
        // Not running inside Tauri (plain browser dev) — present an empty
        // registry so the connect screen still renders (pattern from
        // features/preferences/state.ts).
        set({ savedConnections: [], loaded: true, loadError: null });
      }
    }
  },

  save: async (connection, secrets) => {
    const stored = migrate(await connectionSave(connection, secrets));
    set((state) => ({
      savedConnections: state.savedConnections.some((c) => c.id === stored.id)
        ? state.savedConnections.map((c) => (c.id === stored.id ? stored : c))
        : [...state.savedConnections, stored],
      // A successful save proves the backend registry is reachable, so the
      // empty-state gate may open even if load() hasn't settled yet.
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
