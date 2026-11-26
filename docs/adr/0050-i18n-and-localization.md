# ADR-0050 — In-house i18n runtime with per-locale string tables, RTL and per-script fonts

- **Status:** Accepted (retroactive — documented 2026-11-26 from the shipped implementation)
- **Date:** 2026-08-11 (`e0e63ce feat: #32 add interface localization with region formats, RTL and per-script fonts`; full string wiring + complete zh-Hans in `128078f`, 2026-10-11)
- **Area:** App shell
- **Related:** ADR-0049, ADR-0053, ADR-0054, `docs/TRANSLATING.md`, `docs/i18n-zh-hans-audit.md`

## Context

ByteTable needed a translated interface, but only the chrome is translated. `docs/TRANSLATING.md`
says schema names, identifiers, cell values, query text and engine responses are never rewritten.
Contributors should be able to translate one language by editing one file, and a partial
translation should be usable. A language switch must not remount the tree, because that would
drop open tabs, grid scroll positions and terminal sessions. Arabic needs RTL. Bengali, Japanese,
Chinese and Arabic need fonts other than the bundled Latin IBM Plex Sans.

## Decision

- **One small runtime module.** `src/shared/i18n/index.ts` provides `t(key, vars)` with ICU-lite
  formatting: `{name}` interpolation and one `plural` form whose category comes from
  `Intl.PluralRules`, plus exact `=N` arms. Lookup order is current locale → English → the key
  itself, so a string is never empty. Every fallback is recorded in `missingKeys()` for QA.
- **English defines the key set.** `strings/en.ts` exports `StringKey = keyof typeof en`. Every
  other locale is a `StringTable = Partial<Record<StringKey, string>>`, so a typo in a key fails
  `tsc`. Keys are dotted namespaces (`common.*`, `menu.*`, `set.*`, `ai.*`, …). Callers pass
  parameters and never concatenate keys into sentences.
- **Eight locales** (`locales.ts::LOCALES`): `en`, `bn`, `es`, `de`, `ja`, `zh-Hans`, `zh-Hant`,
  `ar`. Only `zh-Hans` is complete. `strings.test.ts` asserts that zh-Hans covers exactly the
  English key set in both directions, that no locale adds a key English lacks, and that
  placeholder signatures match. The others hold about 110 keys each. `coverage(code)` shows the
  percentage in the language picker.
- **React binding without a provider.** `useT()` (`useT.ts`) reads a locale version through
  `useSyncExternalStore`. It returns one function identity per locale, so memos that depend on
  `t` rebuild after a switch and stay stable between switches. Non-React modules
  (`titlebarMenus.ts`, `report_issue/api.ts`) call `t()` at build time, and their React hosts
  subscribe.
- **Switching is synchronous DOM work.** `setLocale` sets `html[lang]`, `html[dir]`,
  `--ui-script` (prepended to `--ui`, never to the mono stack) and `body.bt-rtl`, then notifies
  subscribers. The locale is part of `Settings` (`locale`, `region`, `hour12`, `firstDay`) and is
  applied in the pre-mount bootstrap (ADR-0049), so the first frame is already in the right
  language and direction. The first run picks a locale with `detectLocale()` from
  `navigator.languages`, which includes mapping Chinese variants.
- **Per-script fonts on demand.** `ensureScriptFont` injects a Google Fonts `<link>` for the
  locale's Noto family, once. Latin locales load nothing. If the network is unavailable, the
  platform's own faces render the text.
- **Region formats separate from language.** `REGIONS` and `intlTag()` drive `fmtNumber`,
  `fmtDate`, `fmtTime`, `fmtRelative` and `firstDayOf`. `"auto"` follows the language's region.
  `"ISO"` maps to `en-CA` to get `YYYY-MM-DD`.
- **Native surfaces get labels from the renderer.** The tray menu is built in Rust, where the
  i18n layer does not reach. The renderer sends already-localized `TrayLabels` with `tray_update`
  (`src-tauri/src/lib.rs`), and Rust falls back to English until it receives them.

## Alternatives considered

- **A full i18n library (i18next, FormatJS).** The `index.ts` header says the layer is
  "deliberately small" so that it is one file plus one file per locale. It also keeps the call
  signature so a full ICU implementation could replace it without touching call sites.
- **A React context provider.** Inferred: rejected because a context change re-renders through
  the tree and `t` must also work outside React (menu models, issue templates). The module plus
  `useSyncExternalStore` covers both.
- **Bundling the Noto fonts.** Inferred: CJK fonts are large, and most users would download them
  for no benefit. Latin fonts are bundled through `@fontsource` (`src/main.tsx`).

## Consequences

- **Positive:** Contributors work in one file. Partial translations are usable. Language switches
  keep all UI state. The type system catches unknown keys.
- **Negative / trade-offs:** Only `en` and `zh-Hans` are complete. The other six fall back to
  English for most of the UI. The `zh-Hans` audit found that before `128078f` most components had
  hard-coded English, so full coverage depends on authors routing every new string through `t()`.
  Script fonts need network access to Google Fonts, which is allowed by the CSP in
  `src-tauri/tauri.conf.json`. Shortcut hints and the product name are not translated, by design.
- **Follow-ups:** Complete the six partial locales. RTL layout corrections exist in only a few
  stylesheets (`bt-rtl` appears in three CSS rules), so RTL polish is likely incomplete (inferred).
