// Zustand store for the preferences slice.

import { create } from "zustand";

import { defaultPreferences, prefsGet, prefsSet, type Preferences } from "./api";
import { applyTheme } from "./applyTheme";

interface PreferencesSliceState {
  preferences: Preferences;
  loaded: boolean;
  /** Load persisted preferences from the backend and apply the theme. */
  load: () => Promise<void>;
  /** Optimistically apply new preferences, then persist them. */
  setPreferences: (preferences: Preferences) => Promise<void>;
}

export const usePreferencesStore = create<PreferencesSliceState>((set) => ({
  preferences: defaultPreferences,
  loaded: false,

  load: async () => {
    let preferences = defaultPreferences;
    try {
      preferences = await prefsGet();
    } catch {
      // Not running inside Tauri (plain browser dev) or the backend failed —
      // fall back to defaults so the app still renders.
    }
    applyTheme(preferences);
    set({ preferences, loaded: true });
  },

  setPreferences: async (preferences) => {
    set({ preferences });
    applyTheme(preferences);
    try {
      await prefsSet(preferences);
    } catch {
      // Persistence is best-effort outside Tauri; the in-memory state and
      // applied theme remain valid for the session.
    }
  },
}));
