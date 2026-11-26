# ADR-0003 — Engine adapters behind per-family port traits

- **Status:** Accepted (retroactive — documented 2026-11-26 from the shipped implementation)
- **Date:** 2026-06-13 (first commit that shipped the feature)
- **Area:** Engines
- **Related:** ADR-0001, ADR-0002, ADR-0008, ADR-0041 to ADR-0047, `docs/M2-sqlite-connections.md`, `docs/M12-mysql-postgres-ssh-tls.md`, `docs/superpowers/specs/2026-07-17-engine-module-layout-design.md`, `docs/superpowers/plans/2026-07-17-sqlite-engine-split.md`

## Context

ByteTable supports ten engines (SQLite, PostgreSQL, MySQL, SQL Server,
ClickHouse, Redis, DynamoDB, MongoDB, Cassandra, Typesense; Oracle and Neo4j are
recognised but not supported). These engines do not share one shape. Relational
engines have schemas, tables, SQL and ALTER. Redis is a keyspace, DynamoDB an
item store, Typesense a search index. Engine drivers were required to be
infrastructure adapters behind ports, so that M12 could add engines without
touching slice logic. The first port and adapter (SQLite) shipped in `6b4851a`
(2026-06-13).

## Decision

- **Port families, not one trait.** `src-tauri/src/shared/ports/` holds one module
  per engine shape: `sql` (`Connector`, `EngineConnection`), `keyvalue`
  (`KeyValueConnection`), `document` (`DocumentStoreConnection`), `mongo`
  (`MongoConnection`), `widecolumn` (`WideColumnConnection`), `search`
  (`SearchConnection`). Two capability ports (`process`, `privileges`) are reached
  through `EngineConnection::as_process_reader` / `as_privilege_reader`.
  `shared/mod.rs` re-exports them at their old paths (`crate::shared::engine` =
  `ports::sql`). The `ports/` grouping landed 2026-07-17 (`3f2abc4`).
- **One seam across families:** `OpenConnection` (`shared/ports/mod.rs`) is an enum
  with `Sql | Kv | Document | Mongo | WideColumn | Search`, each an `Arc<dyn …>`.
  `ConnectionManager` stores it behind a `ConnectionHandleId`. Its typed
  accessors (`get_sql`, `get_kv`, …) return a "not available for this engine"
  error on a kind mismatch. `ConnectionKind` goes over the wire, and the
  renderer routes to the matching workspace shell on it. The doc comment gives
  the reason: forcing Redis into `EngineConnection` "would litter it with
  `Unsupported` stubs and lie about its shape".
- **Optional SQL capabilities default to `Unsupported`.** `EngineConnection` gives
  default impls returning `AppError::Unsupported` for `fetch_row_by_key`,
  `column_stats`, `alter_table`, `update_cell`, `truncate_table`, `drop_schema`,
  `execute_script`, `bulk_insert`, `pin` and others. Each engine overrides what
  it supports.
- **All ports are async (`async_trait`).** rusqlite is sync and `!Sync`, so the
  SQLite adapter wraps it in `Arc<Mutex<…>>` and hops through `spawn_blocking`.
  The other drivers are awaited directly (`shared/ports/sql/mod.rs`).
- **Adapters live in `src-tauri/src/engines/`, outside `shared/`**, so the
  dependency direction is `engines → shared`. Only `lib.rs` imports them, to
  `registry.register(Engine::X, Arc::new(XConnector))`. All engine-specific SQL
  stays in these modules (`engines/mod.rs`).
- **Canonical module layout** (spec 2026-07-17, applied in `7bdc366`,
  2026-07-18): an adapter's files mirror the port modules it implements.
  Relational: `mod.rs` (connector + dispatch only), `introspect`, `query`,
  `mutate`, `structure`, `objects`, `sql` (private dialect), `error`, plus
  `bulk`/`processes`/`privileges`/`integration` where present. NoSQL: `mod.rs`,
  `reader`, `writer`, `error`, `value` (Typesense swaps `value` for `http` +
  `terms`). Tests stay inline. Visibility tops out at `pub(super)`, and only the
  `Connector` type is visible outside an engine. SQLite was the pilot; the
  plan's invariant was "all 100 sqlite tests still passing".
- **Driver per SQL engine** (reasons from `src-tauri/Cargo.toml` comments):
  - SQLite: `rusqlite` 0.37 `bundled` (statically linked, no system lib).
    sqlx's SQLite backend is excluded because `sqlx-sqlite` "conflicts with our
    `rusqlite` (both link the native `sqlite3`)".
  - Postgres / MySQL: `sqlx` 0.8, `runtime-tokio`, `tls-rustls`, `bigdecimal`.
    It is async-native on Tauri's tokio runtime. `chrono`/`uuid` are enabled on
    the sub-crates directly, because without them temporal and uuid columns
    decode as NULL.
  - SQL Server: `tiberius` 0.12 (`rustls`, `tds73`). The comment says "there is
    no sqlx SQL Server backend on the 0.8 line"; it runs over a tokio
    `TcpStream` via `tokio-util` compat.
  - ClickHouse: no driver crate. `reqwest` drives the HTTP interface with
    `FORMAT JSONCompact`. The official `clickhouse` crate's compile-time-typed
    `#[derive(Row)]` model is "a poor fit for a dynamic SQL browser". ClickHouse
    still implements the relational `EngineConnection` (`engines/clickhouse/mod.rs`).

## Alternatives considered

- **One universal `Engine` trait.** Rejected, as the `OpenConnection` docs
  record (above).
- **Separate `SchemaReader` / `QueryExecutor` traits.** These were the original
  design. They were folded into `EngineConnection` in M2 because "introspection
  and query execution are operations on an open connection"
  (`shared/ports/sql/mod.rs`).
- **Single-file adapters.** This was the original shape. Rejected in the
  2026-07-17 spec: `sqlite/mod.rs` was 5217 lines with "one module own[ing] four
  unrelated jobs". The spec states that the issue is module coherence, not
  line count.
- **Moving tests to `tests/`.** Rejected for relational engines, because the
  tests exercise private functions. NoSQL live suites do live in crate-root
  `tests/`.

## Consequences

- **Positive:** adding a relational engine means implementing one trait. The
  M4–M11 UI then works unchanged (M12 did this for MySQL/Postgres). The
  `Unsupported` defaults let an engine ship partial support. Port modules and
  adapter modules line up one-to-one.
- **Negative / trade-offs:** every NoSQL family needs its own slice
  (`keyvalue`, `dynamo`, `mongo`, `cassandra`, `search`) and its own renderer
  workspace, so features are re-implemented per family. `OpenConnection` grows
  an arm and six `into_*` helpers per family. Pure-dialect code is duplicated
  across the four relational `sql.rs` files.
- **Follow-ups:** the layout spec still reads "Status: Proposed" although it
  shipped. `DdlDialect` is still an empty trait (`pub trait DdlDialect {}` in `shared/ports/sql/conn.rs`). Oracle and Neo4j are recognised by URL
  import (ADR-0009) but have no adapter.
