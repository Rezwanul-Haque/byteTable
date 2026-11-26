# ADR-0047 — SQL Server engine: `tiberius` TDS driver behind the relational ports

- **Status:** Accepted (retroactive — documented 2026-11-26 from the shipped implementation)
- **Date:** 2026-07-02 (first commit that shipped the feature)
- **Area:** Engines
- **Related:** ADR-0003, ADR-0004, ADR-0008, ADR-0012, ADR-0029, ADR-0032, ADR-0034, ADR-0035, ADR-0036, ADR-0037, ADR-0051, `docs/M21-mssql-engine.md`

## Context

SQL Server is relational, so ByteTable puts it behind the existing relational ports and the
shared SQL workspace, with no new port family or browse slice. What differs is the T-SQL
dialect (bracket identifiers, `OFFSET … FETCH` paging that requires `ORDER BY`, `IDENTITY`,
the `sys.*` catalog, `dbo` default schema, indexed views, `GO` batches in `sqlcmd`) and the
driver: the sqlx 0.8 line used for MySQL/Postgres (ADR-0003) has no SQL Server backend.

## Decision

- **Implement the shared SQL ports.** `src-tauri/src/engines/mssql/` implements `Connector` /
  `EngineConnection`; the renderer routes `mssql` into the relational workspace. The adapter is
  split by responsibility: `introspect.rs`, `objects.rs`, `query.rs`, `mutate.rs`,
  `structure.rs`, `privileges.rs`, `processes.rs`, `bulk.rs`, `sql.rs` (pure dialect helpers),
  `error.rs`.
- **Driver: `tiberius` 0.12**, `default-features = false` with `tds73`, `rustls`, `chrono`. The
  `src-tauri/Cargo.toml` comment records: pure-Rust TDS driver (no sqlx SQL Server backend on
  0.8); `native-tls` default dropped for rustls (no OpenSSL, one rustls in the tree); `tds73` for
  the modern protocol level; `chrono` for DATE/TIME/DATETIME2/DATETIMEOFFSET. `tiberius` speaks
  futures-io, so a tokio `TcpStream` is adapted with `tokio-util`'s `compat` shim;
  `futures-util` collects result streams; `chrono` is named directly so the adapter can spell
  the temporal types.
- **One client behind a `tokio::sync::Mutex`, no pool.** `tiberius` has no pool; the module doc
  of `mod.rs` reasons that a desktop client runs a few short serial queries. Because it is one
  session, a `USE <db>` in the terminal persists across statements, unlike the pooled adapters.
- **SQL authentication only.** `AuthMethod::sql_server(user, password)`, password from the
  keychain (ADR-0004). No Windows/integrated auth, and
  Entra ID auth is not implemented.
- **TLS mode → `EncryptionLevel`** (`apply_encryption`): `disable` → `Off`; `prefer` and unknown
  → `On` trusting self-signed; `require` → `Required` trusting self-signed; `verify-ca` /
  `verify-full` → `Required` with chain validation by rustls. SSH tunnels use the shared local
  forward and keep the real host for SNI (ADR-0008). Version from
  `SERVERPROPERTY('ProductVersion')`.
- **Values** (`decode_value`): bigint as a number within ±2^53, else a string; decimal/numeric/
  money as exact decimal strings; `bit` as 0/1, like MySQL booleans; temporal types and
  `uniqueidentifier` as strings; binary as an `"[N bytes]"` placeholder. Decoding tries Rust
  target types in turn instead of keeping a per-column type table.
- **Bound parameters as `@P1, @P2, …`** (`sql.rs`), threaded by a running index — the TDS
  analogue of Postgres `$N`. Identifiers are bracket-quoted with `]` doubled.
- **Paging needs an `ORDER BY`** (`query.rs`): the browse defaults to the primary key so edited
  rows stay on their page, and falls back to `ORDER BY (SELECT NULL)` for a table without one.
- **Transactional DDL and imports.** Structure apply (`structure.rs`) and SQL-script import
  (`mutate.rs` `execute_script`) run inside `BEGIN TRANSACTION` and roll back as a whole on
  error, because SQL Server DDL is transactional (unlike MySQL).
- **Full object set** (`objects.rs`): views, indexed views shown under the `matview` label,
  functions, procedures, triggers, with definitions from `OBJECT_DEFINITION(OBJECT_ID(…))`.
- **Privileges** (`privileges.rs`, ADR-0034): server logins and database users as two principal
  scopes; `DENY` is its own cell state; fixed roles kept; column-level permissions excluded.
  **Processes** (`processes.rs`, ADR-0035): `sys.dm_exec_sessions` and `KILL <spid>`.
  **Generate data** (`bulk.rs`, ADR-0037): bulk insert and a primary-key pool read.
- **`sqlcmd` terminal** (`src/features/console/components/SqlTerminalTab.tsx`, ADR-0051): `1>`
  prompts, `:` meta commands, and a lone `GO` runs the accumulated batch.

## Alternatives considered

- **sqlx.** Not available for SQL Server on the 0.8 line (`Cargo.toml` comment).
- **ODBC.** Considered as an alternative to `tiberius`; not taken. The reason is
  not recorded (inferred: ODBC needs a system driver manager, against the tree's pure-Rust
  dependency choices).
- **`native-tls`.** Dropped in favour of rustls, reason recorded in `Cargo.toml`.
- **A connection pool such as `bb8-tiberius`.** Not used; the single-mutex model is argued in the
  `mod.rs` module doc.

## Consequences

- **Positive:** SQL Server gets the whole relational feature set through the shared UI; no
  OpenSSL or ODBC dependency; DDL and script imports are atomic; terminal session state behaves
  like `sqlcmd`.
- **Negative / trade-offs:** one mutex-guarded session serialises all queries on a connection, so
  a long query blocks the grid and sidebar on the same workspace. SQL auth only, so domain or
  Entra-only servers cannot be reached. Binary columns are shown as byte counts, not content.
  Tables without a primary key page in an unstable order.
- **Testing:** live tests in `src-tauri/src/engines/mssql/integration.rs`, gated on
  `BYTETABLE_TEST_MSSQL_URL`. The fixture is `mcr.microsoft.com/azure-sql-edge` on port 11433 in
  `test-fixtures/docker-compose.yml`; its comment records that `azure-sql-edge` is used because it
  is arm64-native and `mssql/server:2022` segfaults under qemu on Apple Silicon, and that the SA
  password must be `ByteTable1!` to satisfy SQL Server's password policy. Seeding is manual via
  `test-fixtures/seed/seed-mssql.sh` with `mssql.sql` (the image has no init directory).
- **Follow-ups:** Windows/Entra ID authentication, named-instance resolution, and a decoded view
  of binary values are not implemented.
