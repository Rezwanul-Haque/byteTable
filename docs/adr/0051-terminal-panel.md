# ADR-0051 — Docked multi-session terminal panel built on existing engine commands

- **Status:** Accepted (retroactive — documented 2026-11-26 from the shipped implementation)
- **Date:** 2026-06-13 (`85b5e6a feat(console): M14 Task 1 — docked console panel + SQL console body`; multi-session REPL in `92cb588`, 2026-06-14)
- **Area:** SQL
- **Related:** ADR-0006, ADR-0007, ADR-0018, ADR-0019, ADR-0041–ADR-0046, ADR-0048, `docs/M14-terminal-panel.md`

## Context

Some users prefer typing commands to clicking through tabs. M14 asked for a VS Code-style bottom
panel in every workspace, bound to the active workspace's live connection and adapted to its
engine. For Redis it also replaced the M13 `cli` tab kind. The design made the panel
renderer-only: "No new Tauri commands". Each REPL reuses commands that already existed.

## Decision

- **Slice-neutral store, per workspace.** `src/features/console/state.ts` (`usePanelStore`) holds a
  `Record<workspaceId, PanelState>`: open, maximized, height, sessions and the active session id.
  It sits outside every engine slice because SQL, Redis, DynamoDB, Mongo, Cassandra and Typesense
  workspaces all host it. Entries are created lazily and pruned by a subscription on the
  workspaces store. The store is in memory only, so transcripts do not survive a restart.
- **Chrome.** `components/TerminalPanel.tsx` provides session tabs (add/close, with a right-click
  close menu from `useTabMenu`, ADR-0054), maximize, top-edge resize clamped to
  `[TERM_MIN_HEIGHT=120, innerHeight − 160]` (default 280 px), and hide. Ctrl/⌘+` toggles it; each
  workspace shell registers the key (`WorkspaceShell.tsx`, `RedisWorkspace.tsx`,
  `DynamoWorkspace.tsx`, `CassandraWorkspace.tsx`, `TypesenseWorkspace.tsx`).
- **One body per engine, chosen by `workspace.saved.engine`:**
  - SQL: `SqlTerminalTab.tsx` is a psql/mysql/sqlite3-style REPL. It has engine prompts, multi-line
    buffering until `;`, meta-commands (`\dt`, `\d NAME`, `\dn`, `\l`, `\c`, `\timing`, `SHOW`,
    `DESCRIBE`, `USE`, `.tables`, `.schema`, …), and ↑/↓ history capped at 80. It calls `queryRun`,
    `tableMeta`, `connectionTables` and `connectionSchemas`.
  - Redis: `RedisTerminalSession.tsx` calls `kvCommand`. It reuses the Redis slice's tokenizer and
    reply formatter, and confirms `FLUSHDB`, `FLUSHALL` and multi-key `DEL`/`UNLINK` first on
    `production` connections.
  - Cassandra: `CassandraShellSession.tsx` calls `cassRunCql`.
  - DynamoDB and MongoDB: `DynamoPartiqlSession.tsx` and `MongoShellSession.tsx` wrap those slices'
    existing PartiQL and shell tab bodies.
  - Typesense: `TypesenseHttpSession.tsx` sends raw HTTP (`typesenseRawHttp`) and is titled `http`.
  `shellLabel(engine)` names each session (`psql`, `sqlcmd`, `cqlsh`, `mongosh`, `clickhouse-client`, …).
- **Real tables, not ASCII art, for SELECT output.** A result is a
  `TermGridLine { kind: "grid", columns, rows }` rendered as an HTML table. Meta-commands stay plain text. `terminalBody.ts` copies a result as
  TSV, so it pastes into spreadsheets, and does not focus the prompt when a click ends a text
  selection.
- **Safety stays in the backend.** Because the panel reuses `query_run` and `kv_command`, the same
  read-only gate applies (`refuse_writes_in_read_only` in `connections/commands.rs`; Redis's
  `redis_command_is_read_only` allowlist in `keyvalue/commands.rs`). See ADR-0006.
- **Hand-off from the assistant.** `TermSession.pendingInput` lets ADR-0048's "Use in terminal" put
  text on the prompt line. It never runs; the user presses Enter.

## Alternatives considered

- **Spawn the real CLIs (psql, redis-cli, …) in a PTY.** Not chosen. M14 wires the
  REPL to existing backend commands, so SSH tunnels, TLS, keychain secrets and
  read-only enforcement apply unchanged. A PTY would also require the CLIs to be installed
  (inferred).
- **A compact result grid reusing `SqlResultGrid`.** This was the first sketch in
  `docs/M14-terminal-panel.md`. The shipped design replaced it with a shell-style REPL,
  and HTML tables later replaced the ASCII tables.
- **Keep the Redis CLI as a tab.** Rejected by M14: the panel replaces the `cli` tab kind.

## Consequences

- **Positive:** Every engine gets a console with no new IPC surface, and console commands follow
  the same connection, schema and read-only rules as the rest of the app.
- **Negative / trade-offs:** The meta-command set is an emulation, not the real client's: only
  the listed commands work. History and transcripts are lost on restart. Each engine body is
  maintained separately.
- **Follow-ups:** None marked in the code.
