// Liquid Glass's wallpaper (M38 Task 2) — the image the whole theme takes its
// colour from.
//
// Three choices: the bundled default, one of the user's own, or none. The
// custom image is COPIED into the app's config directory by the backend
// (`wallpaper_set`) and referenced by path — never inlined into the settings
// blob. The prototype stores a downscaled data URL in localStorage because a
// browser has nowhere else to put it; a desktop app does, and a multi-megabyte
// data URL in `settings.json` would bloat the file every other preference
// shares and risk corrupting it.
//
// The resolved CSS url() is cached in localStorage so the pre-mount apply (see
// bootstrap.ts) can paint the wallpaper on the first frame, before the async
// backend round-trip that confirms the file is still there.

import { convertFileSrc, invoke } from "@tauri-apps/api/core";

// WebP, and 3200x2400 rather than the 617x1600 portrait PNG this replaced.
// `cover` on a landscape window scaled that one up to 4.9x on a Retina display,
// and it was a 256-COLOUR PALETTE image, so the quantisation steps stretched
// into visible flat-edged patches — the "low quality" look. It also cropped 76%
// of its own height away, spending three quarters of the file on pixels nobody
// saw. This one is 24-bit, framed 4:3 (the band `cover` actually shows, on
// every window shape), smoothed — the backdrop is viewed through blur(30px)
// anyway, so fine structure was only ever artefacts — and dithered so the flat
// areas cannot band. 59 KB, smaller than the 85 KB it replaces.
import defaultWallpaper from "../../assets/wallpapers/liquid-default.webp";

/** Cached `url(...)` for the pre-mount apply. Its own key, like the splash. */
const WALL_CACHE_KEY = "bytetable.wallpaper-url.v1";

/** The bundled image, as a bundler-resolved URL. */
export const DEFAULT_WALLPAPER = defaultWallpaper;

/** The last resolved wallpaper URL, or null when nothing is cached yet. */
export function cachedWallpaperUrl(): string | null {
  try {
    return localStorage.getItem(WALL_CACHE_KEY);
  } catch {
    return null;
  }
}

function cacheWallpaperUrl(url: string | null): void {
  try {
    if (url === null) localStorage.removeItem(WALL_CACHE_KEY);
    else localStorage.setItem(WALL_CACHE_KEY, url);
  } catch {
    // Storage disabled/full — the next launch just resolves it again.
  }
}

/**
 * The CSS `background-image` value for a wallpaper choice, resolved against
 * what is actually on disk. `"custom"` with no stored file falls back to the
 * bundled image rather than leaving the window blank — a file can disappear
 * between launches, and an empty window is not a usable failure mode.
 */
export async function resolveWallpaper(choice: string): Promise<string> {
  if (choice === "none") {
    cacheWallpaperUrl(null);
    return "none";
  }
  if (choice === "custom") {
    try {
      const path = await invoke<string | null>("wallpaper_path_get");
      if (path) {
        // A cache-buster: the path never changes (one fixed filename), so the
        // webview would otherwise keep showing the previous image after a
        // replace.
        const value = `url("${convertFileSrc(path)}?v=${Date.now()}")`;
        cacheWallpaperUrl(value);
        return value;
      }
    } catch {
      // Backend unavailable (browser dev) — fall through to the default.
    }
  }
  const value = `url("${DEFAULT_WALLPAPER}")`;
  cacheWallpaperUrl(value);
  return value;
}

/**
 * Copy `source` into the app's config directory as the custom wallpaper, and
 * return its CSS url(). Throws with a human message the caller can toast.
 */
export async function storeCustomWallpaper(source: string): Promise<string> {
  const path = await invoke<string>("wallpaper_set", { source });
  const value = `url("${convertFileSrc(path)}?v=${Date.now()}")`;
  cacheWallpaperUrl(value);
  return value;
}
