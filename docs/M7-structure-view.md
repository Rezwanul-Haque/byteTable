# M7 — Structure view (read-only)

> Provenance: this documents what SHIPPED for ByteTable milestone M7 (DESIGN_SPEC §3.6, structure mode — the read-only two-pane view). Imperative sentences are requirements the shipped code satisfies; every claim is grounded in a real path. M7 introduces the **read-only** structure surface (columns + the Indexes / Foreign keys / Referenced by / DDL rail). M8 (`src-tauri/src/features/structure/`, the staged-ALTER pipeline) and the inline editors in `StructureView.tsx` are M8's **superset** of this read-only view — M7 owns the introspection-driven rendering; M8 added the editing affordances on top of the same component. Where this doc cites `StructureView.tsx`, the read-only structure (header chips, columns pane, rail, DDL preview/modal/copy, independent scroll) is M7; the inline edit handlers and pending-changes bar are M8.

## Goal

The two-pane **Structure mode** of a table tab, per §3.6, rendered entirely from real introspection: a non-scrolling header (tree icon + `schema.table` + table comment + count chips), then a body split into a left **columns pane** (own scroll, sticky search head with a live count) and a right **348px rail** (own scroll) holding **Indexes**, **Foreign keys**, **Referenced by**, and the **DDL** (clipped preview + full-screen modal + copy). A **Data | Structure** segmented toggle in the table tab switches between the M4 data grid and this view. It must work comfortably on a 64-column table (columns scroll independently while the rail stays in view) and look right on tiny tables.

It is read-only at the M7 boundary: no command writes the database. The data all comes from the engine-shared `table_meta` introspection command (M3), extended additively with indexes / foreign keys / referenced-by / DDL.

## Dependencies — M3 introspection, M4 tabs

- **M3 introspection** — `table_meta` (the `EngineConnection::table_meta` port and the `tableMeta` invoke wrapper) is the single backend round-trip. M7 extends `TableMeta` additively (everything past `columns`); `columns` keeps its M3 shape so the sidebar and the M4 grid headers, which read only `columns`, are unaffected (`src-tauri/src/shared/engine.rs:425`).
- **M4 table tabs** — the structure view mounts inside a table tab; the `Data | Structure` segmented control and `mode` field on the tab come from the workspaces store (`src/features/workspaces/types.ts:103`, `TableTab.tsx`).

## Backend (Rust core)

### Domain — column meta, index, foreign key, referenced-by, DDL

All structure value objects live in the shared engine module (`src-tauri/src/shared/engine.rs`), serialized `camelCase`, derived `Default` so test fakes build a bare `TableMeta { columns, ..Default::default() }`:

- **`TableMeta`** (`engine.rs:434`) — `columns: Vec<ColumnInfo>`, `comment: Option<String>`, `indexes: Vec<IndexInfo>`, `foreign_keys: Vec<ForeignKeyInfo>`, `referenced_by: Vec<InboundFkInfo>`, `ddl: Option<String>`. The `Vec` fields are always present (empty when none); `comment`/`ddl` are `Option` (`null` on the wire when absent).
- **`ColumnInfo`** (`engine.rs:517`) — `name`, `data_type` (declared text, may be empty), `nullable`, `pk` (every member of a composite pk), `default_value` (wire name `default`, verbatim DEFAULT text or `null`), `fk: Option<FkRef>`. **`FkRef`** (`engine.rs:543`) = `{ table, column }` (empty `column` = unresolvable implicit target).
- **`IndexInfo`** (`engine.rs:462`) — `name`, `columns: Vec<String>` (index order; may be empty for an expression index), `unique`, `primary` (the implicit pk index), `origin: Option<String>` (SQLite `"c"`/`"u"`/`"pk"`; `None` elsewhere).
- **`ForeignKeyInfo`** (`engine.rs:482`) — outbound, grouped per constraint: `name: Option<String>`, `columns`, `ref_table`, `ref_columns` (parallel to `columns`), `on_delete`, `on_update`.
- **`InboundFkInfo`** (`engine.rs:503`) — referenced-by: `table` (the child holding the FK), `columns` (child's FK columns), `ref_columns` (this table's referenced columns), `on_delete`.

### Ports / Application — read full table structure; compute referenced-by; assemble DDL per engine

- **Port**: `EngineConnection::table_meta(&self, schema, table) -> Result<TableMeta, AppError>` (`engine.rs:1232`). One async call returns the full structure. Each engine adapter implements it; the renderer's introspection slice (M3) owns the command and the cache.
- **Compute referenced-by**: there is no inbound-FK catalog lookup that is uniform across engines, so each adapter **scans the schema's other tables** and collects every FK whose target is this table (grouped per constraint). This is the §3.6 "referenced by" list.
- **Assemble DDL**: engine-specific (see Infrastructure). SQLite and MySQL return the engine's _verbatim_ `CREATE TABLE`; Postgres reconstructs a best-effort one from the catalog.
- M7 adds **no** application use-cases of its own — `table_meta` is a thin port call driven by the M3 command. (The `features/structure/application` module — `preview_alter`/`apply_alter` — is **M8**, the staged-ALTER pipeline; it does not participate in the read-only view.)

### Infrastructure — engine-specific DDL retrieval (sqlite_master / SHOW CREATE TABLE / pg-style)

**SQLite** (`src-tauri/src/engines/sqlite/mod.rs`, `table_meta_blocking` at `:440`):

- Existence is proven first via `sqlite_schema` count → §5 unknown-table message (`:450`), because `PRAGMA table_info` returns zero rows for an unknown table.
- Columns: `PRAGMA "schema".table_info("table")` → name/type/notnull/dflt_value/pk; `pk > 0` marks pk membership (`:475`).
- Foreign keys: `PRAGMA "schema".foreign_key_list("table")` read **once** (`foreign_key_rows`, `:544`) and used for both the per-column `ColumnInfo.fk` map and the grouped table-level `ForeignKeyInfo` list (`group_foreign_keys`). Implicit `REFERENCES t` (NULL `to`) resolves the parent pk column at `seq` best-effort via `referenced_pk_column` (`:762`), yielding an empty string when unresolvable rather than a guessed `id`.
- Indexes: `table_indexes` via `PRAGMA index_list` (name/unique/origin) + per-index column lists; the auto pk rowid index is excluded.
- Referenced-by: `inbound_foreign_keys` (`:701`) scans **every other user table in the same schema** (`user_table_names`, `:729`, excludes `sqlite_%`), runs `foreign_key_list` per table — O(N) pragmas, deliberately unbounded but cheap and far cheaper than `count(*)` — and keeps every constraint whose `ref_table` equals this table.
- DDL: `table_ddl` (`:746`) = `SELECT sql FROM "schema".sqlite_schema WHERE type='table' AND name=?1` — the verbatim stored `CREATE TABLE`; `None` when the stored SQL is NULL.

**MySQL** (`src-tauri/src/engines/mysql/mod.rs`, `table_meta` at `:770`):

- Existence: `information_schema.tables` (`:775`) → §5 `missing_table_error` (`:1092`).
- Columns: `information_schema.columns` (`COLUMN_TYPE` = full declared type) (`:791`).
- Foreign keys + referenced-by: `information_schema.key_column_usage` JOIN `referential_constraints` (`:869`, `:1012`); inbound scans constraints whose referenced table is this table (`inbound_foreign_keys`, `:1001`).
- Comment: `information_schema.tables.TABLE_COMMENT` (`table_comment`, `:1053`).
- DDL: `SHOW CREATE TABLE` (`show_create_table`, `:1076`) — faithful, schema-qualified; reads result column index 1 ("Create Table").

**Postgres** (`src-tauri/src/engines/postgres/mod.rs`, `table_meta` at `:682`):

- FKs / referenced-by: `pg_constraint` (`:805`, `:936`); `on_delete`/`on_update` decoded from `confdeltype`/`confupdtype` action chars (`:839`).
- DDL: **assembled** from the catalog (`assemble_ddl`, `:989`) — best-effort, _not_ pg_dump-grade. Emits `CREATE TABLE "schema"."table" (` then each column (`"name" type [NOT NULL] [DEFAULT expr]`), the `PRIMARY KEY (...)`, and table-level `FOREIGN KEY (...) REFERENCES "t" (...)` with `ON DELETE`/`ON UPDATE` (omitting `NO ACTION`) (`:997`–`:1045`).

### Tauri commands — table

M7 reuses the M3 engine-shared introspection command. No M7-specific commands.

| command      | args                          | returns                                                                      | errors                                                                                                        |
| ------------ | ----------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `table_meta` | `handleId`, `schema`, `table` | `TableMeta` (columns + comment + indexes + foreignKeys + referencedBy + ddl) | §5 `AppError`: `NotFound` (closed handle), `Database` (unknown table/schema — message lists available tables) |

(The `alter_preview` / `alter_apply` commands in `src-tauri/src/features/structure/commands.rs` are **M8**, the staged-ALTER pipeline, and are out of scope for the read-only M7 view.)

## Frontend (React)

### State — structure store (columns, indexes, fks, referencedBy, ddl, search)

The introspection slice (`src/features/introspection/state.ts`) caches the full `TableMeta` keyed by `tableMetaKey(handleId, schema, table)` (`:51`) in `tableMetas`, sharing the `loading`/`errors` maps with the column-list cache:

- **`loadTableMeta(handleId, schema, table)`** (`:208`) — cache-first; in-flight de-duped via `inflightTableMetas` (StrictMode double-effect safe); resolves the meta or `null` on failure (error text under the meta key), never rejects. **Side effect**: warms the `columns` cache from the same payload (one round-trip serves both the structure rows and any column-list reader, `:218`).
- **`invalidate(handleId, schema?)`** (`:247`) — drops `tables`/`columns`/`tableMetas`/`errors` under the handle (or one schema) by key prefix, so a forced sidebar refresh or a post-apply re-introspect clears stale structure.
- The **search query** is component-local UI state (`colQuery` in `StructureView.tsx:77`), not stored — it is ephemeral filter text, not introspected truth.

### API — typed invoke wrappers

- `tableMeta(handleId, schema, table): Promise<TableMeta>` — the wrapper in `src/shared/api/engine.ts:408`; the only call the read-only view makes.
- `src/features/structure/api.ts` re-exports `alterApply`/`alterPreview`/`AlterOp`/`AlterResult` from `shared/api/engine.ts` — these are **M8** wire glue, thin re-exports under the structure slice.

### Components — Data|Structure toggle, ColumnsPane, structure rail, count chips

- **Data | Structure toggle** — `TableTab.tsx:222` renders a `.seg` segmented control (`role="tablist"`); the Data button (`table` icon) and Structure button (`account_tree` icon) call `setTableTabMode(tab.id, …)` (workspaces store `:493`). The data-mode toolbar (filters / WHERE readout / refresh / row count) is **not** rendered in structure mode — the structure view has its own header (`TableTab.tsx:247`). `tab.mode` is `"data" | "structure"` (`types.ts:103`); structure renders `<StructureView … />` (`TableTab.tsx:424`).
- **`StructureView`** (`src/features/browse/components/StructureView.tsx`) takes `{ handleId, tabId, schema, table, defaultSchema }`. It calls `loadTableMeta` on mount (`:112`), and renders:
  - **Header** (`.structure-head`, `:377`): `account_tree` accent icon, `<h2>` showing `qualified` (`schema.table`, schema prefix dropped when it equals `defaultSchema`, `:317`), optional table comment (`.structure-sub`), and the **count chips** (`.structure-chips`, `:382`).
  - **ColumnsPane** (`.columns-pane`, `:404`): a sticky `.columns-pane-head` with a "Columns" title (`view_column` icon), a **search box** ("Filter N columns…" with a `search` icon and a clear `×` when non-empty, `:409`), a **live count** (`.columns-count` — `"{filtered} of {total}"` while filtering, else the column count, `:422`), and the "+ Add column" button (M8). The `.columns-scroll` body holds the structure table whose `<th>` row is `position: sticky` (`StructureView.css:147`).
  - **Structure rail** (`<aside className="structure-rail">`, `:475`): four `.structure-section`s, each a heading with an icon, a `.rail-count` badge, and cards (or a `.structure-none` empty line):
    - **Indexes** (`speed` icon, `:476`) — `.structure-card` per index: name + `PRIMARY` (accent tag) / `UNIQUE` tag + `(col, col)` detail.
    - **Foreign keys** (`link` icon, `:500`) — name + `(cols) → refTable(refColumns)` + `ON DELETE …` tag.
    - **Referenced by** (`call_received` icon, `:524`) — inbound: `childTable(cols) → thisTable(refColumns)` + `ON DELETE …` tag; empty line reads "No tables reference {table}".
    - **DDL** (`code` icon, `:548`) — `copy` and `expand` buttons in the heading; a clipped `.ddl-preview` (syntax-highlighted via `highlightSql`) with a gradient `.ddl-fade` showing "view all N lines"; clicking the preview or `expand` opens the **DDL modal** (`:643`, `Modal` with `.ddl-modal`, title `DDL · {qualified}`, a Copy button, scrolling `<pre>`). `copyDdl` (`:331`) writes the verbatim DDL to the clipboard and toasts.
- **Count chips** (`.structure-chip`, `:382`): `<b>{n}</b> columns` (working non-dropped count), `indexes`, `FKs`, `referenced by`, and `rows` — the rows chip only renders when this tab's warmed `totalRows` (from `useTabMetaStore`, `:90`) is a number; **no COUNT is fired just for the chip**.

### Styling — §3.6: 348px rail, independent column scroll, clipped DDL preview

`src/features/browse/components/StructureView.css`:

- **Body grid** `.structure-body { grid-template-columns: 1fr 348px }` (`:65`) — the rail is exactly **348px**.
- **Independent scroll**: `.columns-scroll { overflow-y: auto }` (`:134`) and `.structure-rail { overflow-y: auto }` (`:407`) scroll independently; the columns table's `<th>` is `position: sticky` (`:147`) so headers stay while rows scroll.
- **Clipped DDL preview**: `.ddl-preview { overflow: hidden }` (`:527`) / `.ddl-preview-block { max-height: 218px; overflow: hidden }` (`:531`) with a gradient fade; the **DDL modal** is `.ddl-modal { width: 660px }` (`:572`) and `.ddl-modal-block { overflow: auto }` (`:578`) scrolls.

## Shared data contracts — TS + Rust types

| Concept       | Rust (`src-tauri/src/shared/engine.rs`)                  | TS (`src/shared/api/engine.ts`)                   |
| ------------- | -------------------------------------------------------- | ------------------------------------------------- |
| Table meta    | `TableMeta` (`:434`)                                     | `TableMeta` (`:125`)                              |
| Column        | `ColumnInfo` (`:517`) — `default_value` ⇒ wire `default` | `ColumnInfo` (`:47`) — `default?: string \| null` |
| FK target     | `FkRef` (`:543`)                                         | `FkRef`                                           |
| Index         | `IndexInfo` (`:462`)                                     | `IndexInfo` (`:67`)                               |
| Outbound FK   | `ForeignKeyInfo` (`:482`)                                | `ForeignKeyInfo` (`:88`)                          |
| Referenced-by | `InboundFkInfo` (`:503`)                                 | `InboundFkInfo` (`:107`)                          |

All `camelCase` on the wire. `Vec` fields are always present (empty array when none); `comment`/`ddl` are `null` when absent. Keep the two columns in sync.

## Behavior & edge cases

- **64-column table** — the columns pane scrolls **independently** (`.columns-scroll` own `overflow-y`); the rail (`.structure-rail`) stays in view with the sticky column-table header (`<th>` sticky). Verified visually on a wide table.
- **Search filters** — `colQuery` (lowercased/trimmed, `:320`) filters working columns by **name OR type substring** (`:321`); the live count shows `"{filtered} of {total}"`; an empty result renders a "No columns match …" row (`:442`). A clear `×` resets it.
- **DDL modal scrolls** — `.ddl-modal-block { overflow: auto }`; the preview is clipped at 218px with a fade and a "view all N lines" pill (`ddlLines = ddl.split("\n").length`, `:330`).
- **Small tables** — empty rail sections render `.structure-none` lines ("No indexes" / "No foreign keys" / "No tables reference {table}"); "No DDL available" when `ddl` is `null` (`:584`). Header chips still render.
- **No DDL** — Postgres assembles a best-effort `CREATE TABLE` (always present); SQLite/MySQL may yield `null` when the engine has no stored SQL → "No DDL available".
- **Unresolvable FK target** — SQLite implicit `REFERENCES t` to a table without a resolvable pk reports an empty `refColumns`/`column` — an honest "unknown" rather than a guessed `id`.
- **Cache / round-trips** — one `tableMeta` call serves both the structure rows and the column-list cache; switching Data↔Structure does not re-fetch (cache-first); the rows chip never fires a COUNT.
- **Loading / error** — while loading with no cached meta: an `account_tree` spinner line "Loading structure of {qualified}…" (`:358`); on error with no meta: an inline §5 red block with the message + a Retry button (`:337`) — **no modal** for structure errors.

## Acceptance criteria

- A table tab shows a **Data | Structure** segmented toggle; selecting Structure renders the two-pane view from `table_meta`, and the data-mode toolbar is hidden.
- Header shows `schema.table` (schema prefix dropped for the default schema), optional comment, and **count chips**: columns / indexes / FKs / referenced by (and rows only when warmed).
- The left **columns pane** scrolls independently with a **sticky** header and a **sticky search head** whose live count updates as you type; the right **348px rail** (Indexes / Foreign keys / Referenced by / DDL) stays in view.
- **Indexes** show PRIMARY/UNIQUE tags + column lists; **Foreign keys** show `(cols) → ref(refCols)` + ON DELETE; **Referenced by** lists inbound FKs computed by scanning the schema's FKs (each engine).
- **DDL** is the engine's real `CREATE TABLE` (SQLite `sqlite_master`, MySQL `SHOW CREATE TABLE`) or a best-effort Postgres assembly; the preview is clipped, the **modal** opens (660px) and **scrolls**, and **copy** copies the verbatim DDL.
- On a **64-column table** the columns scroll independently while the rail stays visible; typing a filter (e.g. "ship") narrows the rows + count; the DDL modal scrolls. A small table renders correctly (empty rail sections, header chips).
- The view is read-only at M7: rendering `table_meta` writes nothing to the database.

## Pixel / UX checklist

- Rail column width is **exactly 348px** (`grid-template-columns: 1fr 348px`).
- Header: `account_tree` accent icon (20px), `schema.table` heading, comment in `.structure-sub`, chips right-aligned mono pills (`<b>{n}</b> label`).
- Columns pane head: `view_column` icon + "Columns", search input "Filter N columns…" with `search` icon (14px) + clear `×`, live count `"{filtered} of {total}"`, "+ Add column" accent button (M8).
- Column table `<th>` row stays sticky while rows scroll; pk rows show a rotated accent `key` icon, fk rows a faint `link` icon + `→ table.column` ref label.
- Rail section headings carry icons: Indexes `speed`, Foreign keys `link`, Referenced by `call_received`, DDL `code`; each has a `.rail-count` badge.
- Index cards: name + `PRIMARY` (accent tag) / `UNIQUE` tag + `(cols)`; FK cards: name + `(cols) → ref(refCols)` + `ON DELETE` tag.
- DDL preview clipped at **218px** with a gradient fade and a "view all N lines" pill; DDL modal **660px** wide, scrolling, with a Copy button and `code` accent title.
- Empty states use `.structure-none` lines; loading uses the `account_tree` line; errors use the inline §5 red block with Retry (no modal).
