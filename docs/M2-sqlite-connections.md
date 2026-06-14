# M2 — Real connections: SQLite end-to-end

Status: shipped, merged on `main`. This document describes **what shipped** (source of truth = the code), written so a code-gen pass could rebuild M2 from it. Provenance for every claim is a file path under `bytetable/`. Imperative voice ("the adapter MUST…") marks a requirement the shipped code enforces; later milestones (M3–M15) extended these files but the M2 surface below is intact.

> Note on layering vocabulary: ARCHITECTURE.md calls the backend slice directory `slices/`; the shipped code uses `features/` (`src-tauri/src/features/connections/`) and `src/features/connections/`. Engine adapters live under `src-tauri/src/engines/<engine>/`, not inside the slice. This is the project's standing override — treat `features/` + `engines/` as canonical.

## Goal

Replace the M0/M1 mock connection data with a **real driver for the simplest engine (SQLite)**, end to end:

- A live `rusqlite` adapter that opens a `.db` file, lists schemas (`main` + ATTACHed), introspects tables, and runs queries with timing and a row-limit cap.
- A **connection manager** that holds open driver handles behind opaque string ids the renderer can pass back — the driver handle never crosses the IPC boundary.
- A **persisted connection registry** (`connections.json`) storing only non-secret params (SQLite carries a file path only — no secrets).
- The **connect flow**: a saved-connection card or "Open SQLite file…" opens a real workspace; the new-connection modal (§3.2) has a SQLite file variant + a "Test connection" button.
- Connect/test failures surface as the prototype's **human error style (§5)** inline in the modal / connect screen — never a Rust stack trace.

Acceptance shorthand: open a real `.db` file → a workspace appears with its actual table list; test-connection round-trips. (See full acceptance criteria below.)

## Dependencies

**On M0/M1** (already merged): the design-system primitives the modal/screen reuse (`shared/ui/Modal`, `Btn`, `IconBtn`, `Icon`, `EngineBadge`, `EnvTag`, `BrandMark`, `toastContext`), the workspaces store + rail (`useWorkspacesStore.openWorkspace`, `WorkspaceConnection`), the `shared/engine` port traits and `AppError` shared kernel, and the connect-screen / new-connection-modal shells (M1 shipped them against mocks; M2 wires them to the backend).

**Crates** (`src-tauri/Cargo.toml`):

- `rusqlite = { version = "0.37", features = ["bundled", "column_decltype"] }` — `bundled` statically links SQLite (no system dep); `column_decltype` gives `Column::decl_type()` for `ColumnMeta.type_hint`.
- `serde = { version = "1", features = ["derive"] }`, `serde_json = "1"` — wire/persistence serialization.
- `uuid = { version = "1", features = ["v4", "serde"] }` — handle ids and saved-connection ids.
- `tokio` (`sync`, `rt`, `macros`, …) — `RwLock` for the manager, `spawn_blocking` for rusqlite calls.
- `async-trait = "0.1"` — the `Connector` / `EngineConnection` async traits.
- `thiserror = "2"` — `AppError`.
- `keyring = "3"` — `KeyringSecretStore` is wired in M2's composition root, but **SQLite never touches it** (it's exercised by server engines, M12).

**Tauri plugins**:

- `tauri-plugin-dialog` (`2.7.x`) — native open-file dialog for "Open SQLite file…" and the modal's Browse button. Registered via `.plugin(tauri_plugin_dialog::init())` in `lib.rs`; capability `dialog:allow-open` (+ `dialog:allow-save`) in `src-tauri/capabilities/default.json`. Renderer side: `@tauri-apps/plugin-dialog`'s `open()`.
- `tauri-plugin-opener` (`2.5.x`) — registered (`opener:allow-open-url`); used for external links, not connection-critical for M2.

---

## Backend (Rust core)

Slice root: `src-tauri/src/features/connections/` with layers `domain/`, `application/`, `ports.rs`, `infrastructure/`, `commands.rs`, plus `secrets.rs`. Dependency rule: `domain ← application ← (infrastructure | commands)`. The SQLite engine adapter is separate, at `src-tauri/src/engines/sqlite/mod.rs`, reached only through the shared `Connector` / `EngineConnection` traits in `src-tauri/src/shared/engine.rs`.

### Domain — `src-tauri/src/features/connections/domain/mod.rs`

`SavedConnection` (the registry entity, `#[serde(rename_all = "camelCase")]` — the same derives double as the wire and persisted shape):

| field        | type               | notes                                                                         |
| ------------ | ------------------ | ----------------------------------------------------------------------------- |
| `id`         | `String`           | UUID assigned by the save use-case when empty (new entry).                    |
| `name`       | `String`           | rejected if blank/whitespace on save.                                         |
| `engine`     | `Engine`           | denormalized from `params`; save rejects a mismatch.                          |
| `params`     | `ConnectionParams` | the engine-tagged params (below).                                             |
| `env`        | `Env`              | `dev` \| `staging` \| `production`; `Default = Dev`.                          |
| `color`      | `Option<String>`   | m15 env swatch; `#[serde(default, skip_serializing_if = "Option::is_none")]`. |
| `created_at` | `Option<u64>`      | Unix epoch **ms**, set on first save; optional on the wire.                   |

`Env` (`#[serde(rename_all = "lowercase")]`): `Dev` (carries `#[serde(alias = "local")]` so pre-m15 `"local"` entries still load), `Staging`, `Production`.

The **engine enum** and **ConnectionParams** are shared-kernel types in `src-tauri/src/shared/engine.rs` (the domain re-uses them, allowed by layering):

- `Engine` (`#[serde(rename_all = "lowercase")]`): `Sqlite`, `Mysql`, `Postgres`, `Redis`. `display_name()` → `"SQLite"` / `"MySQL"` / `"PostgreSQL"` / `"Redis"`.
- `ConnectionParams` — internally tagged `#[serde(tag = "engine", rename_all = "lowercase", rename_all_fields = "camelCase")]`. **M2's only live variant is `Sqlite { path: String }`** (no secrets, no TLS, no tunnel). Other variants (`Mysql`/`Postgres`/`Redis`) exist in the type but their connectors arrive in M12/M13. Helpers: `engine()`, `ssh()` (always `None` for SQLite), `uses_password()` (`false` for SQLite — used to skip a needless keychain prompt).

Domain has unit tests asserting the exact camelCase/lowercase wire JSON, the `local`→`dev` migration, and a full serde round-trip.

### Ports — `src-tauri/src/features/connections/ports.rs`

`ConnectionRepository: Send + Sync` — the persistence boundary for the registry. Deliberately **sync** (the backing store is a small local JSON file; commands are still `async fn` and call these inline):

- `fn list(&self) -> Result<Vec<SavedConnection>, AppError>` — all saved, in stored order.
- `fn get(&self, id: &str) -> Result<Option<SavedConnection>, AppError>` — `Ok(None)` for an unknown id (not an error).
- `fn save(&self, connection: &SavedConnection) -> Result<(), AppError>` — insert or update by id.
- `fn delete(&self, id: &str) -> Result<(), AppError>` — `NotFound` for an unknown id.

The slice also re-uses two **shared-kernel ports** from `shared/engine.rs`, registered in the composition root:

- `Connector: Send + Sync` (`#[async_trait]`): `test(&params)`, `open(&params) -> OpenConnection`, plus default-delegating `test_with_secret` / `open_with_secret` (SQLite uses the secretless defaults). The SQLite adapter implements this.
- `EngineConnection: Send + Sync` (`#[async_trait]`): `engine_info()`, `list_schemas()`, `list_tables(schema)`, `table_meta(schema, table)`, `run_query(sql, options)`, `fetch_rows(req)`, `close()`, plus `Unsupported`-defaulted hooks (`fetch_row_by_key`, `column_stats`, `alter_table`, `update_cell`) that later milestones override. **M2 needs `engine_info` / `list_schemas` / `list_tables` / `run_query` / `close`.**

Secret port — `src-tauri/src/features/connections/secrets.rs`: `SecretStore: Send + Sync` (`set`/`get`/`delete` by account key), with `KeyringSecretStore` (OS keychain, real) and `InMemorySecretStore` (test fake). Account-key helpers: `db_account(id) == id`, `ssh_account(id) == "{id}:ssh"`. **SQLite never reads or writes it** — `uses_password()` is false and `ssh()` is `None`, so `resolve_open_secret` returns `None` without a keychain access.

### Application — `src-tauri/src/features/connections/application/mod.rs`

Pure use-cases (no Tauri, no driver imports). Three sub-systems:

**Connector registry** — `ConnectorRegistry` maps `Engine → Arc<dyn Connector>`. `register(engine, connector)` (composition root), `get(engine)` returns the connector or `AppError::Unsupported("{EngineName} connections arrive in a later milestone.")` for an unregistered engine.

**Connection manager** — `ConnectionManager` holds `RwLock<HashMap<ConnectionHandleId, OpenConnection>>`. `ConnectionHandleId(pub String)` is `#[serde(transparent)]` — the opaque id the renderer round-trips.

- `insert(OpenConnection) -> ConnectionHandleId` — mints a v4 UUID, stores the connection.
- `get_sql(&handle) -> Arc<dyn EngineConnection>` — clones the `Arc` and **drops the read lock before the caller awaits driver work** (so a slow query never blocks other handles). Returns `NotFound("connection handle '{id}' is not open (it may have been closed)")` for an unknown handle, or `Unsupported(…needs a SQL connection)` on a kind mismatch (a Redis handle). (`get_kv` is the symmetric Redis accessor, M13.)
- `remove(&handle) -> Option<OpenConnection>`, `close_all()` (drain + `close()` each, swallowing errors at teardown), `open_count()`.

**Use-cases** (all the `commands.rs` handlers delegate here):

- `list_connections(repo) -> Vec<SavedConnection>`.
- `save_connection(repo, secret_store, mut conn, &TransientSecrets) -> SavedConnection` — validates non-blank name and `engine == params.engine()` (both `AppError::Invalid` otherwise); assigns UUID + `created_at = now_epoch_ms()` for a new entry (empty id); persists via the repo; writes only **supplied, non-empty** secrets to the keychain (SQLite supplies none → keychain untouched); returns the stored value (so the renderer learns the assigned id).
- `delete_connection(repo, secret_store, id)` — repo delete first (so an unknown id is `NotFound`), then best-effort keychain clear of `db_account`/`ssh_account`.
- `test_connection(registry, &params, &secrets) -> EngineInfo` — `registry.get(engine)?.test_with_secret(params, secret)`; no keychain touch (testing is pre-save). SQLite ignores the secret.
- `open_connection(repo, registry, secret_store, manager, OpenTarget, &transient) -> OpenedConnection` — resolves params from a saved id or ad-hoc `OpenTarget::Params`; resolves the effective secret (`None` for SQLite); opens via the connector; gathers the **initial schema list** (`conn.list_schemas()` for a SQL connection) _before_ handing the connection to the manager; inserts; returns `OpenedConnection`.
- `close_connection(manager, &handle)` — removes + `close()`; **closing an unknown handle is `Ok(())`** (benign teardown race), not an error.
- `connection_schemas(manager, &handle)` / `connection_tables(manager, &handle, schema)` / `run_query(manager, &handle, sql, options)` — `manager.get_sql(handle).await?` then the matching `EngineConnection` call.

Supporting types: `TransientSecrets { password, ssh }` (`::new` drops empty strings to `None`); `OpenTarget::{SavedId(String), Params(ConnectionParams)}`; `OpenedConnection { handle_id, engine_info, kind: ConnectionKind, schemas: Vec<SchemaInfo>, keyspace: Option<KeyspaceOverview> }` (`#[serde(rename_all = "camelCase")]`; for SQLite `kind == Sql`, `schemas` is the live list, `keyspace` is `None`/omitted).

Application has extensive unit tests with fakes (`FakeRepository`, `FakeConnector`, `FakeConnection`, `InMemorySecretStore`): UUID/`created_at` assignment, in-place update, blank-name/engine-mismatch rejection, the full open→use→close→double-close-idempotent lifecycle, `close_all` draining, open-by-saved-id, and the unregistered-engine `Unsupported` message.

### Infrastructure — registry persistence + SQLite adapter

**`JsonFileConnectionRepository`** (`src-tauri/src/features/connections/infrastructure/mod.rs`) — implements `ConnectionRepository` over pretty-printed JSON at `<app_config_dir>/connections.json`:

- Missing file → empty list (first launch is not an error).
- **Corrupt file → `AppError::Serialization` naming the file, NOT a silent reset** — saved connections are user data; the file is left untouched for the user to fix.
- **Atomic saves**: write `connections.json.tmp`, then `rename` over the target; `create_dir_all` for parents.
- An internal `Mutex<()>` (`write_lock`) serializes each read-modify-write of `save`/`delete`; a poisoned lock maps to a graceful `AppError::Io` (no panic cascade).

**SQLite adapter** — `src-tauri/src/engines/sqlite/mod.rs` (the only place SQLite-specific SQL lives). `SqliteConnector` (stateless, `impl Connector`) and `SqliteEngineConnection { conn: Arc<Mutex<rusqlite::Connection>>, info: EngineInfo }` (`impl EngineConnection`). Every driver call hops to tokio's blocking pool via `run_blocking` / `with_conn` (rusqlite is sync), locking the connection `Mutex` (a poisoned lock → graceful `AppError::Database("…broken state after an earlier crash; close and reopen it.")`).

- **File open** — `open_validated(path)`: errors `Database("SQLite database file '{path}' does not exist.")` if the path is not a file; `Connection::open_with_flags(path, SQLITE_OPEN_READ_WRITE)`; then **forces a header read** (`SELECT count(*) FROM sqlite_schema`) so a non-database file fails _here_ with a clear message rather than on first use. `map_open_error` translates rusqlite codes to §5 sentences: `NotADatabase` → "'{path}' is not a SQLite database file."; `CannotOpen` → "…could not be opened."; `PermissionDenied` → "Permission denied opening …". `test` opens-and-discards (returning `sqlite_engine_info()`); `open` keeps the connection in `OpenConnection::sql(…)`. `engine_info` → `EngineInfo { engine: Sqlite, server_version: "SQLite {rusqlite::version()}" }`.
- **Schema list** (`main` + ATTACHed) — `list_schemas_blocking`: `PRAGMA database_list` for names, then a best-effort `count(*)` of user tables per schema (`table_count` downgrades to `None` on failure rather than failing the listing). `ensure_schema_exists` yields the §5 "Schema 'x' does not exist. Available schemas: …" message for callers given an unknown schema.
- **Table introspection** — `list_tables_blocking(schema)`: validates the schema, selects user tables (`type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`), and for the first `MAX_COUNTED_TABLES` (200) attaches an exact `count(*)` as `approx_row_count` (best effort; `None` past the cap or on failure). (M3 leans on this for the sidebar; `table_meta` columns/indexes/FKs/DDL also live here for M3/M7.)
- **Query w/ timing + LIMIT** — `run_query_blocking(sql, &options)`: `prepare(sql)`, build `ColumnMeta { name, type_hint: decl_type().unwrap_or("") }` per column, then stream rows; **stop and set `truncated = true`** once `out_rows.len() >= options.row_limit` (reads no further). Times the whole thing with `Instant` → `elapsed_ms`. Each cell maps via `value_to_json` (below). Driver errors go through `map_query_error`.
- **Value mapping** (`value_to_json`): `Null → null`; `Integer` within ±`JS_MAX_SAFE_INTEGER` (2^53−1) → JSON number, **beyond that → JSON string** (preserves precision past JS's safe-integer range); `Real → number` (non-finite → `null`); `Text → string` (lossy UTF-8); `Blob → "[blob {n} bytes]"`.
- **Identifier quoting** (`quote_ident`): wrap in double quotes, doubling embedded quotes — used for every interpolated schema/table name (the M2 surface interpolates only quoted identifiers; user data in M4+ is bound as parameters).
- **Error humanization** (`map_query_error`): `no such table: X` → the §5 "Table 'X' does not exist. Available tables: …" listing (cross-schema, attached tables qualified `aux.users`); `no such column: X` → "Column 'X' does not exist."; everything else → the bare driver message, capitalized with a trailing period (never a Rust error chain). `strip_location_suffix` drops newer SQLite's `" in <sql> at offset N"` tail.

### Tauri commands — `src-tauri/src/features/connections/commands.rs`

Thin presentation layer (`deserialize → use-case → serialize`). Managed state `ConnectionsState { repository, registry, manager, secret_store }`, built once in `lib.rs`'s `setup` (the composition root): `JsonFileConnectionRepository`, a `ConnectorRegistry` with `Engine::Sqlite → SqliteConnector` registered (plus Postgres/MySQL/Redis from later milestones), a fresh `ConnectionManager`, and `KeyringSecretStore`. All commands are `async fn`. Registered in `tauri::generate_handler![…]`. `lib.rs` also calls `manager().close_all()` on `RunEvent::ExitRequested`.

| command              | args (typed)                                                                                                       | returns                                          | error cases (`AppError` → `{kind, message}`)                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connection_list`    | —                                                                                                                  | `Vec<SavedConnection>`                           | `Serialization` (corrupt registry file, named), `Io`.                                                                                             |
| `connection_save`    | `connection: SavedConnection`, `password: Option<String>`, `ssh_secret: Option<String>`                            | `SavedConnection` (with assigned id/`createdAt`) | `Invalid` (blank name; engine/params mismatch), `Io`/`Serialization` (write). SQLite passes no secrets.                                           |
| `connection_delete`  | `id: String`                                                                                                       | `()`                                             | `NotFound` (unknown id), `Io`.                                                                                                                    |
| `connection_test`    | `params: ConnectionParams`, `password: Option<String>`, `ssh_secret: Option<String>`                               | `EngineInfo`                                     | `Database` (file missing / not a db / unreadable — §5 sentences), `Unsupported` (engine without a connector), `Invalid` (params/engine mismatch). |
| `connection_open`    | `id: Option<String>`, `params: Option<ConnectionParams>`, `password: Option<String>`, `ssh_secret: Option<String>` | `OpenedConnection`                               | `Invalid` (both or neither of id/params), `NotFound` (unknown saved id), `Database` (open failure), `Unsupported`.                                |
| `connection_close`   | `handle_id: ConnectionHandleId`                                                                                    | `()`                                             | never errors for an unknown handle (benign `Ok(())`).                                                                                             |
| `connection_schemas` | `handle_id: ConnectionHandleId`                                                                                    | `Vec<SchemaInfo>`                                | `NotFound` (handle not open), `Unsupported` (kind mismatch), `Database`.                                                                          |
| `connection_tables`  | `handle_id: ConnectionHandleId`, `schema: String`                                                                  | `Vec<TableInfo>`                                 | `NotFound`, `Database` ("Schema 'x' does not exist…"), `Unsupported`.                                                                             |
| `query_run`          | `handle_id: ConnectionHandleId`, `sql: String`, `options: Option<QueryOptions>`                                    | `QueryResult`                                    | `NotFound`, `Database` (SQL errors, §5), `Unsupported`.                                                                                           |

`query_run` clamps `options.row_limit` to `MAX_ROW_LIMIT = 10_000` at the command boundary (`clamp_row_limit`) regardless of what the renderer asks, so a renderer bug or a hand-crafted invoke can't marshal an unbounded result across IPC; the engine still sets `truncated` when the clamp cuts the result. `options` defaults to `QueryOptions::default()` (`row_limit: 500`, `schema: None`).

> Provenance note in the code: `query_run` (and `connection_schemas`/`connection_tables`) live in the connections slice deliberately — M2 needs a minimal query/introspection surface; M3+ added the `introspection` slice for new surface but these names were kept where the renderer already depends on them.

---

## Frontend (React)

Slice root: `src/features/connections/`. The connect screen + connect flow live in `src/features/workspaces/`.

### State — `src/features/connections/state.ts`

Zustand store `useConnectionsStore` (`ConnectionsFeatureState`). **Backend-first**: mutations call the backend and patch the in-memory list from the reply (the registry file is the source of truth — never optimistic).

Fields:

- `savedConnections: SavedConnection[]` — the registry list.
- `loaded: boolean` — true once the first `load()` settles (gates the connect screen's empty state).
- `loadError: string | null` — the backend's human message when the registry read failed (structured `AppError`); `null` when load succeeded or there is no Tauri at all (plain browser dev).

Actions:

- `load()` — `connectionList()`, map each through `migrate` (env `local`→`dev`); on a structured `AppError` set `{ savedConnections: [], loaded: true, loadError: message }`; on a non-Tauri rejection set an empty list with `loadError: null` (browser dev still renders).
- `save(connection, secrets?)` — `connectionSave(...)`, migrate the reply, upsert by id into the list, set `loaded: true`; rejections bubble to the caller for inline display.
- `remove(id)` — `connectionDelete(id)`, filter out of the list; rejections bubble.

### API — `src/features/connections/api.ts`

Typed `invoke()` wrappers + the TS mirrors of the Rust wire types (camelCase fields, lowercase enum literals — kept in sync with `domain/mod.rs` and `shared/engine.rs`; engine-level types are re-exported from `src/shared/api/engine.ts`). Signatures:

```ts
connectionList(): Promise<SavedConnection[]>
connectionSave(connection: SavedConnection, secrets?: { password?: string; sshSecret?: string }): Promise<SavedConnection>
connectionDelete(id: string): Promise<void>
connectionTest(params: ConnectionParams, secrets?: { password?: string; sshSecret?: string }): Promise<EngineInfo>
connectionOpen(target: OpenTarget, secrets?: { password?: string; sshSecret?: string }): Promise<OpenResult>
connectionClose(handleId: string): Promise<void>
connectionSchemas(handleId: string): Promise<SchemaInfo[]>
connectionTables(handleId: string, schema: string): Promise<TableInfo[]>
// derived display helpers (no IPC):
connectionDetail(params: ConnectionParams): string   // SQLite → path; server → "host:port · db"; redis → "host:port · db{N}"
connectionIsTunneled(params): boolean                 // always false for SQLite
tunnelTitle(params): string
```

`OpenTarget = { id: string; params?: undefined } | { params: ConnectionParams; id?: undefined }` — exactly one, enforced by the union and the backend. `connectionOpen` forwards `{ id, params, password, sshSecret }` (for SQLite, `params = { engine: "sqlite", path }` and no secrets). `queryRun` lives in `src/shared/api/engine.ts` and is re-exported here.

### Components

**`NewConnectionModal`** (`src/features/connections/components/NewConnectionModal.tsx`) — built on the shared `Modal` (scrim / Esc / focus trap). A single `useReducer` holds the form; **every params-relevant field edit resets the test verdict to idle** (the reducer's `field` default branch), with an explicit opt-out list for edits that must not (section tab, env pick/recolor, the verdict transitions, the saving flag).

SQLite variant (`engine === "sqlite"` ⇒ `isFileBased`): hides the General/SSH section tabs entirely; renders a **Name** input, a **Database file** row (`<input>` + "Browse…" tonal button), and the note "SQLite is a local file — no network, tunnel, or TLS needed." (server/Redis fields below the same engine picker handle M12/M13).

- **Test connection** (`test()`): `buildParams()` validates ("Database file is required" for an empty SQLite path) → on local validation error sets `{ phase: "err", message }`; otherwise sets `{ phase: "testing" }`, awaits `connectionTest(params, secrets())`, then `{ phase: "ok", serverVersion }` or (structured `AppError`) `{ phase: "err", message }` with the **exact backend message inline (§5)**. A non-Tauri rejection resets to idle + an info toast ("Test connection requires the desktop app"). For SQLite `secrets()` is `{ password: undefined, sshSecret: undefined }`.
- **Save** (`save()`): requires a non-blank Name (else inline err) and valid params; calls `useConnectionsStore.save({ id: "", name, engine, params, env, color: envColor }, secrets())`; on success toasts "Connection "{name}" saved" and closes; on error toasts the §5 message (no stack trace).
- **Browse** (`browseDatabaseFile`): `pickSqliteFile()`; on a returned path `field({ file: path })`; on cancel (`null`) nothing; on a non-Tauri rejection the info toast "Native file dialog requires the desktop app".
- The **Environment picker** (segmented dev/staging/production + 8-swatch color row + production warning) is always visible and writes `env` + `color`; M2 ships it but it does not affect whether the connection works.

**File dialog wrapper** (`src/features/connections/dialog.ts`): `pickSqliteFile(): Promise<string | null>` calls the plugin's `open({ multiple: false, directory: false, filters: [{ name: "SQLite database", extensions: ["db","sqlite","sqlite3","db3"] }, { name: "All files", extensions: ["*"] }] })` — resolves the absolute path or `null` on cancel; rejects in plain browser dev (callers catch). (`pickPrivateKeyFile` exists for M12's SSH key.)

**ConnectScreen wiring** (`src/features/workspaces/components/ConnectScreen.tsx` + `src/features/workspaces/connect.ts`):

- On mount `load()`s the registry (cheap local JSON read; keeps the list fresh after saves/deletes).
- Renders the saved-connection **cards** (`EngineBadge`, name + `EnvTag`, `connectionDetail(params)` mono detail line, arrow / spinner). Clicking a card runs the real `useConnectAndOpen()` → `connectionOpen({ id })` → `openWorkspace(toWorkspaceConnection(saved, opened))`; the spinner reflects **actual** latency (the M1 prototype's simulated 650ms delay is gone). Failures are toasted inside the flow (the §5 message) and resolve falsy.
- **"Open SQLite file…"** runs `pickSqliteFile()` then `useOpenSqliteFile(path)`: `connectionOpen({ params: { engine: "sqlite", path } })` (open _is_ the test for a local file — no separate `connection_test`); then **auto-saves** the opened file to the registry (name = file stem, env `dev`) so it appears next launch, **reusing an existing entry for the same path** instead of stacking duplicate cards. If the auto-save fails the workspace still opens (ephemeral entry) and the save failure is its own toast.
- "New connection" conditionally mounts `<NewConnectionModal>` (so its reducer state resets on every open).
- `loadError !== null` renders the backend's human sentence inline where the list would be (`connect-load-error`); an empty registry renders the empty-state copy.

### Styling

**§3.2 modal layout** (`NewConnectionModal.css`): a 480px modal. Top-to-bottom: engine **picker** (4-up card grid; active card = accent border + tint), the tinted **Environment** sub-panel (label + live env-tag preview top-right; 3-up segmented control with color dot + Material icon `code`/`science`/`public`, active segment takes its env color as border + 16% tint; an 8-swatch Color row recoloring the _selected_ env; a red production-warning row when production is selected), then — **for SQLite only** — a 2-column `form-grid` with Name and the `span-2` Database-file `file-row` (input + Browse) and the `span-2` `form-note` ("SQLite is a local file…"). Footer (`ModalActions`): a left `test-result` live region, a text "Test connection" button (disabled while testing), a filled "Save" button.

**§5 inline error style**: the test verdict region renders the backend's exact human sentence in `.test-result-err` (red) — never a stack trace; the OK state shows a `check_circle` accent icon + "Connection OK · {serverVersion}". The connect screen's registry-read failure renders the same human sentence in `.connect-load-error`. Connect/open failures from the flow surface as red error toasts carrying the backend message.

---

## Shared data contracts (cross-IPC types)

Rust (`src-tauri/src/shared/engine.rs`, `…/features/connections/domain/mod.rs`, `…/application/mod.rs`) ↔ TS (`src/features/connections/api.ts`, `src/shared/api/engine.ts`, `src/shared/api/error.ts`). All Rust types are `#[serde(rename_all = "camelCase")]`; enums lowercase.

- **`SavedConnection`** / TS `SavedConnection`: `{ id, name, engine, params, env, color?, createdAt? }`.
- **`ConnectionParams`** / TS `ConnectionParams` (engine-tagged union): M2's live arm `{ engine: "sqlite", path: string }`.
- **`Engine`** / TS `Engine`: `"sqlite" | "mysql" | "postgres" | "redis"`. **`Env`**: `"dev" | "staging" | "production"`.
- **`EngineInfo`** / TS `EngineInfo`: `{ engine: Engine, serverVersion: string }` (e.g. `serverVersion: "SQLite 3.46.0"`).
- **`SchemaInfo`**: `{ name: string, tableCount: number | null }`. **`TableInfo`**: `{ name: string, approxRowCount: number | null }`.
- **`QueryOptions`**: `{ rowLimit: number (default 500), schema: string | null }`. **`QueryResult`**: `{ columns: ColumnMeta[], rows: CellValue[][], rowCount: number, truncated: boolean, elapsedMs: number }`; **`ColumnMeta`**: `{ name: string, typeHint: string }`. Row cells are JSON values: `null`; numbers (integers within ±2^53−1); **strings for integers beyond the JS safe range** (precision preservation); strings for text; `"[blob N bytes]"` for blobs.
- **`OpenedConnection`** / TS `OpenResult`: `{ handleId: string, engineInfo: EngineInfo, kind: "sql" | "kv", schemas: SchemaInfo[], keyspace?: KeyspaceOverview }`. For SQLite: `kind: "sql"`, `schemas` = the live list (`main` + attached), `keyspace` omitted.
- **`ConnectionHandleId`**: a transparent string — the opaque open-connection handle.
- **`AppError`** → `{ kind: "io"|"serialization"|"notFound"|"invalid"|"database"|"unsupported", message: string }` (`src/shared/api/error.ts` mirrors it; `isAppErrorPayload` / `appErrorMessage` narrow a caught `unknown`).

---

## Behavior & edge cases

- **Connect failure shown in modal, never a stack trace.** Test/open failures arrive as structured `AppError` `{ kind, message }`; the modal renders `message` inline (§5) and the connect flow toasts it. The SQLite adapter pre-translates rusqlite errors to human sentences (`map_open_error` / `map_query_error`), so a Rust error chain never reaches the renderer.
- **No secrets persisted for SQLite.** `ConnectionParams::Sqlite` has only a `path`; `uses_password()` is false and `ssh()` is `None`, so `resolve_open_secret` short-circuits to `None` — **no keychain read (no OS prompt) and no secret written** on save/open/test. The JSON registry stores the whole SQLite entry as plain JSON safely.
- **Cancel handling.** `pickSqliteFile()` resolves `null` on cancel; both the modal Browse and the connect screen treat `null` as a no-op (no error, no spinner). The connect screen only enters the file-open spinner (`FILE_OPEN_ID`) _after_ a path is returned.
- **Plain browser dev (no Tauri).** Dialog/invoke rejections that aren't structured `AppError`s are detected (`!isAppErrorPayload`) and shown as info toasts ("…requires the desktop app") rather than errors; `load()` presents an empty registry with no `loadError`.
- **Open is the test for a local file.** "Open SQLite file…" skips `connection_test` — opening the file _is_ the validation; `open_validated` forces a header read so a bad file fails immediately with a §5 message.
- **Auto-save dedupe.** Opening the same file twice reuses the existing registry entry (matched by `params.engine === "sqlite" && params.path === path`) instead of stacking duplicate cards.
- **Row-limit truncation.** Results over `rowLimit` (default 500, hard cap 10 000) come back with `truncated: true` and exactly `rowLimit` rows; the adapter reads no further.
- **Large integers.** SQLite integers beyond ±2^53−1 cross IPC as **strings**, not numbers, so the renderer never silently loses precision.
- **Unknown / stale handle.** Any `connection_*`/`query_run` against a closed or unknown handle returns `NotFound` ("…not open (it may have been closed)"); a double `connection_close` is a benign `Ok(())`.
- **Corrupt registry.** `connections.json` that won't parse yields a `Serialization` error naming the file (rendered inline on the connect screen) and is **never overwritten** — no silent data loss.
- **Teardown.** `lib.rs` calls `ConnectionManager::close_all()` on app exit, closing every open handle (errors swallowed — the process is exiting).

## Acceptance criteria

1. Selecting a saved SQLite connection (or "Open SQLite file…") opens a real workspace whose schema list and table list come from `connection_open` / `connection_tables` against the live file (M3's sidebar may be minimal here).
2. **Test connection** in the modal round-trips: a valid `.db` shows "Connection OK · SQLite {version}"; a missing/non-database/unreadable file shows the matching §5 sentence inline.
3. Saving a SQLite connection persists it to `connections.json` (assigned UUID + `createdAt`) with **no secret written to the keychain**; it appears on the connect screen next launch.
4. "Open SQLite file…" opens via the native dialog, auto-saves the file (name = stem, env `dev`), and reuses an existing entry for the same path (no duplicate cards); cancel is a no-op.
5. `query_run` returns columns, JSON-mapped rows, `rowCount`, `elapsedMs`, and `truncated`; results over the row limit are truncated with `truncated: true`; integers beyond the JS safe range arrive as strings.
6. Every failure surfaces as a human §5 sentence (inline in the modal / connect screen, or a toast) — no stack traces; a corrupt `connections.json` is reported (named) and left untouched.
7. Closing the app closes all open handles; a closed/unknown handle yields `NotFound`; a double close is a no-op.
8. Backend tests pass: domain wire-format + migration round-trips, `JsonFileConnectionRepository` (missing/corrupt/atomic-write/parents/delete), application lifecycle (open/use/close/double-close, `close_all`, save/delete/secret policy, unregistered-engine `Unsupported`), and the SQLite adapter (open validation, schema/table listing, `value_to_json` safe-integer boundary, `quote_ident`, `missing_table_error` listing).

## Pixel / UX checklist

- New-connection modal **480px** wide on the shared `Modal` (scrim, Esc, focus trap); SQLite variant hides the General/SSH section tabs.
- Engine picker: **4-up** card grid (SQLite / MySQL / PostgreSQL / Redis); active card = accent border + tint; each card has a **28px** `EngineBadge` + label.
- SQLite form: Name input, `span-2` Database-file `file-row` (input + tonal "Browse…"), `span-2` `form-note` with the `hard_drive` icon and "SQLite is a local file — no network, tunnel, or TLS needed."
- Environment picker present for every engine: "Environment" label + live env-tag preview top-right; 3-up segmented control (color dot + `code`/`science`/`public` icon; active segment border + 16% tint in its env color); 8-swatch Color row (`#56b6c2 #5aa7f5 #34d39e #e2b340 #e8845a #e06c75 #b08cff #ef7fb1`) recoloring the selected env (defaults dev `#56b6c2`, staging `#e2b340`, production `#e06c75`); red production-warning row when Production is selected.
- Footer: left `test-result` live region — spinner + "Testing…" → accent `check_circle` + "Connection OK · {serverVersion}" → red `.test-result-err` sentence; text "Test connection" (disabled while testing) + filled "Save".
- Connect screen: centered **460px** panel (r16, `--bg1`, border, 28px padding) over an accent radial glow; brand row → "Open a workspace" → cards → actions ("New connection" tonal + "Open SQLite file…" text) → footnote "…Your credentials never leave this machine."
- Connection card: **34px** engine badge, name (13.5 / 600) + `EnvTag`, mono dim detail line (file path for SQLite), arrow that slides 2px + tints accent on hover, border tints accent on hover; click → spinner (real latency) → workspace opens; cards disabled while any connect is in flight.
