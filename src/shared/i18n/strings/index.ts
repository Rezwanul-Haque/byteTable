// The per-locale string tables, keyed by locale id. One file per locale so a
// contributor only ever touches theirs.

import type { LocaleId } from "../locales";
import { ar } from "./ar";
import { bn } from "./bn";
import { de } from "./de";
import { en, type StringTable } from "./en";
import { es } from "./es";
import { ja } from "./ja";
import { zhHans } from "./zh-Hans";
import { zhHant } from "./zh-Hant";

export const STRINGS: Record<LocaleId, StringTable> = {
  en,
  bn,
  es,
  de,
  ja,
  "zh-Hans": zhHans,
  "zh-Hant": zhHant,
  ar,
};

export { en };
export type { StringKey, StringTable } from "./en";
