# ByteTable - Agent guide

## Repo overview

Tauri 2 desktop database client (TablePlus alternative). Rust core with React 19 + TypeScript + Vite renderer.

| Layer | Stack                                                                                        |
| ----- | -------------------------------------------------------------------------------------------- |
| Shell | Rust + Tauri 2 (rusqlite, sqlx, tiberius, redis, aws-sdk-dynamodb, mongodb, scylla, reqwest) |
| UI    | React 19, TypeScript, Vite 6, Zustand, CodeMirror, TanStack Virtual                          |

Architecture: vertical-slice + clean architecture. One Rust feature folder per capability, engine adapters in `src-tauri/src/engines/`.

## Prerequisites

- Rust >= 1.89 (edition 2021), Node >= 18, pnpm 10
- MSRV-aware resolver in `.cargo/config.toml`
- `make` targets auto-install Rust via rustup if `cargo` is missing

## Key commands

```sh
make dev          # Tauri + Vite hot reload (Vite on fixed port 1420)
make test         # cargo test (Rust) + pnpm typecheck (tsc) + pnpm test (Vitest)
make lint         # ESLint → prettier check → rustfmt check → clippy -D warnings
make fmt          # prettier + rustfmt auto-format
make build        # production Tauri bundle (pnpm tauri build)
make dev-cert     # macOS: one-time self-signed cert for keychain prompt avoidance
make tag VERSION=x.y.z  # bump, commit, tag, push (triggers release workflow)
make db-up        # Docker: Postgres/MySQL/SQL Server/Redis/Redis Cluster/DynamoDB/MongoDB/Cassandra/ClickHouse/Typesense + seed
make db-down      # stop + wipe volumes (both compose projects)
make redis-cluster-up    # just the 3-master/3-replica Redis Cluster (7001-7006) + form + seed
make redis-cluster-down  # just the cluster rig
make hooks        # install git pre-commit hook (husky + lint-staged)
```

Underlying commands:

```sh
pnpm dev          # pnpm tauri dev
pnpm build        # tsc -b && vite build (NOT tauri build)
pnpm lint         # ESLint only
pnpm format       # prettier --write .
pnpm typecheck    # tsc -b
pnpm test         # vitest run (pnpm test:watch for watch mode)
cargo test --all-features                 # from src-tauri/
cargo clippy --all-targets --all-features -- -D warnings
```

## Important rules (run in order where specified)

1. **`make lint` order matters**: ESLint → prettier check → rustfmt check → clippy (`-D warnings`)
2. **`make test`** = cargo test → pnpm typecheck → pnpm test (not `pnpm build`)
3. **CI runs** `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`, `pnpm build`, then `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test --all-features`, `cargo build` — all from `src-tauri/`
4. **Always use `--frozen-lockfile`** in CI (not in dev)
5. **pre-commit**: husky runs lint-staged (prettier on staged files only). Bypass with `--no-verify`

## Style

- Prettier: 100 char width, semicolons, double quotes, trailing commas
- rustfmt: 100 char width, edition 2021, Unix newlines
- ESLint ignores `dist/`, `src-tauri/`; Prettier ignores `dist/`, `node_modules/`, `src-tauri/target/`, `src-tauri/gen/`, `docs/`, `test-fixtures/`, `landing/`
- Clippy denies warnings (`-D warnings`)

## Testing

- Rust tests run via `cargo test --all-features` from `src-tauri/`. SQLite is unit-testable in-process. MySQL/Postgres/SQL Server/Redis/DynamoDB/MongoDB/Cassandra/Typesense integration tests need Docker databases (`make db-up`); each is gated behind a `BYTETABLE_TEST_*_URL` env var (SQL Server: `BYTETABLE_TEST_MSSQL_URL`; Typesense also reads `BYTETABLE_TEST_TYPESENSE_KEY`; the Redis Cluster reader has its own `BYTETABLE_TEST_REDIS_CLUSTER_URL`, satisfied by `make redis-cluster-up`).
- Frontend tests run on **Vitest** via `pnpm test` (`vitest run`); config lives in `vite.config.ts`, not a separate file. The suites are pure logic in `*.test.ts` co-located with the module they cover (`include: ["src/**/*.test.ts"]`), so they run in the default `node` environment — there are no component or DOM tests, and adding one means opting that file into jsdom.
- Test fixtures use offset Docker ports (e.g. Postgres on 55432).

## Project structure

```
src/                     React/TS renderer
  features/<name>/       Zustand state, typed Tauri invoke wrappers, pure logic
    components/          React components + their co-located CSS
    hooks/               modules whose sole export surface is a React hook
  shared/                design tokens, UI primitives, wire types
    hooks/               cross-feature React hooks
    ui/                  UI primitives
    styles/              design tokens + global CSS
src-tauri/               Rust core
  src/engines/           engine adapters (one per database)
  src/features/<slice>/  domain/application/ports/infrastructure/commands
  src/shared/            error type, port traits
test-fixtures/           Docker compose + seeds + sample SQLite
  seed/                  per-engine SQL/script seeds
landing/                 GitHub Pages marketing page
docs/                    design specs
```

Frontend placement rules — a feature slice sorts its files into three buckets:

- **`components/`** holds React components and only React components, each next to its own CSS (`TableTab.tsx` + `TableTab.css`). A `.ts` module of pure functions does not belong here even when only one component imports it — put it at the slice root (`features/workspaces/formatSql.ts`, `features/browse/sql/filter.ts`).
- **`hooks/`** holds modules whose _entire_ export surface is a React hook (`features/settings/hooks/useAutoRefresh.ts`). Modules that export a hook alongside other surface stay where their subject lives — Zustand stores (`state.ts`) export `useX` selectors but are stores, a context stays beside its provider (`shared/ui/toastContext.ts` + `ToastProvider.tsx`), and a hook wrapping a module-level runtime stays with it (`shared/ui/btCmd.ts`, `shared/i18n/useT.ts`).
- **Slice root** holds everything else: `api.ts` (typed `invoke` wrappers), `state.ts`, and pure logic/helper modules with their co-located `*.test.ts`.

`features/browse/shared/` follows the same split and adds `styles/` for stylesheets other slices import but that back no component of their own.

## Entry points

- Rust: `src-tauri/src/main.rs` → `lib.rs`
- TS: `src/main.tsx` → `src/App.tsx`
- Settings bootstrap (theme/font) runs **synchronously before React mount** from `src/features/settings/bootstrap`

## Operational quirks

- **Window close hides to tray** (does not quit); use `⌘Q` or tray "Quit" to exit.
- **Splash screen** shows minimum 1.4s on startup.
- **Secrets** (DB passwords, SSH keys) go to OS keychain via `keyring` crate — never committed.
- **Single-instance** guard: second launch focuses existing window.
- **Auto-updater** checks GitHub releases; `latest.json` signed with Tauri updater key.
- **macOS dock click** on hidden window restores it (handled in `lib.rs` RunEvent::Reopen).
- **Dev build on macOS**: ad-hoc signed, OS may re-ask for keychain access. `make dev-cert` + `make run` avoids this.
- **Release**: `make tag VERSION=x.y.z` bumps manifests, commits, tags, and pushes. CI builds signed installers for all 3 OS + updater artifacts.
- **Landing page** at `landing/` deploys to GitHub Pages on main branch pushes touching that directory.
- **Rust MSRV** (1.89) is enforced via `.cargo/config.toml` resolver fallback. If deps fail to build, check Cargo.lock isn't resolving to newer versions.
