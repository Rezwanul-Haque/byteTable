# ByteTable

A free, open-source, **local-first desktop database client** — a TablePlus / Beekeeper-class
tool with first-class Linux support, no pro tier, and no subscription. One window, four engines:
**SQLite · MySQL · PostgreSQL · Redis**.

Your credentials never leave your machine: all database I/O happens in the Rust core, secrets live
in the OS keychain, and the renderer only ever sees opaque connection ids.

## Features

**Workspaces** — multiple simultaneous connections as colored, renamable tiles in a left rail,
each with its own tab set and sidebar state.

**SQL engines (SQLite / MySQL / PostgreSQL)**

- Virtualized data grid: type-aware cells, sort, server-side paging (rows-per-page footer), inline cell editing (parameterized `UPDATE`, production-confirm).
- Stackable filter builder (13 operators, parameterized) + raw `WHERE` escape hatch.
- SQL editor: syntax highlighting, `⌘↩` run, per-tab history, **global saved queries** (optionally scoped to a workspace), and an **Explain** panel + execution-order minimap.
- Structure view: columns / indexes / foreign keys / referenced-by / DDL, with inline editing staged into reviewable `ALTER` statements (apply/discard).
- **FK hop** (peek a referenced row → open it filtered), **column insights** (distinct/nulls/min/max/avg + top-5 over the current filter).
- **Schema map**: draggable ER diagram with movable FK edges, zoom, and PNG/SVG export.
- **Export** a table or schema to CSV / SQL; **truncate** with a confirm dialog.

**Redis** — a purpose-built keyspace browser (not shoehorned into a grid): db0–db15 switcher, `SCAN`-based key list (tree + flat), type-aware viewers/editors for string/hash/list/set/zset/stream, key TTL/encoding/memory info, and a keyspace dashboard.

**Shared** — a VS Code-style **docked terminal panel** (per-engine REPL: psql/mysql/sqlite3-style for SQL, redis-cli for Redis; `Ctrl+\``), command palette (`⌘K`), system tray, and live theming (accent / darkness / density).

## Tech stack

- **Shell:** Rust + **Tauri 2** (small binaries; macOS / Linux / Windows).
- **UI:** React + TypeScript + Vite in the Tauri webview.
- **Architecture:** vertical-slice + clean architecture — one feature per capability
  (`connections`, `introspection`, `browse`, `query`, `structure`, `mutate`, `export`, `keyvalue`,
  `schema_map`, `insights`, `preferences`), each with domain / application / ports / infrastructure /
  thin Tauri-command layers. Engine drivers (`rusqlite`, `sqlx`, `redis`) are infrastructure adapters
  behind shared port traits.

## Prerequisites

- **Rust** ≥ 1.77 (stable toolchain via [rustup](https://rustup.rs)).
- **Node** ≥ 18 and **pnpm** 10 (`corepack enable` or `npm i -g pnpm`).
- **Tauri 2 system deps** — see the [Tauri prerequisites guide](https://tauri.app/start/prerequisites/).
  On Linux that means WebKitGTK 4.1 + build essentials; macOS needs Xcode command-line tools.
- **Docker** (optional) — only to run the bundled test databases (see below).

## Run it (dev mode)

```sh
git clone <repo-url> && cd bytetable
pnpm install        # or: make install
make dev            # or: pnpm tauri dev
```

`make dev` launches the Vite dev server and the Tauri window together with hot reload. First run
compiles the Rust core, so it takes a few minutes; subsequent runs are fast.

## Common commands (Makefile)

| Command                         | What it does                                                               |
| ------------------------------- | -------------------------------------------------------------------------- |
| `make dev`                      | Run the app in development (Tauri + Vite, hot reload)                      |
| `make test`                     | Rust unit + integration tests + TS typecheck                               |
| `make lint`                     | ESLint + Prettier check + `cargo fmt --check` + `cargo clippy -D warnings` |
| `make fmt`                      | Auto-format (Prettier + rustfmt)                                           |
| `make build`                    | Production desktop bundle (`tauri build`)                                  |
| `make build-debug` / `make run` | Fast debug build / build-then-launch                                       |
| `make db-up` / `make db-down`   | Start+seed / wipe the test databases                                       |
| `make`                          | List all targets                                                           |

(Each maps to the underlying `pnpm` / `cargo` command — run those directly if you prefer.)

## Try it against real databases

A ready-to-use set of throwaway databases lives in [`test-fixtures/`](test-fixtures/):

```sh
make db-up          # Postgres + MySQL + Redis (seeded) on offset ports
```

Then in the app's **New connection** modal (TLS: disable), use the credentials in
[`test-fixtures/README.md`](test-fixtures/README.md) — e.g. Postgres `localhost:55432`,
user `postgres`, password `bytetable`, database `byteshop`. For SQLite, choose
**"Open SQLite file…"** → `test-fixtures/byteshop.db`. Stop them with `make db-down`.

## Project layout

```
src/                     Renderer (React/TS), one folder per feature
  features/<feature>/    components / state (Zustand) / api (typed invoke wrappers)
  shared/                design tokens, UI primitives, wire types
src-tauri/               Rust core
  src/engines/           engine adapters (sqlite, postgres, mysql, redis, ssh tunnel)
  src/features/<slice>/  domain / application / ports / infrastructure / commands
  src/shared/            error type, engine + key-value port traits
test-fixtures/           docker-compose + seeds + sample SQLite
docs/                    design specs
```

## Building a distributable

`make build` (= `pnpm tauri build`) produces installers for the **OS you run it on** — Tauri
builds natively per platform, so build each target on that OS (or in CI). Output lands in
`src-tauri/target/release/bundle/`.

### macOS

```sh
make build                                   # → bundle/macos/ByteTable.app + bundle/dmg/*.dmg
# Apple-silicon + Intel universal binary:
rustup target add aarch64-apple-darwin x86_64-apple-darwin
pnpm tauri build --target universal-apple-darwin
```

Requires Xcode command-line tools. Distributing outside your own machine needs **code signing +
notarization** (an Apple Developer ID); set `APPLE_CERTIFICATE`, `APPLE_ID`, `APPLE_PASSWORD`,
`APPLE_TEAM_ID` env vars and Tauri signs/notarizes during the build. Unsigned `.app`s run locally
but Gatekeeper blocks them elsewhere.

### Linux

```sh
make build          # → bundle/deb/*.deb + bundle/appimage/*.AppImage  (+ bundle/rpm/*.rpm)
```

Install the Tauri 2 Linux deps first (Debian/Ubuntu):

```sh
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
                 librsvg2-dev build-essential curl wget file
```

`.deb`/`.rpm` are tied to the building distro's libraries; the **`.AppImage`** is the most
portable single-file artifact. Build on the oldest distro you intend to support (glibc
compatibility is forward, not backward).

### Windows

```powershell
make build          # → bundle\msi\*.msi (WiX) + bundle\nsis\*-setup.exe (NSIS)
```

Requires the **Microsoft C++ Build Tools** (MSVC) and **WebView2** (preinstalled on Windows 11; the
installer auto-fetches it on older Windows). Signing is optional — set `WINDOWS_CERTIFICATE` /
`WINDOWS_CERTIFICATE_PASSWORD` to sign the installers and avoid SmartScreen warnings.

> **Cross-OS builds:** Tauri does not reliably cross-compile desktop bundles (each needs that OS's
> webview + toolchain). The repo's GitHub Actions CI already builds on an ubuntu/macos/windows
> matrix — use that to produce all three from one push, or run `make build` on each OS.

## License & funding

Free forever — no feature is ever paywalled. Development is donation-funded (the in-app
donate button links to GitHub Sponsors / Buy Me a Coffee).
