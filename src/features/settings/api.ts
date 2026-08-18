// The settings contract (M20 DEFAULTS) plus typed invoke() wrappers for the
// on-disk mirror commands. The renderer's localStorage copy is the source of
// truth (see cache.ts); these commands mirror it to a file so it survives a
// localStorage clear and is editable on disk.

import { invoke } from "@tauri-apps/api/core";

import {
  detectLocale,
  isLocaleId,
  REGIONS,
  type FirstDay,
  type LocaleId,
  type RegionId,
} from "../../shared/i18n";
import type { MonoFontId, ThemeId, UiFontId } from "./catalogs";

/** Rows fetched before paging. */
export type DefaultLimit = 100 | 300 | 1000;
/** Auto-refresh cadence in seconds. */
export type AutoRefreshSec = 5 | 10 | 30;
/** Connect budget in seconds — how long an unreachable server is waited on. */
export type ConnectTimeoutSec = 3 | 5 | 10 | 30;
export type Density = "compact" | "comfortable";
/** Which side the object-list sidebar renders on. */
export type SidebarSide = "left" | "right";
/**
 * How a sidebar's SCOPE switcher is presented (M36) — the control that picks a
 * SQL schema, a Cassandra keyspace or a MongoDB database. One setting for all
 * three: they are the same control wearing each engine's noun (`scopeNoun`).
 *
 * `"dropdown"` — the trigger names the current scope and opens a popover beside
 * it. The default, and the better fit for a handful of scopes.
 * `"icon"` — the trigger collapses to a single icon and opens the full list in
 * a searchable modal. Meant for connections with many scopes, where the popover
 * is a cramped scroll and the trigger crowds the row's action icons. The active
 * scope is still named in the status bar either way.
 */
export type ScopeSwitcher = "dropdown" | "icon";
export type TitlebarPosition =
  | "topLeftIcon"
  | "topRightIcon"
  | "bottomLeftIcon"
  | "bottomRightIcon";
/**
 * macOS window chrome for the custom title bar (ignored on Windows/Linux):
 * `"native"` = hiddenInset (OS-drawn traffic lights, our bar sits inset, the
 * app menu lives in the system bar); `"frameless"` = decorations:false (we draw
 * the traffic lights and the in-window menu bar).
 */
export type MacChrome = "native" | "frameless";
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
  /**
   * How long a connect attempt may take before it is abandoned. Read by the
   * BACKEND connect path (from the on-disk mirror), not by the renderer: it
   * bounds the driver work itself. Covers the whole attempt — SSH tunnel and
   * TLS handshake included — so raise it for bastions or slow links.
   */
  connectTimeoutSec: ConnectTimeoutSec;
  /**
   * List the engine's server-internal schemas (`mysql`, `pg_catalog`, `sys`,
   * …) in the sidebar's schema switcher. On by default — they are grouped
   * apart and read-only there. Toggled from the switcher itself.
   */
  showSystemSchemas: boolean;
  /**
   * Dropdown (default) or an icon that opens the scope list in a modal.
   * Presentation only — both offer the same actions.
   */
  scopeSwitcher: ScopeSwitcher;
  sidebarSide: SidebarSide;
  titlebarPosition: TitlebarPosition;
  /** macOS-only: which custom-titlebar chrome to use. */
  macChrome: MacChrome;
  /** Interface language (M31). Only the chrome is translated — never data. */
  locale: LocaleId;
  /** Date/number formats; `"auto"` follows the language's own region. */
  region: RegionId;
  hour12: boolean;
  firstDay: FirstDay;
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
  connectTimeoutSec: 5,
  showSystemSchemas: true,
  scopeSwitcher: "dropdown",
  sidebarSide: "left",
  titlebarPosition: "topLeftIcon",
  macChrome: "native",
  // English is the contract default; a FIRST RUN (nothing stored at all) starts
  // from the OS languages instead — see `mergeSettings` / `initialSettings`.
  locale: "en",
  region: "auto",
  hour12: false,
  firstDay: "auto",
};

/** Valid `region` ids, for validating a stored (or hand-edited) blob. */
const REGION_IDS = new Set<string>(REGIONS.map((r) => r.id));
/** Valid `firstDay` ids. */
const FIRST_DAYS = new Set<string>(["auto", "mon", "sun", "sat"]);

/**
 * The settings a profile starts from when NOTHING is stored — DEFAULTS, except
 * the interface language, which follows the OS. An explicit choice always wins
 * because it is persisted from the moment it is made.
 */
export function initialSettings(): Settings {
  return { ...DEFAULTS, locale: detectLocale() };
}

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
    // A blob written before M31 has no `locale` at all: that user has never
    // chosen a language, so treat it as a first run and follow the OS.
    if (!("locale" in stored)) merged.locale = detectLocale();
  }
  // The locale-ish keys are open string unions, so a stale or hand-edited value
  // would otherwise pass the typeof check above and reach Intl.
  if (!isLocaleId(merged.locale)) merged.locale = DEFAULTS.locale;
  if (!REGION_IDS.has(merged.region)) merged.region = DEFAULTS.region;
  if (!FIRST_DAYS.has(merged.firstDay)) merged.firstDay = DEFAULTS.firstDay;
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
