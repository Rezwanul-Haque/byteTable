# ByteTable - Agent guide

## Repo overview

Tauri 2 desktop database client (TablePlus alternative). Rust core with React 19 + TypeScript + Vite renderer.

| Layer | Stack |
|-------|-------|
| Shell | Rust + Tauri 2 (rusqlite, sqlx, redis, aws-sdk-dynamodb, mongodb, scylla) |
| UI | React 19, TypeScript, Vite 6, Zustand, CodeMirror, TanStack Virtual |

Architecture: vertical-slice + clean architecture. One Rust feature folder per capability, engine adapters in `src-tauri/src/engines/`.

## Prerequisites

- Rust >= 1.89 (edition 2021), Node >= 18, pnpm 10
- MSRV-aware resolver in `.cargo/config.toml`
- `make` targets auto-install Rust via rustup if `cargo` is missing

## Key commands

```sh
make dev          # Tauri + Vite hot reload (Vite on fixed port 1420)
make test         # cargo test (Rust) + pnpm typecheck (tsc)
make lint         # ESLint → prettier check → rustfmt check → clippy -D warnings
make fmt          # prettier + rustfmt auto-format
make build        # production Tauri bundle (pnpm tauri build)
make dev-cert     # macOS: one-time self-signed cert for keychain prompt avoidance
make tag VERSION=x.y.z  # bump, commit, tag, push (triggers release workflow)
make db-up        # Docker: Postgres/MySQL/Redis/DynamoDB/MongoDB/Cassandra + seed
make db-down      # stop + wipe volumes
make hooks        # install git pre-commit hook (husky + lint-staged)
```

Underlying commands:
```sh
pnpm dev          # pnpm tauri dev
pnpm build        # tsc -b && vite build (NOT tauri build)
pnpm lint         # ESLint only
pnpm format       # prettier --write .
pnpm typecheck    # tsc -b
cargo test --all-features                 # from src-tauri/
cargo clippy --all-targets --all-features -- -D warnings
```

## Important rules (run in order where specified)

1. **`make lint` order matters**: ESLint → prettier check → rustfmt check → clippy (`-D warnings`)
2. **`make test`** = cargo test → pnpm typecheck (not `pnpm build`)
3. **CI runs** `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm build`, then `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test --all-features`, `cargo build` — all from `src-tauri/`
4. **Always use `--frozen-lockfile`** in CI (not in dev)
5. **pre-commit**: husky runs lint-staged (prettier on staged files only). Bypass with `--no-verify`

## Style

- Prettier: 100 char width, semicolons, double quotes, trailing commas
- rustfmt: 100 char width, edition 2021, Unix newlines
- ESLint ignores `dist/`, `src-tauri/`; Prettier ignores `dist/`, `node_modules/`, `src-tauri/target/`, `src-tauri/gen/`, `docs/`, `test-fixtures/`, `landing/`
- Clippy denies warnings (`-D warnings`)

## Testing

- Rust tests run via `cargo test --all-features` from `src-tauri/`. SQLite is unit-testable in-process. MySQL/Postgres/Redis/DynamoDB/MongoDB/Cassandra integration tests need Docker databases (`make db-up`).
- No frontend test framework configured.
- Test fixtures use offset Docker ports (e.g. Postgres on 55432).

## Project structure

```
src/                     React/TS renderer
  features/<name>/       components, Zustand state, typed Tauri invoke wrappers
  shared/                design tokens, UI primitives, wire types
src-tauri/               Rust core
  src/engines/           engine adapters (one per database)
  src/features/<slice>/  domain/application/ports/infrastructure/commands
  src/shared/            error type, port traits
test-fixtures/           Docker compose + seeds + sample SQLite
  seed/                  per-engine SQL/script seeds
landing/                 GitHub Pages marketing page
docs/                    design specs
```

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
