# M40 — Query parameters + snippet library

> Provenance: this spec documents the **shipped code**, and closes item **#5** of `../feature-gap-backlog.md` ("Query parameters & snippets"). It extends M6 (`M6-sql-editor.md`), which built the SQL editor and the global saved-query store. An imperative sentence is a requirement, and every requirement is grounded in a real path.

## Goal

Turn saved queries from bookmarks into tools, in two halves that share nothing but the editor they live in:

1. **Query parameters** — a buffer may hold `:name` / `${name}` / `?` placeholders. They are filled in from a bar under the toolbar, prompted for on run when a value is missing, resolved into real SQL before execution, and **remembered**: a saved query stores both its parameter declarations (type, label, default, choices) and the values it last ran with.
2. **Snippet library** — a global store of reusable SQL fragments with an abbreviation and `#{1:label}` tab stops, offered in the editor's autocomplete and managed from a drawer.

The two resolve at different times, which is the whole reason they are separate features: a **snippet** field is resolved at INSERT time (tab through it, nothing is left in the buffer); a **parameter** is resolved at RUN time.

## Part 1 — Query parameters

### Model: substitution, not driver binding

`src/features/workspaces/sqlParams.ts` resolves placeholders by **substituting literals into the SQL text** before the statement reaches `queryRun`. It does not add a bind-parameter channel to the engine ports.

This is a deliberate trade, and the reasons are load-bearing:

- **Everything downstream keeps working on one string.** `splitStatements` (multi-statement runs), the EXPLAIN panel, query history, the result tabs, and — most importantly — the backend's read-only guard (`refuse_writes_in_read_only`, `src-tauri/src/features/connections/commands.rs`) all receive the SQL that actually ran. A parallel `params` array would have to be threaded through every one of them, and the read-only classifier would be classifying a statement it could not fully see.
- **Identifiers are parameterizable.** No engine can bind a table name, so `FROM ${table}` is impossible with real binding — and it is half of what people reach for parameters to do.
- **It works on every engine at once**, with no change to any of the six SQL adapters.

The security trade is acceptable because of what this surface already is: the M6 editor grants arbitrary SQL by design, and the filter builder's raw mode documents the same trust level (`src/features/browse/sql/filter.ts`). A value the user typed into their own query is not an untrusted input. Even so, **nothing is interpolated naively**:

- every kind but `raw` renders through a quoting or validating path;
- `raw` must be chosen per parameter, so a text parameter can never inject by accident;
- an invalid `number` falls back to a **quoted literal**, so a typo surfaces as an engine type error rather than as executable SQL.

### Placeholder syntax

| Form | Meaning |
| --- | --- |
| `:name` | Canonical named placeholder (JDBC / DataGrip / DBeaver convention). Repeats of one name are ONE parameter, substituted everywhere. |
| `${name}` | Braced form — needed when the name touches word characters (`${col}_id`). |
| `?` | Positional, named `1`, `2`, … in order. Each `?` is its own parameter. |

`$name` is deliberately **not** a placeholder: it collides with Postgres `$1` and with dollar-quoting (`$body$`).

Scanning is lexically aware (`scanParams`): a placeholder inside a string literal, quoted identifier, bracket identifier, line/block comment or Postgres dollar-quoted body is content, not a placeholder, and `id::text` is never read as holding `:text`. The shared lexer is `src/features/workspaces/sqlLex.ts` (`skipNonCode` / `skipNonCodeOrBracket`), extracted from `sqlStatement.ts` so the statement splitter and the parameter scanner cannot disagree about SQL's quoting quirks.

`?` is **not** detected on Postgres, where `?`, `?|` and `?&` are jsonb existence operators — treating `data ? 'key'` as a placeholder would turn a working query into a prompt. Named placeholders work on every engine.

### Kinds

`ParamKind`, with the literal each renders (`renderParam`):

| Kind | Renders as |
| --- | --- |
| `text` | Quoted literal. `'` doubled; `\` doubled only on MySQL/ClickHouse, where it is an escape character. |
| `number` | Bare numeric literal; a non-numeric value falls back to a quoted literal. |
| `boolean` | `TRUE`/`FALSE`, or `1`/`0` on SQLite and SQL Server, which have no boolean type. Accepts `true/t/yes/y/1` and their negatives. |
| `date` | Quoted literal, like `text`. The kind exists so the UI offers a date picker and the intent survives in the saved query. |
| `list` | Comma-separated input → comma-separated literals, for `WHERE id IN (:ids)`. Numeric items stay bare, others are quoted. An empty list renders `NULL`, which matches nothing and still parses (`IN ()` is a syntax error everywhere). |
| `null` | Always `NULL`; takes no value. |
| `raw` | Verbatim. The escape hatch for identifiers and fragments. |

### Value precedence and the prompt rule

`effectiveValues` is the single place precedence is decided — **entered value, else declared default, else empty** — so the bar, the prompt and the run path cannot disagree about what is about to run.

The prompt-on-run rule, in `SqlEditorTab.run()`:

- Every run resolves parameters FIRST, before `splitStatements`.
- If any detected parameter has no value and no default, the run **does not happen**: `ParamPrompt` opens and resumes that exact run (same source, same batch choice) once values are in.
- If every value is present, the query **runs immediately**. A dialog between ⌘↵ and a result is exactly the friction that stops people using parameters, so it only appears when it has something to ask.
- **⇧⌘↩ / ⇧Ctrl+↵** (and the toolbar's tune button) opens the prompt on demand — the way to CHANGE values that are already filled in.
- An unfilled placeholder in a PREVIEW is left exactly as written, so the user sees `:status` sitting there rather than a silent `''`.

### Where the state lives

| State | Home | Why |
| --- | --- | --- |
| Detected parameter list | Derived from the buffer on every render (`detectParams`) | Never stored, so it cannot go stale — delete a placeholder and its row is gone. |
| Entered values | `SqlTabState.params` (`src/features/workspaces/types.ts`) | Survives tab/workspace switches, like the buffer itself. |
| Declarations | `SqlTabState.paramDefs`, copied to/from the saved query | On the tab for the same reason `text` is: declaring `${table}` as `raw` has to work on a buffer that was never saved, and the declaration editor should affect the inputs as you type. |
| Last-used values | `SavedQuery.paramValues` | "Remembers what it last ran with" — a report query reopens ready to run. |

Saving prunes both (`defsToStore` / `valuesToStore`): declarations that say nothing beyond the default, and declarations/values for placeholders that are no longer in the buffer, are dropped. **An unparameterized query therefore saves byte-identically to what a build without this feature wrote** — the Rust fields are `#[serde(default, skip_serializing_if)]`, so they never appear on the wire when empty.

Loading replaces values and declarations together; replacing the buffer from a snippet chip, a history entry or a file clears both, because they described the old SQL.

### Backend

`SavedQuery` (`src-tauri/src/features/saved_queries/domain/mod.rs`) gains:

```rust
#[serde(default, skip_serializing_if = "Vec::is_empty")]
pub params: Vec<ParamDef>,
#[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
pub param_values: BTreeMap<String, String>,
```

`ParamDef.kind` is an **opaque `Option<String>`**, not an enum. Substitution happens entirely in the renderer, so this slice only stores the kind — typing it here would buy no safety and would cost real robustness: a kind written by a newer build (or hand-edited) would fail to deserialize and take the user's entire saved-query list down with it, against this slice's "corrupt file = error, never silent data loss" stance. The renderer treats an unknown kind as plain text.

`validation_error` rejects a blank or **duplicated** parameter name. Duplicates matter because declarations are resolved by name, so two entries for `status` would make which one applies arbitrary. The kind is not validated.

`BTreeMap` rather than `HashMap` for the values, so the pretty-printed JSON file has a stable key order — it is user data people read and diff.

## Part 2 — Snippet library

### Its own slice

`src-tauri/src/features/snippets/` + `src/features/snippets/`, mirroring the saved-queries slice (JSON store, sync port, async commands, "corrupt = error" policy, atomic temp-file-then-rename saves).

Separate from saved queries on purpose: a saved query is a whole buffer you LOAD and run; a snippet is a fragment you INSERT mid-typing, with an abbreviation that triggers it from autocomplete and tab stops resolved on insert. None of that belongs on `SavedQuery`, and all of it would have to be nullable fields there.

```rust
pub struct Snippet {
    pub id: String,
    pub name: String,
    pub abbreviation: Option<String>,  // completion trigger; blank is normalised to None
    pub body: String,                  // stored verbatim, never parsed here
    pub engine: Option<String>,        // dialect restriction; None = everywhere
    pub saved_at: u64,
}
```

Commands: `snippet_list` / `snippet_save` / `snippet_delete`, registered in `lib.rs` with the store at `<app_config_dir>/snippets.json`.

### Field syntax: `#{1:label}`

CodeMirror's snippet parser accepts both `${…}` and `#{…}`, plus the numbered `${1:label}` form and `${0}` for the final caret. ByteTable documents **`#{1:label}`** because `${name}` is already the braced form of a query parameter — a `${status}` in a snippet body would be eaten as a tab stop on insert instead of surviving into the buffer.

So: `#{…}` for "ask me as I type", and the canonical `:status` form — which the snippet parser never touches — for "ask me when I run".

### Editor integration

`src/features/workspaces/snippetCompletion.ts` is a **second completion source** beside the schema/keyword one, both listed in `autocompletion({ override: [...] })` in `SqlCodeEditor.tsx`. Snippets go first: a matched abbreviation is the more specific hit (the user named it) where a keyword row is generic.

- Options are built with `snippetCompletion`, which is what makes the fields tabbable — Tab/Shift-Tab navigation, linked fields and final caret position all come from `@codemirror/autocomplete` (already a direct dependency at 6.20.3).
- Rows carry the `bt*` fields the shared row renderer reads (`sqlCompletion.ts`), so a snippet row looks like every other row. `SuggestKind` gains a `snippet` member for exactly that reason, even though `suggestSql` never emits one.
- Matching (`src/features/snippets/match.ts`, a pure DOM-free module so it is unit-testable) is prefix-based: abbreviation hits first, then name hits, library order kept within each group so rows do not reshuffle between keystrokes, capped at 12 so a large library cannot bury the schema rows.
- Insertion from the drawer goes through `insertSnippetIntoActiveEditor` in `src/shared/ui/activeCodeEditor.ts` — the same last-focused-view registry the title bar's Undo uses, because clicking a drawer row has already moved focus out of the editor.

### Built-in starters

`src/features/snippets/builtins.ts` ships the everyday skeletons — SELECT, INSERT, UPDATE, DELETE, CREATE TABLE, CREATE INDEX, ADD COLUMN, JOIN, GROUP BY, CTE, UPSERT — so the library is useful before the user has written anything.

They are **merged in at read time, not seeded into the store**. Seeding would write user data they did not create, could be corrupted, would not come back if the file were lost, and would never gain the entries a later version ships. Merging costs nothing on first run and keeps all four properties. The same stance as the SQL toolbar's engine starter chips (`snippetsFor`), and the reason a built-in row has no edit or delete button: it is not the user's row to lose. A user snippet with the same abbreviation ranks **above** the built-in in both the drawer and the completion list, which is how you override one.

Per **engine**, not one generic set, because a starter that does not run is worse than no starter:

| Engine | What differs |
| --- | --- |
| SQL Server | `SELECT TOP (n)` not `LIMIT`; `ADD col` with no `COLUMN` keyword; `IDENTITY`; no upsert (MERGE is too easy to half-fill) |
| ClickHouse | `ALTER TABLE … UPDATE` / `… DELETE WHERE` for mutations; data-skipping `ADD INDEX`; `ENGINE = MergeTree` + `ORDER BY`; no upsert |
| MySQL | `AUTO_INCREMENT`; `ON DUPLICATE KEY UPDATE` |
| Postgres / SQLite | `bigserial` / `AUTOINCREMENT`; `ON CONFLICT … DO UPDATE` |
| Cassandra | reads and writes name a partition key; no JOIN, CTE or GROUP BY; no separate upsert (INSERT already is one) |
| Redis, DynamoDB, MongoDB, Typesense | none — they have no SQL editor to insert into |

`builtins.test.ts` pins each of those rules, plus "no body may use `${…}`" — the parameter form would be eaten as a tab stop on insert.

### UI

`src/features/snippets/components/SnippetsDrawer.tsx` reuses the `.sq-*` drawer markup and styling from `workspaces/components/QueryDrawers.css` (same affordance, same slot) and adds only the create/edit form and the group headings. Its opener sits on the tab strip beside Saved queries and History; all three share the right-hand slot, so each opener closes the others.

The list is grouped "Your snippets" / "Starters", headed only when both are on screen.

"New snippet" is a `.sq-drawer-link` nav row — icon, label, trailing chevron — so it is visually identical to the history drawer's "Saved queries" link.

The per-engine **starter chips** in the SQL toolbar (`snippetsFor`, `SqlEditorTab.tsx`) are unchanged and separate — they replace the buffer, where a snippet inserts at the caret.

Cassandra's CQL tab (`browse/cassandra/components/CassandraQueryTab.tsx`) uses the same `SqlCodeEditor`, so it gets the library and the CQL built-ins in its completion too; the management drawer lives only in the SQL workspaces, and the library is global.

## Files

**New**

- `src/features/workspaces/sqlLex.ts` — shared lexical-skip helper.
- `src/features/workspaces/sqlParams.ts` (+ `.test.ts`, 43 cases) — detection, substitution, kinds, precedence, store-pruning.
- `src/features/workspaces/components/QueryParams.tsx` + `.css` — `ParamBar`, `ParamPrompt`, declaration editor.
- `src/features/workspaces/snippetCompletion.ts` — CodeMirror snippet source.
- `src/features/snippets/{api,state,match,builtins}.ts` (+ `match.test.ts`, `builtins.test.ts`) and `components/SnippetsDrawer.tsx` + `.css`.
- `src-tauri/src/features/snippets/` — full slice (domain/application/ports/infrastructure/commands), 22 tests.

**Changed**

- `sqlStatement.ts` — uses the extracted lexer (also fixes a `;` inside a MySQL backtick identifier splitting a statement).
- `saved_queries` domain + `api.ts` — `params` / `paramValues`.
- `workspaces/types.ts` + `state.ts` — `SqlTabState.params` / `paramDefs`, `setSqlParam(s)`, `setSqlParamDefs`, `openSqlTabWith` seeds both.
- `SqlEditorTab.tsx` — param bar, resolved runs, prompt, ⇧⌘↩, snippet feed to the editor.
- `WorkspaceContent.tsx` / `TabBar.tsx` — snippet drawer + opener; saved-query load restores parameters.
- `CommandPalette.tsx` — a saved query opened from the palette carries its parameters.
- `browse/cassandra/components/CassandraQueryTab.tsx` — the CQL editor gets the library.
- `sqlSuggest.ts` / `sqlCompletion.ts` — `snippet` kind in the shared row vocabulary.
- `shared/ui/activeCodeEditor.ts` — `insertSnippetIntoActiveEditor`.
- `shared/i18n/strings/{en,zh-Hans}.ts` — `ws.params.*`, `ws.snip.*`.
