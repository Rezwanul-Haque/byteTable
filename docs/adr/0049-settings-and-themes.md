# ADR-0049 — Settings store, pre-mount bootstrap and themes (incl. glass materials)

- **Status:** Accepted (retroactive — documented 2026-11-26 from the shipped implementation)
- **Date:** 2026-06-23 (`439aea1 feat: App settings added`; Frosted and Liquid Glass shipped 2026-10-10 in `dfaa270` / `4722885`)
- **Area:** App shell
- **Related:** ADR-0002, ADR-0005, ADR-0017, ADR-0048, ADR-0050, `docs/M20-settings.md`

## Context

Every engine surface reads the same CSS variables (`--bg0..3`, `--accent`, `--mono`, `--ui`,
`--grid-row-h`, …), so one global preferences store can restyle the whole app. That store has to
apply before the first paint, or the default palette flashes on screen before the saved theme
loads. M20 also asked that settings be local-first (no account, no sync), survive a localStorage
clear, and be editable as a file. Later releases added material themes: Frosted Glass and
Liquid Glass. Blur, specular edges and lensing cannot be expressed as palette values.

## Decision

- **localStorage is the source of truth, and the disk copy is a mirror.**
  `src/features/settings/cache.ts` reads and writes `bytetable.settings.v1`. The Rust slice
  `src-tauri/src/features/settings/` stores the same blob in `<app_config_dir>/settings.json`
  through the sync commands `settings_load` / `settings_save`. On every change, `state.ts` writes
  both. M20 states the split directly: "the renderer remains the source of truth and applies
  everything itself."
- **Forward-compatible merge in both layers.** `mergeSettings` lays the stored blob over `DEFAULTS`
  (`api.ts`). Each Rust field carries `#[serde(default = …)]` (`domain/mod.rs`), so older files load
  without error.
- **Synchronous bootstrap.** `src/main.tsx` imports `features/settings/bootstrap.ts` for its side
  effect before `createRoot`. That module runs `applySettings(readCachedSettings() ?? initialSettings())`.
  `apply.ts` writes `data-theme`, `data-material`, the palette variables, the accent and the fonts
  on `<html>`, and also applies the locale (ADR-0050), so the first frame has the right theme,
  language and direction. The disk mirror is reconciled asynchronously after mount.
- **Cross-window sync.** `sync.ts` emits a `settings-changed` Tauri event. Outside Tauri it is a no-op.
- **UI.** `components/SettingsModal.tsx` has eight tabs: appearance, fonts, grid, language,
  behavior, masking, history, ai. It opens from ⌘, (`App.tsx`), the rail gear, the title-bar File
  menu, or any `openSettings(tab)` call. The open tab lives in the store because the openers are
  spread across the tree (`state.ts`).
- **Themes are data plus attribute-scoped CSS.** `catalogs.ts::THEMES` holds 16 palettes (ByteTable,
  Editor and Light groups, plus `glass` and `liquidGlass`). A theme with `material: "frosted" | "liquid"`
  makes `applySettings` set `<html data-material>`:
  - `src/shared/styles/glass.css` keys on the presence of `data-material`. It defines three tiers
    by role: chrome at 5.5% white, floating at 78% (drawers 86%), cards at 7%. Text is never
    translucent.
  - `liquid.css` adds lensing on `[data-material="liquid"]`.
  - Both sheets are imported unconditionally in `main.tsx` and stay inert for flat palettes.
    Switching back to a flat palette removes the attribute, so nothing needs undoing.
- **Liquid Glass specifics.** The wallpaper is a CSS variable (`--lg-wall`), not an `<img>`.
  `wallpaper_set` copies a custom image into the app data dir, and `tauri.conf.json` scopes the
  asset protocol to `$APPCONFIG/wallpaper`, so no image bytes go into `settings.json`. Edge
  refraction (`lens.ts`, an SVG `feDisplacementMap`) is enabled only when `supportsBackdropLens()`
  detects Chromium (WebView2): WKWebView and WebKitGTK drop the whole `backdrop-filter` when it
  contains `url()`. `reduceTransparency` and `prefers-reduced-transparency` force opaque surfaces.
- **The second system: `features/preferences`.** `src/features/preferences/` and
  `src-tauri/src/features/preferences/` (`prefs_get` / `prefs_set`, `preferences.json`, data
  attributes `data-accent` / `data-darkness` / `data-density`) date from the 2026-06-12 walking
  skeleton (`471ccd3 feat(preferences): add architecture skeleton and preferences walking slice`).
  That slice was the template for the vertical-slice layering (ADR-0002); its `mod.rs` says the
  sync commands are "the exception, not the template". Its only UI is `PreferencesPanel`,
  rendered in the dev-only Gallery (`src/dev/Gallery.tsx`, ⌘⇧G in dev). `App.tsx` still calls
  `loadPreferences()` at boot. M20 built the real store as a new slice instead of growing this one.
  Why both remain is not recorded; inferred: the skeleton slice is kept as a reference and gallery
  fixture.

## Alternatives considered

- **Rust as the source of truth.** This would put an async IPC round-trip in front of the first
  paint and bring back the default-theme flash. M20 chose localStorage for the synchronous read.
- **Material themes as palette values only.** Rejected in `glass.css`'s header: blur, specular lip
  and depth "cannot be expressed as palette values".
- **Unconditional lens CSS.** Rejected in `lens.ts`: on macOS, an ungated `backdrop-filter: url()`
  would leave every pane transparent.
- **Extend `features/preferences`.** Not done. M20 specified its own contract (`DEFAULTS`,
  `bytetable.settings.v1`), which did not match the skeleton's three fields (inferred).

## Consequences

- **Positive:** No theme or language flash on launch. Settings survive a localStorage clear and
  can be edited by hand. Every engine inherits theming for free. Glass rules cost flat themes nothing.
- **Negative / trade-offs:** Two copies can drift: the disk mirror is best-effort, which is why
  ADR-0048 passes settings with each call. Two settings slices sit side by side, and only
  `features/settings` reaches users, so a control added to `preferences` ships nothing. Liquid
  Glass looks different by platform: refraction is Chromium-only.
- **Follow-ups:** `set_mac_chrome` in `src-tauri/src/lib.rs` is a no-op kept as a stable target.
  `features/preferences` still loads at boot and could be removed or folded into `features/settings`.
