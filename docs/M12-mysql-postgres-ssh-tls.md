# M12 — MySQL + PostgreSQL + SSH tunnels + TLS

> Provenance: this documents what SHIPPED (merged on `main`, `feat: M12 — MySQL + PostgreSQL + SSH tunnels + TLS`). Source of truth is the code; every imperative ("MUST", "is", "does") is a requirement a rebuild must satisfy, traced to a real path. Where the prototype/handoff sketch and the shipped code diverge, the **shipped code wins** and the divergence is called out (e.g. the modal's TLS list, the "tunnel up" string).

## Goal

Complete the engine matrix and the connection security story:

- **MySQL + PostgreSQL** as first-class relational engines behind the existing `EngineConnection` port — full introspection (multiple schemas / databases), DDL, browse/filter/insights/edit (M4–M11) identical to SQLite.
- **SSH tunnels** (`russh`) to reach servers through a bastion: key / password / ssh-agent auth.
- **TLS modes** (`disable` / `prefer` / `require` / `verify-ca` / `verify-full`) threaded to the sqlx drivers.
- **OS keychain** (`keyring`) for the two server secrets — the DB password and the SSH key passphrase / bastion password — keyed by saved-connection id, never in the JSON registry.
- **Real schema switcher** (Postgres `public`/user schemas; MySQL databases) and **tunnel-status indicators** (sidebar header + status-bar lock icon).

Renderer-and-backend milestone; depends only on the M2 connection seam and the M3–M11 SQL surface, which it now lights up for two more engines.

## Dependencies — M2–M11 (engine parity), crates: sqlx, russh, rustls, keyring

- **M2** connection manager / `Connector` seam (`OpenConnection`, `ConnectionHandleId`, the JSON registry). M12 adds two connectors + the keychain `SecretStore`.
- **M3–M11** SQL surface (`list_schemas`/`list_tables`/`table_meta`/`run_query`/`fetch_rows`/`fetch_row_by_key`/`column_stats`/`update_cell`/`alter_table`) — the Postgres and MySQL adapters implement **all** of these so M4–M11 work unchanged.
- **Crates** (`src-tauri/Cargo.toml`):
  - `sqlx = { version = "0.8", default-features = false, features = ["runtime-tokio", "tls-rustls", "postgres", "mysql", "bigdecimal", …] }` — async-native, awaited directly (no `spawn_blocking`, unlike rusqlite). `bigdecimal` is required because `NUMERIC`/`DECIMAL` arrive in a binary format sqlx cannot decode to a primitive.
  - `russh = "0.61"` — pure-Rust async SSH client (no system libssh2/OpenSSL), key/password/agent auth via `russh::keys`.
  - **rustls (shared)** — sqlx `tls-rustls`, `russh`'s rustls, and the M13 redis driver all unify on the single rustls 0.23 in the tree. No OpenSSL system dependency anywhere.
  - `keyring = "3"` — OS keychain (macOS Keychain / Windows Credential Manager / Secret Service).

## Backend (Rust core)

### Domain — `ConnectionParams` variants, SSH config, TLS modes, engine enum

`src-tauri/src/shared/engine.rs`.

- **`Engine`** (`enum { Sqlite, Mysql, Postgres, Redis }`, `#[serde(rename_all="lowercase")]`). `display_name()` → `"SQLite"`/`"MySQL"`/`"PostgreSQL"`/`"Redis"`.
- **`TlsMode`** (`#[serde(rename_all="kebab-case")]`): `Disable`, `Prefer` (`#[default]`), `Require`, `VerifyCa`, `VerifyFull`. `as_token()` → `disable`/`prefer`/`require`/`verify-ca`/`verify-full` — the exact strings the renderer `<select>` emits and the adapters' `ssl_mode_from_token` accepts.
- **`SshAuth`** (`#[serde(tag="method", rename_all="lowercase", rename_all_fields="camelCase")]`): `Key { key_path }` (`{"method":"key","keyPath":"…"}`), `Password` (`{"method":"password"}`), `Agent` (`{"method":"agent"}`). **Carries NO secret** — the key passphrase / SSH password live in the keychain; the key *path* and method are non-secret. `method_name()` → `"private key"`/`"password"`/`"ssh-agent"`.
- **`SshConfig`** (`#[serde(rename_all="camelCase")]`): `{ host, port: u16, user, auth: SshAuth }`. No secret here either.
- **`ConnectionParams`** (`#[serde(tag="engine", rename_all="lowercase", rename_all_fields="camelCase")]`), all server variants secret-free:
  - `Sqlite { path }`
  - `Mysql { host, port: u16, database, user, tls_mode: TlsMode, ssh: Option<SshConfig> }`
  - `Postgres { … same as Mysql … }`
  - `Redis { host, port (default 6379), db_index: u8 (default 0), user: Option<String>, tls_mode, ssh }` (M13; listed for completeness)
  - Accessors: `engine()`, `ssh() -> Option<&SshConfig>` (server variants), **`uses_password() -> bool`** (`true` for every non-SQLite engine — the gate that skips a needless keychain read for SQLite).
  - **Custom `Deserialize`** (hand-written so the migration lives in one place): reads the `engine` tag, then tolerantly reads `tlsMode` OR the legacy `tls: bool` (`true`→`Prefer`, `false`→`Disable`, absent→`Prefer`), and `ssh` (null/absent→`None`). `Serialize` is derived and always emits canonical `tlsMode`; `ssh` is `skip_serializing_if = "Option::is_none"`.
- **`ConnectSecret`** (transient, never persisted, custom `Debug` masks both fields): `{ password: Option<String>, ssh: Option<String> }`. `new(pw)`, `with_ssh(pw, ssh)`, `password()`, `ssh()`. The `ssh` arm carries the key passphrase (key auth) or bastion password (password auth); `None` for agent / direct.

### Ports — the shared `EngineConnection` / `Connector` traits MySQL+PG implement

`src-tauri/src/shared/engine.rs`. (Note: the doc-comment records that the original `SchemaReader`/`QueryExecutor` stubs were folded into one `EngineConnection` — "introspection and query execution are operations on an open connection".)

- **`Connector`** (`#[async_trait]`): `test`/`open` (secretless) + `test_with_secret`/`open_with_secret(params, Option<&ConnectSecret>)` (default impls delegate to the secretless form). MySQL/Postgres **override the `_with_secret` forms** to use the password + open the tunnel. `open*` returns `OpenConnection` (the SQL/KV kind seam — both engines wrap in `OpenConnection::sql(…)`).
- **`EngineConnection`** (`#[async_trait]`): `engine_info`, `list_schemas`, `list_tables`, `table_meta`, `run_query`, `fetch_rows` (required); `fetch_row_by_key`, `column_stats`, `update_cell`, `alter_table`, `truncate_table`, `drop_schema`, `execute_script` (default `Unsupported` — **both M12 adapters override every one**); `quote_identifier` (default ANSI double-quote; **MySQL overrides to backticks**); `close`.

### Application — open with optional SSH tunnel; secret resolution + keychain gating

`src-tauri/src/features/connections/application/mod.rs` + `secrets.rs`.

- **`SecretStore`** port (`secrets.rs`): `set/get/delete(account, …)`. Adapters: `KeyringSecretStore` (real `keyring` crate, service name `"ByteTable"`), `InMemorySecretStore` (`#[cfg(test)]`). Account derivation is the single source of truth: **`db_account(id) = id`**, **`ssh_account(id) = "{id}:ssh"`**. Keychain errors map to `AppError::Io("the OS keychain is unavailable (…)" / "could not read/save/delete a secret …")`; `keyring::Error::NoEntry` → `Ok(None)` / `Ok(())` (a missing entry is never an error).
- **`TransientSecrets { password, ssh }`** — `new(pw, ssh)` drops empty strings to `None` (so re-saving without retyping keeps the stored secret). `is_empty()` when both are `None`.
- **`save_connection`** — validates non-empty name + engine==params.engine(); assigns UUID + `created_at` for new entries; `repository.save` stores **only non-secret params**; then writes secrets **only when supplied AND non-empty**: `password` → `db_account(id)`, `ssh` → `ssh_account(id)`. Storing an empty string is explicitly avoided (it would create an item that later reads — and prompts — needlessly).
- **`delete_connection`** — repo delete first, then best-effort delete of both keychain accounts.
- **`test_connection`** — builds `ConnectSecret` from the transient secrets ONLY (testing happens before save), never reads/writes the keychain. SQLite ignores the secret (default `Connector`).
- **`open_connection`** — resolves params (saved id or ad-hoc), calls **`resolve_open_secret`**, then `open_with_secret`, then gathers the initial `schemas` (SQL) before handing the connection to the `ConnectionManager` and returning `OpenedConnection { handle_id, engine_info, kind, schemas, keyspace }`.
- **`resolve_open_secret` — the keychain-gating fix (avoid double prompt):**
  ```rust
  let mut password = transient.password.clone();
  let mut ssh      = transient.ssh.clone();
  if let Some(id) = saved_id {
      if password.is_none() && params.uses_password() { password = store.get(&db_account(id))?; }
      if ssh.is_none()      && params.ssh().is_some() { ssh      = store.get(&ssh_account(id))?; }
  }
  // None when both still None (SQLite / passwordless direct); else ConnectSecret::with_ssh(password, ssh)
  ```
  Each keychain `get` pops an OS access prompt, so the gate is load-bearing: a **non-tunnelled server** reads only the db password (the `ssh` account is NOT touched even if one is stored), and **SQLite** reads neither account. Before the fix a local server with no tunnel prompted twice (db + ssh). Transient values always win over the keychain (so first-connect-before-save works). Covered by the unit test `resolve_open_secret_merges_keychain_and_transient`.
- **`ConnectionManager`** — `get_sql`/`get_kv` return the kind-mismatch §5 error so a SQL command can never reach a Redis connection; stores `Arc` clones and drops the lock before awaiting driver work (one slow query never blocks others); `close_all` on app teardown.

### Infrastructure — sqlx MySQL + Postgres adapters; russh tunnel; TLS wiring

#### SSH tunnel — `src-tauri/src/engines/ssh.rs` (shared by both connectors)

- **`open_tunnel_if_needed(params, secret) -> Option<SshTunnel>`** — `None` when `params.ssh()` is `None`; else opens an `SshTunnel` to the params' real `host:port`, using `secret.ssh()` for the passphrase/password.
- **`tunnel_override(&Option<SshTunnel>) -> (Option<&str>, Option<u16>)`** — the `(127.0.0.1, ephemeral_port)` the driver connects to when tunnelled, `(None, None)` otherwise.
- **`db_password(secret) -> Option<&str>`** — the DB password arm, for sqlx connect options.
- **`SshTunnel::open(ssh, target_host, target_port, secret)`** — `russh::client::connect` to the bastion (failure → §5 `"Could not reach the SSH bastion {host}:{port} (…)"`), `authenticate`, bind a `127.0.0.1:0` listener, spawn an accept loop that opens a `channel_open_direct_tcpip` per inbound conn and `tokio::io::copy_bidirectional` pumps both ways. Held inside the `EngineConnection` (`_tunnel`) so it lives exactly as long as the DB connection; `Drop` aborts the accept loop and the session disconnects when its last `Arc` drops.
- **Auth (`authenticate`)** — `Password`: `authenticate_password`; `Key { key_path }`: `load_secret_key(expand_tilde(key_path), secret)` then `authenticate_publickey`; `Agent`: `AgentClient::connect_env()` (uses `SSH_AUTH_SOCK`), tries every identity until one is accepted. Every failure → `AppError::Database("SSH authentication to {user}@{host} failed: …")`. `expand_tilde` expands a leading `~/` via `$HOME`.
- **Host-key policy (deliberate):** `check_server_key` returns `true` — accept on first use (local-first desktop client; a known-hosts TOFU store is a documented future hardening item, not an oversight).

#### Postgres — `src-tauri/src/engines/postgres/{mod.rs, sql.rs}`

- **`PostgresConnector`** (stateless). `test_with_secret`/`open_with_secret`: `open_tunnel_if_needed` → `tunnel_override` → `sql::connect_options(params, db_password(secret), host_over, port_over)`. `test` connects a single `PgConnection`, reads version, closes. `open` builds a `PgPool` (`max_connections(4)`), reads version once, returns `PostgresEngineConnection { pool, info, _tunnel }`. `close()` → `pool.close()`.
- **`connect_options`** builds `PgConnectOptions::new().host(host_over.unwrap_or(host)).port(port_over.unwrap_or(port)).database(db).username(user).ssl_mode(ssl_mode_from_token(tls_mode.as_token())).application_name("ByteTable")`, `.password()` only when `Some`.
- **TLS — `ssl_mode_from_token`** (trim + lowercase, then): `disable`→`Disable`, `allow`→`Allow`, `prefer`→`Prefer`, `require`→`Require`, `verify-ca`→`VerifyCa`, `verify-full`→`VerifyFull`, unknown→`Prefer`. (Caveat: under `verify-full` the cert hostname is checked against the real `host`, not the local tunnel endpoint.)
- **Version** — `SHOW server_version`, `display_version` keeps the leading token and prefixes `"PostgreSQL "`.
- **Introspection (multi-schema):**
  - `list_schemas` — `pg_namespace LEFT JOIN pg_class` with `count(c.oid) FILTER (WHERE relkind='r')` as `table_count`; excludes `pg_catalog`, `information_schema`, `pg_toast%`/`pg_temp%`/`pg_toast_temp%`; ordered by `nspname`. → real `public`/user schemas.
  - `list_tables(schema)` — `ensure_schema_exists` then `pg_class JOIN pg_namespace … relkind='r'`; `approx_row_count` from the planner estimate `pg_class.reltuples` (never-analyzed `-1` → `None`).
  - `table_meta` — columns from `information_schema.columns` (ARRAY types substitute `udt_name`); PK via `pg_index.indisprimary`; outbound/inbound FKs via `pg_constraint contype='f'` (`fk_action` decodes `a/r/c/n/d`); indexes via `pg_index`; `comment` via `obj_description`; **DDL synthesized** by `assemble_ddl` (PG has no native source) — columns, `PRIMARY KEY`, table-level `FOREIGN KEY … REFERENCES` with non-`NO ACTION` ON DELETE/UPDATE only (best-effort; does not reproduce CHECK/exclusion/partitioning).
- **`run_query`** — `SET search_path TO "{schema}"` (best-effort) when `options.schema` is set; `query(sql).fetch_all`; truncates client-side at `row_limit` (sets `truncated`).
- **`fetch_rows`** — schema-qualified `"schema"."table"`; exact filtered `count(*)`; page `SELECT * … [WHERE …] [ORDER BY …] LIMIT $k OFFSET $k+1`; `$N` placeholders, limit/offset bound as `i64`; `limit.min(10_000)`.
- **Row→JSON** (`decode_value` on `type_info().name()`): `BOOL`→JSON bool; integer types via `decode_int` (≤2^53−1 → number, else **string** to preserve precision); `FLOAT4/8`→number (NaN/Inf→null); `NUMERIC/DECIMAL/MONEY`→`BigDecimal` normalized, number when it round-trips exactly else **exact string**; `BYTEA`→`"[N bytes]"`; `JSON/JSONB`→serialized JSON **string**; everything else (uuid/timestamp/date/array/enum/…) → text string; NULL→null.
- **Other ops** — `fetch_row_by_key` (null key → `match_count: 0`), `column_stats` (`is_numeric_type` drives numeric handling; min/max/avg + top-5), `update_cell` (real transaction; asserts exactly 1 affected, else rollback + §5), `alter_table` (native `ALTER TABLE` in one transaction; `ChangeType` → `ALTER COLUMN … TYPE … USING "c"::newtype`; pk-protected), `truncate_table` (counts first, then `TRUNCATE`), `drop_schema` (`DROP SCHEMA "x" CASCADE; CREATE SCHEMA "x"` — atomic via transactional DDL), `execute_script` (`split_statements` + `SET search_path`, one transaction). `quote_identifier` → double-quote, doubled `"`.
- **Errors** — `map_connect_error` → `AppError::Database("Could not connect to the PostgreSQL server: {driver msg}.")`; `map_query_error` surfaces the **server's own message** (capitalized, period-terminated) via `humanize`. No special-cased auth/host/db-not-found sentence — the raw PG message is surfaced. App-level §5 sentences (`ensure_schema_exists`, `missing_table_error`, column validation) match §5 style.

#### MySQL — `src-tauri/src/engines/mysql/{mod.rs, sql.rs}` (deltas from Postgres)

- **`MysqlConnector`** / `MysqlEngineConnection { pool, info, _tunnel }`, same connect path. `connect_options` builds `MySqlConnectOptions` (host/port/db/user/`ssl_mode`); password only when `Some`. `SYSTEM_SCHEMAS = ["mysql", "information_schema", "performance_schema", "sys"]`.
- **TLS — `ssl_mode_from_token`**: `disable`→`Disabled`, `allow`/`prefer`→`Preferred` (MySQL has no `allow`), `require`→`Required`, `verify-ca`→`VerifyCa`, **`verify-full`→`VerifyIdentity`** (sqlx has no `VerifyFull`), unknown→`Preferred`.
- **Version** — `SELECT VERSION()`, `display_version` drops the distro `-suffix` and prefixes `"MySQL "`.
- **`list_schemas` = list DATABASES** (schema == database): `information_schema.schemata` with a correlated `count(*)` over `BASE TABLE` rows, **excluding the 4 system schemas** (bound `NOT IN (?,?,?,?)`); `CAST(... AS CHAR)` to unwrap MySQL 8's VARBINARY information_schema strings. → the schema switcher lists real databases.
- **`list_tables`** — `information_schema.tables … table_type='BASE TABLE'`; `approx_row_count` ← `table_rows` (InnoDB cached estimate, NULL→None).
- **`table_meta`** — columns from `information_schema.columns` (display type = full `COLUMN_TYPE`, e.g. `tinyint(1)`, `varchar(255)`, `int unsigned`); PK from `column_key='PRI'`; FKs from `key_column_usage × referential_constraints`; indexes from `statistics`; `comment` from `tables.TABLE_COMMENT`; **DDL via `SHOW CREATE TABLE` (verbatim, faithful)** — reads result column index 1.
- **`run_query`** — `USE "{schema}"` (best-effort) when `options.schema` set; truncates client-side. **`fetch_rows`** uses fully-qualified `` `db`.`table` `` (not `USE`); `?` placeholders, limit/offset bound; exact filtered `count(*)`.
- **Row→JSON deltas**: `BOOLEAN/BOOL` (a `tinyint(1)`) → **integer 0/1**, NOT a JSON bool (only Postgres emits JSON bools); integer types via `decode_signed_width` reading the exact native width incl. unsigned (large → string); `DECIMAL/NEWDECIMAL` via `BigDecimal`; `BIT` folded big-endian; `JSON` → string; `BLOB/BINARY/VARBINARY/GEOMETRY` → `"[N bytes]"`.
- **`quote_identifier` override → backticks**: `` `{ident with `` doubled}` ``; `qualified` → `` `db`.`table` ``. LIKE family uses no explicit `ESCAPE` clause (MySQL's default escape is already `\`).
- **Non-atomic DDL caveats** (MySQL DDL auto-commits): `drop_schema` = `DROP DATABASE` + `CREATE DATABASE` (NOT atomic); `execute_script` runs statements one-by-one via the **text protocol** (dump DDL is rejected by the prepared-statement protocol) and reports how far it got on failure; `alter_table` builds all statements up front, validates ALL ops first, runs them sequentially and names the failing statement (no rollback). `SetNullable` uses `MODIFY COLUMN col {current_type} {NULL|NOT NULL}` (MODIFY couples type+nullability, so the current type is read from meta). `update_cell`/`truncate_table` are transactional/native like Postgres.
- **Errors** — `map_connect_error` → `"Could not connect to the MySQL server: {driver msg}."` (auth, unreachable host, unknown database all flow through this); `map_query_error` surfaces the server message via `humanize`. Same §5 app-level sentences.

#### M8 per-engine type list — shipped reality

The handoff scope line says "type lists for M8 per engine"; **the shipped code does NOT have a per-engine backend type list.** The structure-editor type picker is frontend-only and SQLite-flavoured for every engine: `SQLITE_TYPES = ["TEXT","INTEGER","REAL","NUMERIC","BLOB","BOOLEAN","DATE","TIMESTAMP"]` in `src/features/structure/ops.ts`, used by `StructureView.tsx`'s `TypeCell` (it prepends the column's current declared type if absent). The MySQL/Postgres adapters accept whatever type expression string the UI sends and pass it verbatim into native `ADD COLUMN`/`MODIFY COLUMN`/`ALTER COLUMN … TYPE`. The only backend type-name lists are each adapter's `is_numeric_type` helper — used solely for column-stats numeric detection, NOT for the editor. A faithful rebuild matching the spec wording would add `MYSQL_TYPES`/`POSTGRES_TYPES` and branch `TypeCell` on engine; the shipped build did not.

### Tauri commands — table (delta vs SQLite/M2)

`src-tauri/src/features/connections/commands.rs`. M12 adds the two transient-secret args (`password`, `ssh_secret`) to save/test/open; the rest of the surface is unchanged (and now simply works for two more engines).

| command | args | returns | errors / notes |
|---|---|---|---|
| `connection_list` | — | `Vec<SavedConnection>` | — |
| `connection_save` | `connection`, `password?`, `ssh_secret?` | `SavedConnection` | `Invalid` (blank name / engine-params mismatch); stores supplied non-empty secrets to keychain keyed by assigned id (DELTA: `ssh_secret` arg) |
| `connection_delete` | `id` | `()` | clears both keychain accounts (best-effort) |
| `connection_test` | `params`, `password?`, `ssh_secret?` | `EngineInfo` | uses transient secrets ONLY (never touches keychain); SSH/connect/TLS errors are §5 `Database` (DELTA: `ssh_secret` arg) |
| `connection_open` | `id?` XOR `params?`, `password?`, `ssh_secret?` | `OpenedConnection` | `Invalid` if both/neither id+params; saved id → keychain secrets via `resolve_open_secret` (gated), transient overrides; ad-hoc params → transient only (DELTA: `ssh_secret` arg) |
| `connection_close` | `handle_id` | `()` | unknown handle is a no-op `Ok(())` |
| `connection_schemas` | `handle_id` | `Vec<SchemaInfo>` | `get_sql` kind-mismatch / not-open §5 (now returns real PG/MySQL schemas) |
| `connection_tables` | `handle_id`, `schema` | `Vec<TableInfo>` | unknown schema → §5 |
| `query_run` | `handle_id`, `sql`, `options?` | `QueryResult` | `row_limit` clamped to `MAX_ROW_LIMIT = 10_000` |

Composition root (`src-tauri/src/lib.rs`): `registry.register(Engine::Postgres, Arc::new(PostgresConnector))` and `Engine::Mysql, MysqlConnector`; `ConnectionsState::new(…, Box::new(KeyringSecretStore::new()))`. Every engine now has a registered connector (no more "arrives in a later milestone").

## Frontend (React)

### State — connection form; schema switcher real schemas; tunnel status

`src/features/connections/components/NewConnectionModal.tsx` — single `useReducer` over **`FormState`**:
```ts
interface FormState {
  engine: Engine;
  section: "general" | "tunnel";
  name: string; host: string; port: string;
  portTouched: boolean;          // switching engines keeps a user-edited port
  db: string; user: string; file: string;
  tls: TlsMode;
  password: string;              // transient
  useSsh: boolean;
  sshHost: string; sshPort: string; sshUser: string;
  sshAuth: SshAuthMethod;        // = SshAuth["method"]
  sshKey: string; sshPassword: string;
  env: Env; envColors: Record<Env, string>;
  test: TestState; saving: boolean;
}
// TestState = {idle} | {testing} | { ok; serverVersion } | { err; message }
```
- `DEFAULT_PORTS = { postgres: "5432", mysql: "3306", redis: "6379" }`; the `engine` action fills the default port only when `!portTouched`.
- `secrets()` builds `{ password, sshSecret }` — `sshSecret` is sent only when tunnelling with **password** auth (key passphrase is also a secret; agent sends none).
- The `field` action resets the test verdict; `section`/`saving`/`test`/`env`/`engine` do not.

Schema-switcher state lives in the workspaces store: `workspace.schemas: SchemaInfo[]` (seeded from `OpenResult.schemas` in `connect.ts`'s `toWorkspaceConnection`); selected schema is `workspace.ui.schemaName` (fallback to the first listed, or `"main"` for SQLite). Tunnel state is derived, not stored (see Components).

### API — typed invoke wrappers

`src/features/connections/api.ts`:
- `connectionList()`, `connectionSave(connection, secrets?)` (`{connection, password, sshSecret}`), `connectionDelete(id)`, `connectionTest(params, secrets?) → EngineInfo`, `connectionOpen(target, secrets?) → OpenResult`, `connectionClose(handleId)`, `connectionSchemas(handleId) → SchemaInfo[]`, `connectionTables(handleId, schema)`. `secrets` is `{ password?, sshSecret? }` everywhere.
- Tunnel helpers: `connectionIsTunneled(params)` (`engine !== "sqlite" && params.ssh !== undefined`), `tunnelTitle(params)` (`"Tunnelled through {user}@{host}:{port}"`), `connectionDetail(params)`.
- Verbatim TS types (mirror the Rust wire shapes):
```ts
export type TlsMode = "disable" | "prefer" | "require" | "verify-ca" | "verify-full";
export type SshAuth =
  | { method: "key"; keyPath: string }
  | { method: "password" }
  | { method: "agent" };
export interface SshConfig { host: string; port: number; user: string; auth: SshAuth; }
export type ConnectionParams =
  | { engine: "sqlite"; path: string }
  | { engine: "mysql";    host: string; port: number; database: string; user: string; tlsMode: TlsMode; ssh?: SshConfig }
  | { engine: "postgres"; host: string; port: number; database: string; user: string; tlsMode: TlsMode; ssh?: SshConfig }
  | { engine: "redis";    host: string; port: number; dbIndex: number; user?: string; tlsMode: TlsMode; ssh?: SshConfig };
```

### Components — modal SSH + TLS sections, schema switcher, tunnel indicator

- **NewConnectionModal** — 4-up engine picker (`role="radiogroup"`, SQLite/MySQL/PostgreSQL/Redis, active = accent border + tint). SQLite → file form + Browse + "SQLite is a local file — no network, tunnel, or TLS needed". Server engines → ARIA tablist **General / SSH tunnel** (SSH tab shows a dot when `useSsh`; both panels stay mounted, inactive uses `hidden` so controlled inputs keep their values).
  - **General**: Name; **TLS mode `<select>`** (see styling note on the shipped option list); Host; Port (sets `portTouched`); Database ("DB index" label for Redis); User ("ACL user", default `default`, for Redis); Password. Env picker (dev/staging/production segmented + color swatches; production warning).
  - **SSH tunnel**: toggle "Connect through an SSH tunnel"; when on → SSH host / port (default `22`) / user, **Auth method** `<select>` (`Private key` / `Password` / `SSH agent`); key path (default `~/.ssh/id_ed25519`) + Browse (`pickPrivateKeyFile`); or SSH password; or the agent note "Keys are read from your local ssh-agent. Nothing is stored." Live summary (icon `vpn_lock`): **`{sshUser||"user"}@{sshHost||"bastion"} → {host}:{port}`**.
  - **Footer** (`ModalActions`): `aria-live` result + "Test connection" + "Save". Test → `connectionTest`; success shows **`✓ Connection OK · {serverVersion}`** (`check_circle`); errors render the exact backend message inline (`.test-result-err`, via `isAppErrorPayload`). Save → store's `saveConnection(connection, secrets())`, toast, close.
- **Schema switcher** — inline in `src/features/workspaces/components/Sidebar.tsx` (`.schema-btn` / `.schema-pop`). Lists `workspace.schemas` (real PG/MySQL schemas, NOT the M2 single-schema placeholder), each row `role="menuitemradio"` with name + `schemaTableCount` (or "—"). Select → `patchWorkspaceUi(id, { schemaName })`. Refresh re-introspects via `connectionSchemas(handleId)` + `loadTables(force)` and `setWorkspaceSchemas`.
- **Tunnel status indicator** — `vpn_lock` Material icon tinted `var(--accent)`, gated on `connectionIsTunneled(params)`, title `tunnelTitle(params)`:
  - **Sidebar header**: `.tunnel-lock` in `.sidebar-conn-detail` (`Sidebar.tsx`).
  - **Status bar**: `.status-dim.status-tunnel` (`StatusBar.tsx`).
  (Redis has parallel `RedisSidebar`/`RedisStatusBar`.)

### Styling — §3.2 SSH/TLS; §5 error mapping

- §3.2: modal engine picker (4-up, active = accent border + tint); General/SSH section tabs (server engines only); env picker sub-panel; SSH toggle reveals the bastion fields + live `user@bastion → host:port` summary; connection card shows an `ssh` pill + tunnel lock on the detail line; sidebar header shows the lock when tunnelled.
- §5: `src/shared/api/error.ts` — `AppErrorPayload { kind, message }` (`kind` ∈ `io|serialization|notFound|invalid|database|unsupported`), `isAppErrorPayload`, `appErrorMessage`. The modal surfaces the **exact** backend §5 sentence (human, lowercase-table/column aware) inline; no client-side rephrasing.

## Shared data contracts — TS + Rust types

The wire shapes are the contract; Rust `Serialize`/`Deserialize` and the TS unions above must stay byte-identical.

- `ConnectionParams` — internally `engine`-tagged, fields camelCase. Server variants: `{ engine, host, port, database, user, tlsMode, ssh? }`. Redis: `{ engine, host, port, dbIndex, user?, tlsMode, ssh? }`. SQLite: `{ engine, path }`. `tlsMode` is canonical on save; the Rust deserializer also accepts legacy `tls: bool`.
- `SshConfig = { host, port, user, auth }`; `SshAuth` = `{method:"key", keyPath}` | `{method:"password"}` | `{method:"agent"}`.
- `TlsMode = "disable" | "prefer" | "require" | "verify-ca" | "verify-full"`.
- `EngineInfo { engine, serverVersion }`; `SchemaInfo { name, tableCount? }`; `OpenResult`/`OpenedConnection { handleId, engineInfo, kind, schemas, keyspace? }`.
- Secrets are **never** in `ConnectionParams` or `SavedConnection`; they travel as separate `password` / `sshSecret` command args (transient) and rest in the keychain (`db_account`/`ssh_account`).

## Behavior & edge cases

- **Keychain prompt exactly once per relevant secret.** `resolve_open_secret` reads `db_account` only when `uses_password()`, and `ssh_account` only when `params.ssh().is_some()`. SQLite → 0 prompts; non-tunnelled server → 1 (db only, even if an ssh secret happens to be stored); tunnelled server with key/password auth → up to 2 (db + ssh); agent auth stores no ssh secret. Empty secrets are never written (no phantom keychain item). Re-saving without retyping keeps the stored secret.
- **Engine-specific identifier quoting** — Postgres/SQLite double-quote (`"name"`, embedded `"` doubled); MySQL backticks (`` `name` ``, embedded `` ` `` doubled) via the `quote_identifier` override. Used by export (M15) and the cosmetic update statement.
- **Engine-specific snippet chips** — in the SQL terminal (`src/features/console/SqlTerminalTab.tsx`): SQLite `.tables`/`.schema users`/`SELECT … LIMIT 5`; MySQL `SHOW TABLES;`/`DESCRIBE orders;`/`GROUP BY`; Postgres `\dt`/`\d orders`/`SELECT … WHERE country='DE'`. (The SQL editor tab's `SQL_SNIPPETS` remains SQLite-flavoured only — not branched per engine.)
- **Error mapping** — connect failures (bad password, unreachable host, unknown database) → §5 `AppError::Database("Could not connect to the {PostgreSQL|MySQL} server: …")`; SSH auth → `"SSH authentication to {user}@{host} failed: …"`; query/DDL errors surface the server's own message (capitalized, period-terminated). Schema/table/column existence errors match the §5 templates ("Table 'x' does not exist. Available tables: …", "Column 'x' does not exist on 'T' (columns: …)").
- **M4–M11 behave identically across the three engines** — both adapters implement the full `EngineConnection` surface. Per-engine deltas are confined to: type→JSON mapping (PG `BOOL`→bool vs MySQL `tinyint(1)`→0/1; precision-preserving big-int/decimal strings on both), DDL source (PG synthesized vs MySQL `SHOW CREATE TABLE`), DDL atomicity (PG transactional vs MySQL auto-commit), `approx_row_count` source (PG `reltuples` vs MySQL `table_rows`), schema meaning (PG namespace vs MySQL database).
- **TLS + tunnel interaction** — when tunnelled, the driver connects to `127.0.0.1:<ephemeral>`; under `verify-full` (PG `VerifyFull` / MySQL `VerifyIdentity`) the certificate hostname is still verified against the real `host`.

## Acceptance criteria

- **PG via bastion + key auth**: a Postgres connection with `ssh = { host, port, user, auth: {method:"key", keyPath} }` and a key-passphrase secret in the keychain opens through the tunnel (russh local-forward to `127.0.0.1:<ephemeral>`), the sidebar header + status bar show the `vpn_lock` lock, and the schema switcher lists real `public`/user schemas — with exactly one keychain prompt per relevant secret (db + ssh; no double-prompt for the db).
- **Switch schemas**: selecting a schema (PG schema / MySQL database) in the popover re-scopes the sidebar table list; Refresh re-introspects via `connection_schemas`.
- **MySQL parity**: `list_schemas` returns databases minus the 4 system schemas; `table_meta.ddl` is the verbatim `SHOW CREATE TABLE`; `tinyint(1)` renders as `0/1`; backtick quoting in edits/exports.
- **Secret gating**: SQLite opens with zero keychain access; a non-tunnelled server reads only the db password.
- **Full regression across engines**: run M4 (browse/grid), M5 (filter builder), M6 (SQL editor), M7 (structure view), M8 (structure editing/ALTER), M9 (schema map), M10 (FK-hop + insights), M11 (inline edit) against SQLite, MySQL, and Postgres and confirm identical behavior (modulo the documented per-engine deltas).
- **TLS modes**: each of `disable`/`prefer`/`require`/`verify-ca`/`verify-full` maps to the documented sqlx ssl mode; a legacy `tls: bool` connection still loads (`true`→prefer, `false`→disable).

## Pixel / UX checklist

- Engine picker: 4-up grid, active card = accent border + tint.
- General/SSH section tabs only for server engines; SSH tab carries a dot when the tunnel toggle is on; SQLite shows the file picker + "no network, tunnel, or TLS needed" note.
- TLS mode `<select>` present on server engines. **Shipped delta:** the modal's `TLS_MODES` array is `["disable","prefer","require","verify-full"]` — it OMITS `verify-ca`, which the `TlsMode` type and the backend both support (`verify-ca` is reachable from saved/legacy params but not selectable). A faithful rebuild should add `verify-ca` to the option list to match the type.
- Port auto-fills 5432 / 3306 / 6379 by engine, preserved once edited.
- SSH summary line: `{user}@{bastion} → {host}:{port}` with the `vpn_lock` icon.
- Test result: **`✓ Connection OK · {serverVersion}`** with `check_circle`. **Shipped delta:** the handoff sketch said "✓ Connection OK · tunnel up"; the code shows the server version, not "tunnel up". Errors render the exact backend §5 message in `.test-result-err`.
- Tunnel lock (`vpn_lock`, `var(--accent)`) on the sidebar header detail line and the status bar, title `Tunnelled through {user}@{host}:{port}`, gated on `params.ssh` presence.
- Schema popover rows show name + table count (or "—"), selected row marked; Refresh spins and toasts.
