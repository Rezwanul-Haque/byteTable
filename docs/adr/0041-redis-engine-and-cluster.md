# ADR-0041 — Redis engine: key-value port family, per-node cluster view, clients tab

- **Status:** Accepted (retroactive — documented 2026-11-26 from the shipped implementation)
- **Date:** 2026-06-13 (first commit that shipped the feature; cluster view and clients tab followed on 2026-08-21)
- **Area:** Engines
- **Related:** ADR-0003, ADR-0004, ADR-0006, ADR-0008, ADR-0035, ADR-0051, `docs/M13-redis-engine.md`

## Context

Redis was the first non-relational engine. It has no schemas, tables, columns or SQL: it has
16 numbered logical databases, six value types (`string`/`hash`/`list`/`set`/`zset`/`stream`),
per-key TTLs, and a command protocol. Routing it through the SQL `EngineConnection` trait
(ADR-0003) would have meant a trait full of `Unsupported` stubs — the module doc of
`src-tauri/src/shared/ports/keyvalue.rs` records this as the reason for a separate port family.

Two later needs: seeing and killing connected clients (`CLIENT LIST` / `CLIENT KILL`),
and working against a Redis Cluster, where `SELECT` is rejected and `SCAN`, `INFO keyspace` and
`CLIENT LIST` all answer only for the node you are attached to.

## Decision

- **Separate port family.** `src-tauri/src/shared/ports/keyvalue.rs` defines a keyspace reader,
  a keyspace writer, a raw command runner, and `ClusterReader`, bundled as the
  `KeyValueConnection` super-trait. `OpenConnection::Kv` in `src-tauri/src/shared/ports/mod.rs`
  is the seam that lets the shared `ConnectionManager` hold a Redis handle next to SQL ones;
  `get_kv` refuses a handle of the wrong kind, so a Redis command cannot reach a SQL connection.
- **Driver: `redis` 0.27** with `tokio-comp`, `tokio-rustls-comp`, `tls-rustls-webpki-roots`,
  `keep-alive`. The `src-tauri/Cargo.toml` comment gives the reasons: async multiplexed
  connection on Tauri's tokio runtime (no `spawn_blocking`), pure-Rust rustls TLS, and 0.27 as
  the last 0.x line before the 1.0 rename, building on rustc 1.89.
- **One multiplexed connection per logical db, lazily cached** (`RedisKvConnection::conn_for` in
  `src-tauri/src/engines/redis/mod.rs`). A per-operation `SELECT n` on one shared multiplexed
  connection would race between concurrent tasks; instead every command carries a `db` argument
  and runs on the connection bound to that db. A `SELECT` typed in the console is handled by the
  renderer switching the `db` it passes.
- **Adapter split** into `reader.rs` (cursor `SCAN … MATCH … COUNT 100 [TYPE]`, pipelined
  `TYPE`/`TTL` enrichment, typed reads), `writer.rs`, `value.rs` (pure `redis::Value` ⇄ DTO
  mapping, unit-tested), `clients.rs`, `cluster.rs`, `processes.rs`, `error.rs`.
- **Server reply errors are data, not failures.** `WRONGTYPE`/`ERR …` come back from the raw
  command runner as `RespReply::Error` so the console prints them redis-cli style; only
  connection/IO failures become `AppError`. The backend never formats replies — the renderer's
  `formatReply` in `src/features/browse/redis/helpers.ts` does.
- **Tauri commands** live in `src-tauri/src/features/keyvalue/commands.rs` (`kv_server_info`,
  `kv_scan`, `kv_get_key`, typed writes `kv_set_string`/`kv_hash_set`/`kv_list_set`/
  `kv_zset_add`/…, `kv_delete_key`, `kv_rename_key`, `kv_expire`, `kv_persist`,
  `kv_create_key`, `kv_command`, `kv_client_list`, `kv_client_kill`, `kv_client_kill_ids`,
  `kv_client_no_evict`, `kv_client_unpause`, `kv_cluster_topology`). The slice has no domain or
  infrastructure layer of its own.
- **Read-only workspaces** (ADR-0006): every typed write calls `ensure_writable`; `kv_command`
  checks the argv against an allowlist in `src-tauri/src/shared/readonly.rs`
  (`redis_command_is_read_only`), so unknown commands, including `EVAL`, are refused.
- **Renderer slice** `src/features/browse/redis/`: its own workspace (`RedisWorkspace.tsx`),
  sidebar with a namespace tree built from key names (`buildNamespaceTree`), per-key tabs
  (`KeyTab.tsx`) with a viewer per type, a dashboard from `INFO`, and the redis-cli in the
  shared bottom panel (`src/features/console/components/RedisTerminalSession.tsx`, ADR-0051).
  It reuses the shell and grid but not the SQL browse slice.
- **Cluster mode is detected, not configured.** `cluster_topology` asks `INFO server` first and
  returns `None` unless `redis_mode:cluster`, so a standalone server never sees a `CLUSTER`
  command. Topology comes from `CLUSTER NODES` (always), `CLUSTER SHARDS` (Redis 7+, optional)
  and `CLUSTER INFO` (passed through verbatim). Per-node keys/memory/ops are probed with one
  short-lived connection per node, concurrently, with a 1.5 s timeout, and skipped entirely when
  an SSH tunnel is in use; missing counters stay `None` instead of showing zero.
- **No cluster-aware client.** The app keeps a plain `redis::Client` to one node. The sidebar's
  node picker (`ClusterNodePicker.tsx`) opens a new connection to the chosen node with the saved
  entry's credentials and repoints the workspace (`RedisWorkspace.tsx` `onPickNode`); for a
  replica it sends `READONLY` so keyed reads are not answered with `MOVED`. The db switcher is
  replaced by a cluster chip.
- **Slot math in the renderer.** `src/features/browse/redis/cluster.ts` implements CRC16/XMODEM,
  `{hash-tag}` rules and `keySlot`, tested against values from real Redis
  (`cluster.test.ts`), plus the health warnings shown by `ClusterDashboard.tsx`.
- **Clients tab** (`RedisClientsTab.tsx`, `clients.ts`): `CLIENT LIST` lines kept verbatim plus
  parsed fields; kill by id, by selected ids, or by one of six server-side `CLIENT KILL`
  filters previewed locally. In cluster mode the list is per node.

## Alternatives considered

- **Implement `EngineConnection` for Redis.** Rejected; recorded in the `keyvalue.rs` module doc.
- **`SELECT n` per operation on one connection.** Rejected because of the race described in the
  `engines/redis/mod.rs` module doc.
- **The driver's cluster client (`redis::cluster`, not enabled in `Cargo.toml`).** Not used. The
  comment in `RedisWorkspace.tsx` records the reasoning for the per-node approach: `SCAN`,
  `INFO keyspace` and `CLIENT LIST` are per node anyway, so the workspace reconnects instead of
  adding a "node" argument to every command. That this was weighed against a slot-routing client
  is inferred.
- **A `clusterMode` flag on the saved connection** (an earlier proposal). The shipped
  code decides from the server's `redis_mode` instead.

## Consequences

- **Positive:** the SQL trait stays clean; concurrent tabs on different dbs cannot interfere;
  cluster topology needs no configuration; a server-side error never breaks the console.
- **Negative / trade-offs:** values are read whole (`LRANGE 0 -1`, `SMEMBERS`, `HGETALL`,
  `ZRANGE 0 -1`, `XRANGE - +`), so very large keys load in full. In cluster mode you only see
  the keys of the node you picked, and keys on other shards return `MOVED`. A transparent
  driver reconnect drops `READONLY` on a replica (noted in `RedisWorkspace.tsx`). No Sentinel
  support.
- **Testing:** `src-tauri/tests/redis_integration.rs`, gated on `BYTETABLE_TEST_REDIS_URL` and
  `BYTETABLE_TEST_REDIS_CLUSTER_URL`; fixtures are the standalone Redis on 63790 in
  `test-fixtures/docker-compose.yml` and the 3-master/3-replica rig in
  `test-fixtures/docker-compose.redis-cluster.yml`, whose nodes share one network namespace so
  announced addresses work from both host and nodes (the reason is in its header comment). Seeds:
  `test-fixtures/seed/seed-redis.sh`, `seed-redis-cluster.sh`.
- **Follow-ups:** deferred work includes cluster write operations (failover, reshard), per-node
  slowlog/INFO inspection, slot heat, a CROSSSLOT lint, client tracking, `CLIENT PAUSE` with a
  countdown, and Sentinel.
