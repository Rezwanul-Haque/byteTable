// The i18n runtime (M31 Task 1) — the app's single localization layer, ported
// from the prototype's `i18n.js` (`window.BT_I18N`) to a module.
//
// Deliberately small: `t(key, vars)` with ICU-lite formatting ({name}
// interpolation plus one `plural` form) rather than a full ICU library, so the
// whole layer is one file plus one file per locale. If a full ICU
// implementation is swapped in later, keep this call signature — no call site
// should have to change.
//
// Resolution order for every key: current locale → English → the key itself.
// A key never renders as an empty string, and every fallback is recorded in
// `missingKeys()` so QA can find untranslated surfaces.
//
// Switching locale is synchronous and side-effectful (html[lang], html[dir],
// --ui-script, body.bt-rtl, script font) and then notifies subscribers, which
// is what lets a language change repaint the tree without remounting anything.

import {
  isLocaleId,
  LOCALES,
  REGIONS,
  type Dir,
  type FirstDay,
  type LocaleId,
  type LocaleMeta,
  type RegionId,
} from "./locales";
import { STRINGS, type StringKey } from "./strings";

export { LOCALES, REGIONS, isLocaleId };
export type { Dir, FirstDay, LocaleId, LocaleMeta, RegionId, StringKey };

/** Values interpolated into a string: `{name}` and `{count, plural, …}`. */
export type Vars = Record<string, string | number>;

// ---- runtime state -------------------------------------------------------

let current: LocaleId = "en";
let region: RegionId = "auto";
let hour12 = false;
let firstDay: FirstDay = "auto";

const listeners = new Set<(locale: LocaleId) => void>();
const seenMissing = new Set<string>();

/** Bumped on every locale change so React can subscribe with useSyncExternalStore. */
let version = 0;

export function localeMeta(code: LocaleId = current): LocaleMeta {
  return LOCALES[code] ?? LOCALES.en;
}

/**
 * The effective BCP-47 tag for the Intl formatters: an explicit region setting
 * wins, else the locale's own default region. `ISO` is not a real tag — it maps
 * to `en-CA`, whose numeric date format is `YYYY-MM-DD`.
 */
export function intlTag(): string {
  if (region && region !== "auto") return region === "ISO" ? "en-CA" : region;
  return localeMeta().region;
}

// ---- formatting ----------------------------------------------------------

/**
 * `{count, plural, one {…} other {…}}` — matched as a whole, arms included.
 *
 * The body is spelled out as a sequence of `category {text}` arms rather than
 * the prototype's `[^}]*(?:\{[^}]*\}[^}]*)*`: `[^}]` also matches `{`, so that
 * pattern greedily ate `one {# row` and stopped at the FIRST `}`, leaving
 * `other {# rows}}` in the output for every two-arm plural.
 */
const PLURAL_RE = /\{(\w+),\s*plural,\s*((?:\w+\s*\{[^{}]*\}\s*)+)\}/g;
/** One `category {text}` arm inside a plural body. */
const PLURAL_ARM_RE = /(\w+)\s*\{([^{}]*)\}/g;
/** A plain `{name}` placeholder. */
const VAR_RE = /\{(\w+)\}/g;

/**
 * ICU-lite interpolation. The plural category comes from `Intl.PluralRules` for
 * the effective tag — never `n === 1 ? … : …`, because Bengali, Arabic and
 * Chinese all categorize differently. `#` renders the localized count.
 */
export function format(template: string, vars?: Vars): string {
  if (!vars) return template;
  const withPlurals = template.replace(PLURAL_RE, (_match, key: string, body: string) => {
    const n = Number(vars[key]);
    const forms: Record<string, string> = {};
    body.replace(PLURAL_ARM_RE, (_arm, category: string, text: string) => {
      forms[category] = text;
      return "";
    });
    let category = "other";
    try {
      category = new Intl.PluralRules(intlTag()).select(n);
    } catch {
      category = n === 1 ? "one" : "other";
    }
    const picked = forms[category] ?? forms.other ?? "";
    return picked.replace(/#/g, fmtNumber(n));
  });
  return withPlurals.replace(VAR_RE, (match, key: string) =>
    vars[key] === undefined ? match : String(vars[key]),
  );
}

/** Translate `key`, interpolating `vars`. Falls back to English, then the key. */
export function t(key: StringKey, vars?: Vars): string {
  const table = STRINGS[current] ?? STRINGS.en;
  let str: string | undefined = table[key];
  if (str === undefined) {
    str = STRINGS.en[key];
    // A real English string exists — this locale simply hasn't translated it.
    if (str !== undefined && current !== "en") seenMissing.add(`${current}::${key}`);
  }
  if (str === undefined) {
    // Not even English has it: render the key so the surface is still readable.
    seenMissing.add(`MISSING::${key}`);
    return key;
  }
  return format(str, vars);
}

/** Whether the CURRENT locale translates `key` (English fallbacks don't count). */
export function has(key: StringKey): boolean {
  return (STRINGS[current] ?? {})[key] !== undefined;
}

/** Translated keys ÷ English keys, as a whole percentage. Drives the picker bars. */
export function coverage(code: LocaleId): number {
  if (code === "en") return 100;
  const base = Object.keys(STRINGS.en).length;
  const table = STRINGS[code] ?? {};
  const have = Object.keys(table).filter((k) => k in STRINGS.en).length;
  return Math.round((have / base) * 100);
}

/** Every key that fell back this session, as `<locale>::<key>` (QA aid). */
export function missingKeys(): string[] {
  return [...seenMissing];
}

// ---- Intl wrappers -------------------------------------------------------

export function fmtNumber(n: number, opts?: Intl.NumberFormatOptions): string {
  try {
    return new Intl.NumberFormat(intlTag(), opts).format(n);
  } catch {
    return String(n);
  }
}

export function fmtDate(value: Date | string | number, opts?: Intl.DateTimeFormatOptions): string {
  const date = value instanceof Date ? value : new Date(value);
  // ISO 8601 is a format, not a locale: force the numeric form whatever
  // dateStyle the caller asked for. en-CA renders YYYY-MM-DD in LOCAL time
  // (toISOString would shift the day for anyone east or west of UTC).
  if (region === "ISO") {
    try {
      return new Intl.DateTimeFormat("en-CA", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(date);
    } catch {
      return date.toISOString().slice(0, 10);
    }
  }
  try {
    return new Intl.DateTimeFormat(intlTag(), opts ?? { dateStyle: "medium" }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

export function fmtTime(value: Date | string | number): string {
  const date = value instanceof Date ? value : new Date(value);
  try {
    return new Intl.DateTimeFormat(intlTag(), {
      hour: "2-digit",
      minute: "2-digit",
      hour12,
    }).format(date);
  } catch {
    return date.toISOString().slice(11, 16);
  }
}

export function fmtRelative(value: number, unit: Intl.RelativeTimeFormatUnit = "day"): string {
  try {
    return new Intl.RelativeTimeFormat(intlTag(), { numeric: "auto" }).format(value, unit);
  } catch {
    return `${value} ${unit}`;
  }
}

/** Explicit first-day settings, as ISO-8601 weekday numbers (Mon = 1 … Sun = 7). */
const FIRST_DAY_NUMBER: Record<Exclude<FirstDay, "auto">, number> = { mon: 1, sat: 6, sun: 7 };

/**
 * First day of the week as an ISO weekday number (Mon = 1 … Sun = 7): the
 * user's explicit choice, else the region's own convention via
 * `Intl.Locale.weekInfo`, else a small fallback table for engines without it.
 */
export function firstDayOf(): number {
  if (firstDay !== "auto") return FIRST_DAY_NUMBER[firstDay];
  try {
    const info = (new Intl.Locale(intlTag()) as Intl.Locale & { weekInfo?: { firstDay?: number } })
      .weekInfo;
    if (info?.firstDay) return info.firstDay;
  } catch {
    // No weekInfo in this engine — fall through to the table.
  }
  const tag = intlTag();
  if (/^ar/.test(tag)) return 6; // Saturday
  if (/^(en-US|ja)/.test(tag)) return 7; // Sunday
  return 1; // Monday — the ISO default, and most of the world
}

// ---- script fonts --------------------------------------------------------

// Deliberately a local injector rather than settings/fonts.ts: `shared/` must
// not depend on a feature slice. Nothing loads for Latin locales.
//
// This is the same sanctioned network exception the curated fonts already use
// (settings/fonts.ts) — the Google Fonts CDN is the only remote origin the CSP
// in tauri.conf.json allows. If the font cannot be fetched (offline), the UI
// falls back to the platform's own CJK / Bengali / Arabic faces: the text still
// renders, it just isn't Noto.
const loadedScripts = new Set<string>();

/** Inject the Noto family for `code`'s script, once. No-op for Latin locales. */
export function ensureScriptFont(code: LocaleId): void {
  const family = localeMeta(code).google;
  if (!family || loadedScripts.has(family)) return;
  loadedScripts.add(family);
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `https://fonts.googleapis.com/css2?family=${family}&display=swap`;
  document.head.appendChild(link);
}

// ---- switching -----------------------------------------------------------

export interface LocaleOptions {
  region?: RegionId;
  hour12?: boolean;
  firstDay?: FirstDay;
}

/**
 * Switch locale (and the format options that travel with it). Synchronous: by
 * the time this returns, the document is in the right language, direction and
 * script font, so a caller can rely on the very next paint being correct.
 */
export function setLocale(code: string, opts?: LocaleOptions): void {
  current = isLocaleId(code) ? code : "en";
  if (opts?.region !== undefined) region = opts.region;
  if (opts?.hour12 !== undefined) hour12 = opts.hour12;
  if (opts?.firstDay !== undefined) firstDay = opts.firstDay;

  const meta = localeMeta(current);
  ensureScriptFont(current);

  const root = document.documentElement;
  root.setAttribute("lang", current);
  root.setAttribute("dir", meta.dir);
  // --ui-script is prepended to --ui (see settings/apply.ts), so the script
  // family wins over the Latin UI font. The MONO stack is never touched: code
  // stays in the user's chosen mono face.
  root.style.setProperty("--ui-script", meta.script ? `${meta.script}, ` : "");
  // Guarded: the pre-mount bootstrap can run before <body> exists.
  document.body?.classList.toggle("bt-rtl", meta.dir === "rtl");

  version += 1;
  listeners.forEach((fn) => {
    try {
      fn(current);
    } catch {
      // A broken subscriber must not stop the others from repainting.
    }
  });
}

/** Subscribe to locale changes. Returns an unsubscribe. */
export function onChange(fn: (locale: LocaleId) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** useSyncExternalStore pair (see useT.ts). */
export function subscribe(fn: () => void): () => void {
  return onChange(fn);
}
export function getLocaleVersion(): number {
  return version;
}

export function getLocale(): LocaleId {
  return current;
}
export function getDir(): Dir {
  return localeMeta().dir;
}
export function getRegion(): RegionId {
  return region;
}

// ---- first run -----------------------------------------------------------

/** Chinese navigator tags carry a region, not a script, far more often than not. */
function chineseVariant(tag: string): LocaleId | null {
  const lower = tag.toLowerCase();
  if (!lower.startsWith("zh")) return null;
  if (/hant|-tw|-hk|-mo/.test(lower)) return "zh-Hant";
  return "zh-Hans";
}

/**
 * Best match for the OS languages: exact tag, then Chinese script, then the
 * base language, else English. Only consulted on first run — an explicit choice
 * always wins, because it is persisted with the rest of the settings.
 */
export function detectLocale(tags: readonly string[] = navigator.languages ?? []): LocaleId {
  for (const tag of tags) {
    if (isLocaleId(tag)) return tag;
    const zh = chineseVariant(tag);
    if (zh) return zh;
    const base = tag.split("-")[0];
    if (base && isLocaleId(base)) return base;
  }
  return "en";
}
