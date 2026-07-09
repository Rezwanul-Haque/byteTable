# M22 — Object Explorer (SQL schema catalog)

> Provenance: this documents what SHIPPED for ByteTable milestone M22 — a first-class catalog tab (`objexplorer`) for schemas holding hundreds of views, materialized views, functions, procedures, and triggers. Imperative sentences are requirements the shipped code satisfies; every claim is grounded in a real path. M22 **reuses** the M-series `db_objects` layer wholesale — the object registry, DDL generation, `ObjectViewer`, and drop modal already existed — and adds two things on top: (1) a spacious, sortable/filterable **grid tab** that the sidebar's capped object sections escalate into, and (2) an **enrichment** of the `list_objects` introspection command so the grid's per-facet columns carry real data. The prototype (`ByteTable_latest/project/bytetable/objexplorer.jsx`) is a mock (synthetic `padCatalog` + `window.BT_OBJ`); M22 ports its UI + behavior 1:1 while replacing the mock data source with real introspection. The synthetic seed padding is intentionally **not** ported.

## Goal

A `'objexplorer'` tab: a toolbar (category icon + `schema` pill + autofocused filter + `X of Y` total), a left **facet rail** ("All objects" + one facet per non-table class with a live count), and a **grid** whose columns change per facet — Functions show Returns/Lang/Args/Volatility, Triggers show Table/Timing/Events/Enabled, Materialized Views show Rows/Size/Reads, etc. Rows single-click to select, double-click to open the existing `ObjectViewer`; a name-cell hover exposes **copy-name** and **browse/open**. Multi-select drives a bottom action bar — **Export DDL** (concatenated `object_definition` output → `<schema>_objects.sql`) and a prod-gated **Bulk Drop**. One Explorer tab per schema; it survives schema switches.

It is opened from the sidebar: each object section caps at **12** names with a "Show all N in Explorer →" overflow, and an "Explore all" header button opens the union facet.

## Dependencies — the existing `db_objects` + `introspection` slices, the tab system

- **`db_objects` object layer** — reused unchanged: `listObjects` / `objectDefinition` / `dropObject` (`src/shared/api/engine.ts:496`), the introspection cache (`loadObjects` / `loadObjectDefinition` / `invalidateObjects`, `src/features/introspection/state.ts:153`), class metadata (`OBJ_SECTIONS` / `ENGINE_OBJECTS` / `objectClassesFor` / `isBrowsable` / `typeBadge`, `src/features/db_objects/kinds.ts`), DDL helpers (`dropPrefix`, `editableObjectDDL`, `src/features/db_objects/ddl.ts`), and the double-click target `ObjectViewer` + `ObjectDropModal` (`src/features/db_objects/components/`).
- **Tab system** — the `Tab` union (`src/features/workspaces/types.ts:183`) gains the `objexplorer` variant; the store adds `openObjExplorer` (`src/features/workspaces/state.ts`); `TabBar` maps it to the `category` icon + "Objects" title (`src/features/workspaces/components/TabBar.tsx`); `WorkspaceContent` routes it to `ObjectExplorer` (`src/features/workspaces/components/WorkspaceContent.tsx`).

## Backend (Rust core) — enrich `list_objects`

The sidebar needs only name/kind/detail, but the Explorer grid needs per-object metadata (owner, returns, timing, …). Rather than N `object_definition` round-trips for a big schema, M22 **enriches the list row** so one `list_objects` call fills the grid.

- **`DbObjectInfo`** (`src-tauri/src/shared/engine.rs:699`) gains optional, `#[serde(default)]` metadata — `owner`, `modified`, `returns`, `language`, `volatility`, `arg_count`, `table`, `timing`, `events`, `enabled`, `approx_rows`, `size`, `depends_on` — plus a `DbObjectInfo::bare(name, kind, detail)` constructor for rows with no metadata. All fields are `Option`/`Vec`, so old adapters and the sidebar are unaffected; each renders as a grid column only when present. The TS mirror is `src/shared/api/engine.ts:440`.
- **Postgres** (`src-tauri/src/engines/postgres/objects.rs`) — `list` populates routines (returns via `pg_get_function_result`, language, volatility via `provolatile`, `pronargs`, owner via `pg_roles`), triggers (`tgtype` bits → timing/events, `tgenabled` → enabled), and views/matviews (owner; matview `reltuples` + `pg_size_pretty`). Pure decoders `volatility_label` + `trigger_bits` are extracted and reused by the definition path (unit-tested: `pg_decodes_volatility_and_trigger_bits`).
- **MySQL** (`src-tauri/src/engines/mysql/objects.rs`) — `information_schema` `DEFINER` → owner, routine `DTD_IDENTIFIER` → returns, `LAST_ALTERED` → modified, a `parameters` count → arg count, and trigger `ACTION_TIMING`/`EVENT_MANIPULATION`/`EVENT_OBJECT_TABLE` (always enabled). No volatility/matviews.
- **MSSQL** (`src-tauri/src/engines/mssql/objects.rs`) — `sys.*`: `modify_date` → modified for all; matview rows via `sys.dm_db_partition_stats`; routine arg count via `sys.parameters`; trigger `is_disabled`/`is_instead_of_trigger` + `sys.trigger_events` (STRING_AGG) → enabled/timing/events.
- **SQLite** (`src-tauri/src/engines/sqlite/objects.rs`) — the catalog is thin; `parse_trigger_sql` scans the stored `CREATE TRIGGER` header for timing + events (unit-tested: `sqlite_parses_trigger_timing_and_events`). Views/triggers only; other metadata stays `None`.

## Frontend — the Explorer tab

- **`ObjectExplorer`** (`src/features/db_objects/components/ObjectExplorer.tsx`) — the tab component. Takes `{ workspace, schema, focusClass }`, derives `engine`/`env`/`envColor` from `workspace.saved`, eager-loads every class list for counts, and renders the toolbar + facet rail + grid. `columnsFor(facet)` is the per-facet column spec (fixed widths; Name flexes with `NAME_MIN = 220`, `minWidth` drives horizontal scroll); sorting toggles direction on `.oe-th` click (numeric for `argCount`/`approxRows`, else case-insensitive with a name tiebreaker); filtering matches name/detail/owner. Copy-name mirrors the standalone copy-name spec (icon → check + toast, 1.2 s guarded reset, clipboard + textarea fallback). Browse (`table_rows`) opens a table tab for browsable kinds via `openTableTab`; open (`code`) opens the viewer.
- **`BulkDropModal`** (`src/features/db_objects/components/BulkDropModal.tsx`) — portal + scrim, per-class tally chips, a preview of up to 6 `dropPrefix` statements, and a `drop <N>` type-to-arm gate on production. Confirm drops each row via `dropObject` then `invalidateObjects` (the refetch replaces the prototype's `bumpVersion`).
- **Sidebar escalation** (`src/features/db_objects/components/SidebarObjectGroups.tsx`) — `CAP = 12`; overflow renders "Show all N in Explorer →" (`openObjExplorer(schema, kind)`); the "Objects" header carries "Explore all" (`openObjExplorer(schema, "all")`). Filtering shows all matches, uncapped.
- **Styling** (`src/features/db_objects/components/ObjectExplorer.css`) — the `.oe-*` rules ported from the prototype (toolbar, rail, grid header/body, sortable `.oe-th`, `.oe-row` hover/checked, `.oe-copy`/`.oe-open` hover-reveal + focus ring, `.oe-badge`, `.oe-actionbar`, `.oe-drop-chip`, `.oe-empty`) plus the sidebar `.obj-showall`/`.obj-explore-all` escalation. `.obj-type-badge` is reused from `ObjectsView.css`, not duplicated.

## QA checklist

- [ ] All engines expose the correct facet set; rail counts equal `list_objects` lengths.
- [ ] Column set + widths change per facet; the header stays aligned under horizontal scroll.
- [ ] Sort (asc/desc, numeric vs text), filter, and the empty state behave per the prototype.
- [ ] Row select / select-all-of-filtered / double-click-open work independently; copy + open buttons `stopPropagation`.
- [ ] Export DDL yields valid multi-object SQL for every class & dialect.
- [ ] Bulk Drop: production requires `drop N`; grid + counts refresh after drop.
- [ ] Sidebar cap = 12; overflow + "Explore all" open the Explorer focused correctly; one Explorer tab per schema; survives schema switch.
- [ ] Enriched columns populate where the engine can source them (owner/timing/events/returns/…); absent metadata degrades to `—`.
