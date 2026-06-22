// localStorage fast-path for settings. This copy is the renderer's source of
// truth (M20.1): it is read synchronously before React mounts so there is no
// flash of the default theme, and it is what "hand-edit localStorage and
// reload" exercises. The Tauri JSON file (api.ts) is only a mirror.

import { mergeSettings, type Settings } from "./api";

export const STORAGE_KEY = "bytetable.settings.v1";

/** Read + merge the cached settings, or `null` if nothing is cached. */
export function readCachedSettings(): Settings | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return mergeSettings(JSON.parse(raw));
  } catch {
    // Unparseable / unavailable storage — treat as no cache.
    return null;
  }
}

/** Write the settings to the localStorage fast-path. Best-effort. */
export function writeCachedSettings(settings: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage full / disabled — the in-memory state and disk mirror remain
    // valid for the session.
  }
}
