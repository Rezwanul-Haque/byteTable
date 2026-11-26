# ADR-0046 — ClickHouse engine: relational ports over the HTTP interface with `reqwest`

- **Status:** Accepted (retroactive — documented 2026-11-26 from the shipped implementation)
- **Date:** 2026-07-23 (first commit that shipped the feature)
- **Area:** Engines
- **Related:** ADR-0003, ADR-0004, ADR-0008, ADR-0012, ADR-0020, ADR-0029, ADR-0032, ADR-0034, ADR-0035, ADR-0045, ADR-0051

## Context

ClickHouse is a columnar OLAP store. It speaks SQL but has no transactions, no foreign keys and
no unique per-row primary key: tables have an ENGINE (MergeTree family), an `ORDER BY` sort key
that acts as a sparse primary index, and an optional `PARTITION BY`. Rows are changed through
asynchronous `ALTER TABLE … UPDATE/DELETE` mutations, not OLTP statements. It is relational
enough to reuse the shared SQL workspace with no engine-specific host (it routes
into the default `kind: 'sql'` branch). There is no ClickHouse-specific spec under `docs/`.

## Decision

- **Implement the shared SQL ports.** `src-tauri/src/engines/clickhouse/` implements `Connector` /
  `EngineConnection` (ADR-0003), so the shared grid, filter builder, editor, structure view,
  object explorer, explain, privileges and processes UI work unchanged. Only the dialect differs.
- **Transport: the HTTP interface via `reqwest` 0.12**, not the official `clickhouse` crate. The
  `src-tauri/Cargo.toml` comment records why: that crate is built around compile-time typed
  `#[derive(Row)]` structs and RowBinary, a poor fit for a browser whose columns are unknown until
  runtime. `FORMAT JSONCompact`'s `{meta, data}` maps straight onto `QueryResult`, and 64-bit
  integers and decimals already arrive as strings, so precision is kept. Features:
  `rustls-tls` (no OpenSSL), `json`, `gzip` for large results.
- **Stateless requests** (`http.rs`): SQL in the POST body; user and password as
  `X-ClickHouse-User`/`X-ClickHouse-Key` headers (password from the keychain, ADR-0004). The
  `reqwest::Client` is internally pooled and `Send + Sync`, so the adapter holds no mutex. The
  editor's selected schema is sent as the `database` setting on each request rather than through
  `USE`. `engine_info` comes from `SELECT version()`.
- **TLS mode chooses the scheme:** `disable`/`prefer` → `http://`; `require` → `https://`
  accepting self-signed; `verify-ca`/`verify-full` → `https://` with chain validation. SSH
  tunnels use the shared local-forward (ADR-0008). The connect form defaults to port 8123
  (`src/features/connections/components/NewConnectionModal.tsx`); an early design said
  9000 (native TCP), which this adapter does not speak. URL import still maps `clickhouse://`
  to 9000 and `clickhouse+http(s)://` to 8123/8443 (`urlImport.test.ts`).
- **Row limits by server setting** (`query.rs` `run_query`): `max_result_rows = limit + 1` with
  `result_overflow_mode=break`, so truncation is detected without fetching everything. Grid paging
  is `LIMIT … OFFSET …`.
- **Escaped literals instead of bound parameters** (`sql.rs` `ch_literal`). ClickHouse's
  `param_x` binding needs each placeholder's type spelled out, which a dynamic browser cannot know.
  The module doc notes the official crate also renders `?` values as escaped literals; strings are
  single-quoted with `\` and `'` escaped, numbers are numeric-only, booleans are `1`/`0`.
- **Edits become mutations** (`mutate.rs`): a cell edit is `ALTER TABLE … UPDATE`, a row delete is
  `ALTER TABLE … DELETE`, both with `mutations_sync=1` so the call waits. Because the sort key is
  not unique, the adapter counts matches on the full key first and refuses on 0 or more than 1.
  Truncate is `TRUNCATE TABLE`; a "schema" is a database (`CREATE`/`DROP DATABASE`).
- **Introspection from `system.*`** (`introspect.rs`, `objects.rs`): `system.databases`,
  `system.tables` (approximate `total_rows`; views, matview `.inner` tables and temporary tables
  filtered out), `system.columns` (`is_in_primary_key` treated as the PK), and
  `system.data_skipping_indices`; DDL via `SHOW CREATE TABLE`. Object kinds are table, view,
  materialized view and SQL UDF; ClickHouse has no procedures or triggers.
- **Structure editing** (`structure.rs`): column add/modify/drop/rename and data-skipping index
  add/drop only. Sort key, engine and partition changes need a rebuild and are shown read-only;
  foreign-key operations return an error. `ALTER` auto-commits per statement.
- **Other surfaces:** processes from `system.processes` with `KILL QUERY WHERE query_id = …`
  (`processes.rs`, ADR-0035); privileges from `system.users`/`roles`/`role_grants`/`grants`, with
  `is_partial_revoke` mapped to a Denied state (`privileges.rs`, ADR-0034); `EXPLAIN` without an
  ANALYZE form (`src-tauri/src/features/explain/domain/mod.rs`, ADR-0020); a `clickhouse-client`
  style terminal (`src/features/console/components/SqlTerminalTab.tsx`, ADR-0051).

## Alternatives considered

- **The official `clickhouse` crate.** Rejected, reason recorded in `Cargo.toml` (typed rows,
  RowBinary).
- **The native TCP protocol (port 9000).** An early connect-form design used it, but it is
  not implemented; the shipped adapter is HTTP-only. Why is not recorded beyond the crate comment
  (inferred: HTTP plus JSONCompact needed no extra dependency).
- **Typed server-side parameters (`{name:Type}`).** Rejected in the `sql.rs` module doc because the
  types are not known up front.
- **Rebuild tables for sort-key/engine changes.** Not done; `structure.rs` leaves them read-only.

## Consequences

- **Positive:** ClickHouse gets the whole relational feature set with about 3,300 lines of adapter
  code and no new crate (reqwest is shared with Typesense, ADR-0045, and the assistant); values
  keep full precision; a non-unique sort key cannot cause mass updates.
- **Negative / trade-offs:** no session, so `SET` and `USE` typed in the editor do not carry to the
  next request; mutations are heavy operations on ClickHouse and not meant for frequent edits; a
  multi-statement structure apply can fail halfway with earlier statements applied; the native
  protocol is unsupported.
- **Testing:** no Rust integration test exists for this engine; the adapter's pure helpers in
  `sql.rs` are unit-tested. Fixture: `clickhouse/clickhouse-server:24` with HTTP on 8123 and native
  on 19000 in `test-fixtures/docker-compose.yml`, seeded from `test-fixtures/seed/clickhouse.sql`.
- **Follow-ups:** table rebuild for sort-key/engine/partition changes, and column-level grants
  (`privileges.rs` skips rows with a non-NULL `column`).
