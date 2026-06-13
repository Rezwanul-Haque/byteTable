# M14 — Docked console panel (VS Code–style bottom terminal)

Status: design approved (brainstorm 2026-06-13). Build on branch `m14-terminal-panel`; **do not merge until the user has tested and confirmed.**

> **AUTHORITATIVE PROTOTYPE (supersedes the from-scratch sketch below where they differ):** the user provided the real design in `ByteTable_latest/bytetable/terminal.jsx` (`TerminalPanel` + `SqlTerminalTab`) and `redis-tabs.jsx` (`RedisCli`), with `.term-*`/`.rcli-*` CSS in `ByteTable_latest/ByteTable.html`. Port these faithfully. Two deltas from the sketch:
> 1. **Multi-session panel**: `TerminalPanel` is VS Code–style with *multiple* terminal sessions (session tabs with add/close, a `+` new-session button), a **maximize** toggle (`open_in_full`/`close_fullscreen`), top-edge resize (clamp [120, innerHeight−160]), and a hide button (Ctrl+`). The tab-bar toggle is a `tabbar-tool` button ("Terminal", `terminal` icon, title "Toggle terminal (Ctrl+`)").
> 2. **SQL output is a psql/mysql/sqlite3-style ASCII REPL, not a compact grid** (this supersedes the earlier grid choice). `SqlTerminalTab` is a real REPL: engine-specific prompt/banner/errPrefix (`termConfig`: `mysql>` / `sqlite>` / `{conn}=#`), meta-commands (`\dt \d NAME \dn \l \c \timing \! clear \q`; `SHOW TABLES/DATABASES`, `DESCRIBE`, `USE`; `.tables .schema .databases .timing .clear .quit`), multi-line statement buffering until `;`, `asciiTable` output (centered headers, `--+--` rule, right-aligned numerics), history (↑/↓, cap 80), Ctrl+L clear, Ctrl+C cancel-line. **Wire the prototype's mock calls to the real backend**: SQL → `query_run`; `\dt`/list-tables → `connection_tables`; `\d`/DESCRIBE → `table_meta` (format columns/indexes/FKs as ASCII); `.schema`/DDL → `table_meta.ddl`; `\dn`/`\l`/SHOW DATABASES → `connection_schemas`; `\c`/USE → set workspace `ui.schemaName`. Redis session body = `RedisCli` (real `kv_command`).
> No backend changes (all commands already exist). Revise the Task-1 panel/console to match `terminal.jsx`.

## Goal

A persistent, dockable **bottom console panel** (like the VS Code panel) available in every workspace, for users who prefer typing commands over the tab UI. The panel is **attached to the active workspace's live connection** and adapts to its engine:

- **SQL workspaces** (SQLite/MySQL/Postgres): a query console — type SQL, run it against the workspace's connection/current schema, see a **compact result grid inline** with a **"send to tab"** affordance for large/keepable results.
- **Redis workspaces**: the **redis-cli** console (line-oriented replies). **This panel REPLACES the M13 Redis CLI tab** — the `cli` tab kind is removed; Redis command work happens only in the panel.

It is renderer-only: it reuses the existing `query_run` (SQL, M6) and `kv_command` (Redis, M13) backend — **no backend changes**.

## Relationship to existing surfaces

- **Complement for SQL**: the SQL editor *tab* (M6) stays for saved queries, multi-statement scripts, and full-grid work. The panel is the always-available **ephemeral scratch console** for quick one-offs.
- **Replace for Redis**: the M13 `cli` tab kind is deleted. The sidebar "New CLI console" footer button and ⌘T (which opened a cli tab) now **open/focus the bottom panel** instead. Redis tab kinds become `{dashboard, key}`.

## Chrome & behavior

- **Toggle**: a console/terminal icon button in the workspace tab-bar row (right-aligned), present for both SQL and Redis workspaces. Plus a keyboard shortcut **⌃` (Ctrl+backtick)** — the VS Code convention — to toggle.
- **Dock**: panel docks at the bottom of the workspace content area (above the status bar), full width of the content column (right of the sidebar). **Resizable** via a drag handle on its top edge; min height ~120px, default ~33% of content height. A close (×) button in the panel header collapses it.
- **Per-workspace state** (lives in the workspaces store / a console store keyed by workspace id, surviving workspace switches): open/closed, height, command history, and the console log/output. Switching workspaces shows that workspace's own console; the panel is bound to the **active workspace's** `handleId` + engine + current schema/db.
- **Header**: a small strip — engine-appropriate title (`{conn} · {schema}` for SQL, `{conn}:db{N}>` lineage for Redis), a clear-console button, and the close ×.

## SQL console (SQLite/MySQL/Postgres)

- **Prompt + input**: a sticky input line, prompt shows the connection/active schema (e.g. `byteshop>`). Enter (and ⌘↩) runs the input via `queryRun(handleId, sql, {schema})`.
- **Output log** (scrolling): each entry = the echoed command (with prompt) + a status line (`✓ N rows · X ms · schema`, or `✓ Query OK` for non-SELECT, or a red `✗ {message}` §5 error) + for row-returning queries a **compact inline result grid** reusing `SqlResultGrid`/`GridCell` (mono cells, type colors, NULL/number/pill rendering; capped height with its own scroll; no FK-hop/insights/inline-edit in the panel — those stay in the full data/result tabs).
- **Send to tab**: each successful result carries an "↗ open in tab" action that opens a SQL editor tab (M6) seeded with that query (and runs it there for the full grid + history/save). 
- **History**: ↑/↓ cycles previous commands (per-workspace, capped). Ctrl+L clears the log.
- Multi-statement / write statements: run as given (same trust model as the M6 editor); show affected/OK.

## Redis console (port of M13 CliTab into the panel)

- Move the M13 `CliTab` behavior into the panel verbatim: preset chips (`KEYS *`, `DBSIZE`, `INFO`, `SCAN …`, `ZREVRANGE …`, `HGETALL …`), prompt `{conn}:db{N}>`, tokenizer, **exact `formatReply`** (status/error/integer/bulk/multi-line/nil/nested-array), ↑/↓ history, Ctrl+L clear.
- Writes mutate live and **bumpVersion** (sidebar + open key tabs refresh). `SELECT n` updates the workspace db index. `FLUSHDB`/`FLUSHALL`/multi-key `DEL`/`UNLINK` confirm first when the connection env is `production` (reuse the M11 confirm modal).
- Remove the `cli` `RedisTab` kind, its tab-bar/content rendering, and its store actions; rewire "New CLI console" + ⌘T + the Redis command palette's "New CLI console" entry to `togglePanel`/`openPanel`.

## Architecture (per ARCHITECTURE §11)

- The panel **host** is a shared composition point (like `App.tsx` routing) — it may import both the SQL console piece and the Redis console piece. Place the host in a small shared location (e.g. `src/features/console/` or `src/shared/console/`). It branches on the active workspace's engine/kind to render the SQL console vs the Redis console body.
- The SQL console body reuses `SqlResultGrid`/`GridCell` (shared kernel). The Redis console body reuses the M13 `formatReply`/tokenizer/helpers from `redis_browse/helpers.ts` (move shared bits to the kernel if a cross-slice import would otherwise be needed; do not make the SQL slice import `redis_browse` or vice-versa — the host wires both).
- No new Tauri commands. SQL → `query_run`; Redis → `kv_command`. Per-workspace console state lives with the workspace/console store.

## Acceptance

- Toggle button in the tab bar + ⌃` open/close a resizable bottom panel in both SQL and Redis workspaces; panel state is per-workspace and survives workspace switches.
- **SQL**: run a query in the panel → see status + a compact inline grid; "open in tab" promotes it to a SQL editor tab; history (↑/↓) works; errors show in §5 red.
- **Redis**: the panel is the cli (no cli tab exists); presets/history/formatReply/live-mutation/SELECT/production-confirm all behave as the M13 cli tab did; sidebar "New CLI console" + ⌘T open the panel.
- SQL editor tab (M6) and Redis dashboard/key tabs unaffected; SQL engines and Redis browsing otherwise unchanged.

## Out of scope (this milestone)

System shell access (this is an *engine* console, not bash); panel tabs / multiple consoles; output export; FK-hop/insights/inline-edit inside the panel grid (those remain in full tabs).
