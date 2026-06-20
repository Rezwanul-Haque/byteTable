# Contributing to ByteTable

Thanks for your interest in ByteTable — a free, local-first desktop database
client for SQLite, MySQL, PostgreSQL, Redis, DynamoDB and MangoDB. Contributions of all kinds are
welcome: bug reports, fixes, features, docs, and design feedback.

By contributing you agree that your work is licensed under the project's
[Apache License 2.0](LICENSE).

## Ways to contribute

- **Report a bug** — open an issue with steps to reproduce, what you expected,
  what happened, your OS, and the engine/version involved.
- **Suggest a feature** — open an issue describing the use case before sending a
  large PR, so we can agree on the approach first.
- **Send a pull request** — fixes, features, tests, or docs (see below).

## Tech stack

- **Core:** Tauri 2 + Rust (engine adapters, commands, secrets).
- **Renderer:** React 19 + TypeScript + Vite, Zustand for state.
- **Engines:** rusqlite (SQLite), sqlx (MySQL/PostgreSQL), the `redis` crate (Redis).

## Prerequisites

- **Node + pnpm** (renderer).
- **Rust toolchain** (rustup) — `make` will install it via `ensure-cargo` if missing.
- **Docker** (optional) — only to run the real MySQL/PostgreSQL/Redis test databases.
- See the README "Prerequisites" section for platform-specific system libraries.

## Getting started

```bash
make install      # install renderer dependencies (pnpm)
make hooks        # install the git pre-commit hook (one-time)
make dev          # run the app with hot reload (Tauri + Vite)
```

To exercise the app against real databases:

```bash
make db-up        # start Postgres/MySQL/Redis in Docker + seed them
make db-down      # stop and wipe them
```

The seed data lives in `test-fixtures/seed/` (`*.sql` per engine, plus
`seed-redis.sh` for a rich Redis keyspace).

> **macOS keychain prompts in dev:** dev builds are ad-hoc signed, so the OS may
> re-ask for keychain access. Run `make dev-cert` once to sign dev builds with a
> stable identity (then `make run` is prompt-free after one "Always Allow").

## Pre-commit hook

`make hooks` installs a [husky](https://typicode.github.io/husky/) pre-commit
hook (also installed automatically by `pnpm install` via the `prepare` script).
On every commit it runs [lint-staged](https://github.com/lint-staged/lint-staged),
which applies `prettier --write` to your **staged** files only (`*.{ts,tsx,js,jsx,json,css,md,html}`)
and re-stages the result — so commits stay Prettier-clean and the CI
`format:check` step won't fail. It does not touch unstaged files or run the
slower full-repo `make fmt`.

Bypass it for a one-off (e.g. a WIP commit) with `git commit --no-verify`.

## Project layout

```
src/                     Renderer (React/TS), one folder per feature
  features/<feature>/    components / state (Zustand) / api (typed invoke wrappers)
  shared/                design tokens, UI primitives, wire types
src-tauri/               Rust core
  src/engines/           engine adapters (sqlite, postgres, mysql, redis, ssh tunnel)
  src/features/<feature>/ domain / application / ports / infrastructure / commands
  src/shared/            error type, engine + key-value port traits
test-fixtures/           docker-compose + seeds + sample SQLite
docs/                    design specs
```

ByteTable follows a **vertical-slice + clean-architecture** layout: each feature
owns its domain, application, and adapter code, and never reaches across into
another feature's internals. Per-engine SQL/commands live only under
`src-tauri/src/engines/*` — feature/application code stays engine-agnostic.

## Making a change

1. **Branch** off `main` (don't commit directly to `main`).
2. **Keep it focused** — one logical change per PR. Match the style and patterns
   of the surrounding code; read a nearby file before adding a new one.
3. **Add tests** for backend logic. SQLite is fully unit-testable in-process;
   MySQL/PostgreSQL/Redis paths have unit tests for SQL generation and gated
   integration tests against the Docker databases.
4. **Run all the checks** (below) and make sure they pass.
5. **Open a PR** with a clear description of what changed and why. Link any
   related issue.

## Checks (must pass before a PR)

Run the whole suite:

```bash
make test         # Rust tests + TS typecheck
make lint         # ESLint + clippy + rustfmt/prettier checks
make fmt          # auto-format (prettier + rustfmt) — run before pushing
```

Or directly, the way CI runs them:

```bash
# Frontend
pnpm typecheck
pnpm lint
pnpm format:check        # or `pnpm format` to fix
pnpm build

# Backend (from src-tauri/)
cargo test --all-features
cargo clippy --all-features -- -D warnings
cargo fmt --check        # or `cargo fmt` to fix
```

Clippy runs with `-D warnings`, so warnings fail the build — fix them rather
than allowing them.

## Coding guidelines

- **No unrelated churn** — don't reformat or refactor code you aren't changing.
- **Comments earn their place** — explain _why_, not _what_; match the density of
  the file you're editing.
- **Errors are human** — surface engine/validation failures as clear, actionable
  sentences (the `AppError` / §5 pattern), never raw driver text.
- **Secrets** — database passwords and SSH secrets go to the OS keychain, never
  into the connection registry or any committed file.
- **Keep adapters thin and engine-specific code where it belongs** — SQL and
  driver calls live under `src-tauri/src/engines/*` only.

## Commit messages

Write clear, present-tense messages explaining the change ("Fix Redis key grid
alignment", not "fixes"). Reference an issue number when one applies.

## License

ByteTable is licensed under the [Apache License 2.0](LICENSE). All contributions
are accepted under the same license.
