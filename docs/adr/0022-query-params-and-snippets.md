# ADR-0022 — Query parameters by text substitution; a separate snippet library

- **Status:** Accepted (retroactive — documented 2026-11-26 from the shipped implementation)
- **Date:** 2026-10-25 (first commit that shipped the feature: `caef1e5` "query parameters with prompt-on-run and a snippet library")
- **Area:** SQL
- **Related:** ADR-0006, ADR-0011, ADR-0018, ADR-0019, ADR-0023, ADR-0044, `docs/M40-query-params-snippets.md`

## Context

Saved queries (ADR-0023) were bookmarks. Users wanted reusable queries with
inputs (`WHERE status = :status`, `FROM ${table}`) and reusable fragments they
insert while typing. These two resolve at different times. A **parameter** is
filled at run time. A **snippet** field is filled at insert time and leaves
nothing behind. Downstream code expects one SQL string: statement splitting,
Explain, history, result tabs, and the backend read-only classifier
(`refuse_writes_in_read_only`). This closed item #5 of `feature-gap-backlog.md`.

## Decision

### Parameters (renderer-only resolution)

- **Substitution, not driver binding.** `src/features/workspaces/sqlParams.ts`
  renders literals into the SQL text before `queryRun`. No bind channel was added
  to the engine ports.
- **Syntax:** `:name` (canonical), `${name}` (braced, usable inside a word) and
  `?` (positional, named `1`, `2`, …). `$name` is excluded because it collides
  with Postgres `$1` and dollar-quoting. `?` is not detected on Postgres, where it
  is a jsonb operator. `scanParams` uses the shared `sqlLex.ts`, which was
  extracted from `sqlStatement.ts` at this point, so placeholders inside strings,
  comments, quoted/bracket identifiers and `$$` bodies are ignored.
  `id::text` is never read as `:text`.
- **Kinds** (`ParamKind`) are `text | number | boolean | date | list | null | raw`.
  Each kind except `raw` renders through a quoting or validating path
  (`renderParam`, `quoteLiteral`), and that path is engine-aware: backslash
  doubling on MySQL/ClickHouse, `1/0` booleans on SQLite/SQL Server. An invalid
  number falls back to a quoted literal. An empty list renders `NULL`. `raw` is
  opt-in per parameter.
- **Prompt rule** (`SqlEditorTab.run`): parameters are resolved before
  `splitStatements`. `effectiveValues` applies precedence: entered value, then
  default, then empty. The run continues immediately if nothing is missing.
  Otherwise `ParamPrompt` (`components/QueryParams.tsx`) opens and resumes the
  same run. `⇧⌘↩` opens the prompt on demand.
- **State:** the detected list is derived and never stored. Values and
  declarations live on `SqlTabState.params` / `paramDefs`. Last-used values are
  written back to the linked saved query (`SavedQuery.paramValues`) when they
  change. `defsToStore` / `valuesToStore` prune what they write, so an
  unparameterized query saves byte-identically to older builds (Rust fields are
  `#[serde(default, skip_serializing_if)]`).
- **Backend:** `ParamDef.kind` is an opaque `Option<String>` in
  `src-tauri/src/features/saved_queries/domain/mod.rs`. The recorded reason is
  that an unknown kind would otherwise break deserialization of the whole saved
  list. Values are stored in a `BTreeMap` so the JSON has a stable key order.

### Snippets (own slice)

- `src-tauri/src/features/snippets/` (domain/application/ports/infrastructure/commands)
  copies the saved-queries pattern: a sync `SnippetRepository` port, a JSON file
  at `<app_config_dir>/snippets.json`, atomic temp-then-rename writes, and a
  corrupt file treated as an error. Commands are `snippet_list`, `snippet_save`,
  `snippet_delete`. The model is `Snippet { id, name, abbreviation?, body, engine?, saved_at }`.
- **Field syntax `#{1:label}`**. CodeMirror's snippet parser accepts both `${…}`
  and `#{…}`, but `${…}` is already taken by parameters.
- **Editor:** `src/features/workspaces/snippetCompletion.ts` is a second CM
  completion source, listed before the schema source. `src/features/snippets/match.ts`
  does prefix matching with abbreviation hits first, capped at
  `MAX_SNIPPET_OPTIONS = 12`. Insertion from the drawer
  (`components/SnippetsDrawer.tsx`) goes through `insertSnippetIntoActiveEditor`
  (`src/shared/ui/activeCodeEditor.ts`), because clicking the drawer takes focus
  from the editor.
- **Built-ins** (`src/features/snippets/builtins.ts`) are per engine (TOP vs
  LIMIT, upsert forms, Cassandra without JOIN/CTE). They are **merged at read
  time, not seeded** into the store. A user snippet with the same abbreviation
  outranks the built-in. `builtins.test.ts` checks that no body uses `${…}`.
  Cassandra's CQL tab reuses `SqlCodeEditor`, so it gets the snippet library too.

## Alternatives considered

- **Driver bind parameters.** Rejected in the M40 doc and the `sqlParams.ts`
  header. Binding cannot parameterize identifiers. It would also need a `params`
  array threaded through every consumer and all six adapters. The read-only guard
  would be classifying a statement it cannot fully see. The trust model is the
  one already accepted for the SQL editor and the filter raw mode (ADR-0011).
- **Snippets as fields on `SavedQuery`.** Rejected in the M40 doc. A snippet is
  inserted mid-typing, not loaded, and all its fields would have to be nullable
  on saved queries.
- **Seeding built-ins into `snippets.json`.** Rejected because it would write
  user data the user did not create, could not be restored if lost, and would
  never pick up built-ins added by later versions.

## Consequences

- **Positive:** parameters work on every SQL engine with no adapter changes.
  Read-only enforcement still sees the final SQL. Saved queries reopen ready to
  run with their last values. Built-ins stay current across releases.
- **Negative / trade-offs:** substitution means values are not prepared-statement
  bound. Plan caching per value is lost, and safety rests on `quoteLiteral` being
  correct per engine. `raw` is an intentional injection hatch. `?` is unavailable
  on Postgres. Non-SQL engines (Redis, DynamoDB, MongoDB, Typesense) get neither
  feature.
- **Follow-ups:** the snippet management drawer exists only in SQL workspaces,
  not in the Cassandra tab. The kind is not validated server-side.
