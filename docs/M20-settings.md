# Milestone 20 — Settings (themes, fonts, sizes, behavior)

> A **cross-cutting** milestone, not an engine. It can land any time after **M0–M1** (app shell + root) exist, but is most useful once at least one engine renders data (so theme/font/grid changes are visible). Settings is a **global preferences store** applied as CSS variables + body classes on `:root`, plus a tabbed modal to edit it. Every engine (SQL, Redis, DynamoDB, Mongo, Cassandra) inherits it for free because they all read the same `--bg*`, `--accent`, `--mono`, `--ui`, `--editor-fs`, `--grid-fs`, `--grid-row-h` variables and `bt-*` body classes. This file expands the milestone into independently shippable subtasks; build them in order, one per session.

Conventions carry over from `MILESTONES.md`:
- Recreate visuals from the prototype — do not improvise colors/spacing/copy. Open `ByteTable.html`, press **⌘, / Ctrl+,** (or click the gear in the workspace rail) and interact with every tab + control at 100% zoom before coding.
- Settings is **renderer-only state** persisted to `localStorage` (local-first: no account, no sync, no telemetry). In the Tauri build, persist the same JSON blob to the app-config dir via a `settings_load` / `settings_save` command pair so it survives a `localStorage` clear and is editable as a file — but the renderer remains the source of truth and applies everything itself.
- Definition of done = acceptance criteria pass **and** the pixel checklist matches the prototype side-by-side **and** the store has unit tests (load/merge/migrate, theme-apply, font-probe).

---

## Design files to follow (Settings)

All under `bytetable/` in the design project. These are the source of truth for layout, behavior, and copy — recreate them, don't reinvent.

| File | What it defines |
|---|---|
| `bytetable/settings.js` | The **store + catalogs** (plain JS, loads before React). `window.BT_SETTINGS = { THEMES, ACCENTS, MONO_FONTS, UI_FONTS, DEFAULTS, KEY, load, save, apply, ensureFont, detectSystemMonos, monoMetaFor, isFontAvailable }`. **`THEMES`** = 12 full palettes, each `{ label, group, bg0,bg1,bg2,bg3, border, text, dim, faint, accent, danger, onAccent, light? }`, grouped `ByteTable` / `Editor` / `Light`. **`ACCENTS`** = curated accent overrides (`'auto'` = use theme's own accent + 6 hexes). **`MONO_FONTS`** / **`UI_FONTS`** = curated web fonts `{ label, stack, google, liga }` (google = CSS2 family string, null for system). **`DEFAULTS`** = the full settings object (see contract below). `apply(s)` writes all CSS variables + body classes on `:root`; `load`/`save` use `localStorage['bytetable.settings.v1']` merged over `DEFAULTS`; `ensureFont` injects a Google `<link>` once per family; `detectSystemMonos`/`isFontAvailable` canvas-probe installed monospace faces; `monoMetaFor(id)` resolves a curated key **or** a `"sys:<Family>"` id. Calls `apply(load())` immediately on load to avoid a flash before React mounts. |
| `bytetable/settings.jsx` | The **hook + modal** (babel). `useSettings()` → `[settings, setSetting, reset]`; an effect re-applies + saves on every change. **`SettingsModal`** = 4-tab modal (`Appearance` / `Fonts & text` / `Data grid` / `Behavior`) with a left nav + Reset-all. Helper components: `ThemeSwatch` (live mini-palette preview card), `SetRow` / `SetToggle` (switch) / `SetSeg` (segmented control), `FontPreview` (syntax-highlighted SQL sample via `window.highlightSQL` — **must not** use the editor's `.sql-highlight` overlay class, which is `position:absolute`), and **`MonoFontPicker`** (dropdown: bundled web fonts + canvas-probed system monos, with an optional `queryLocalFonts()` "Load all installed fonts…" path on Chromium). Exports `useSettings`, `SettingsModal` on `window`. |
| `bytetable/app.jsx` | **Wiring**: `const [settings, setSetting, resetSettings] = useSettings()` at the root; `settingsOpen` state; the **⌘,/Ctrl+,** global shortcut; renders `<SettingsModal settings setSetting reset onClose toast />`; passes `onSettings` to the rail; mirrors a few hot settings (theme/accent/density) into the Tweaks panel so both stay in sync through the same `setSetting`. |
| `bytetable/rail.jsx` | The **gear button** in the workspace rail (`.rail-settings`, `onSettings`) — bottom cluster next to the donate button. |
| `ByteTable.html` | All Settings CSS (search `set-` — `.set-modal` with **`gap:0`** override of base `.modal`'s `gap:16px`, `.set-head`, `.set-body`/`.set-nav`/`.set-pane`, `.set-theme*` swatch grid, `.set-accents`/`.set-accent`, `.set-row`/`.set-switch`/`.set-seg`/`.set-range`/`.set-size`, `.set-select` with custom chevron + accent focus ring, `.set-font-prev`, `.mono-picker*` dropdown, `.set-liga-tag`, `.rail-settings`) plus the body-class hooks (`.bt-liga`, `.bt-reduce-motion`, `.bt-no-rowhover`, `.bt-light`) and the script-load order (`settings.js` before babel; `settings.jsx` right after `ui.jsx`). |

---

## The settings contract (`DEFAULTS`)

The single source of truth. Persist this exact shape; migrate forward by merging over `DEFAULTS`.

| Key | Type | Default | Applied as | Affects |
|---|---|---|---|---|
| `theme` | enum (12 ids) | `charcoal` | `--bg0..3`, `--border`, `--text`, `--text-dim`, `--text-faint`, `--danger`, `--accent`, `--on-accent` + `.bt-light` | Whole app palette |
| `accent` | `'auto'` \| hex | `auto` | `--accent`, `--on-accent` (auto = theme's own) | Accent everywhere |
| `monoFont` | curated key \| `sys:<Family>` | `jetbrains` | `--mono` (+ `ensureFont`) | **Editor + data grid only** |
| `uiFont` | enum (4 ids) | `plexSans` | `--ui` (+ `ensureFont`) | App chrome (sidebar, tabs, menus, dialogs) |
| `fontSize` | int 10–18 | `13` | `--editor-fs` = n px, `--grid-fs` = n−1 px | **Editor + grid pixel size only — not chrome** |
| `density` | `compact`\|`comfortable` | `compact` | `--grid-row-h` (26 / 32 px) | Data-grid row height |
| `ligatures` | bool | `true` | `.bt-liga` body class | Mono ligatures (=> != <=) |
| `reduceMotion` | bool | `false` | `.bt-reduce-motion` | Animations/transitions |
| `highlightRow` | bool | `true` | `.bt-no-rowhover` (inverse) | Row hover tint in grids |
| `relativeTime` | bool | `false` | (read by value renderers) | "2h ago" vs full datetime |
| `confirmProd` | bool | `true` | (read by write guards) | Typed confirm for UPDATE/DELETE/TRUNCATE on prod |
| `defaultLimit` | 100\|300\|1000 | `300` | (read by query/browse) | Rows fetched before paging |
| `restoreTabs` | bool | `true` | (read on launch) | Reopen last session's tabs |

> Note the deliberate split: **`monoFont` + `fontSize` are scoped to monospace surfaces** (editor + grid); the chrome uses `uiFont` at its own hardcoded sizes. There is intentionally **no global app-scale knob**, so heavy data screens stay dense while chrome stays stable.

---

## Subtasks

Build in order. Each is independently shippable and testable.

### 20.1 — Settings store + `:root` apply (no UI yet)
Port `settings.js` to the app: the `DEFAULTS` contract, `load`/`save` (localStorage merged over defaults, key `bytetable.settings.v1`), and `apply(s)` writing **all** CSS variables + body classes exactly as the prototype does. Call `apply(load())` at startup before React mounts (no flash). In Tauri, back `load`/`save` with `settings_load`/`settings_save` commands writing JSON to the app-config dir, but keep the renderer applying.
- **Wire**: nothing visible yet — verify by hand-editing localStorage and reloading.
- **Acceptance**: every key in the contract round-trips; unknown/old keys merge cleanly over `DEFAULTS`; theme swap repaints the whole app via variables only (no per-component overrides).
- **Pixel**: n/a (store milestone). Unit-test load/merge/migrate + apply.

### 20.2 — `useSettings` hook + rail gear + empty modal shell
Add `useSettings()` (state + apply-on-change effect + save), the **gear button** in the rail (`.rail-settings`), the **⌘,/Ctrl+,** shortcut, and the `SettingsModal` **shell**: header, left nav (4 tabs), `.set-body`/`.set-pane`, Reset-all, Esc-to-close. **Critical:** `.set-modal` must override the base `.modal` `gap:16px` to `gap:0` or a 16px dead band appears under the header.
- **Acceptance**: gear + shortcut open it; tabs switch; Esc/scrim close; Reset-all restores `DEFAULTS`.
- **Pixel**: header, nav rail, pane padding, reset button.

### 20.3 — Appearance tab (themes + accent + reduce motion)
12 `ThemeSwatch` cards grouped `ByteTable`/`Editor`/`Light` (each a live mini-palette preview), the `ACCENTS` row (`auto` + swatches), and the Reduce-motion toggle. Selecting repaints instantly.
- **Acceptance**: all 12 themes apply correctly (incl. the `light` one flipping `.bt-light`); `auto` accent follows theme, hex accents override + recompute `--on-accent`; reduce-motion toggles `.bt-reduce-motion`.
- **Pixel**: swatch grid, active check, group labels, accent ring.

### 20.4 — Fonts & text tab (mono picker, UI select, ligatures, size)
`MonoFontPicker` dropdown (bundled web fonts + canvas-probed system monos via `detectSystemMonos`; optional `queryLocalFonts()` "Load all…" on Chromium), the syntax-highlighted `FontPreview`, the ligatures toggle, the `uiFont` `<select>` (styled `.set-select` — custom chevron, **no browser focus ring**), and the size stepper+range (10–18, grid = n−1).
- **Acceptance**: picking a bundled font injects its Google link once and applies `--mono`; picking a `sys:` font applies without a network load; ligatures toggle flips `.bt-liga`; size updates `--editor-fs`/`--grid-fs` live; UI select changes `--ui`. The preview never escapes the modal (no `.sql-highlight` overlay class).
- **Pixel**: dropdown groups/tags, preview block, select chevron + focus, stepper.

### 20.5 — Data grid + Behavior tabs
**Data grid**: density segmented control (`--grid-row-h`), highlight-active-row toggle, default-limit segmented (100/300/1000), relative-timestamps toggle. **Behavior**: confirm-writes-on-prod toggle, restore-tabs toggle, and the local-first footnote. Then make the consuming code **read** these: grid row height + hover from CSS; `defaultLimit` from the query/browse limit defaults; `confirmProd` gating the typed-confirm dialog on prod connections; `relativeTime` in value renderers; `restoreTabs` on launch.
- **Acceptance**: each control persists and visibly changes behavior in at least one engine; prod write-guard respects `confirmProd`; new query/browse tabs honor `defaultLimit`.
- **Pixel**: segmented controls, toggles, footnote.

### 20.6 — Tauri persistence + cross-window sync (desktop only)
Back the store with `settings_load`/`settings_save` Tauri commands (JSON in app-config dir). On multi-window builds, broadcast changes so all windows re-`apply` (e.g. a `settings-changed` event). Keep `localStorage` as the fast path / web fallback.
- **Acceptance**: settings survive a localStorage clear; editing the on-disk file and relaunching reflects changes; a change in one window repaints others.
- **Pixel**: n/a.

---

## Load order (must match `ByteTable.html`)
`settings.js` (plain, **before** babel scripts) → … → `tweaks-panel.jsx` → `ui.jsx` → **`settings.jsx`** → the rest. `settings.js` self-applies saved prefs on load; `settings.jsx` depends on `ui.jsx` (`MIcon`, `IconBtn`) and `editor.jsx`'s `highlightSQL` (guarded with a fallback).

## Cross-cutting acceptance (whole milestone)
- Switching any setting repaints **every** open engine surface through variables/classes alone — no engine-specific settings code.
- No flash of default theme on launch (apply-before-mount).
- Local-first: zero network beyond Google Fonts `<link>`s; everything in `localStorage` (+ optional config file in Tauri).
- The mono/size scope is honored: chrome never resizes with `fontSize`.
