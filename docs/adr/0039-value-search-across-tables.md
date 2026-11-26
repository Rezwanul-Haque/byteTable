# ADR-0039 — Value search across every table

- **Status:** Accepted (retroactive — documented 2026-11-26 from the shipped implementation)
- **Date:** 2026-10-27 (`6d46d28` feat: search a pasted value across every table in a database from the left context menu)
- **Area:** Data browsing
- **Related:** ADR-0003, ADR-0006, ADR-0011, ADR-0028, ADR-0045, ADR-0054

## Context

In an unfamiliar schema a user often holds a value (an email, an id, a fragment) and
needs to know which tables and columns contain it. No index answers "this value in
any column of any table", so every candidate table must be scanned, which is
expensive on a production database. Engines also differ in `LIKE` case sensitivity,
wildcard escaping and how non-text columns can be compared with a string.

Note on scope: this is easy to confuse with Rust `features/search`, but that slice is
the Typesense dashboard (`typesense_*` commands, ADR-0045) and is unrelated. Value
search is entirely `features/value_search`.

## Decision

- **Backend slice `src-tauri/src/features/value_search/`** (`domain`, `application`,
  `commands`), SQL engines only: it uses `ConnectionManager::get_sql`, so SQLite,
  MySQL, Postgres, SQL Server and ClickHouse work and any other handle gets the
  usual §5 error.
- **No SQL in the slice.** One table's search is a `FilterSpec::Conditions` of one
  `FilterOp::Contains` (or `FilterOp::Eq` in exact mode) per column, OR'd, passed to the existing
  `EngineConnection::fetch_rows`. The adapters already bind parameters, escape
  `%`/`_` and cast columns (`::text`, `CAST(… AS NVARCHAR(MAX))`, `toString(…)`),
  so the slice only decides which columns to ask and drives the sweep.
- **`domain.rs`:** `MatchMode` `contains` (default; every non-binary column) or
  `exact` (only columns whose `ColumnClass`, guessed from the type label, the needle
  fits — e.g. a uuid-shaped needle for a uuid column, `looks_like_uuid`), because
  binding a mismatched type is an error, not an empty result. `conditions_for`
  returns empty to skip a table; `matched_columns` re-derives which columns matched,
  case-insensitively, since the OR does not say.
- **`application.rs` `run_search`:** tables visited smallest-first by the engine's
  row estimate (no estimate sorts last); per table `table_meta` then `fetch_rows`
  (each adapter pairs the page with an exact filtered `COUNT(*)`); a failing table
  becomes a `TableError` and the sweep continues; stops after `max_hit_tables`.
  `ValueSearchOptions` defaults: `per_table_limit` 20, `max_hit_tables` 100, all
  non-system schemas (`include_system_schemas` false).
- **Commands:** `value_search_run` and `value_search_cancel`. Cancel flags in managed
  `ValueSearchState` keyed by `run_id`, checked between tables; each table's
  `SearchProgress` (with its `TableHit`) streams over a `Channel`, and the final
  `ValueSearchSummary` repeats every hit. No `ensure_writable` gate — it is
  read-only, so it works in read-only workspaces (ADR-0006).
- **Renderer `src/features/value_search/`:** `api.ts`, `state.ts`,
  `components/ValueSearchModal.tsx` (hits land live; an `InfoHint` states it is a
  full table scan before the user starts). Opened from the sidebar context menu and
  a command-palette entry (`CommandPalette.tsx`).

## Alternatives considered

- **Per-engine search SQL in the slice.** Rejected in `mod.rs` docs: the adapters
  already solve escaping, casting and binding for `fetch_rows` filters.
- **Exact match on every column.** Rejected in `domain.rs`: the engine rejects
  binding a non-uuid string against a uuid column, so exact mode filters columns by
  type first.
- **Skip the count query.** Kept deliberately; `mod.rs` says the per-table match
  count is "the answer, not a detail", at the cost of a second pass.
- **Abort on the first unreadable table.** Rejected in `application.rs`: one bad
  view should not cost the rest of the sweep.
- **Full-text indexes or a local index.** Not pursued; no index covers arbitrary
  columns (inferred from the slice docs' framing).

## Consequences

- **Positive:** a single sweep tells the user where a value lives, with per-table
  counts, without new adapter code; small tables answer first and the user can
  cancel; safe in read-only workspaces.
- **Negative / trade-offs:** two full scans per table can be heavy on large
  production databases; `contains` on cast columns cannot use indexes; the
  type-class guess is a substring heuristic on display labels; NoSQL engines are not
  supported.
- **Follow-ups:** no per-table timeout; cancel is only honoured between tables, so a
  single very large table cannot be interrupted mid-scan.
