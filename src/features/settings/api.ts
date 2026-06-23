// The settings contract (M20 DEFAULTS) plus typed invoke() wrappers for the
// on-disk mirror commands. The renderer's localStorage copy is the source of
// truth (see cache.ts); these commands mirror it to a file so it survives a
// localStorage clear and is editable on disk.

import { invoke } from "@tauri-apps/api/core";

import type { MonoFontId, ThemeId, UiFontId } from "./catalogs";

/** Rows fetched before paging. */
export type DefaultLimit = 100 | 300 | 1000;
/** Auto-refresh cadence in seconds. */
export type AutoRefreshSec = 5 | 10 | 30;
export type Density = "compact" | "comfortable";
/** Which side the object-list sidebar renders on. */
export type SidebarSide = "left" | "right";
/** `"auto"` (theme's own accent) or a `#rrggbb` hex string. */
export type Accent = "auto" | string;
/** Curated mono key or a probed `"sys:<Family>"` id. */
export type MonoFont = MonoFontId | string;

export interface Settings {
  theme: ThemeId;
  accent: Accent;
  monoFont: MonoFont;
  uiFont: UiFontId;
  /** Monospace base size in px (editor); grid renders at fontSize - 1. */
  fontSize: number;
  density: Density;
  ligatures: boolean;
  reduceMotion: boolean;
  highlightRow: boolean;
  relativeTime: boolean;
  confirmProd: boolean;
  defaultLimit: DefaultLimit;
  restoreTabs: boolean;
  /** Periodically refresh the sidebar object list (+ Redis keyspace). */
  autoRefresh: boolean;
  autoRefreshSec: AutoRefreshSec;
  sidebarSide: SidebarSide;
}

/** The single source of truth for the contract shape and default values. */
export const DEFAULTS: Settings = {
  theme: "charcoal",
  accent: "auto",
  monoFont: "jetbrains",
  uiFont: "plexSans",
  fontSize: 13,
  density: "compact",
  ligatures: true,
  reduceMotion: false,
  highlightRow: true,
  relativeTime: false,
  confirmProd: true,
  defaultLimit: 300,
  restoreTabs: true,
  autoRefresh: true,
  autoRefreshSec: 10,
  sidebarSide: "left",
};

/**
 * Merge a stored (possibly partial or old) blob over DEFAULTS. Unknown keys
 * are dropped; missing keys fall back to the default. This is the renderer-side
 * mirror of the Rust domain's `#[serde(default)]` forward-merge.
 */
export function mergeSettings(stored: unknown): Settings {
  const merged: Settings = { ...DEFAULTS };
  if (stored && typeof stored === "object") {
    for (const key of Object.keys(DEFAULTS) as (keyof Settings)[]) {
      const value = (stored as Record<string, unknown>)[key];
      if (value !== undefined && typeof value === typeof DEFAULTS[key]) {
        // Type matches the default's primitive type — accept it.
        (merged as unknown as Record<string, unknown>)[key] = value;
      }
    }
  }
  return merged;
}

/** Load the on-disk settings mirror (fallback when localStorage is empty). */
export function settingsLoad(): Promise<Settings> {
  return invoke<Settings>("settings_load");
}

/** Mirror the current settings to disk. */
export function settingsSave(settings: Settings): Promise<void> {
  return invoke("settings_save", { settings });
}
