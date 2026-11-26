# ADR-0023 — Saved queries: one global JSON store, optional workspace attachment, tab link

- **Status:** Accepted (retroactive — documented 2026-11-26 from the shipped implementation)
- **Date:** 2026-06-13 (first commit that shipped the feature: `6ff5e6c` "SQL editor tab with CodeMirror, results, saved queries (M6 T2)")
- **Area:** SQL
- **Related:** ADR-0002, ADR-0005, ADR-0007, ADR-0018, ADR-0022, ADR-0027, ADR-0054, `docs/M6-sql-editor.md`, `docs/M40-query-params-snippets.md`

## Context

Users want to keep a query and reach it again, sometimes from a different
connection. Examples are a health check that works on every Postgres, or a report
that only makes sense on one database. Workspaces have ephemeral `ws-<uuid>` ids,
but `SavedConnection.id` is persisted (`docs/M6-sql-editor.md`). The first build
had two problems, fixed on 2026-10-10:

- saving a loaded-and-edited query created a second, near-identical entry
  (`5b58dfe`);
- the saved list could only be opened from inside a SQL tab (`5e61730`).

## Decision

- **Rust slice `src-tauri/src/features/saved_queries/`** (domain / ports /
  application / infrastructure / commands, ADR-0002):
  - The model is `SavedQuery { id, name, sql, saved_at, connection_id?, params, param_values }`
    with camelCase serde. `connection_id`, `params` and `param_values` are
    omitted when empty, so a global, unparameterized entry keeps the original
    four-key shape.
  - `validation_error` rejects a blank name or SQL (after trimming) and blank or
    duplicate parameter names.
  - The `SavedQueryRepository` port is **sync**, because the store is a small
    local file.
  - The `save_saved_query` use-case mints a UUID and `saved_at` when `id` is
    blank. An existing id keeps both, so the save is an upsert.
  - `JsonFileSavedQueryRepository` writes `<app_config_dir>/saved_queries.json`
    atomically (`*.json.tmp`, then rename) under a `Mutex<()>`. A missing file
    means an empty list. A corrupt file is returned as `AppError::Serialization`
    and is **never reset**.
  - The commands are `saved_query_list`, `saved_query_save` and
    `saved_query_delete`.
- **Renderer store `src/features/saved_queries/state.ts`:** a single global Zustand
  store. Mutations go to the backend first, then the list is patched from the
  reply; there are no optimistic updates. `load()` is idempotent and records
  `loadError` when the file is corrupt. Visibility per workspace comes from
  `selectQueriesForConnection`: global entries plus entries whose `connectionId`
  matches. The save popover has an attach toggle that sets
  `connectionId = workspace.saved.id`.
- **Update-on-save:** the field `SqlTabState.savedQueryId`
  (`src/features/workspaces/types.ts`) links a tab to the entry its buffer came
  from. It stores only the id; the name and attachment are read live, so a rename
  or delete needs no extra bookkeeping. `doSave` in `SqlEditorTab.tsx` handles
  the save:
  - a linked tab **updates** the same entry, keeping its `id` and `savedAt`;
  - "Save as new" forks a new entry, and the tab follows the copy.
  The link is set on load and after a save. Editing the buffer keeps the link.
  Loading text from a snippet chip, a history entry or an opened file clears it.
  `src/features/workspaces/savedQueryLink.test.ts` covers these rules.
- **Open from the tab strip:** the saved-queries drawer
  (`src/features/workspaces/components/QueryDrawers.tsx`) is hosted by
  `WorkspaceContent.tsx` with its opener on `TabBar.tsx`. No query tab needs to be
  open. `loadSavedQuery` loads into the active SQL tab, or opens a new one via
  `openSqlTabWith(sql, id, …, paramValues, params)`. Saved queries also appear as
  command-palette entries (ADR-0054). The drawer searches by name or SQL.
- **Reuse elsewhere:** schedules can be created from a saved-query row
  (ADR-0027). They copy the SQL, and keep `saved_query_id` only for provenance.

## Alternatives considered

- **Per-workspace stores:** rejected in favour of one global store with optional
  attachment. The M6 doc describes the attachment as an extension of a pure-global
  store. Keying by `SavedConnection.id` survives
  restarts, which ephemeral workspace ids do not.
- **Silently reset a corrupt file** (the preferences policy): rejected. "saved
  queries are user data" (M6 doc).
- **Always create a new entry on save:** this was the original behaviour, and it
  was replaced by `5b58dfe` because it piled up near-duplicates. Forking is still
  available as "Save as new".
- **SQLite or keychain storage:** not used. Inferred: a pretty-printed JSON file
  is enough for a small list and people can read and diff it (the `BTreeMap`
  choice in ADR-0022 notes this).

## Consequences

- **Positive:** queries move across workspaces. Corruption is surfaced and never
  hides data loss. Tweak-and-save does not create duplicates. The list is
  reachable from any tab.
- **Negative / trade-offs:** the whole file is rewritten on every save. There
  are no folders, tags or sharing. Attachment is to one saved connection only;
  there is no multi-connection or per-engine scope. A deleted connection leaves
  its attached queries orphaned and invisible (inferred from the filter: no
  cleanup path is visible).
- **Follow-ups:** saved queries are not offered for non-SQL engines (the
  `TabBar` opener is omitted there).
