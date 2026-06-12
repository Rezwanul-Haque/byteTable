// Zustand store for the preferences slice.

import { create } from "zustand";

import { defaultPreferences, prefsGet, prefsSet, type Preferences } from "./api";
import { applyTheme } from "./applyTheme";

interface PreferencesFeatureState {
  preferences: Preferences;
  loaded: boolean;
  /** Load persisted preferences from the backend and apply the theme. */
  load: () => Promise<void>;
  /** Optimistically apply new preferences, then persist them. */
  setPreferences: (preferences: Preferences) => Promise<void>;
}

export const usePreferencesStore = create<PreferencesFeatureState>((set) => ({
  preferences: defaultPreferences,
  loaded: false,

  load: async () => {
    let preferences = defaultPreferences;
    try {
      preferences = await prefsGet();
    } catch {
      // Not running inside Tauri (plain browser dev) or the backend failed —
      // fall back to defaults so the app still renders.
      // TODO(toast surface, later milestone): real backend errors are
      // swallowed here too; the structured payload to inspect is
      // AppErrorPayload in src/shared/api/error.ts.
    }
    // Guard against the load/set race: if a user set (or another load)
    // already marked the store loaded while we were awaiting, that choice
    // supersedes this stale result — discard it.
    let applied = false;
    set((state) => {
      if (state.loaded) return state;
      applied = true;
      return { preferences, loaded: true };
    });
    if (applied) {
      applyTheme(preferences);
    }
  },

  setPreferences: async (preferences) => {
    // A user choice supersedes any in-flight load: marking loaded here makes
    // load() discard its result if it resolves after this.
    set({ preferences, loaded: true });
    applyTheme(preferences);
    try {
      await prefsSet(preferences);
    } catch {
      // Swallows both "not running inside Tauri" (plain browser dev) and
      // real backend persistence failures — the in-memory state and applied
      // theme remain valid for the session, but a genuine write error is
      // currently invisible to the user. A toast surface arrives in a later
      // milestone (see AppErrorPayload in src/shared/api/error.ts).
    }
  },
}));
