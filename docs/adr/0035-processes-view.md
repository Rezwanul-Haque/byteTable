# ADR-0035 — Processes view: live session list with kill

- **Status:** Accepted (retroactive — documented 2026-11-26 from the shipped implementation)
- **Date:** 2026-07-24 (first commit that shipped the feature)
- **Area:** Schema
- **Related:** ADR-0003, ADR-0006, ADR-0034, ADR-0041, ADR-0043, ADR-0046, ADR-0047

## Context

A database client needs a way to see what is running on the server and to kill a
runaway or blocking session, as TablePlus's Processes view does. Each engine exposes
this differently:

| Engine | Source | Kill |
| ------ | ------ | ---- |
| MySQL | `SHOW FULL PROCESSLIST` | `KILL` |
| Postgres | `pg_stat_activity` | `pg_terminate_backend` |
| SQL Server | `sys.dm_exec_sessions` | `KILL` |
| ClickHouse | `system.processes` | `KILL QUERY` by `query_id` |
| MongoDB | `db.currentOp()` | `killOp` |
| Redis | `CLIENT LIST` | `CLIENT KILL ID` |

SQLite is embedded. Cassandra and DynamoDB have no kill equivalent that a user can
act on. Killing the session the app itself uses would break the workspace. Shipped in
`c96c12b` ("feat: engines process list and ability to kill processes").

## Decision

- **An optional capability port.** `ProcessReader` is defined in
  `src-tauri/src/shared/ports/process.rs` with two methods: `list_processes` and
  `kill_process`. Connections opt in through `as_process_reader` on their family
  trait (default `None`). `ConnectionManager::get_process_reader` is the single
  accessor across families and returns `Unsupported` otherwise. It is implemented in
  `src-tauri/src/engines/{postgres,mysql,mssql,clickhouse,redis,mongo}/processes.rs`.
- **One engine-neutral DTO.** `ProcessInfo { pid, serial?, qid?, user, host, db,
  state, time_s, query, is_self }`.
  - `pid` is a string so that non-numeric ids survive (Mongo shard opids, ClickHouse
    UUIDs).
  - Redis and Mongo reuse the same fields under different column labels.
  - `ProcessKill { pid, serial?, qid? }` carries what each engine's kill needs.
  - The four SQL adapters select the same ten columns in the same order, so one
    mapper (`map_sql_rows`) serves all of them.
- **Commands** (`src-tauri/src/features/processes/commands.rs`): `process_list` and
  `process_kill`. `process_kill` calls `ensure_writable` first (ADR-0006).
  `application.rs` only resolves the reader and delegates.
- **The renderer previews the kill statement; the backend runs the real kill.**
  `PROC_SOURCES` in `src/features/processes/api.ts` holds, per engine, the source
  label, the PID label key, the preview `kill(p)` text, and column-label overrides
  for Mongo and Redis. Killing an id that is already gone is not an error.
- **The app's own session is protected.** The adapter sets `is_self` for the app's
  own session. `ProcessesTab.tsx` shows a `me` badge for it and excludes it from row
  and bulk selection.
- **UI** in `src/features/processes/components/`:
  - `ProcessesTab.tsx` is a singleton tab with a filter, stat chips and resizable
    columns.
  - Auto-refresh runs every `REFRESH_MS = 2500` and pauses while the tab is not
    visible. The manual refresh button is hidden while auto-refresh is on
    (`d3e506f`).
  - `KillProcessModal.tsx` previews every statement. On production, when the
    `confirmProd` setting is on, the user must type `kill <N>`.
  - The tab is reachable from the View menu, the command palette and the status bar.

## Alternatives considered

- **Add process methods to every family trait.** The port doc rejects this: the
  feature is a narrow capability that some connections have and others do not, so it
  is opted into rather than forced onto every family.
- **Send raw kill SQL from the renderer.** Not done. The renderer only previews, and
  the adapter builds and runs the kill, which keeps id validation (`numeric_id`) in
  Rust. The reason is inferred.
- **Oracle `ALTER SYSTEM KILL SESSION`.** It was specced and `serial` exists
  for it, but `PROC_SOURCES` notes that Oracle is absent because the engine is not
  built.

## Consequences

- **Positive:**
  - One tab and one DTO cover six engines.
  - Adding an engine means one adapter and one `PROC_SOURCES` entry.
  - The app cannot kill its own connection from this UI.
- **Negative / trade-offs:**
  - The preview text and the backend kill are written separately and can drift.
  - Bulk kill runs `processKill` one process at a time with no batching.
  - For pooled SQL engines, `is_self` reflects only the pooled connection that ran
    the list query.
  - Polling every 2.5 s puts steady load on the server while the tab is visible.
- **Follow-ups:**
  - SQLite, DynamoDB, Cassandra and Typesense show an empty state.
  - The Oracle path is a placeholder.
