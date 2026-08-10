// The locale catalog + the region list the Formats section offers (M31 Task 1,
// ported from the prototype's i18n.js `LOCALES` / `REGIONS`).
//
// `script` is the extra font family prepended to --ui for non-Latin UI text;
// `google` is the CSS2 family string used to fetch it on demand (nothing loads
// for Latin locales). `region` is the locale's default BCP-47 tag, used by the
// Intl formatters whenever the user leaves the region setting on "auto".

export type Dir = "ltr" | "rtl";

export interface LocaleMeta {
  /** English name, shown next to the endonym in the picker. */
  name: string;
  /** The language's own name for itself — always shown first. */
  endonym: string;
  dir: Dir;
  /** Default BCP-47 tag for Intl when region is "auto". */
  region: string;
  /** Font family prepended to --ui (quoted), for non-Latin scripts. */
  script?: string;
  /** Google Fonts CSS2 family string for `script`. */
  google?: string;
}

/** Every shipped locale. `en` is the source of truth for the string tables. */
export const LOCALES = {
  en: { name: "English", endonym: "English", dir: "ltr", region: "en-US" },
  bn: {
    name: "Bengali",
    endonym: "বাংলা",
    dir: "ltr",
    region: "bn-BD",
    script: "'Noto Sans Bengali'",
    google: "Noto+Sans+Bengali:wght@400;500;600",
  },
  es: { name: "Spanish", endonym: "Español", dir: "ltr", region: "es-ES" },
  de: { name: "German", endonym: "Deutsch", dir: "ltr", region: "de-DE" },
  ja: {
    name: "Japanese",
    endonym: "日本語",
    dir: "ltr",
    region: "ja-JP",
    script: "'Noto Sans JP'",
    google: "Noto+Sans+JP:wght@400;500;600",
  },
  "zh-Hans": {
    name: "Chinese (Simplified)",
    endonym: "简体中文",
    dir: "ltr",
    region: "zh-CN",
    script: "'Noto Sans SC'",
    google: "Noto+Sans+SC:wght@400;500;600",
  },
  "zh-Hant": {
    name: "Chinese (Traditional)",
    endonym: "繁體中文",
    dir: "ltr",
    region: "zh-TW",
    script: "'Noto Sans TC'",
    google: "Noto+Sans+TC:wght@400;500;600",
  },
  ar: {
    name: "Arabic",
    endonym: "العربية",
    dir: "rtl",
    region: "ar-SA",
    script: "'Noto Sans Arabic'",
    google: "Noto+Sans+Arabic:wght@400;500;600",
  },
} as const satisfies Record<string, LocaleMeta>;

export type LocaleId = keyof typeof LOCALES;

/** Runtime guard for a persisted / detected locale id. */
export function isLocaleId(value: unknown): value is LocaleId {
  return typeof value === "string" && value in LOCALES;
}

/**
 * Region choices for the Formats section. `auto` follows the language's own
 * default region; `ISO` is not a real BCP-47 tag — it maps to `en-CA` so dates
 * render as `YYYY-MM-DD` (see `intlTag()`).
 */
export const REGIONS = [
  { id: "auto", label: "Follow language" },
  { id: "en-US", label: "United States · en-US" },
  { id: "en-GB", label: "United Kingdom · en-GB" },
  { id: "bn-BD", label: "Bangladesh · bn-BD" },
  { id: "de-DE", label: "Germany · de-DE" },
  { id: "es-ES", label: "Spain · es-ES" },
  { id: "ja-JP", label: "Japan · ja-JP" },
  { id: "zh-CN", label: "中国大陆 · zh-CN" },
  { id: "zh-TW", label: "台灣 · zh-TW" },
  { id: "zh-HK", label: "香港 · zh-HK" },
  { id: "ar-SA", label: "Saudi Arabia · ar-SA" },
  { id: "ISO", label: "ISO 8601 · 2026-08-10" },
] as const;

export type RegionId = (typeof REGIONS)[number]["id"];

/** First day of the week: `auto` defers to the region's own convention. */
export type FirstDay = "auto" | "mon" | "sun" | "sat";
