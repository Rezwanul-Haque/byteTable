# M0 — Scaffold + design system

> One-line provenance: reconstructed from shipped code (`ByteTable/bytetable` on `main`) + handoff docs (`MILESTONES.md` M0, `DESIGN_SPEC.md` §1, `ARCHITECTURE.md`); imperative voice = requirement. Where the shipped code diverges from the handoff, the SHIPPED code wins and the divergence is called out inline.

## Goal

Stand up an empty, themed desktop shell that already _feels_ like ByteTable: the Tauri 2 + Rust + React/TS/Vite stack, the vertical-slice + clean-architecture skeleton, the design-token CSS (three darkness presets, four accents, two densities, semantic + engine + env + workspace colors), locally-bundled fonts, and the full set of base UI primitives. Prove the whole architecture end-to-end with ONE walking-skeleton slice — `preferences` — that runs the chain `domain → application → ports → infrastructure → command → typed invoke()` and live-updates the theme tokens. No database, no connections, no workspaces yet (those are M1/M2).

Two deliberate divergences from `MILESTONES.md`, both shipped on purpose, documented in detail below:

1. **Directory + identifier naming is `features/`, not `slices/`.** Everything else in `ARCHITECTURE.md` holds; only the word changed (`src-tauri/src/features/<slice>/`, `src/features/<slice>/`).
2. **The window is NOT frameless.** `tauri.conf.json` ships `"decorations": true` — the app uses the native OS titlebar. The handoff's "frameless" wording is superseded. Do not add a custom titlebar or `data-tauri-drag-region`; there is no in-app drag region in M0.

---

## Dependencies — actually used (from `Cargo.toml` / `package.json`)

### Rust crates (`src-tauri/Cargo.toml`)

Only the M0-relevant subset is required to _build M0_; the rest were added by later milestones (M2/M12/M13) but the spec lists what is in the shipped tree so a rebuild compiles against the same lock.

| Crate                 | Version                               | M0 role                                                     |
| --------------------- | ------------------------------------- | ----------------------------------------------------------- |
| `tauri`               | 2 (features `tray-icon`, `image-png`) | App runtime, command macro, managed state, window.          |
| `serde`               | 1 (`derive`)                          | Wire (de)serialization of domain types.                     |
| `serde_json`          | 1                                     | JSON for the preferences file + the error payload.          |
| `thiserror`           | 2                                     | Derives `AppError` (`shared/error.rs`).                     |
| `tauri-plugin-opener` | 2.5.4                                 | Open external URLs (donate links, M1) in the OS browser.    |
| `tauri-plugin-dialog` | 2.7.1                                 | Native file pickers (M2+). Registered in M0's builder.      |
| `async-trait`         | 0.1.89                                | Async port traits in `shared/engine.rs` (the engine stubs). |
| `tempfile` (dev)      | 3                                     | Temp dirs for the preferences-store unit tests.             |

> M0-not-required but present (later milestones): `uuid`, `tokio`, `rusqlite`, `sqlx`, `base64`, `keyring`, `russh`, `redis`. A from-scratch M0 needs only the eight above. `[profile.release]` is set for size (`opt-level="s"`, `lto`, `codegen-units=1`, `panic="abort"`, `strip`). Edition 2021, `rust-version = "1.77.2"`. The lib is named `bytetable_lib` (`crate-type = ["staticlib","cdylib","rlib"]`).

### JS libraries (`package.json`)

M0-required:

| Package                                       | Version         | M0 role                                 |
| --------------------------------------------- | --------------- | --------------------------------------- |
| `react` / `react-dom`                         | ^19.2.0         | UI.                                     |
| `@tauri-apps/api`                             | ^2.9.0          | `invoke()` (preferences api).           |
| `zustand`                                     | ^5.0.14         | Slice store (`preferences/state.ts`).   |
| `@fontsource/ibm-plex-sans`                   | ^5.2.8          | Bundled UI font (400/500/600).          |
| `@fontsource/jetbrains-mono`                  | ^5.2.8          | Bundled mono font (400/500/600).        |
| `material-symbols`                            | ^0.45.1         | Bundled icon font (`rounded.css`).      |
| `@tauri-apps/plugin-dialog` / `plugin-opener` | ^2.7.1 / ^2.5.4 | JS sides of the two plugins (used M1+). |

> Present but M4/M6+ only: `@codemirror/*`, `@lezer/highlight`, `@tanstack/react-virtual`. Not needed to build M0.

### Build tooling

- **pnpm** (`packageManager: pnpm@10.17.0`).
- **Vite 6** + `@vitejs/plugin-react` (`vite.config.ts`): fixed dev port **1420**, `strictPort: true`, `clearScreen: false`, ignores `src-tauri/**`.
- **TypeScript ~5.9** (`tsc -b` in `build` and `typecheck`).
- **ESLint 9** flat config + `typescript-eslint` + react-hooks/react-refresh plugins; **Prettier 3** (`.prettierrc.json`).
- **rustfmt / clippy** for Rust (CI gate per `MILESTONES.md`).
- Scripts: `dev` = `tauri dev`; `dev:vite` = `vite`; `build` = `tsc -b && vite build`; `tauri` = tauri CLI. `tauri.conf.json` wires `beforeDevCommand: pnpm dev:vite`, `devUrl: http://localhost:1420`, `beforeBuildCommand: pnpm build`, `frontendDist: ../dist`.
- A `Makefile` exists at repo root with convenience targets.
- **CI**: `.github/` holds the cross-OS (Linux/macOS/Windows) build workflow per the acceptance criteria.

---

## Backend (Rust core)

Layout (note `features/`, not `slices/`):

```
src-tauri/src/
  main.rs                      # thin bin: calls bytetable_lib::run()
  lib.rs                       # composition root (see below)
  shared/
    mod.rs                     # pub mod engine; error; keyvalue;
    error.rs                   # AppError — the one app-wide error type
    engine.rs                  # engine port-trait stubs + wire types
    keyvalue.rs                # KV port family (M13 stub; out of M0 scope)
  features/
    preferences/               # the walking-skeleton slice
      mod.rs
      domain/mod.rs
      application/mod.rs
      ports.rs
      infrastructure/mod.rs
      commands.rs
```

> The shipped `shared/engine.rs` has grown to the full M13 surface (`EngineConnection`, `fetch_rows`, `column_stats`, Redis seam, …). For M0 you implement only the **stubs**: the `Engine` enum, an `AppError`-returning `Connector`/`EngineConnection` trait pair (async, `async_trait`), and the `EngineInfo` value type — enough to prove the seam exists and compiles. The rich row/filter/DDL types are added by M2–M13. The async-commands rule (DB slices use `async fn`; preferences is the sync exception) is documented in the engine module header and MUST be preserved.

### Shared kernel — `AppError` (`shared/error.rs`)

One error enum for the whole backend. Use-cases and adapters return `Result<T, AppError>`; command handlers surface it to the renderer.

```rust
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("A file operation failed: {0}")]            Io(String),
    #[error("Data could not be read or written in the expected format: {0}")] Serialization(String),
    #[error("Not found: {0}")]                          NotFound(String),
    #[error("Invalid: {0}")]                            Invalid(String),
    #[error("{0}")]                                     Database(String),    // pass-through §5 sentence
    #[error("{0}")]                                     Unsupported(String), // pass-through sentence
}
```

Requirements:

- `From<std::io::Error>` → `Io`; `From<serde_json::Error>` → `Serialization`.
- A private `kind(&self) -> &'static str` mapping: `io | serialization | notFound | invalid | database | unsupported`.
- A **hand-written** `serde::Serialize` impl that emits `{ "kind": <discriminant>, "message": <Display> }` (a 2-field struct). This is the ONLY thing that crosses the command boundary on error — never a stack trace or `Debug`.
- `Database`/`Unsupported` carry an already-complete human sentence (per `DESIGN_SPEC §5`), so their `Display` passes the payload through verbatim (no prefix).
- Mirror exactly in `src/shared/api/error.ts` (`AppErrorKind`, `AppErrorPayload`).
- Unit tests (shipped): serializes to `{kind,message}`; every variant maps to a stable kind; Database/Unsupported pass through verbatim; io conversion works.

### Shared kernel — engine stubs (`shared/engine.rs`)

For M0, define:

- `enum Engine { Sqlite, Mysql, Postgres, Redis }` — `#[serde(rename_all="lowercase")]`, `Copy`, with `display_name()`. Lowercase on the wire, matching `src/shared/types.ts`'s `Engine`.
- `struct EngineInfo { engine: Engine, server_version: String }` (`camelCase`).
- The async port traits `Connector` / `EngineConnection` (`#[async_trait]`, `Send + Sync`) as **stubs** that return `AppError`. No concrete adapter is registered in M0 (M2 adds SQLite). Document the async rule in the module header.

> Do NOT pull in `rusqlite`/`sqlx`/`redis` for M0 — the engine module is type-level only until M2.

### `preferences` slice — the walking skeleton

Dependency rule (enforced): `domain ← application ← (infrastructure | commands)`. Nothing in `domain`/`application` imports Tauri or drivers.

#### Domain (`domain/mod.rs`)

Pure value objects. `serde` derives double as the wire + persisted shape — the documented "no serde in domain" exception, justified because these are dependency-free 1:1 value objects.

```rust
#[serde(rename_all="lowercase")] enum Accent   { #[default] Teal, Blue, Violet, Amber }
#[serde(rename_all="lowercase")] enum Darkness { #[default] Charcoal, Black, Soft }
#[serde(rename_all="lowercase")] enum Density  { #[default] Compact, Comfortable }

#[serde(rename_all="camelCase")]
struct Preferences { accent: Accent, darkness: Darkness, density: Density }  // derive Default
```

Defaults: **teal / charcoal / compact**. Wire form is exactly `{"accent":"teal","darkness":"charcoal","density":"compact"}`. Unknown enum strings (`"crimson"`) MUST fail deserialization. Unit tests: default trio; lowercase string wire format; round-trip; reject-unknown.

#### Ports (`ports.rs`)

```rust
pub trait PreferencesStore {
    fn load(&self) -> Result<Preferences, AppError>;          // missing/empty → defaults
    fn save(&self, preferences: &Preferences) -> Result<(), AppError>;
}
```

**Sync** trait — the deliberate exception (tiny local JSON file). DB slices must use async ports.

#### Application (`application/mod.rs`)

Two free functions, generic over `S: PreferencesStore + ?Sized` (so trait objects and fakes both pass):

```rust
fn get_preferences<S>(store: &S) -> Result<Preferences, AppError>     // store.load()
fn set_preferences<S>(store: &S, preferences: Preferences) -> Result<(), AppError>  // store.save(&p)
```

Unit tests use an in-memory `FakeStore` (RefCell + `fail` flag): empty store → defaults; set-then-get round-trips; store failures propagate.

#### Infrastructure (`infrastructure/mod.rs`)

`JsonFilePreferencesStore { path: PathBuf }`, `new(path)`. Behavior (documented, tested):

- **Missing file → defaults** (first launch is not an error: match `ErrorKind::NotFound`).
- **Corrupt file → defaults**, log one line to stderr, leave the bad file in place (overwritten on next save). Appearance is low-stakes; never block startup.
- **Atomic save**: `create_dir_all(parent)`, write `to_string_pretty` to a `*.json.tmp` sibling, then `fs::rename` over the target. Creates missing parent dirs.
  Tests: missing→defaults; save→load round-trip; pretty JSON + no temp left behind; nested parent creation; corrupt→defaults; overwrite.

#### Commands (`commands.rs`)

Thin presentation. Managed state holds the boxed port:

```rust
pub struct PreferencesState { store: Box<dyn PreferencesStore + Send + Sync> }

#[tauri::command] fn prefs_get(state: State<PreferencesState>) -> Result<Preferences, AppError>
#[tauri::command] fn prefs_set(state: State<PreferencesState>, preferences: Preferences) -> Result<(), AppError>
```

`Send + Sync` because Tauri shares managed state across threads. Commands deserialize → call the use-case → serialize; **no logic** here. Note these are **sync** commands (the exception). The concrete adapter is chosen only in `lib.rs`.

#### Composition root (`lib.rs`)

`run()` builds `tauri::Builder`:

- `.plugin(tauri_plugin_opener::init())` and `.plugin(tauri_plugin_dialog::init())` (registered now, used M1+).
- `.setup(|app| { let config_dir = app.path().app_config_dir()?; let store = JsonFilePreferencesStore::new(config_dir.join("preferences.json")); app.manage(PreferencesState::new(Box::new(store))); Ok(()) })`.
- `.invoke_handler(tauri::generate_handler![prefs_get, prefs_set])`.
- `.run(tauri::generate_context!())`.

> The shipped `lib.rs` also wires connections/saved_queries/schema_map state, a system tray, and close-to-tray window handling — all **later milestones**. M0's composition root is just the preferences `manage` + the two-command handler. Build M0 minimal; later milestones extend the same `setup`/`invoke_handler`.

### Tauri commands (M0 surface)

| command     | args (typed)                   | returns (typed)                           | error cases                                                                                              |
| ----------- | ------------------------------ | ----------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `prefs_get` | — (managed `PreferencesState`) | `Preferences` `{accent,darkness,density}` | `Io` (read failed, non-NotFound); never errors on missing/corrupt (→ defaults)                           |
| `prefs_set` | `preferences: Preferences`     | `void`                                    | `Io` (dir create / temp write / rename failed); `Serialization` (encode failed — practically impossible) |

Errors arrive at the renderer as `{ kind, message }` (`AppErrorPayload`).

---

## Frontend (React)

Layout:

```
src/
  main.tsx                     # mounts <App/>; imports fonts + token/global CSS
  App.tsx                      # shell; loads prefs on mount; ⌘⇧G dev gallery toggle
  App.css
  dev/Gallery.tsx + .css       # the M0 "storybook" page (dev-only overlay)
  shared/
    styles/tokens.css          # design tokens (normative)
    styles/global.css          # reset, body, .msym, scrollbars, ::selection
    types.ts                   # Engine, Env, normalizeEnv
    api/error.ts               # AppErrorPayload mirror
    ui/                         # all base primitives (see table)
  features/preferences/
    api.ts                     # typed invoke wrappers + TS types
    state.ts                   # Zustand store
    applyTheme.ts              # writes <html> data-* attributes
    components/PreferencesPanel.tsx + .css
```

`main.tsx` import order is load-bearing: font CSS (`@fontsource/ibm-plex-sans/{400,500,600}.css`, `@fontsource/jetbrains-mono/{400,500,600}.css`, `material-symbols/rounded.css`), then `tokens.css`, then `global.css`, then `<App/>` in `<StrictMode>`.

### State — preferences store (`features/preferences/state.ts`)

Zustand store `usePreferencesStore`:

- Fields: `preferences: Preferences` (init `defaultPreferences`), `loaded: boolean`.
- `load()`: `await prefsGet()` (catch → keep defaults so plain-browser dev still renders). **Load/set race guard**: inside `set`, if `state.loaded` is already true, discard the stale load result (a user choice that landed first wins). Only call `applyTheme` if this load actually applied.
- `setPreferences(p)`: optimistic — `set({preferences:p, loaded:true})`, `applyTheme(p)` immediately, then `await prefsSet(p)` (catch swallowed; in-memory + applied theme remain valid for the session; a real toast surface is a later milestone).

How it drives tokens — `applyTheme.ts`: writes three `<html>` data attributes via a `setOrRemove(name, value, default)` helper that **removes the attribute when the value equals the default** (so default = no attribute, matching `tokens.css` where `:root` is the charcoal/teal/compact baseline):

- `data-accent` (default `teal`)
- `data-darkness` (default `charcoal`)
- `data-density` (default `compact`)

`App.tsx` calls `void loadPreferences()` once on mount. Toggling any control re-applies synchronously → **live** token update with no reload.

### API — typed invoke wrappers (`features/preferences/api.ts`)

```ts
export type Accent = "teal" | "blue" | "violet" | "amber";
export type Darkness = "charcoal" | "black" | "soft";
export type Density = "compact" | "comfortable";
export interface Preferences {
  accent: Accent;
  darkness: Darkness;
  density: Density;
}
export const defaultPreferences: Preferences = {
  accent: "teal",
  darkness: "charcoal",
  density: "compact",
};
export const prefsGet = () => invoke<Preferences>("prefs_get");
export const prefsSet = (preferences: Preferences) => invoke("prefs_set", { preferences });
```

String literals MUST mirror the Rust `serde(rename_all="lowercase")` enums exactly. The `prefsSet` argument key is `preferences` (matches the Rust command param name).

### Components — base UI primitives

All live in `src/shared/ui/`. Each is a faithful port from the prototype `ui.jsx` / `ByteTable.html`; CSS is "byte-identical from the prototype" except documented additive overrides. The `Icon` is the rendering substrate (`.msym` span). `EngineBadge`/`EnvTag` keep literal hex + alpha-suffix formulae (`{color}22` etc.) intentionally so the prototype look is exact.

| Component                   | File                            | Responsibility                                                  | Key props / variants                                                                                                                                                                                                                                 |
| --------------------------- | ------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Btn`                       | `Btn.tsx`/`.css`                | Text/icon button                                                | `variant: "filled"\|"tonal"\|"text"` (default `tonal`), `small?`, `icon?` (Material name), forwards button props + ref; renders `type="button"`                                                                                                      |
| `IconBtn`                   | `IconBtn.tsx`/`.css`            | Square icon button, ≥26×26 hit target                           | `icon` (required), `size=18`, `active?`, `danger?`; aria-label falls back to `title`                                                                                                                                                                 |
| `Icon`                      | `Icon.tsx`                      | Material Symbols glyph                                          | `name`, `size=18`, `fill: 0\|1` (→ `--msym-fill`), `className?`, `style?`; `aria-hidden`                                                                                                                                                             |
| `EngineBadge`               | `EngineBadge.tsx`/`.css`        | Rounded engine chip                                             | `engine: Engine`, `size=22`; fill `{c}22`, border `{c}55`, color `c`, mono 600, fontSize `0.42×size`, radius 7. Map: SQLite `#56b6c2` "SQ", MySQL `#e2b340` "My", Postgres `#61afef` "Pg", Redis `#e8533d` "Rd" (vermilion, distinct from error red) |
| `EnvTag`                    | `EnvTag.tsx`/`.css`             | Environment pill                                                | `env: Env` (`dev`/`staging`/`production`, run through `normalizeEnv`); color from `ENV_COLOR`; border `{c}66`, bg `{c}14`, mono 9.5 uppercase 600 tracking .06em radius 99                                                                           |
| `envColors`                 | `envColors.ts`                  | Env tint map + picker swatches                                  | `ENV_COLOR` (dev `#56b6c2`, staging `#e2b340`, production `#e06c75`), `ENV_SWATCHES` (8) — split out so non-component consumers import without tripping react-refresh                                                                                |
| `Kbd`                       | `Kbd.tsx`/`.css`                | Keyboard chip                                                   | `children`; mono 10, `--bg3` bg, 2px bottom border, radius 4                                                                                                                                                                                         |
| `BTLogo`                    | `BTLogo.tsx`/`.css`             | The SVG mark (§1.7), exact 24×24 viewBox port                   | `size=24`, `accent`, `fg`, `blink?` (cursor block animates 1.2s steps(2)). Three rounded rows: header split (accent + accent@.45), body (fg@.55), short third row (fg@.35) + accent cursor block                                                     |
| `BrandMark`                 | `BrandMark.tsx`/`.css`          | Logo on the 46×46 r13 accent tile (connect/donate brand)        | `size=26`, `blink?`; tile bg `color-mix(accent 18%, --bg2)`                                                                                                                                                                                          |
| `Modal`                     | `Modal.tsx`/`.css`              | Scrim + centered 480px panel; also `ModalTitle`, `ModalActions` | `onClose`, `label?` (→ aria-labelledby), `width?`, `className?`. Behaviors below                                                                                                                                                                     |
| `ToastProvider`             | `ToastProvider.tsx`/`Toast.css` | Bottom-right toast stack                                        | provides `toast(msg, kind)`; kinds `ok`/`err`/`info` → icon `check_circle`/`error`/`info`; auto-dismiss 3.2s; slide-up 180ms                                                                                                                         |
| `useToast` / `ToastContext` | `toastContext.ts`               | Toast hook (split so component files export only components)    | `ToastFn = (msg, kind?) => void`; throws if used outside provider                                                                                                                                                                                    |

Primitive behaviors worth re-implementing exactly:

- **Modal** — Esc closes only the **top-most** modal (module-level `modalStack` of symbols, push on mount / pop on unmount). Scrim-close fires only on a press-and-release **both** on the scrim (tracks `mouseDownOnScrim` so a drag started inside the panel doesn't dismiss). **Focus trap**: focus first tabbable on mount (else the panel), Tab/Shift+Tab wrap within the panel, restore focus to the opener (or `document.body` if detached) on unmount. `role="dialog"`, `aria-modal="true"`.
- **Toast** — monotonic id (`toastSeq`, not `Math.random`); per-toast `setTimeout` retained in a ref Map and cleared on unmount; `role="status" aria-live="polite"`.
- **Btn/IconBtn** — `forwardRef`, `type="button"` default (overridable), spread native props.

### Design tokens (`src/shared/styles/tokens.css`) — normative, verified against shipped CSS

Switched by `<html>` data attributes; `:root` is the **charcoal / teal / compact** baseline (default = no attribute). Values below are byte-verified against the shipped file and `DESIGN_SPEC §1`.

**Surfaces** (lighter = higher elevation):

| Token      | charcoal (`:root`) | black (`[data-darkness="black"]`) | soft (`[data-darkness="soft"]`) |
| ---------- | ------------------ | --------------------------------- | ------------------------------- |
| `--bg0`    | `#131418`          | `#0b0b0d`                         | `#1d2026`                       |
| `--bg1`    | `#191b20`          | `#111114`                         | `#23262e`                       |
| `--bg2`    | `#20232a`          | `#17171c`                         | `#2b2f39`                       |
| `--bg3`    | `#282c35`          | `#1f1f26`                         | `#343945`                       |
| `--border` | `#2c3039`          | `#232329`                         | `#383e4b`                       |

**Text**: `--text #e3e6eb`, `--text-dim #9aa1ad`, `--text-faint #5d6470`.

**Accent** (default teal in `:root`; alternates override only `--accent`):

- `--accent #2dd4a7` (teal) · `--on-accent #0c1512`
- `[data-accent="blue"]` → `#5aa7f5` · `[data-accent="violet"]` → `#b08cff` · `[data-accent="amber"]` → `#f5b54a`

**Semantic**: `--success #34d39e`, `--info #61afef`, `--warn #e2b340`, `--error #e06c75`, `--purple #c678dd`, `--string #e5c07b`, `--number #7fb8e8`, `--donate-pink #ef7fb1`.

**Engine identity**: `--engine-sqlite #56b6c2`, `--engine-mysql #e2b340`, `--engine-postgres #61afef`. (Redis vermilion `#e8533d` lives in the `EngineBadge` map, not as a token.)

**Environment tags** (note: `dev` replaces the spec's `local`): `--env-dev #56b6c2`, `--env-staging #e2b340`, `--env-production #e06c75`.

**Workspace palette** (8 user-pickable): `--ws-1 #2dd4a7`, `--ws-2 #5aa7f5`, `--ws-3 #b08cff`, `--ws-4 #f5b54a`, `--ws-5 #e06c75`, `--ws-6 #ef7fb1`, `--ws-7 #8fce5a`, `--ws-8 #8b93a3`.

**Density** (compact in `:root`; comfortable overrides):

- `:root` → `--grid-row-h: 26px`, `--grid-fs: 12px`
- `[data-density="comfortable"]` → `--grid-row-h: 32px`, `--grid-fs: 12.5px`

**Font stacks**: `--ui: "IBM Plex Sans", system-ui, sans-serif`; `--mono: "JetBrains Mono", ui-monospace, monospace`.

> Spec→shipped divergences in tokens: (1) the env token is `--env-dev` not `--env-local` (the m15 redesign renamed `local`→`dev`; the TS side keeps a `normalizeEnv("local") → "dev"` read-boundary shim and the Rust side a serde `alias="local"`). (2) The Redis engine color is not a CSS var. Everything else is byte-identical to `DESIGN_SPEC §1`.

`global.css` also ships: full reset (`box-sizing`, zero margin/padding), `html/body/#root { height:100% }`, `body { font-family: var(--ui); background: var(--bg0); color: var(--text); font-size:13px; overflow:hidden; -webkit-font-smoothing:antialiased }`, the `.msym` icon class (`font-variation-settings: FILL var(--msym-fill,0), wght 400, GRAD 0, opsz 20`), form `font-family:inherit`, `button` reset, `::selection { background: color-mix(in oklab, var(--accent) 35%, transparent) }`, and the custom scrollbar (10px, thumb `--bg3` radius 5 with 2px `--bg0` border, hover `--text-faint`).

### Fonts — bundled locally (no runtime Google Fonts)

The app is local-first; fonts ship inside the bundle:

- **IBM Plex Sans** 400/500/600 — `@fontsource/ibm-plex-sans` (`400.css`/`500.css`/`600.css`). UI/chrome text.
- **JetBrains Mono** 400/500/600 — `@fontsource/jetbrains-mono`. All data: grid, table/column names, SQL, paths, tags, status values.
- **Material Symbols Rounded** — `material-symbols/rounded.css` (variable font; FILL 0–1 per icon via `--msym-fill`, wght 400, opsz 20).

All imported in `main.tsx` (so they are part of the Vite build, not fetched at runtime). The CSP in `tauri.conf.json` allows `font-src 'self' data:` only — there is no network font source. CSP also: `default-src 'self'; style-src 'self' 'unsafe-inline'` (the `unsafe-inline` is required because primitives like `EngineBadge`/`EnvTag` set inline `style`).

---

## Shared data contracts — TS ↔ Rust across IPC

| Concept     | Rust (`src-tauri`)                           | TS (`src`)                                  | Wire shape                                                                                                                   |
| ----------- | -------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Preferences | `features::preferences::domain::Preferences` | `features/preferences/api.ts` `Preferences` | `{ "accent":"teal"\|"blue"\|"violet"\|"amber", "darkness":"charcoal"\|"black"\|"soft", "density":"compact"\|"comfortable" }` |
| Error       | `shared::error::AppError` (custom Serialize) | `shared/api/error.ts` `AppErrorPayload`     | `{ "kind": "io"\|"serialization"\|"notFound"\|"invalid"\|"database"\|"unsupported", "message": string }`                     |
| Engine enum | `shared::engine::Engine`                     | `shared/types.ts` `Engine`                  | `"sqlite"\|"mysql"\|"postgres"\|"redis"`                                                                                     |
| Env         | (Rust `Env` arrives M1/M15)                  | `shared/types.ts` `Env` + `normalizeEnv`    | `"dev"\|"staging"\|"production"` (legacy `"local"`→`"dev"`)                                                                  |

The enums are lowercase on the wire on both sides; the keep-in-sync contracts are explicitly noted in the source-file headers (`error.ts` ↔ `error.rs`, `api.ts` ↔ `domain/mod.rs`).

---

## Behavior & edge cases

- **Window decorations (SHIPPED divergence from "frameless")**: `tauri.conf.json` window is `decorations: true` — native OS titlebar. 1440×900 default, min 1024×640, resizable. There is **no** custom titlebar and **no** `data-tauri-drag-region` in M0. (The handoff `MILESTONES.md`/`DESIGN_SPEC §2` say "frameless" / "drag region"; the shipped product deliberately uses native decorations. Do not flag native decorations as drift and do not implement a drag region.) `App.css` `.app-frame`/`.app-body` lay out the 56px rail column + the swappable body per `§2`, but in M0 the body just renders the `ConnectScreen`/gallery — no real workspace yet.
- **Live token updates**: changing accent/darkness/density in `PreferencesPanel` calls `setPreferences`, which optimistically updates the store, calls `applyTheme` (toggles `<html>` data attributes), and persists. The CSS cascade re-resolves the `--*` vars instantly; no reload, no flash. Setting a value back to its default _removes_ the attribute (clean `:root` baseline).
- **First launch / missing prefs file**: `prefs_get` returns defaults (teal/charcoal/compact); the file is created on the first `prefs_set`.
- **Corrupt prefs file**: silently falls back to defaults (stderr log), never blocks startup; the bad file is overwritten on next save.
- **Plain browser dev (no Tauri)**: `prefsGet`/`prefsSet` reject; the store catches and keeps defaults so the gallery still renders in `vite dev`.
- **Load/set race**: a user choice (`setPreferences`) that lands before an in-flight `load()` resolves wins — `load()` discards its stale result because `loaded` is already true.
- **Dev gallery toggle**: `⌘⇧G` / `Ctrl+Shift+G` toggles a fullscreen `Gallery` overlay. The import is guarded by `import.meta.env.DEV` (statically false in production → the chunk is never built or shipped). Lazy-loaded via `React.lazy` + `Suspense`.
- **Atomic prefs write**: temp-file-then-rename, so a crash mid-write never truncates `preferences.json`.

---

## Acceptance criteria (concrete)

From `MILESTONES.md` M0, made testable:

1. **App launches** via `pnpm tauri dev` on Linux/macOS/Windows; the CI workflow builds a release bundle on all three. (Window: native-decorated, 1440×900, resizable — see the decorations divergence; "frameless" is not a requirement.)
2. **Live theming**: in the dev gallery's PreferencesPanel, switching **accent** (teal/blue/violet/amber), **darkness** (black/charcoal/soft), and **density** (compact/comfortable) changes the UI immediately with no reload, by flipping `<html>` data attributes. The choice persists to `<app_config_dir>/preferences.json` and is restored on relaunch.
3. **Walking skeleton proven**: `prefs_get`/`prefs_set` round-trip the full `domain → application → ports → infrastructure → command → typed invoke()` chain; the renderer never imports a driver and only sees the `{kind,message}` error payload.
4. **Dev/storybook page**: the `Gallery` (⌘⇧G) renders every primitive — BTLogo (blinking + static), all Btn variants/sizes + disabled, IconBtn default/active/danger, EngineBadge ×3 engines ×2 sizes, EnvTag ×3 envs, Kbd, sample Icons, ok/err/info toasts, the Modal, and the PreferencesPanel.
5. **Architecture conformance** (`ARCHITECTURE.md`): vertical slice with clean-architecture layers; `domain`/`application` import nothing outward; the only cross-slice surface is `shared/` (error + engine). NOTE the `features/` naming override.
6. **Slice unit tests pass**: domain (4), application (3), infrastructure (6), error (4) — see each section. `cargo test`, `cargo clippy`, `cargo fmt --check`, `pnpm lint`, `pnpm typecheck` all clean.

---

## Pixel / UX checklist

Verify byte-for-byte against the prototype at 100% zoom:

- **Token values** identical to the tables above (all three darkness presets, four accents, semantic/engine/env/workspace colors, both density rows). `:root` = charcoal/teal/compact.
- **Btn**: padding `7px 14px`, radius 8, font 12.5/500, gap 6, transition 120ms. Hover — filled `brightness(1.1)`; tonal bg `color-mix(accent 14%→22%, --bg2)`; text gains `--bg2` + `--text`. `small`: padding `5px 11px`, font 12, radius 7. Disabled: opacity .5, no hover.
- **IconBtn**: 26×26, radius 6, color `--text-faint`; hover bg `--bg3` + `--text`; `active` bg `color-mix(accent 18%, transparent)` + accent color; `danger:hover` bg `color-mix(error 13.3%, transparent)` + error color.
- **EngineBadge**: radius 7, mono 600, fontSize = 0.42×size; fill `{c}22`, border 1px `{c}55`, text `c`. SQ/My/Pg/(Rd) labels + colors as mapped.
- **EnvTag**: mono 9.5px uppercase 600, tracking .06em, padding `1px 6px`, radius 99; border `{c}66`, bg `{c}14`, text `c`.
- **Kbd**: mono 10px, `--bg3` bg, `--border` 1px with 2px bottom, radius 4, padding `1px 5px`.
- **BTLogo**: exact rects — accent `(3,4,8.5,4,r1.6)` + accent@.45 `(13.5,4,7.5,4,r1.6)`; fg@.55 `(3,10,18,4,r1.6)`; fg@.35 `(3,16,11,4,r1.6)`; accent cursor `(16.5,16,4.5,4,r1.2)`. Cursor blinks `1.2s steps(2,start)` (50% → opacity .15) only with `blink`.
- **BrandMark**: 46×46 tile, radius 13, bg `color-mix(accent 18%, --bg2)`.
- **Modal**: scrim `rgba(0,0,0,.5)` + `blur(2px)`; panel 480px (max `100vw-48px`), `--bg1`, 1px `--border`, radius 14, padding 20, gap 16, shadow `0 24px 60px rgba(0,0,0,.5)`, entrance `modal-in 180ms ease-out` (translateY(8px)→0 + fade). Title 15/600 space-between; actions right-aligned gap 8.
- **Toast**: bottom-right (`bottom:40px right:16px`), `--bg3` card, 1px `--border`, radius 10, mono 11.5, padding `9px 14px`, gap 8, shadow `0 10px 28px rgba(0,0,0,.4)`, max-width 480; icon tint ok=accent / err=error / info=text-dim; entrance `toast-in 180ms ease-out`; auto-dismiss 3.2s.
- **Scrollbar**: 10px, thumb `--bg3` radius 5 with 2px `--bg0` border, hover `--text-faint`.
- **Selection**: `color-mix(in oklab, accent 35%, transparent)`.
- **Font smoothing**: body antialiased; UI text IBM Plex Sans; mono JetBrains Mono; icons Material Symbols Rounded.
