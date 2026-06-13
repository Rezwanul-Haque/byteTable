# M8 — Structure editing (staged ALTERs)

Status: shipped, merged on `main` (`feat: M8 — structure editing (staged ALTERs)`).

> Provenance: this document describes what SHIPPED. It is reconstructed from the
> source of truth — the merged code — and cross-checked against
> `design_handoff_bytetable_latest/MILESTONES.md` (M8) and `DESIGN_SPEC.md` §3.6.
> Imperative statements ("MUST", "rejects", "rolls back") are requirements the
> shipped code already enforces, not aspirations. Paths are repo-relative.
> Primary sources:
> - Backend slice: `src-tauri/src/features/structure/` (`domain/mod.rs`,
>   `application/mod.rs`, `commands.rs`, `mod.rs`).
> - SQLite ALTER generation + rebuild: `src-tauri/src/engines/sqlite/structure.rs`.
> - Port + wire types: `src-tauri/src/shared/engine.rs` (`alter_table`,
>   `AlterResult`) and `src/shared/api/engine.ts` (`AlterOp`, `alterPreview`,
>   `alterApply`).
> - Frontend: `src/features/structure/ops.ts`, `src/features/structure/api.ts`,
>   `src/features/browse/components/StructureView.tsx` (+ `.css`),
>   `src/features/workspaces/state.ts` (`setTabStructureOps`).

## Goal

§3.6 editing: every inline structure edit (rename / type / nullable / default /
add column / drop column) becomes exactly one staged `ALTER` operation. The
structure view never mutates the introspected truth; it accumulates an ordered
batch and shows a bottom **pending-changes bar** with *N pending changes*,
**Review SQL** (the statements the batch implies), **Discard** (revert the UI to
introspected truth), and **Apply changes** (execute the batch transactionally).
After a successful apply the view re-introspects so the rows, sidebar counts, and
data grid reflect the new schema; on failure the engine rolls back fully and the
error appears in the pending bar with the database untouched.

Primary-key columns are protected: dropping or retyping a pk column is rejected
at both preview and apply. SQLite has no native `ALTER COLUMN`, so type /
nullable / default changes are realized via the documented **table-rebuild
dance**; tables whose definition a metadata rebuild cannot reconstruct (CHECK,
generated columns, AUTOINCREMENT, WITHOUT ROWID, COLLATE, triggers) are refused
rather than silently degraded.

## Dependencies — M7

M8 builds directly on **M7 — Structure view (read-only)** (`docs/M7-structure-view.md`):

- The two-pane Structure mode (`StructureView`), the `account_tree` header, the
  count chips, the columns pane, and the Indexes / Foreign keys / Referenced-by /
  DDL rail are M7. M8 makes the columns pane **editable** and adds the pending bar.
- M8 reuses M7's introspection: `useIntrospectionStore.loadTableMeta` / `invalidate`
  / `loadTables` and the `TableMeta` (`columns[]`, `indexes[]`, `foreignKeys[]`,
  `referencedBy[]`, `ddl`) it warms. After apply, M8 invalidates and reloads
  through these same store actions — there is no client-side schema cache to patch.
- M8 reuses the connections feature's `ConnectionManager` (`get_sql(handle)`) and
  `ConnectionsState`, the same cross-feature composition M3/M4 introspection uses.
- The row-count chip reuses M4/M5's `useTabMetaStore.meta[tabId].totalRows`
  (only shown when Data mode has already warmed it — no COUNT fired for the chip).

## Backend (Rust core)

### Domain — pending edit model → ALTER statement; edit kinds

`src-tauri/src/features/structure/domain/mod.rs` — pure value objects + serde, no
SQL, no Tauri (the layering rule; SQL generation lives in `engines::*`).

`AlterOp` is an internally-tagged enum (`#[serde(tag = "op", rename_all = "camelCase")]`)
with six variants — one per §3.6 editing operation. A batch is a JSON array:

```json
[
  { "op": "addColumn", "name": "note", "dataType": "TEXT", "nullable": true, "default": null },
  { "op": "renameColumn", "from": "qty", "to": "quantity" },
  { "op": "changeType", "column": "price", "newType": "NUMERIC(10,2)" },
  { "op": "setNullable", "column": "email", "nullable": false },
  { "op": "setDefault", "column": "status", "default": "'pending'" },
  { "op": "dropColumn", "name": "legacy" }
]
```

Variants and field semantics:

| variant        | wire token (`op`) | fields                                                   | meaning |
|----------------|-------------------|----------------------------------------------------------|---------|
| `AddColumn`    | `addColumn`       | `name`, `dataType`, `nullable`, `default` (`Option<String>`) | add column; `default` is the verbatim default expression (`null` = none) |
| `RenameColumn` | `renameColumn`    | `from`, `to`                                             | rename `from` → `to` |
| `ChangeType`   | `changeType`      | `column`, `newType`                                      | change declared type |
| `SetNullable`  | `setNullable`     | `column`, `nullable`                                     | `true` ⇒ DROP NOT NULL, `false` ⇒ SET NOT NULL |
| `SetDefault`   | `setDefault`      | `column`, `default` (`Option<String>`)                  | `Some(expr)` ⇒ SET DEFAULT, `None` ⇒ DROP DEFAULT |
| `DropColumn`   | `dropColumn`      | `name`                                                    | drop column; pk-protected |

The Rust field `default_value` is renamed to the wire name `default` (a Rust
keyword) via `#[serde(rename = "default")]`; variant structs that carry it also
get `#[serde(rename_all = "camelCase")]` so `dataType` / `newType` match the TS
mirror in `src/shared/api/engine.ts`.

Three classifier methods drive the adapter:

- `is_native(&self) -> bool` — `true` for `AddColumn` / `RenameColumn` /
  `DropColumn` (realizable with a native SQLite `ALTER TABLE`); `false` for the
  three that require a rebuild on SQLite.
- `target_column(&self) -> Option<&str>` — the existing column the op targets
  (`from` for rename, `column`/`name` otherwise); `AddColumn` returns `None`
  because it introduces a new column. Used for validation + pk protection.
- `rejected_on_pk(&self) -> bool` — `true` for `ChangeType` and `DropColumn`
  (a rebuild cannot safely retype a pk, and dropping it is destructive in a way
  the editor does not support). Rename / nullable / default on a pk column are
  allowed.

Tests in this module pin every variant's exact wire token, round-trip, the
native classification, and the pk rules.

### Ports / Application — stage edit → engine-correct ALTER; apply in transaction; discard; re-introspect

`src-tauri/src/features/structure/application/mod.rs` — two thin use-cases over the
`EngineConnection::alter_table` port; no Tauri, no drivers, no SQL.

```rust
pub async fn preview_alter(manager, handle, schema, table, ops) -> Result<AlterResult, AppError>
    => manager.get_sql(handle).await?.alter_table(schema, table, ops, /*apply=*/false).await

pub async fn apply_alter(manager, handle, schema, table, ops) -> Result<AlterResult, AppError>
    => manager.get_sql(handle).await?.alter_table(schema, table, ops, /*apply=*/true).await
```

- **Preview is PURE**: `apply == false` returns the statement strings only and
  MUST NOT mutate the database (it may read schema metadata to validate).
- **Apply executes transactionally**: `apply == true` realizes the batch and on
  any failure the adapter rolls back fully (database untouched) and returns a §5
  error.
- **Discard** has no backend call — the renderer simply clears its pending batch
  (the introspected snapshot is the truth, so discard reverts for free).
- **Re-introspect** is the renderer's job after apply (nothing is cached
  server-side); the application layer holds no per-edit state.
- A closed/unknown handle surfaces as `AppError::NotFound` ("…closed…") via
  `get_sql`. Tests use a `FakeConnection` that echoes the requested mode to prove
  the preview/apply wiring (`applied` flag, statement passthrough, closed handle).

The port itself (`src-tauri/src/shared/engine.rs`):

```rust
async fn alter_table(&self, schema: &str, table: &str, ops: &[AlterOp], apply: bool)
    -> Result<AlterResult, AppError>;
```

Default impl returns `AppError::Unsupported("Structure editing is not supported for
this engine yet.")` — only engines that implement structure editing override it.
**SQLite implements it (M8).** Postgres and MySQL adapters also override it (added
later, M12); M8 is the SQLite story.

### Infrastructure — per-engine ALTER generation; SQLite table-rebuild; unsupported-op handling per engine

`src-tauri/src/engines/sqlite/structure.rs` — `alter_table_blocking(conn, schema,
table, ops, apply)`. This is the ONLY place SQLite ALTER/rebuild SQL lives.

Pipeline:

1. `ensure_schema_exists` + `table_meta_blocking` — existence + the real column
   set (gives pk membership). Empty batch ⇒ `AppError::Invalid("No structure
   changes to apply.")`.
2. `validate_ops(&meta, table, ops)` — for every op with a `target_column`: the
   column must exist (else a §5 `Database` error listing the real columns), and a
   pk column rejects `ChangeType` / `DropColumn` ("…is part of the primary key…
   cannot be dropped or retyped."). Runs for **both** preview and apply so the
   user sees the error before committing.
3. `preview_statement(table, op)` for each op — the "Review SQL" strings (logical
   intent, same list for preview and apply):

   | op           | preview statement |
   |--------------|-------------------|
   | `AddColumn`  | `ALTER TABLE "t" ADD COLUMN "c" TYPE [NOT NULL] [DEFAULT x]` |
   | `RenameColumn` | `ALTER TABLE "t" RENAME COLUMN "a" TO "b"` |
   | `DropColumn` | `ALTER TABLE "t" DROP COLUMN "c"` |
   | `ChangeType` | `ALTER TABLE "t" ALTER COLUMN "c" TYPE x` |
   | `SetNullable`| `ALTER TABLE "t" ALTER COLUMN "c" SET/DROP NOT NULL` |
   | `SetDefault` | `ALTER TABLE "t" ALTER COLUMN "c" SET DEFAULT x / DROP DEFAULT` |

   All identifiers go through `quote_ident`. `apply == false` returns here with
   `applied: false` (no mutation).
4. Apply strategy:
   - **All native** (`ops.iter().all(AlterOp::is_native)`) → `apply_native`: run
     `native_exec_statement` for each op (schema-qualified `ALTER TABLE`) in order
     inside one transaction.
   - **Any rebuild op** → `apply_with_rebuild`.

**SQLite table-rebuild dance** (`apply_with_rebuild`), the documented "Making
Other Kinds Of Table Schema Changes" procedure, because SQLite has no native
`ALTER COLUMN`:

1. **Safety guard** (`rebuild_unsupported_feature`): fetch the original `CREATE
   TABLE` DDL (`table_ddl`) and trigger presence (`table_has_triggers`). A
   metadata rebuild cannot preserve CHECK constraints, generated/virtual columns
   (` AS `/`GENERATED`), AUTOINCREMENT, WITHOUT ROWID, COLLATE, or triggers, so if
   any are present it returns `AppError::Unsupported("Changing the type,
   nullability, or default of a column on 't' isn't supported yet because the
   table uses {feature}…")`. The DDL scan first runs `strip_quoted` (removes
   single-quoted strings and `"`/`` ` ``/`[]` identifiers) so a column literally
   named `check_in` or a default `'GENERATED'` does not trip the guard.
2. `compute_target_columns(meta, ops)` — replay all ops in order over the
   introspected columns to build the target column set, tracking each target
   column's source name (`from`) for the data copy (`None` for added columns).
   Catches add-collisions, rename-collisions, missing columns, and a batch that
   would leave **zero columns**.
3. FK handling: read `PRAGMA foreign_keys`; if ON, `PRAGMA foreign_keys = OFF`
   (it cannot be toggled inside a transaction).
4. `rebuild_in_transaction`: `BEGIN`; (1) `CREATE TABLE __bytetable_rebuild_{table}`
   from the target columns + original FKs + pk (`build_create_table`: single pk
   inline `PRIMARY KEY`, composite pk as a table-level clause; FKs whose local
   columns survive are re-emitted with ON DELETE / ON UPDATE); (2) `INSERT INTO
   tmp(mapped cols) SELECT (source cols) FROM orig` (added columns omitted so
   their DEFAULT/NULL applies); (3) `DROP TABLE orig`; (4) `ALTER TABLE tmp RENAME
   TO orig`; (5) recreate user `CREATE INDEX`es (`origin == "c"`) whose columns
   all survive — implicit pk/UNIQUE indexes are recreated by the new `CREATE
   TABLE` itself; `COMMIT`.
5. Restore `PRAGMA foreign_keys = ON` (always attempted, regardless of rebuild
   outcome), then run `PRAGMA {schema}.foreign_key_check(table)`; a violation ⇒
   `AppError::Database("…would violate a foreign-key constraint; no changes were
   applied.")`.

Rollback is guaranteed by a small RAII `Transaction` guard over the shared
`&Connection`: `BEGIN` with a 5s busy_timeout, `commit()` on success, and
`ROLLBACK` on `Drop` if not committed — so any early return / error / panic
leaves the table untouched. Driver errors go through `map_query_error` for §5
messages.

**Unsupported-op handling per engine:** non-SQLite SQL engines fall back to the
`alter_table` default (`AppError::Unsupported`) until they override it; Postgres /
MySQL adapters (M12) implement native `ALTER TABLE` for every op (no rebuild
needed). The frontend type-change select offers SQLite affinities only (M8 ships
SQLite editing).

### Tauri commands — table

`src-tauri/src/features/structure/commands.rs`, registered in
`src-tauri/src/lib.rs` (`features::structure::commands::{alter_preview, alter_apply}`).
Both are `async`, read `ConnectionsState` for the handle manager, deserialize →
use-case → serialize (no logic in the command layer).

| command | args | returns | errors |
|---------|------|---------|--------|
| `alter_preview` | `handleId: String`, `schema: String`, `table: String`, `ops: Vec<AlterOp>` | `AlterResult { statements: Vec<String>, applied: false }` | §5 `{kind, message}`: closed handle (`NotFound`), unknown schema/table/column, pk-protected op (`Database`), empty batch (`Invalid`). Never mutates. |
| `alter_apply`   | same as above | `AlterResult { statements, applied: true }` | all of the above **plus** rebuild-unsupported feature (`Unsupported`), FK-check violation / constraint failure during apply (`Database`). On any failure the engine rolls back fully and returns the §5 error. |

## Frontend (React)

### State — staging store (pending edits[], generated SQL, dirty)

**Persisted (survives Data↔Structure switch and workspace switch):** the ordered
pending batch lives per table tab on the active workspace's `ui.structureEdits`
map, keyed by `tabId`, in `src/features/workspaces/state.ts`:

- `setTabStructureOps(tabId, ops: AlterOp[])` — replaces a tab's batch (creates
  the `structureEdits` map lazily; an empty array clears the entry).
- Closing a tab deletes its `structureEdits` entry (state.ts `~L477`).
- `StructureView` reads `ws.ui.structureEdits?.[tabId]` as `pendingOps`.

There is **no separate "snapshot"** stored: the snapshot for discard is the
introspected `TableMeta` in `useIntrospectionStore`, so discard = clear the batch
and the working set re-derives for free (mirrors §4's "pendingStatements[],
snapshot for discard — per table tab").

**Derived on render (`src/features/structure/ops.ts`):**

- `applyOpsToColumns(columns, ops): WorkingColumn[]` — replay the batch over the
  introspected `ColumnInfo[]` to get the *working column set* the rows display.
  Dropped columns are kept (flagged `markedForDrop`, struck-through) rather than
  vanishing; added columns get `isNew`; each carries `origin` (the introspected
  name it maps from, `null` for a freshly added column). Mirrors the backend's
  `compute_target_columns`.
- `toWireBatch(ops): AlterOp[]` — reorder the stored batch into the backend-safe
  phase order **drops → addColumns → in-place edits → renames** before sending.
  Renames last guarantees a same-column "retype + rename" batch validates (every
  op except `addColumn` must reference an ORIGINAL column name; after a rename the
  running column set holds the new name).

**Transient (local component state, not persisted):** `reviewOpen`, `applying`,
`applyError`, `previewStatements`, `previewError`, `editingCell`, `autoEditName`,
plus the column filter `colQuery` and `ddlOpen`.

**Op accumulation / dedup** (the `setOps` handlers in `StructureView.tsx`):
in-place edits (`changeType` / `setNullable` / `setDefault`) are keyed by the
ORIGINAL column name, last-wins; an edit that returns a cell to its introspected
value **removes** the op. `renameColumn` is keyed by the original name (renaming
back to the original removes it). Edits to a not-yet-added column mutate its
`AddColumn` op in place (never emit a rename/changeType for a server-absent
column). `dropColumn` toggles on/off; dropping a just-added column removes its
`AddColumn` op. So the pending count and working set always reflect "net change".

### API — typed invoke wrappers

`src/features/structure/api.ts` re-exports the engine-shared wire glue from
`src/shared/api/engine.ts` under the structure slice (thin by design):

```ts
export { alterApply, alterPreview, type AlterOp, type AlterResult } from "../../shared/api/engine";
```

In `engine.ts`:

```ts
alterPreview(handleId, schema, table, ops: AlterOp[]): Promise<AlterResult>
  // invoke("alter_preview", { handleId, schema, table, ops })
alterApply(handleId, schema, table, ops: AlterOp[]): Promise<AlterResult>
  // invoke("alter_apply", { handleId, schema, table, ops })
```

`AlterOp` is the discriminated-union TS mirror of the Rust enum (`op` tag,
camelCase). `SQLITE_TYPES` (`ops.ts`) is the type-change select list: TEXT,
INTEGER, REAL, NUMERIC, BLOB, BOOLEAN, DATE, TIMESTAMP (the column's current type
is prepended if absent).

### Components — inline column editors, pending bar, pk-protection affordances

`src/features/browse/components/StructureView.tsx` (mounted from
`src/features/workspaces/components/TableTab.tsx` for Structure mode):

- **Columns pane head**: search ("Filter N columns…", live count "M of N"), and
  the accent **"+ Add column"** button (`addColumn`) — appends an `isNew`
  accent-tinted row with a unique synthetic name (`new_column`, `new_column_2`,…)
  already in name-edit (`autoEditName`).
- **`ColumnRow`** (one per working column) with inline editors:
  - **Name** — `EditableText`: double-click → input; commits via `renameColumn`
    (names normalized: trim, non-word→`_`, lowercase; duplicate-name guard with a
    `err` toast). Shows the FK `→ table.col` suffix when present.
  - **Type** — `TypeCell`: double-click → `<select>` of `SQLITE_TYPES` (+ current
    type); commits via `changeType`. **PK columns render a locked, non-editable
    span** ("Primary key column — type is locked").
  - **Nullable** — a toggle button (`NULL` / `NOT NULL`); `toggleNullable`. **PK
    columns are disabled/locked** ("Primary key — always NOT NULL").
  - **Default** — `EditableText`: double-click → input (empty ⇒ `NULL`/no
    default); commits via `changeDefault`.
  - **Drop** — trash icon on row hover (`dropColumn`); a `markedForDrop` row shows
    an always-visible **undo** affordance (`undropColumn`). **PK columns render no
    drop affordance.**
- **Pending bar** (renders only when `ops.length > 0`):
  - Row: `pending_actions` icon · "**N pending changes**" · **Review SQL** toggle
    (`expand_less`/`expand_more`, flips to "Hide SQL") · spacer · **Discard**
    (text button) · **Apply changes** (filled, `check` icon; "Applying…" while busy).
  - **Review SQL** expanded: a "Pending statements" list. On expand (and on batch
    change while open) it calls `alterPreview(handleId, schema, table, toWireBatch(ops))`
    and renders each returned statement as a syntax-highlighted `<pre>`
    (`highlightSql`). Pure — no DB write. Preview errors render in the same red
    `.pending-error`.
  - **Apply** (`applyPending`): calls `alterApply(...)`; on success clears the
    batch, closes review, `invalidate(handleId, schema)` + `loadTableMeta(force)`
    + `loadTables(force)` (sidebar counts) + `requestRefetch(tabId)` (data grid),
    and toasts "Applied N change(s)". On failure keeps the batch and shows the §5
    engine error **in the pending bar** (`applyError`).
  - **Discard** (`discardPending`): `setOps([])`, resets review/preview/apply
    state, toasts "Pending changes discarded".

### Styling — §3.6 pending bar

`src/features/browse/components/StructureView.css` ("byte-exact from
ByteTable.html"):

- `.pending-bar` — top border `color-mix(accent 40%, border)`, bg `color-mix(accent
  5%, bg1)` (accent-tinted, §3.6).
- `.pending-bar-row` — flex, gap 9px, padding 7px 14px; `.pending-count` 12px/600;
  `.pending-review` 11.5px dim, hover lifts to `--text` on `--bg2`.
- `.pending-list` — padding 10px 14px 2px, dashed bottom border, `max-height:180px`
  scroll; `.pending-list-title` 10px uppercase 0.09em tracking faint.
- `.pending-sql` — mono 11px, `--bg0` card, border, radius 7px, `white-space: pre`,
  horizontal scroll.
- `.pending-error` / `.pending-error-row` — §5 red (`#e06c75`), 11.5px, with an
  `error` icon for the apply-failure row.
- `.add-col-btn` — accent text on `color-mix(accent 12%, bg2)`, radius 7px.
- `.st-row-new td` — accent 7% tint; `.st-row-drop td` — line-through + faint;
  `.st-drop` hover red, `.st-undrop` hover accent; `.st-null-toggle.locked` /
  locked type cell dimmed for pk.

## Shared data contracts — TS + Rust types

| concept | Rust (`src-tauri`) | TS (`src`) |
|---------|--------------------|-----------|
| staged edit | `features::structure::domain::AlterOp` (enum, `tag="op"`, camelCase) | `AlterOp` union in `shared/api/engine.ts` |
| preview/apply result | `shared::engine::AlterResult { statements: Vec<String>, applied: bool }` | `interface AlterResult { statements: string[]; applied: boolean }` |
| port | `EngineConnection::alter_table(schema, table, ops, apply) -> AlterResult` | `alterPreview` / `alterApply` invoke wrappers |
| working column (UI only) | n/a (server uses `compute_target_columns` → `TargetColumn`) | `WorkingColumn { name, dataType, nullable, pk, default, fk, origin, isNew, markedForDrop }` in `structure/ops.ts` |
| persisted batch (UI only) | n/a | `ws.ui.structureEdits[tabId]: AlterOp[]` |

`AlterResult.statements` is the SAME list for preview and apply (logical intent;
on SQLite this is truthful about *what* changes, not the verbatim rebuild SQL).

## Behavior & edge cases

- **Discard reverts to introspected truth.** No backend call; clearing `ops`
  re-derives the working set from the cached `TableMeta`. The §3.6 "Discard (full
  revert, incl. data)" wording is honored because nothing was applied — the
  database was never touched.
- **Failed apply rolls back + shows the engine error in the pending bar.** The
  RAII transaction guarantees the table is untouched; `applyPending` keeps the
  batch and renders `applyError` in the §5-red `.pending-error-row`. Tested
  rollbacks: native rename collision rolls back the whole batch
  (`native_rename_collision_rolls_back_whole_batch`); a SET NOT NULL on a column
  holding NULL fails the rebuild copy and leaves the table unchanged
  (`rebuild_not_null_violation_rolls_back`).
- **PK protections** are enforced server-side (`validate_ops` rejects ChangeType /
  DropColumn on a pk at preview AND apply) and reflected client-side (no drop
  affordance, locked type cell, disabled nullable toggle for pk rows). Rename /
  default on a pk column are allowed.
- **SQLite caveats:** type/nullable/default changes require the table-rebuild
  dance; tables using CHECK / generated columns / AUTOINCREMENT / WITHOUT ROWID /
  COLLATE / triggers are **refused** (`Unsupported`) rather than silently losing
  the feature. A batch that would leave the table with no columns is rejected.
  Native-only batches (add/rename/drop) avoid the rebuild entirely and preserve
  the table definition by construction.
- **Op ordering correctness:** `toWireBatch` emits drops → adds → in-place edits
  → renames so a same-column "retype + rename" batch validates (in-place edits
  reference the original name; renames run last). The acceptance batch (add +
  rename + retype) is a valid wire batch.
- **Empty batch** is a no-op in the UI (the bar only renders with `ops.length > 0`);
  the backend rejects an empty `ops` with `AppError::Invalid`.
- **Unknown handle / engine without support** surface as §5 errors (`NotFound` /
  `Unsupported`) in the pending bar.

## Acceptance criteria

- **Add + rename + retype a column on SQLite, verified externally.** A single
  batch — `AddColumn("in_stock", INTEGER, NOT NULL, DEFAULT 1)` + `RenameColumn
  label→name` + `ChangeType price→NUMERIC` — applies in one transaction, preserves
  every row (renamed column keeps values, added column defaults, retyped column
  re-cast per affinity), preserves composite pk + FKs, and recreates user indexes.
  Pinned by `engines/sqlite/structure.rs::acceptance_add_rename_retype_in_one_batch`
  and verifiable with an external tool (e.g. `sqlite3 .schema` / `PRAGMA table_info`).
- **Discard truly reverts.** Staging any edits then Discard clears the batch and
  the rows show introspected truth again; no statement ever reached the database.
- **Failed apply rolls back and shows the engine error in the pending bar.** A
  pk drop/retype, an unsupported-feature rebuild, a rename collision, or a NOT
  NULL violation returns a §5 message, the batch is kept, and `PRAGMA table_info`
  shows the table unchanged.
- **PK protection.** Dropping or retyping a pk column is rejected at preview and
  apply (`dropping_a_pk_column_is_rejected_at_preview_and_apply`,
  `retyping_a_pk_column_is_rejected`); the UI offers no such affordance.
- **Preview is pure.** `alter_preview` never mutates
  (`preview_does_not_mutate_the_table`).

## Pixel / UX checklist

- [ ] Editable columns pane: double-click name / type / default to edit; single
      click toggles nullable; "+ Add column" appends an accent-tinted row already
      in name-edit.
- [ ] PK rows: type cell locked (tooltip "type is locked"), nullable toggle
      disabled (tooltip "always NOT NULL"), no drop trash icon.
- [ ] Drop trash appears on row hover; a marked-for-drop row is struck-through +
      faint with an always-visible undo button.
- [ ] Pending bar renders only with ≥1 pending change: `pending_actions` icon ·
      "N pending changes" · Review SQL toggle · Discard · filled "Apply changes".
- [ ] Review SQL expands a "Pending statements" list of highlighted `ALTER TABLE …`
      statements (scrolls at 180px); collapse flips label to "Hide SQL".
- [ ] Apply shows "Applying…", on success toasts "Applied N changes", clears the
      bar, and the rows / sidebar counts / data grid refresh to the new schema.
- [ ] Apply failure shows the §5-red engine error inside the bar with the batch
      preserved; Discard toasts "Pending changes discarded".
- [ ] Pending bar styling: accent-tinted top border + bg, mono SQL cards on
      `--bg0`, red error row with `error` icon.
- [ ] A draft batch survives switching to Data mode and back, and switching
      workspaces and back (persisted per tab in `ui.structureEdits`).
