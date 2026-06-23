// Zustand store for the settings slice (M20). localStorage is the source of
// truth; the Tauri JSON file is a mirror that survives a localStorage clear and
// is editable on disk.
//
// Persistence on every change writes both: the localStorage fast-path (read
// before mount next launch) and the disk mirror (best-effort; absent in plain
// browser dev).

import { create } from "zustand";

import { DEFAULTS, settingsLoad, settingsSave, type Settings } from "./api";
import { applySettings } from "./apply";
import { readCachedSettings, writeCachedSettings } from "./cache";
import { broadcastSettings } from "./sync";
import { applyZoom } from "./zoom";

interface SettingsFeatureState {
  settings: Settings;
  loaded: boolean;
  /** Reconcile the localStorage fast-path with the on-disk mirror and apply. */
  load: () => Promise<void>;
  /** Change one setting: apply, cache, and mirror to disk. */
  setSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  /** Restore every setting to DEFAULTS. */
  reset: () => void;
  /** Adopt settings broadcast by another window: apply + cache, but do NOT
   *  re-save or re-broadcast (that would loop). */
  syncExternal: (settings: Settings) => void;
}

/** Apply + persist a fully-resolved settings object (both fast-path + mirror)
 *  and broadcast it to other windows. */
function persist(settings: Settings): void {
  applySettings(settings);
  applyZoom(settings.fontSize);
  writeCachedSettings(settings);
  // Best-effort disk mirror. Swallows "not running inside Tauri" (plain browser
  // dev) and real write errors alike; the in-memory state + cache stay valid.
  void settingsSave(settings).catch(() => {});
  // Tell other windows to re-apply (desktop multi-window; no-op elsewhere).
  broadcastSettings(settings);
}

export const useSettingsStore = create<SettingsFeatureState>((set, get) => ({
  settings: readCachedSettings() ?? DEFAULTS,
  loaded: false,

  load: async () => {
    const cached = readCachedSettings();
    if (cached) {
      // localStorage wins. Re-apply so body-class hooks (which the pre-mount
      // bootstrap may have skipped before <body> existed) are set, and refresh
      // the disk mirror so an out-of-sync file catches up.
      set((state) => (state.loaded ? state : { settings: cached, loaded: true }));
      if (get().settings === cached) persist(cached);
      return;
    }

    // No cache (fresh profile, or localStorage was cleared): fall back to the
    // on-disk mirror so settings survive a clear. In plain browser dev the
    // command rejects and we keep DEFAULTS.
    let fromDisk = DEFAULTS;
    try {
      fromDisk = await settingsLoad();
    } catch {
      // Not running inside Tauri, or the backend failed — DEFAULTS already
      // applied by the bootstrap; nothing more to do.
    }
    let applied = false;
    set((state) => {
      if (state.loaded) return state;
      applied = true;
      return { settings: fromDisk, loaded: true };
    });
    if (applied) {
      applySettings(fromDisk);
      applyZoom(fromDisk.fontSize);
      writeCachedSettings(fromDisk); // seed the fast-path for next launch.
    }
  },

  setSetting: (key, value) => {
    const next: Settings = { ...get().settings, [key]: value };
    set({ settings: next, loaded: true });
    persist(next);
  },

  reset: () => {
    const next = { ...DEFAULTS };
    set({ settings: next, loaded: true });
    persist(next);
  },

  syncExternal: (settings) => {
    set({ settings, loaded: true });
    applySettings(settings);
    applyZoom(settings.fontSize);
    writeCachedSettings(settings);
    // Deliberately no settingsSave / broadcast — the originating window
    // already did both; echoing would loop.
  },
}));
