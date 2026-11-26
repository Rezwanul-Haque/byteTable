# ADR-0018 — CodeMirror 6 as the SQL editor, with per-engine dialects

- **Status:** Accepted (retroactive — documented 2026-11-26 from the shipped implementation)
- **Date:** 2026-06-13 (first commit that shipped the feature: `6ff5e6c` "SQL editor tab with CodeMirror, results, saved queries (M6 T2)")
- **Area:** SQL
- **Related:** ADR-0007, ADR-0019, ADR-0022, ADR-0023, ADR-0028, ADR-0049, ADR-0051, `docs/M6-sql-editor.md`

## Context

The SQL tab is where users write and run queries against the SQL-speaking engines
(SQLite, Postgres, MySQL, SQL Server, Cassandra CQL, ClickHouse, and others that
fall back). The first design was a regex-highlighted `<textarea>` with a
hand-built caret-positioned autocomplete popup (mirroring the textarea into a
hidden div to measure the caret). Requirements that grew over
time, per the commit log:

- syntax highlighting and `⌘↩`/`Ctrl+Enter` to run the statement at the caret (2026-06-13);
- a formatter (`⇧⌥F`) and schema-aware autocomplete (2026-06-18, `9960b35`, `b73cb3d`);
- engine-specific keywords, functions and highlighting (2026-08-14, `2e8a24f`);
- multi-cursor editing (2026-08-15, `cac6639`);
- opt-in vim keybindings (2026-10-25, `7c657c7`).

Autocomplete must not call the backend per keystroke; it reads the cached
introspected schema (ADR-0028).

## Decision

- **Editor:** CodeMirror 6 (`@codemirror/view`, `state`, `commands`, `language`,
  `lang-sql`, `autocomplete`, `search`; pinned in `package.json`), wrapped
  imperatively in `src/features/workspaces/components/SqlCodeEditor.tsx` — one
  `EditorView` per mount created in a layout effect, buffer controlled by the SQL
  tab's store-backed `text`; non-typing value changes (snippet/history/saved load)
  are reconciled with a dispatched transaction. The header comment records the
  reason: CM6 "parses SQL properly (no regex false-positives on e.g. `select`
  inside a string), and gives us bracket matching / undo for free". A custom
  `HighlightStyle` reproduces the app's syntax palette (keyword = `--accent`, etc.).
- **Dialect for highlighting:** `sqlDialectFor(engine)` in
  `src/features/workspaces/sqlCompletion.ts` maps engine → `PostgreSQL`, `MySQL`,
  `MSSQL`, `SQLite`, `Cassandra`; ClickHouse and anything else get `StandardSQL`
  (no CM ClickHouse dialect exists).
- **Autocomplete:** our own ranking core, not CM's built-in SQL completion.
  `src/features/workspaces/sqlSuggest.ts` is pure `(text, caret, schema)` →
  suggestions, shared by the editor and the SQL terminal (ADR-0051).
  Tables after `FROM`/`JOIN`/`INTO`/`UPDATE`; otherwise columns of tables already
  in the statement first, then tables, then keywords/functions. Case-insensitive
  prefix match, including multi-word phrases ("ON DUP"). Array order is the
  ranking. `sqlCompletion.ts` adapts it to a CM `CompletionSource`, so the
  keyboard handling and caret placement come from `@codemirror/autocomplete`.
  `snippetCompletion.ts` adds snippet entries (ADR-0022).
- **Vocabularies:** `src/features/workspaces/sqlKeywords.ts` is an ANSI core plus
  per-`Engine` `KEYWORD_EXTRAS`/`FUNCTION_EXTRAS`. Cassandra **replaces** the core
  instead of adding to it ("Suggesting `RIGHT JOIN` in a CQL editor is worse than
  suggesting nothing"). ClickHouse camelCase functions keep their case.
- **Statement at caret:** `pickAndSelect` uses `statementRangeAt`
  (`sqlStatement.ts`). A selection wins. Otherwise the statement under the caret
  is selected and returned, and the whole buffer is the fallback.
  `SqlCodeEditorHandle` exposes `pickStatement`, `revealRange` (used by failed
  result tabs, ADR-0019) and `insertSnippet`.
- **Multi-cursor:** `allowMultipleSelections`, `⌥`-click
  (`clickAddsSelectionRange` on `altKey`), `⌥`-drag rectangular selection with
  `crosshairCursor`, and the default `⌘⌥↑/↓` cursor stacking. Escape collapses
  them.
- **Vim:** `@replit/codemirror-vim`, toggled by the `editorKeymap: "default" | "vim"`
  setting (`src/features/settings/api.ts`, ADR-0049) through a `Compartment`, so
  switching it reconfigures the live view and nothing remounts. The vim
  compartment goes **first** in the extension list so Escape reaches vim before
  `defaultKeymap`. Run/format/zoom keymaps are `Prec.highest` so vim cannot take
  them.
- **Formatter:** `src/features/workspaces/formatSql.ts`, a regex pretty-printer
  (described in the file as "not a parser"). It puts
  each major clause on its own line and breaks multi-column SELECT lists and
  AND/OR onto indented lines. It upper-cases keywords and common functions, and
  splits on top-level semicolons outside quotes. `⇧⌥F` is matched on the physical
  `event.code` so macOS Option-chars don't swallow it. It is also on the wand FAB
  and the context menu.

## Alternatives considered

- **A `<textarea>` with regex highlighting:** rejected in the source
  comment for false positives and missing undo/bracket matching.
- **CM's `lang-sql` schema completion:** not used. Inferred: a custom core lets
  the editor and the terminal (which is not CodeMirror) rank identically, and it
  supports statement-scoped column priority, PK icons, and per-engine vocabularies.
- **A real SQL formatter library (e.g. `sql-formatter`):** not adopted. The file
  calls itself "intentionally simple … aims to make hand-written queries
  readable, not to canonicalize every dialect". Inferred: this avoids a dependency
  and per-dialect configuration.
- **Monaco:** no record. Inferred: CM6 is smaller, modular, and the M6 spec
  recommended it.

## Consequences

- **Positive:** one editor component serves every SQL engine; dialect differences
  live in data tables, not branches. Compartments make font size, read-only,
  vim and marks hot-swappable.
- **Negative / trade-offs:** the formatter can mis-handle unusual syntax:
  comments, `$$` bodies, and dialect quoting (it tracks only `'` and `"`).
  ClickHouse highlighting uses StandardSQL. On Linux some window managers take
  `Alt`+click (noted in the source), so `⌥`-click multi-cursor may not work there.
  Autocomplete is only as fresh as the cached schema.
- **Follow-ups:** no configurable multi-cursor modifier; no formatter options
  (keyword case, indent width).
