# M13 — Redis engine (parallel track)

Status: shipped, merged on `main` (`feat: M13 — Redis engine (key-value, parallel track)`).

> **Provenance.** This spec documents the **shipped code** as the source of truth, cross-checked
> against `design_handoff_bytetable_latest/REDIS_SPEC.md` (authoritative design) and the M13 entry
> in `MILESTONES.md`. Where REDIS_SPEC and the code diverge, the code wins and the divergence is
> called out inline. Every imperative sentence below is a **requirement** that the shipped artefact
> satisfies; rebuild to match it. Real symbol names and absolute paths are used throughout.
>
> **One structural note up front:** the M13 design placed the redis-cli in a closable `cli` **tab
> kind**. The follow-on milestone **M14 (docked console panel)** removed that tab kind and moved the
> redis-cli into the shared bottom panel (`src/features/console/`). The shipped code reflects M14:
> there is **no `cli` RedisTab kind**; the console is `RedisTerminalSession` mounted inside
> `TerminalPanel`. This document describes the redis-cli where it lives now and flags the delta.

## Goal

Redis as a first-class **fourth engine**, designed around its key-value model — **not** forced into
the relational table UI. It is built as its own vertical slice: a backend `keyvalue` feature behind a
**separate key-value port family** (distinct from the SQL `SchemaReader`/`QueryExecutor`), a `redis`
engine adapter on the `redis` crate, and a `redis_browse` renderer slice that reuses only the shell
(rail, tab bar, palette, status bar, design tokens, DataGrid, toasts). A Redis workspace and the three
SQL workspaces coexist as sibling rail tiles; neither slice imports the other.

## Dependencies — M0–M1 + M4 tab system; crate: `redis`

- **M0–M1**: design system, workspace rail, connect modal (the modal already offers the Redis engine
  as its 4th picker column), the `ConnectionsState` manager + `ConnectionHandleId` model.
- **M4**: the per-workspace tab system + shared `SqlResultGrid`/`GridCell` DataGrid (reused by the
  hash/list/set/zset/stream viewers).
- **Crate**: [`redis`](https://crates.io/crates/redis) (async, `redis::aio::MultiplexedConnection`),
  with `SCAN` cursors. Builds on the shared SSH-tunnel + TLS infrastructure from M12.

---

## Backend (Rust core)

### Domain — key types, key metadata, RESP reply model

All domain types live in `src-tauri/src/shared/keyvalue.rs` (the port + DTO module, shared so the
adapter and the feature both depend on it without depending on each other).

- **`KeyType`** enum — the six Redis types. Variants `String, Hash, List, Set, Zset, Stream`.
  Helpers `as_token(self) -> &'static str` (`"string"|"hash"|"list"|"set"|"zset"|"stream"`) and
  `from_token(&str) -> Option<Self>`. Serialized to TS as the lowercase token.
- **`KvValue`** enum — the typed value union, **wire-tagged by a `type` field**:
  - `Str { value: String }` — scalar (may be int or JSON text).
  - `List { items: Vec<String> }` — ordered.
  - `Set { members: Vec<String> }` — unique, unordered.
  - `Hash { fields: Vec<KvField> }` — ordered `{field, value}` pairs.
  - `Zset { entries: Vec<KvScored> }` — `{member, score}`, returned sorted by score.
  - `Stream { entries: Vec<KvStreamEntry> }` — `{id, fields}`.
  - `Missing {}` — key vanished / wrong type fallthrough.
  - Leaf structs: `KvField { field, value }`, `KvScored { member, score: f64 }`,
    `KvStreamEntry { id: String, fields: Vec<KvField> }`.
- **Key metadata.**
  - `KeyEntry { name: String, key_type: KeyType, ttl: i64 }` — one row in a scan page (`ttl`: `-1`
    no expiry, `-2` vanished mid-scan).
  - `KeyView { key_type: KeyType, ttl: i64, encoding: Option<String>, memory: Option<u64>,
idle: Option<u64>, value: KvValue }` — the full single-key view: `encoding` from
    `OBJECT ENCODING`, `memory` from `MEMORY USAGE`, `idle` from `OBJECT IDLETIME`.
- **Scan paging.** `ScanRequest { pattern: String, type_filter: Option<KeyType>, cursor: String,
count: u32 }` and `ScanPage { cursor: String, keys: Vec<KeyEntry> }` (`cursor == "0"` ends paging).
- **Keyspace stats / identity.**
  - `KvServerInfo { server_version, mode, role, resp_version: u8 }` (dashboard header / status bar).
  - `KvServerStats { keyspace_hits, keyspace_misses, instantaneous_ops_per_sec, connected_clients,
used_memory, maxmemory, uptime_in_days, expired_keys, evicted_keys }` — best-effort from `INFO`
    (`maxmemory == 0` = unbounded).
  - `KvDbInfo { index: u8, key_count: u64 }` — per-db counts from the `INFO keyspace` section.
- **RESP reply model** — `RespReply` enum, internally tagged by `kind`:
  - `Status { value }` (`+OK`, `+PONG`), `Error { value }` (`-ERR`, `-WRONGTYPE` — surfaced, **not**
    thrown), `Int { value: i64 }`, `Bulk { value: Option<String> }` (`None` = nil), `Array { items:
Vec<RespReply> }` (nests).

### Ports — key-value port family

`src-tauri/src/shared/keyvalue.rs` declares three `#[async_trait]` traits + a super-trait. These are a
**separate family** from the SQL ports; no SQL trait references them.

- **`KeyspaceReader`**
  - `async fn server_info(&self) -> Result<KvServerInfo, AppError>`
  - `async fn server_stats(&self) -> Result<KvServerStats, AppError>`
  - `async fn keyspace(&self) -> Result<Vec<KvDbInfo>, AppError>`
  - `async fn scan(&self, db: u8, req: ScanRequest) -> Result<ScanPage, AppError>`
  - `async fn get_key(&self, db: u8, key: &str) -> Result<KeyView, AppError>`
- **`KeyspaceWriter`** — `set_string`, `hash_set`, `hash_del -> bool`, `list_set`, `set_add -> bool`,
  `set_remove -> bool`, `zset_add(.., score: f64)`, `zset_remove -> bool`, `delete_key -> bool`,
  `rename_key`, `expire(.., seconds: i64) -> bool`, `persist -> bool`,
  `create_key(.., key_type: KeyType, initial: Option<&str>)`. Every method takes `db: u8, key: &str`.
- **`CommandRunner`** — `async fn run_command(&self, db: u8, args: Vec<String>) -> Result<RespReply,
AppError>` (the raw redis-cli executor).
- **`KeyValueConnection`** — super-trait bundling all three, plus `fn engine_info(&self) -> EngineInfo`
  and `async fn close(&self) -> Result<(), AppError>`. This is the object stored per handle.

### Application — listing, metadata, type reads, writes, raw exec, db switch, keyspace stats

`src-tauri/src/features/keyvalue/application.rs` is a thin orchestration layer: it pulls the
`Arc<dyn KeyValueConnection>` for a handle and delegates to the port methods.

- **SCAN listing**: `scan(db, ScanRequest{ pattern, type_filter, cursor, count })`. Cursor-driven —
  the renderer pages by re-calling with the returned `cursor` until `"0"`. `COUNT` is the server work
  hint (default 100), `MATCH` is the glob, optional `TYPE` filter is applied server-side.
- **Key metadata + type reads**: `get_key(db, key)` returns one `KeyView` (TYPE/TTL/encoding/memory/
  idle + the typed `KvValue`). The adapter reads each type with the canonical command (below).
- **Writes**: each `KeyspaceWriter` method = one Redis write (SET/HSET/HDEL/LSET/SADD/SREM/ZADD/ZREM/
  DEL/RENAME/EXPIRE/PERSIST + `create_key`).
- **Raw command exec**: `run_command(db, args)` → typed `RespReply` for the console.
- **DB switch**: there is **no shared "current db"** in the core. Every command carries `db: u8`
  (0–15); the renderer owns the selected db and passes it per call.
- **Keyspace stats**: `keyspace()` → per-db counts; `server_stats()` + `server_info()` → dashboard.

### Infrastructure — `redis`-crate adapter; safety

Adapter lives under `src-tauri/src/engines/redis/` (`mod.rs` + `value.rs`).

- **`RedisConnector`** implements the shared `Connector` trait: `test` / `open` /
  `test_with_secret` / `open_with_secret(params, secret)`. It reads `ConnectionParams::Redis`
  (`host`, `port` default **6379**, `db_index` 0–15, optional ACL `user` → `default` when `None`,
  password via secret, `tls_mode`, optional `ssh: SshConfig`), establishes the optional SSH tunnel,
  builds the `redis::Client`, and returns an `OpenConnection::Kv(Arc<dyn KeyValueConnection>)`.
- **`RedisKvConnection`** is the open connection. It holds `client: redis::Client`, the resolved
  `EngineInfo`, an optional `_tunnel: SshTunnel` (kept alive for the connection's lifetime), and
  `connections: Mutex<HashMap<u8, MultiplexedConnection>>` — **one multiplexed connection per db
  index**, lazily opened by `conn_for(db)` and bound once with `SELECT db`. This avoids per-operation
  `SELECT` racing across awaits on a shared connection.
- **SCAN listing** (no blocking `KEYS *`): paginates with the cursor; for each page of names,
  `enrich_keys(conn, names)` issues `TYPE` + `TTL` for every key in **one pipelined round trip** and
  drops any key that vanished (`ttl == -2`).
- **TYPE / TTL / OBJECT ENCODING / MEMORY USAGE / OBJECT IDLETIME** populate `KeyView`.
- **Type reads** in `read_typed_value(conn, key, key_type)`: string `GET`; list `LRANGE key 0 -1`;
  set `SMEMBERS`; hash `HGETALL`; zset `ZRANGE key 0 -1 WITHSCORES`; stream `XRANGE key - +`.
  RESP2 flat arrays and RESP3 maps/pairs/doubles are both handled (`parse_field_pairs`,
  `parse_scored`, `parse_stream`, `score_of`).
- **Raw executor → typed RESP**: `run_command` sends tokens via the dynamic-command API; `value.rs`
  `value_to_reply(redis::Value) -> RespReply` maps the wire reply, and
  `redis_error_as_reply_text(&RedisError) -> Option<String>` converts **server** errors
  (`WRONGTYPE`, `ERR unknown command …`) into a `RespReply::Error` rather than a thrown `AppError`;
  real I/O failures still become `AppError`.
- **Safety (shipped state):**
  - Listing is **always** cursor `SCAN`; no `KEYS *` is ever issued by `scan`. (A user can still type
    `KEYS *` into the console; that is plain `run_command`.)
  - The core exposes **no `FLUSHDB`/`FLUSHALL`** port method; bulk destructive intent only reaches
    Redis through the raw `run_command`. The **production confirm gate lives in the renderer**
    (see Behavior): the redis-cli intercepts `FLUSHDB`/`FLUSHALL` and multi-key `DEL`/`UNLINK` on a
    `production`-env connection and requires confirmation before invoking `kv_command`. Single-key
    deletes from the key tab also confirm in the renderer.
  - `rename_key` maps Redis `ERR no such key` to `AppError::NotFound` (a §5 human sentence).
  - `get_kv(handle)` rejects a handle that is not the `Kv` variant with `AppError::Unsupported`
    (cannot drive Redis ports against a SQL connection).

### Tauri commands

Registered in `src-tauri/src/lib.rs` (`generate_handler!`); defined in
`src-tauri/src/features/keyvalue/commands.rs`. All take `state: State<ConnectionsState>` +
`handle_id: ConnectionHandleId` and return `Result<_, AppError>`. **19 commands:**

| Command           | Args (beyond state + handle_id)                       | Returns         | Errors                                                                     |
| ----------------- | ----------------------------------------------------- | --------------- | -------------------------------------------------------------------------- |
| `kv_server_info`  | —                                                     | `KvServerInfo`  | `AppError` (conn down / wrong kind)                                        |
| `kv_server_stats` | —                                                     | `KvServerStats` | `AppError`                                                                 |
| `kv_keyspace`     | —                                                     | `Vec<KvDbInfo>` | `AppError`                                                                 |
| `kv_scan`         | `db: u8, request: ScanRequest`                        | `ScanPage`      | `AppError`                                                                 |
| `kv_get_key`      | `db: u8, key: String`                                 | `KeyView`       | `AppError`                                                                 |
| `kv_set_string`   | `db, key, value: String`                              | `()`            | `AppError`                                                                 |
| `kv_hash_set`     | `db, key, field, value`                               | `()`            | `AppError`                                                                 |
| `kv_hash_del`     | `db, key, field`                                      | `bool`          | `AppError`                                                                 |
| `kv_list_set`     | `db, key, index: i64, value`                          | `()`            | `AppError` (out-of-range index)                                            |
| `kv_set_add`      | `db, key, member`                                     | `bool`          | `AppError`                                                                 |
| `kv_set_remove`   | `db, key, member`                                     | `bool`          | `AppError`                                                                 |
| `kv_zset_add`     | `db, key, member, score: f64`                         | `()`            | `AppError`                                                                 |
| `kv_zset_remove`  | `db, key, member`                                     | `bool`          | `AppError`                                                                 |
| `kv_delete_key`   | `db, key`                                             | `bool`          | `AppError`                                                                 |
| `kv_rename_key`   | `db, key, new_key`                                    | `()`            | `AppError::NotFound` on missing key                                        |
| `kv_expire`       | `db, key, seconds: i64`                               | `bool`          | `AppError`                                                                 |
| `kv_persist`      | `db, key`                                             | `bool`          | `AppError`                                                                 |
| `kv_create_key`   | `db, key, key_type: KeyType, initial: Option<String>` | `()`            | `AppError::Unsupported` for unsupported seed                               |
| `kv_command`      | `db, args: Vec<String>`                               | `RespReply`     | `AppError` only on I/O failure; server errors arrive as `RespReply::Error` |

Connection lifecycle (open/close/test) reuses the shared M1/M12 connection commands; Redis flows
through `OpenConnection::Kv` and `ConnectionsState::manager().get_kv(&handle_id)`.

---

## Frontend (React)

Slice root: `src/features/redis_browse/`. Console: `src/features/console/` (shared with SQL).

### State

- **`useRedisBrowseStore`** — `src/features/redis_browse/state.ts`. Per-workspace state keyed by
  `workspaceId`, surviving rail switches.
  - Fields: `tabs: RedisTab[]`, `activeTabId: string`, `dbIndex: number` (selected db 0–15),
    `version: number` (monotonic invalidation nonce, bumped after a write/refresh to force re-scan).
  - `RedisTab` is a discriminated union over `kind`: `{ kind: "dashboard"; closable: false }` and
    `{ kind: "key"; db; key; keyType: KeyType }`. **No `cli` kind** (removed in M14).
  - Actions: `ensure`, `setDbIndex` (switch db + bump version), `bumpVersion`, `openKeyTab`,
    `openDashboardTab`, `setActiveTab`, `closeTab` (dashboard never closable), `clear`.
- **CLI / console state** — `usePanelStore` in `src/features/console/state.ts` (shared SQL+Redis).
  - `PanelState { open, maximized, height, sessions: TermSession[], activeSessionId }` keyed per
    workspace. `TermSession { id, title, lines: TermLine[], history: string[], buffer, timing }` —
    the redis-cli history lives here as `history`. `TermLine { cls, text }`.
  - Actions: `togglePanel`, `openPanel`, `closePanel`, `toggleMax`, `setHeight`, `newSession`,
    `closeSession`, `selectSession`, `patchSession`. The selected db / preset list for Redis come
    from `useRedisBrowseStore.dbIndex` + the preset constant in `RedisTerminalSession`.

### API — typed invoke wrappers

`src/features/redis_browse/api.ts` — one wrapper per Tauri command (camelCase), all `invoke<T>(...)`:

`kvServerInfo(handleId)`, `kvServerStats(handleId)`, `kvKeyspace(handleId)`,
`kvScan(handleId, db, request)`, `kvGetKey(handleId, db, key)`, `kvSetString`, `kvHashSet`,
`kvHashDel`, `kvListSet`, `kvSetAdd`, `kvSetRemove`, `kvZsetAdd(.., score)`, `kvZsetRemove`,
`kvDeleteKey`, `kvRenameKey`, `kvExpire(.., seconds)`, `kvPersist`, `kvCreateKey(.., keyType,
initial?)`, and `kvCommand(handleId, db, args: string[]) -> RespReply` (never throws on server
errors — they return as `{ kind: "error" }`).

### Components

All under `src/features/redis_browse/components/` unless noted.

- **`RedisWorkspace.tsx`** — slice root, sibling of the SQL `WorkspaceShell`. Frame: sidebar 248px |
  (tab bar 37px | tab content) | status bar 28px. Owns ⌘K palette, ⌘T / Ctrl+\` to open the docked
  console, and mounts the shared `TerminalPanel` at the bottom.
- **`RedisSidebar.tsx`** (+ `RedisSidebar.css`) — keyspace browser:
  1. Connection header (color bar, `Rd` badge, name + env dot, detail w/ tunnel lock, close power).
  2. **DB row** — `storage`-icon button `db{N}` + key count + chevron → popover (`.rdb-pop`) listing
     db0–db15 with per-db counts (empty dimmed); `monitoring` icon (open dashboard); `sync` icon
     (refresh, spins while loading). Switching db re-lists.
  3. **MATCH input** — mono, accent `MATCH` label, default `*`, glob; reset affordance when ≠ `*`.
  4. **Type filter chips** (`.rtype-chips`) — `all` + six type chips, tinted with the type color
     when active.
  5. **KEYS section label** + tree⇄flat toggle (`.rview-toggle`) + match count.
  6. **Key list** — flat (full names) or namespace **tree** (default; split on `:`, collapsible
     `folder` rows with leaf counts, leaves shown by last segment). Each row: type badge (16px) ·
     mono ellipsized name · TTL badge (`.rkey-ttl`, `.live` tint when it has an expiry). "Load more"
     pages the cursor.
  7. **Footer** — full-width tonal **"New CLI console"** → `openPanel` (the docked panel; no longer a
     tab).
- **`RedisTabBar.tsx`** — 37px tab bar; one tab per `{dashboard, key}` tab (dashboard non-closable,
  key tabs carry a leading **type badge** not a generic icon); right-aligned **"Terminal"** toggle
  (lights when the panel is open). No `+`/cli tab (M14 delta).
- **`RedisTabContent.tsx`** — switch on `tab.kind`: `dashboard → DashboardTab`, `key → KeyTab`.
- **`KeyTab.tsx`** (+ `KeyTab.css`) — type-aware viewer. Toolbar: **Value / Info** segmented toggle
  (Value carries the type badge) · key name mono chip · TTL badge · right size readout (`N bytes` for
  string, `N items` otherwise). Value-mode viewers (all grids reuse the shared DataGrid; numbers
  right-aligned, mono):
  - `StringViewer` — full-height pane; JSON pretty-print when parseable (`JSON|string · N bytes`
    header); **Edit** → textarea → **Save (SET)** via `kvSetString`, then toast + `bumpVersion`.
  - `HashViewer` — `field | value` grid; edit value → `HSET`; edit field → `HDEL old` + `HSET new`;
    add/delete field.
  - `ListViewer` — `index | value` grid; edit value → `LSET`.
  - `SetViewer` — `member` grid; add → `SADD`; remove → `SREM`.
  - `ZsetViewer` — `rank | member | score` grid sorted by score; edit score → `ZADD key score
member`; remove → `ZREM`.
  - `StreamViewer` — read-only `id | fields` grid (fields flattened `k=v  k=v`).
  - **Info mode** — type badge + key + copy; two-column grid (Type, Encoding, Elements, Size
    `humanBytes`, Idle `humanTTL`, TTL `no expiry (∞)` / `29m (1740s)`); quick-action row: seconds
    input + **Set TTL (EXPIRE)**, **Persist** (only when a TTL exists), **Delete key (DEL)**
    (confirms, then closes the tab). Reports active-key meta up via `onMeta` for the status bar.
- **`DashboardTab.tsx`** (+ `DashboardTab.css`) — `Rd` badge + "Keyspace dashboard" + `{mode} ·
{role} · Redis {version}`; 4-up **stat grid** (Total keys, Memory used of max, Hit rate %, Ops/sec,
  Clients, Uptime, Expired, Evicted from `kvServerStats`); **Keys by type** panel (one colored bar per
  type, sampled from a bounded SCAN, caption `Sample of db{N} (X keys)`); **Keys per database** panel
  (db0–db15 mini-cells, empty dimmed, current highlighted, click switches db).
- **`RedisStatusBar.tsx`** — color chip · name · `cache` env tag · `Redis {version}` · tunnel lock ·
  `db{N} · {count} keys` · spacer · active-key `type · memory` · `RESP{N}`.
- **`RedisCommandPalette.tsx`** — ⌘K: a bounded key-jump sample (`vpn_key` icon + key + type hint),
  then **New CLI console** (⌘T), **Keyspace dashboard**, switch-to-db entries (non-empty dbs),
  **Close workspace**.
- **`RedisTypeBadge.tsx`** — the shared type badge (rounded square, mono 600, short label
  `Str/Hsh/Lst/Set/ZSt/Xst`, fill `{color}22`, border `{color}55`).
- **redis-cli console** — `src/features/console/RedisTerminalSession.tsx`, rendered as the Redis body
  of the shared `TerminalPanel.tsx`. Toolbar: `terminal` icon + preset chips + clear. Presets
  (exact): `KEYS *`, `DBSIZE`, `INFO`, `SCAN 0 MATCH session:* COUNT 20`,
  `ZREVRANGE leaderboard:sales 0 4 WITHSCORES`, `HGETALL feature_flags`. Body: scrolling log + sticky
  input prompted `{conn}:db{N}>`; ↑/↓ history; Ctrl+L clear. Replies formatted by `formatReply`
  (below). Writes bump the workspace `version`; `SELECT n` updates `useRedisBrowseStore.dbIndex`.

### Styling — classes; routing

- Redis viewer classes: `.redis-sidebar`, `.rkey-item`/`.rkey-list`/`.rkey-name`/`.rkey-ttl`(`.live`),
  `.rns-row`/`.rns-name`/`.rns-count` (tree), `.rtype-chips`/`.rtype-chip`, `.rview-toggle`,
  `.rdb-keycount`/`.rdb-pop`, `.rtype-badge`; key tab `.rkey-tab`/`.rkey-toolbar`/`.rkey-size`,
  string `.rstr*`, grid `.rinfo-*`; dashboard `.rdash-*`; palette `.palette*`. (Files: the per-
  component `.css` next to each component.)
- redis-cli classes (in `src/features/console/`): panel `.term-panel`/`.term-tabs`/`.term-resize`/…;
  Redis body `.rcli`, `.rcli-toolbar`, `.rcli-title`, `.rcli-body`, `.rcli-inputline`, `.rcli-input`,
  `.rcli-prompt`, `.rcli-line`, `.snippet-chip`; reply lines `.cli-status` `.cli-error` `.cli-int`
  `.cli-bulk` `.cli-nil` `.cli-idx` `.cli-prompt` `.cli-info`.
- **Routing**: `src/App.tsx` branches on the active workspace's `kind` — `kind === "kv"` →
  `<RedisWorkspace>`, otherwise `<WorkspaceShell>` (the relational shell). The workspace `kind` is
  `"kv"` for a `redis` engine connection. Neither slice imports the other; shared bits (badge, tokens,
  DataGrid, toast, palette, the console host) live in shared/kernel.

---

## Shared data contracts — TS + Rust types

| Concept         | Rust (`shared/keyvalue.rs`)                                                                          | TS (`redis_browse/api.ts` + `state.ts`)                                                         |
| --------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| key type        | `KeyType` (`String`…`Stream`)                                                                        | `KeyType = "string"\|"hash"\|"list"\|"set"\|"zset"\|"stream"`                                   |
| scan row        | `KeyEntry { name, key_type, ttl }`                                                                   | `KeyEntry { name; keyType; ttl }`                                                               |
| key view        | `KeyView { key_type, ttl, encoding: Option<String>, memory: Option<u64>, idle: Option<u64>, value }` | `KeyView { keyType; ttl; encoding; memory; idle; value: KvValue }`                              |
| value (string)  | `KvValue::Str { value }`                                                                             | `{ type: "str"; value: string }`                                                                |
| value (list)    | `KvValue::List { items }`                                                                            | `{ type: "list"; items: string[] }`                                                             |
| value (set)     | `KvValue::Set { members }`                                                                           | `{ type: "set"; members: string[] }`                                                            |
| value (hash)    | `KvValue::Hash { fields: Vec<KvField> }`                                                             | `{ type: "hash"; fields: KvField[] }`                                                           |
| value (zset)    | `KvValue::Zset { entries: Vec<KvScored> }`                                                           | `{ type: "zset"; entries: KvScored[] }`                                                         |
| value (stream)  | `KvValue::Stream { entries: Vec<KvStreamEntry> }`                                                    | `{ type: "stream"; entries: KvStreamEntry[] }`                                                  |
| value (missing) | `KvValue::Missing {}`                                                                                | `{ type: "missing" }`                                                                           |
| field           | `KvField { field, value }`                                                                           | `KvField { field; value }`                                                                      |
| scored          | `KvScored { member, score: f64 }`                                                                    | `KvScored { member; score }`                                                                    |
| stream entry    | `KvStreamEntry { id, fields }`                                                                       | `KvStreamEntry { id; fields: KvField[] }`                                                       |
| scan req/page   | `ScanRequest { pattern, type_filter, cursor, count }` / `ScanPage { cursor, keys }`                  | `ScanRequest { pattern; typeFilter?; cursor; count }` / `ScanPage { cursor; keys: KeyEntry[] }` |
| server info     | `KvServerInfo { server_version, mode, role, resp_version }`                                          | `KvServerInfo { serverVersion; mode; role; respVersion }`                                       |
| server stats    | `KvServerStats { keyspace_hits, …, evicted_keys }`                                                   | `KvServerStats { keyspaceHits; …; evictedKeys }`                                                |
| per-db count    | `KvDbInfo { index, key_count }`                                                                      | `KvDbInfo { index; keyCount }`                                                                  |
| RESP reply      | `RespReply::{Status,Error,Int,Bulk,Array}` (tag `kind`)                                              | `{ kind: "status"\|"error"\|"int"\|"bulk"\|"array"; … }`                                        |

Helpers (port from `redis_browse/helpers.ts`): `humanTTL(s)` → `∞ / Ns / Nm / Nh / Nd`;
`humanBytes(b)` → `B/KB/MB/GB`; `humanNum(n)` → `K/M`; `patternToRegExp(glob)` (glob→regex for the
MATCH client preview); `buildNamespaceTree`/`countLeaves`/`lastSegment`/`KEY_SEPARATOR=":"` (tree);
`tokenizeCommand`/`isMutatingCommand`/`isDestructiveCommand` (console); `REDIS_TYPES` map with fixed
accent colors — string `#61afef`, hash `#e2b340`, list `#c678dd`, set `#34d39e`, zset `#e8845a`,
stream `#8b93a3` — and `REDIS_TYPE_ORDER`.

`formatReply(reply, indent?, out?): CliLine[]` (in `helpers.ts`) mirrors redis-cli exactly:
status → `.cli-status` plain accent text; error → `.cli-error` `(error) …`; int → `.cli-int`
`(integer) N`; bulk → `.cli-bulk` quoted `"…"`, multi-line bulk (e.g. `INFO`) printed line-per-line,
nil → `.cli-nil` `(nil)`; array → numbered `1) … 2) …` with nested arrays indented one level
(`.cli-idx` indices), empty array → `(empty array)`.

---

## Behavior & edge cases

- **SCAN cursor paging.** Listing starts at cursor `"0"`, COUNT 100; "Load more" re-scans with the
  returned cursor until it comes back `"0"`. The MATCH glob and the type chip both feed `ScanRequest`
  (type filter applied server-side). `humanTTL`-formatted badges; vanished keys (`ttl -2`) are
  dropped by `enrich_keys` before reaching the UI.
- **`KEYS *` confirm.** `scan` never issues `KEYS`. If a user types `KEYS *` (or any other blocking
  command) into the redis-cli it runs as a raw `run_command` like any other command; the design
  intent is to gate huge/blocking listings behind a confirm at the console layer.
- **Production destructive-command confirm.** When the connection env is `production`, the redis-cli
  (`isDestructiveCommand`) intercepts `FLUSHDB`/`FLUSHALL` and multi-key `DEL`/`UNLINK` and requires
  the confirm modal before calling `kvCommand`. Single-key **Delete (DEL)** from the Info panel also
  confirms in the renderer. The backend exposes no `FLUSHDB`/`FLUSHALL` port; bulk wipes only travel
  through the guarded raw executor.
- **Type mismatch.** Reads/writes against the wrong type return a Redis `WRONGTYPE` — surfaced as
  `RespReply::Error` in the console (red `(error) WRONGTYPE …`), not a thrown error.
- **Live mutation.** Any successful write (key tab editors or a mutating console command) bumps
  `useRedisBrowseStore.version`; the sidebar re-scans and open key tabs re-`load` so changes are
  immediately visible. `SELECT n` in the console updates `dbIndex`.
- **SQL workspaces unaffected.** Redis is a sibling rail tile (`kind === "kv"`); SQL workspaces render
  the relational `WorkspaceShell` from the same `App.tsx` branch. No SQL slice imports Redis code or
  vice-versa; the shared DataGrid/badge/palette/console host are the only common surfaces. Adjacent
  SQL tiles run their own connections and tabs untouched.
- **DB isolation.** Each command carries its own `db: u8`; the adapter keeps one multiplexed
  connection per db, so reads/writes in db0 never bleed into db1.

---

## Acceptance criteria

1. **Connect** to a real Redis (host/port/db-index/ACL-user/password/TLS/SSH from the connect modal);
   the rail shows a Redis tile and routes to `RedisWorkspace`.
2. **Browse** a namespaced keyspace in **both** tree (default, `:`-split folders with leaf counts)
   and flat modes; MATCH glob and type chips filter the SCAN; TTL badges render via `humanTTL`;
   "Load more" pages the cursor.
3. **Open one key of each of the six types** (string/hash/list/set/zset/stream) into its correct
   viewer with the Value/Info toggle; Info shows encoding/memory/idle/TTL.
4. **Run a redis-cli session** (e.g. `GET`/`HGETALL`/`SCAN`/`INCR`/`DEL`/`ZADD`) with correct **typed
   replies** (status/error/integer/bulk/multi-line/nil/nested-array per `formatReply`) and **live
   mutation** (sidebar + open tabs refresh on writes); history (↑/↓) and Ctrl+L work.
5. **Switch databases** via the sidebar db popover, the dashboard per-db cells, the palette, or
   `SELECT n` in the console; the keyspace re-lists and the prompt/status bar track `db{N}`.
6. **SQL workspaces run unaffected** in adjacent rail tiles (full M4–M12 behavior intact).
7. A `WRONGTYPE`/`ERR` from the server shows as a red `(error) …` line, not a crash.
8. On a `production` connection, `FLUSHDB`/`FLUSHALL`/multi-key `DEL` and single-key Delete prompt for
   confirmation before executing.

---

## Pixel / UX checklist

- `Rd` engine badge color `#e8533d` (vermilion, distinct from error/production red `#e06c75`);
  badge recipe `{color}22` fill / `{color}55` border. Sample connection `byteshop_cache`
  (`cache.byteshop.io:6379 · db0`, env tag `cache` `#56b6c2`, `Redis 7.4.1`, SSH-tunneled).
- Connect modal: Redis is the 4th picker column; server form with **port default 6379**, **DB index
  (0–15)** in place of "Database", optional ACL user (placeholder `default`), password, TLS mode, SSH
  tab; no file picker.
- Frame matches SQL exactly: rail | sidebar 248px | tab bar 37px | content | status bar 28px.
- Type accent colors fixed: string `#61afef`, hash `#e2b340`, list `#c678dd`, set `#34d39e`,
  zset `#e8845a`, stream `#8b93a3`; short labels `Str Hsh Lst Set ZSt Xst` (rounded square, mono 600).
- Sidebar db popover: db0–db15 with counts, empty dimmed, current highlighted.
- TTL badge: `∞` when `-1`; else `30s/29m/2h/3d`, tinted accent with faint bg when an expiry exists.
- Key tab toolbar: Value button carries the type badge; right-aligned `N bytes` (string) / `N items`
  (other); grids reuse the shared DataGrid (sticky header, row numbers, mono, number right-align).
- Dashboard: 4-up stat cards; type bars colored per type with counts; 16 per-db mini-cells.
- redis-cli: accent prompt `{conn}:db{N}>`, mono; preset chips exactly as listed; reply colors per
  `.cli-*` classes; nested arrays indented one level.
- Status bar: color chip · name · `cache` tag · `Redis 7.4.1` · tunnel lock · `db{N} · {count} keys`
  · spacer · active-key `type · memory` · `RESP3`. (No "mock engine" tag in production.)

> **M14 delta (for the rebuilder):** the M13 design's closable `cli` tab kind, its `+`/⌘T-opens-a-tab
> behavior, and its tab-bar rendering were removed by M14. The redis-cli now lives in the shared
> docked `TerminalPanel` as `RedisTerminalSession`; "New CLI console", ⌘T, and the palette's
> "New CLI console" entry all `openPanel`/`togglePanel`. Build the console in the panel, not as a tab.
