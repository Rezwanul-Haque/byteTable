# ADR-0044 — Cassandra engine: wide-column port on the `scylla` driver, CQL rules enforced

- **Status:** Accepted (retroactive — documented 2026-11-26 from the shipped implementation)
- **Date:** 2026-06-23 (first commit that shipped the feature)
- **Area:** Engines
- **Related:** ADR-0003, ADR-0004, ADR-0006, ADR-0012, ADR-0030, ADR-0036, ADR-0043, ADR-0051, `docs/M19-cassandra-engine.md`

## Context

Cassandra is cluster → keyspaces → tables with partition and clustering keys, queried with CQL.
CQL looks like SQL but follows different rules: an efficient read restricts the whole
partition key, clustering columns must be used in order, and any other predicate is rejected
unless the query says `ALLOW FILTERING`. There is no cheap `COUNT(*)`. Data is denormalised
into one table per query (`*_by_*`). The module doc of `src-tauri/src/shared/ports/widecolumn.rs`
records that this query model is distinct enough from the SQL trait and from the Redis,
DynamoDB and MongoDB ports (ADR-0041/0042/0043) to need its own family.

## Decision

- **Own port family.** `src-tauri/src/shared/ports/widecolumn.rs` defines `WideColumnReader`
  (introspection, bounded query, cluster status, `DESCRIBE`) and `WideColumnWriter`
  (full-primary-key CRUD, index/MV/keyspace/table DDL), bundled as `WideColumnConnection`,
  carried by `OpenConnection::WideColumn` (wire token `"cassandra"`) and resolved by
  `ConnectionManager::get_wide_column`.
- **Driver: `scylla` 1.7** (the ScyllaDB Rust driver, which also talks to Apache Cassandra).
  The `src-tauri/Cargo.toml` comment records: async on Tauri's tokio runtime, pure Rust with
  default features. No other Rust Cassandra driver is mentioned.
- **Connection** (`src-tauri/src/engines/cassandra/mod.rs`): one or more comma-separated
  contact points (default port appended), ring discovery by the driver, optional local
  datacenter preference, `PasswordAuthenticator` when a user is set (password from the
  keychain, ADR-0004), optional initial keyspace. Reachability is
  `SELECT release_version FROM system.local`.
- **TLS is refused, not downgraded.** `disable`/`prefer` connect in plaintext;
  `require`/`verify-ca`/`verify-full` return an error. The module doc says native-protocol TLS
  was planned behind an explicit rustls feature; it has not shipped. No SSH tunnel.
- **Introspection from `system_schema`** (`keyspaces`, `tables`, `columns`, `indexes`, `views`)
  in a fixed set of queries per keyspace, not from driver metadata. `describe_table` rebuilds the
  `CREATE TABLE` text locally (`build_ddl`) from that metadata. Cluster status reads
  `system.local` and `system.peers`; load and ownership are left `None` (no `nodetool`).
- **Query rules enforced in Rust** (`reader.rs` `query`): the request carries structured
  predicates; the adapter decides whether the partition key is fully restricted by `=`/`IN` and
  whether a non-key, non-indexed column is filtered. If filtering is needed and not opted into,
  it refuses with an explanation; if opted into, it runs with `ALLOW FILTERING` and returns a
  warning. Paging uses the driver's `PagingState`, passed to the renderer as hex.
- **Values are bound, never interpolated** (`value.rs`): `cql_to_json` covers every `CqlValue`;
  `json_to_cql` converts to the column's named CQL type and errors on unsupported bind types.
- **Never `COUNT(*)`** for table lists or row counts (safety contract in `widecolumn.rs`).
- **Tauri commands** (`src-tauri/src/features/cassandra/commands.rs`): `cassandra_list_keyspaces`,
  `cassandra_list_tables`, `cassandra_table_meta`, `cassandra_cluster_status`, `cassandra_query`,
  `cassandra_insert_row`, `cassandra_update_row`, `cassandra_delete_row`, `cassandra_delete_rows`,
  `cassandra_run_cql` (raw CQL with optional consistency; `USE` and `DESCRIBE KEYSPACES` are
  handled in the adapter), `cassandra_describe_table`, `cassandra_create_index`/`drop_index`,
  `cassandra_create_mv`/`drop_mv`, `cassandra_create_keyspace`/`create_table`,
  `cassandra_drop_table`/`drop_keyspace`, `cassandra_truncate_table` (native `TRUNCATE`),
  `cassandra_empty_keyspace`.
- **Read-only workspaces** (ADR-0006): writers call `ensure_writable`; `cassandra_run_cql` is
  classified with `sql_is_read_only` from `src-tauri/src/shared/readonly.rs`.
- **Renderer slice** `src/features/browse/cassandra/`: `CassandraWorkspace.tsx`, sidebar and
  keyspace dashboard, `CassandraTableTab.tsx` (key-aware query builder over `CassRowGrid.tsx`),
  `CassRowModal.tsx`, `CassStructure.tsx` (columns, indexes, MVs), `CassandraQueryTab.tsx` plus
  a cqlsh-style session in the bottom panel (`src/features/console/components/CassandraShellSession.tsx`),
  `CassCreateModals.tsx`, `CassDropModals.tsx`, `CassIoModals.tsx` + `cassIo.ts`
  (export/import), and `CassandraSchemaMap.tsx`.
- **Hybrid editing.** Regular scalar cells edit inline; primary-key columns are locked (changing
  a key is delete + re-insert); collection/UDT/complex cells open the row modal
  (`CassRowGrid.tsx` header comment).
- **Schema map edges are inferred** from tables sharing partition/clustering key columns, since a
  live cluster has no reference catalog (`CassandraSchemaMap.tsx` header comment).

## Alternatives considered

- **Treat Cassandra as another SQL engine behind `EngineConnection`.** Rejected; recorded in the
  `widecolumn.rs` module doc — the SQL grid, filter builder and editing assume a relational
  model that CQL's key rules break.
- **Let the server reject bad queries.** Not chosen; the adapter pre-checks so the UI can explain
  why and offer the `ALLOW FILTERING` opt-in. That this is clearer than a server error is
  inferred from the warning text.
- **Silently connect without TLS when TLS is asked for.** Explicitly rejected in the module doc.
- **The DataStax C++-driver bindings or other crates.** Not recorded; inferred that `scylla` was
  picked as the async pure-Rust option consistent with the other driver choices.

## Consequences

- **Positive:** users cannot accidentally issue a cross-partition scan; values are always bound;
  no `COUNT(*)` against large tables; one driver works for Cassandra and ScyllaDB.
- **Negative / trade-offs:** no encrypted connections at all, so clusters that require TLS cannot
  be opened; no SSH tunnel. `DESCRIBE` output is reconstructed, so table options not read from
  `system_schema` are absent. Cluster status lacks load and ownership. Results are bounded and not
  virtualised (`CassRowGrid.tsx`).
- **Testing:** no Rust integration test exists for this engine. Fixture: `cassandra:5` on 9042
  in `test-fixtures/docker-compose.yml`, seeded by `test-fixtures/seed/seed-cassandra.sh` with
  `cassandra.cql`.
- **Follow-ups:** native-protocol TLS (named in the adapter module doc), SSH tunnelling, and
  `nodetool`-level cluster metrics.
