# M11 — Inline cell editing

> **Provenance:** reconstructed from the SHIPPED code, not a forward design. Source of truth is what is in the tree: backend `src-tauri/src/features/mutate/` + the `EngineConnection::update_cell` adapters in `src-tauri/src/engines/{sqlite,postgres,mysql}/mod.rs`; wire DTOs in `src-tauri/src/shared/engine.rs`; renderer in `src/features/browse/components/DataGrid.tsx` (+ `GridCell.tsx`, `DataGrid.css`) and the typed wrapper in `src/shared/api/engine.ts`. Design intent: MILESTONES.md M11 and DESIGN_SPEC.md §3.5 (Table tab — Data mode, "Inline edit"). **Every imperative sentence is a requirement** the code already satisfies; this document is written so the feature is rebuildable from it.
>
> The SQLite adapter (`update_cell_blocking`) is the canonical M11 implementation. Postgres + MySQL implement the same `update_cell` contract (shipped with M12) behind the identical port method; this spec documents the shared contract and calls out engine deltas inline.

## Goal

Real, safe single-cell data mutation per §3.5. Double-click a grid cell → a borderless in-cell input → Enter/blur commits a **parameterized** `UPDATE … SET col = ? WHERE pk = ?`. The new value is type-coerced by the column; an empty input on a nullable column writes NULL. The write is **optimistic** (cache updates immediately) and a success toast shows the executed (display) statement; an engine error **rolls the cell back** and shows why. A cell is **read-only** (with a tooltip explaining why) when the table has no usable primary key. Editing on a connection tagged `production` requires a **confirm dialog** first. Nothing the user types is ever interpolated into SQL.

## Dependencies

- **M4 grid** — `DataGrid.tsx` owns the page cache (keyed by absolute row index), the selected/edit state, and the cell render path. M11 hangs the edit flow off the existing `td` `onDoubleClick` seam and the `.cell-input` / `.cell-editing` CSS the M4 port already shipped.
- **M7 (pk / column meta)** — `tableMeta` supplies per-column `pk` / `fk` / `dataType` / `nullable`, collapsed into the grid's `ColCellMeta` map. PK columns drive the WHERE predicate and the editability gate; `dataType`/`nullable` drive type coercion and the NULL affordance. The backend independently re-derives the pk from `table_meta` inside `update_cell` — the renderer's gate is convenience, the adapter's check is the guarantee.
- **Env metadata from connections** — `SavedConnection.env: Env` (`"dev" | "staging" | "production"`, `src/shared/types.ts`) on the active workspace drives the production-confirm dialog. The §3.5 env color (red for production) is the same metadata surfaced as the env tag elsewhere.

## Backend (Rust core)

### Domain — cell-update model

The mutate slice is deliberately thin (no domain/infra of its own — see `src-tauri/src/features/mutate/mod.rs`). The cell-update model lives in `crate::shared::engine` and is shared by every slice that talks to a connection:

- **`UpdateCellRequest`** (`shared/engine.rs:961`): `{ schema, table, column, value: serde_json::Value, pk: Vec<PkPredicate> }`. `value` is the new cell value (`null` ⇒ set the cell to NULL). `pk` is the **full** primary key of the target row.
- **`PkPredicate`** (`shared/engine.rs:938`): `{ column, value }`. One per pk column; the adapter ANDs them so the WHERE clause matches exactly one row. `column` must be a real pk column (validated); `value` is *bound*, never interpolated. A `null` pk value is a no-match (`= NULL` is never true).
- **`UpdateResult`** (`shared/engine.rs:984`): `{ affected: u64, statement: String }`. `affected` is exactly `1` on success. `statement` is a **cosmetic, values-inlined display** rendering (e.g. `UPDATE "main"."users" SET "name" = 'Ada' WHERE "id" = 42`) for the §3.11 toast — it is NOT the verbatim query sent to the engine (which binds every value).

### Application — route the request; the safety contract lives in the adapter

`features/mutate/application.rs::update_cell(manager, handle, req)` resolves the open SQL connection (`manager.get_sql(handle)`) and delegates to `EngineConnection::update_cell`. No logic here beyond routing — a closed/unknown handle is an `AppError::NotFound` ("…closed…"). (The slice also carries `truncate_table` / `drop_schema` for M15; out of scope here.)

The **mutation safety contract** is enforced in the adapter (port docs at `shared/engine.rs:1320`; canonical impl `engines/sqlite/mod.rs::update_cell_blocking:1231`). The adapter MUST, in order:

1. **Validate existence + column.** Load `table_meta` (unknown schema/table → §5 "Table 'x' does not exist…"); `validate_column` (unknown column → §5 "Column 'x' does not exist on 't' (columns: …)").
2. **Require the FULL primary key** (`validate_pk_predicates`, `sqlite/mod.rs:1459`). The predicate column set must equal the table's real pk column set exactly — reject (all §5 errors): a table with **no** pk ("…it has no primary key, so a single row cannot be safely targeted."); a **partial** pk ("…requires the full primary key (…); 'x' is missing."); a predicate naming a **non-pk** column ("Column 'x' is not part of the primary key of 't'…"); a **duplicate** pk column. This is mass-update prevention — it guarantees the WHERE clause targets at most one row.
3. **Bind everything.** Build `UPDATE "schema"."table" SET "col" = ? WHERE "pk1" = ? AND …` with quoted identifiers; bind the SET value first, then each pk value in predicate order. The new value is bound even when NULL (`json_to_set_value`, `sqlite/mod.rs:1529`, maps JSON `null` → `SqlValue::Null` → a correct `SET col = NULL`; pk values use `json_to_sql_value`, which rejects null because `= NULL` is the WHERE trap). A `null` pk value short-circuits to a "no row matched" miss without touching the DB.
4. **Execute transactionally and assert the affected count.** `BEGIN`; on any engine error → `ROLLBACK` + map to §5 (e.g. a NOT NULL violation when setting NULL). `affected == 0` → `ROLLBACK` + "No row matched (it may have been deleted or changed since you loaded it)." (stale/deleted pk). `affected > 1` → `ROLLBACK` + §5 error (defense in depth; unreachable once pk is validated, but never silently mass-update). `affected == 1` → `COMMIT` and return `UpdateResult` with the cosmetic `display_update_statement` (`sqlite/mod.rs:1540`).

**Type coercion (adapter side).** SQLite uses affinity: `json_to_sql_value` (`sqlite/mod.rs:1758`) maps JSON bool → integer 0/1, integer → `Integer`, float → `Real`, u64-overflow → text, string → text. The renderer pre-coerces by declared type (below) before sending; the adapter binds whatever scalar arrives and lets the engine reject true mismatches. Postgres/MySQL adapters (`engines/postgres/mod.rs:1218`, `engines/mysql/mod.rs:1251`) bind through their drivers with engine-correct quoting (double-quotes / backticks).

### Tauri commands

| Command | Args | Returns | Errors |
|---|---|---|---|
| `row_update` | `handle_id: ConnectionHandleId`, `req: UpdateCellRequest` | `UpdateResult` `{ affected, statement }` | `{ kind, message }` (§5): closed handle → `NotFound`; unknown schema/table/column, no/partial/non-pk primary key, stale pk (0 rows), >1 rows, engine constraint failure → `Database`; engine without support → `Unsupported` |

Registered in `src-tauri/src/lib.rs:163` (`features::mutate::commands::row_update`). Handler `features/mutate/commands.rs:30` is deserialize → use-case → serialize; reads the connections feature's managed `ConnectionsState` for the handle manager (sanctioned cross-feature composition at the presentation boundary). `async fn` per the async-commands rule.

## Frontend (React)

All renderer M11 logic lives in `src/features/browse/components/DataGrid.tsx` (the M4 grid). There is **no separate `src/features/mutate/` slice** on the renderer — the edit flow is part of the grid, which already owns the cell render path and the page cache.

### State

In `DataGrid`:

- **`editing: EditState | null`** (`{ row, col, draft }`, `DataGrid.tsx:67`) — the in-flight edit: absolute cache row index, column index into `columns`, and the borderless input's draft text. `null` when no cell is being edited.
- **`pendingConfirm: PendingConfirm | null`** (`DataGrid.tsx:78`) — a commit parked on the production-confirm modal: `{ row, col, column, value, prior, pk, display }`. Holds everything `commitEdit` computed (including the coerced `value`, the `prior` value for rollback, and the cosmetic `display` SQL) so Confirm fires it or Cancel drops it. The page cache is **not** mutated while parked.
- **`committingRef`** — guards against Enter-then-blur double-firing one commit.
- **`generationRef`** — bumped on every reset (sort/filter/refresh/page change). `runUpdate` captures the generation at fire time so a rollback only writes back if the cache is still the same generation (otherwise the row was re-fetched / replaced anyway).
- **Optimistic snapshot** — `prior = row[ci]` captured at commit; `writeCache` applies the new value immediately and a `setCacheVersion` bump re-renders. Rollback re-applies `prior` via the same `writeCache`.
- **`isProduction`** — `useWorkspacesStore(s => …workspaces.find(ws => ws.handleId === handleId)?.saved.env === "production")` (`DataGrid.tsx:281`).

A reset clears both `editing` and `pendingConfirm` (`DataGrid.tsx:401`).

### API — typed invoke wrapper

`src/shared/api/engine.ts`:
- `rowUpdate(handleId, req: UpdateCellRequest): Promise<UpdateResult>` → `invoke("row_update", { handleId, req })` (`engine.ts:457`).
- Types: `UpdateCellRequest` (`engine.ts:332`), `PkPredicate` (`engine.ts:316`), `UpdateResult` (`engine.ts:353`) — camelCase mirrors of the Rust DTOs (`CellValue = string | number | boolean | null`).

### Components — the editable cell

All in `DataGrid.tsx`. The `td` (`.dg-td`) keeps its M4 structure; M11 adds:

- **Editability gate** — `pkColumns`/`hasPk` (`:557`) derive the pk columns in `columns` order; `buildPk(row)` (`:565`) assembles the full predicate from the row's loaded values (returns `null` if any pk value is missing). `readOnlyReason(rowIndex, ci)` (`:582`) returns a tooltip string or `null`:
  - no pk → `"Read-only: table has no primary key"`
  - the cell's own column **is** a pk column → `"Read-only: primary key column"` (editing a pk changes row identity — safe default)
  - the row's pk values aren't all loaded → `"Read-only: row key unavailable"`
- **Double-click → edit** — the `td`'s `onDoubleClick` (`:925`) clears any pending FK hop, then `startEdit(rowIndex, ci)` (`:596`). `startEdit` no-ops on a read-only cell, prefills `draft` with the current value as text (**NULL → empty input**, the NULL-entry affordance), and sets `editing`.
- **Type-aware input** — when editing, the cell renders `<input className="cell-input" aria-label={"Edit "+col}>` (`:933`), auto-focused + selected (`:615`). `onChange` updates `editing.draft`; `onBlur` → `commitEdit`; `Enter` → `commitEdit`, `Escape` → `cancelEdit` (`:942`). Non-editing cells render `<CellContent>` (the shared `GridCell` rendering — NULL faint small-caps, numbers right-aligned, booleans green/red, enums as pills, FK links).
- **Coercion** — `coerceForColumn(draft, meta)` (`:114`): empty draft on a nullable column → `null`; integer/real affinity → a `Number` when the trimmed text parses (else the raw string, letting the engine reject); boolean affinity → `1`/`0` for `true|1` / `false|0` (else raw string; the wire value is `string|number|null`, so SQLite's integer-backed boolean is sent as the integer); else the verbatim string. Affinity is keyword-matched on the declared type (`affinityOf`, `:92`).
- **Commit flow** — `commitEdit` (`:662`): coerce by column type; **no-op if unchanged** (compares by value and by string form, so a big-integer string edit that coerces back to the same number doesn't fire a precision-losing write); build the pk (bail if `null`); set `committingRef`; exit edit mode. If `isProduction`, build the cosmetic `display` SQL and **park on `pendingConfirm`** (cache NOT yet mutated). Otherwise `runUpdate` immediately.
- **Optimistic update + toast** — `runUpdate` (`:637`): `writeCache` applies `value` now; `rowUpdate(...)` fires; on success `toast(result.statement + " — " + result.affected + " row affected", "ok")` (the executed display statement, per §3.11). On error: roll back to `prior` (if same generation) and `toast(appErrorMessage(err, …), "err")`.
- **Production confirm dialog** — `pendingConfirm` renders a shared `Modal` (`:990`): red `warning` icon + "Update a row on a production connection?", body "This connection points at **production**. The following update will run:", the cosmetic `display` SQL in `<code className="dg-confirm-sql">`, and Cancel (`confirmCancel` → drop pending, cell untouched) / Confirm (`confirmProceed` → `runUpdate` the parked commit). `sqlLiteral` (`:134`) renders the display value (NULL/number/bool verbatim, strings single-quoted with `'` doubled) — display only; the real query is parameterized server-side.

### Styling — §3.5 cell-edit affordances

`src/features/browse/components/DataGrid.css`:
- **`.cell-input`** (`:198`) — full-width, transparent-style borderless input: `background: var(--bg0)`, `border: none`, `outline: none`, mono font at `--grid-fs`, zero padding, `color: var(--text)`. (Borderless in-cell input per §3.5.)
- **`.dg-td.cell-editing`** (`:209`) — `outline: 1.5px solid var(--accent)` (offset -1.5px) + `var(--bg0)` background — the 1.5px accent inset matching the §3.5 selected-cell treatment.
- **`.dg-confirm-body`** (`:216`) / **`.dg-confirm-sql`** (`:223`) — confirm modal body (UI font, dim) + the mono SQL block (`--bg0` bg, bordered, r7).
- Read-only cells carry the `readOnlyReason` string as the `td` `title` (native tooltip); editable cells fall back to the value-as-string title.

## Shared data contracts

| TypeScript (`src/shared/api/engine.ts`) | Rust (`src-tauri/src/shared/engine.rs`) | Notes |
|---|---|---|
| `PkPredicate { column: string; value: CellValue }` | `PkPredicate { column: String, value: serde_json::Value }` | one per pk column; `value` bound |
| `UpdateCellRequest { schema; table; column; value: CellValue; pk: PkPredicate[] }` | `UpdateCellRequest { schema, table, column, value: Value, pk: Vec<PkPredicate> }` | `value` null ⇒ SET NULL; `pk` = full pk |
| `UpdateResult { affected: number; statement: string }` | `UpdateResult { affected: u64, statement: String }` | `affected == 1` on success; `statement` cosmetic |
| `Env = "dev" \| "staging" \| "production"` (`src/shared/types.ts`) | `Env` on `SavedConnection` | drives production confirm |

All structs `#[serde(rename_all = "camelCase")]`. `CellValue = string | number | boolean | null`.

## Behavior & edge cases

- **pk-less / unkeyable rows are read-only.** No pk, a pk-column cell, or a row whose pk isn't fully loaded → the cell never enters edit mode and shows the reason as a tooltip. The backend independently rejects any such update (a §5 error), so the renderer gate is convenience, not the guarantee.
- **Production confirm.** When the active workspace's connection `env === "production"` (env color red), every commit is parked on a confirm modal showing the exact (cosmetic) statement; Cancel leaves the cell untouched (cache never mutated), Confirm fires the optimistic write. Dev/staging commit directly.
- **Rollback on engine error.** The optimistic write is reverted to the prior value (when the cache generation still matches) and the §5 driver message is toasted — e.g. NOT NULL violation, constraint failure, or "No row matched…" for a stale pk (the adapter rolls back the transaction, so the row is untouched server-side too).
- **Parameterized, never interpolated.** The executed query is `SET "c" = ? WHERE "pk" = ?` with the new value and every pk value bound; only validated, quoted identifiers are interpolated. The `statement`/`display` strings (with values inlined) are cosmetic. A string containing SQL is stored as an inert literal.
- **No-op edits don't fire.** An unchanged value (by value or string form) cancels the edit silently.
- **Empty input on a nullable column writes NULL** (the NULL-entry affordance); on a NOT NULL column the empty/coerced value is sent and the engine's rejection surfaces as a §5 error + rollback.
- **Concurrent reset.** Sort/filter/refresh/page change bumps the generation and clears edit + pending state; an in-flight update's toast is still truthful (the row was updated server-side) but a rollback is skipped because the cache is no longer the same data.
- **Engine coverage.** SQLite (M11), Postgres + MySQL (M12) all implement `update_cell` behind the same port; an engine without it returns `Unsupported` ("Editing cells is not supported for this engine yet.").

## Acceptance criteria

- Double-click a **text** cell on a SQLite table with a pk, type a new value, press Enter → the cell shows the new value, a success toast shows `UPDATE "…"."…" SET "…" = '…' WHERE "pk" = … — 1 row affected`, and the change persists across a refresh.
- Editing a **number** cell coerces to a numeric value and persists; a **boolean** cell accepts `true`/`false`/`1`/`0` and persists as the engine's stored form; clearing a **nullable** cell to empty writes **NULL** (renders as faint small-caps `null`) and persists.
- A table **with no primary key** renders every cell read-only; hovering shows "Read-only: table has no primary key"; double-click does nothing; no `row_update` is sent.
- A **pk column** cell is read-only ("Read-only: primary key column").
- On a connection tagged **`production`**, committing an edit opens the confirm dialog showing the statement; **Cancel** leaves the cell unchanged and sends nothing; **Confirm** applies the edit.
- An edit that violates a constraint (e.g. NULL into a NOT NULL column) **rolls the cell back** to its prior value and shows the §5 driver message in a red toast; the row is unchanged server-side.
- A stale pk (row deleted/changed since load) yields "No row matched…", rolls back, and changes nothing.

## Pixel / UX checklist

- In-cell input is **borderless** (`var(--bg0)` background, no border/outline, mono `--grid-fs`, zero padding) — it reads as the cell itself becoming editable, not a popup.
- The editing cell carries a **1.5px accent inset outline** (`outline-offset: -1.5px`) matching §3.5's selected-cell treatment.
- Edit input **auto-focuses and selects** its text on open; **Enter/blur commits**, **Esc cancels**, no double-fire on Enter-then-blur.
- Optimistic update is **immediate** (no spinner) — the cell shows the new value before the round-trip; rollback is silent except for the error toast.
- Success toast (§3.11, bottom-right, mono 11.5, ok=accent, auto-dismiss): the **executed display statement** + ` — N row affected`.
- Read-only cells show a **native tooltip** with the reason; the cursor/affordance does not invite editing.
- Production confirm modal: shared `Modal` shell (460px), red `warning` icon in the title, the cosmetic SQL in a bordered mono `--bg0` code block, **Cancel** (text) / **Confirm** (filled) actions.
- NULL renders as **faint small-caps `null`**; numbers right-aligned in the number color; booleans green/red — unchanged from the M4 `GridCell` render and preserved after an edit commits.
