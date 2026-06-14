# M9 — Schema map (ER diagram)

Status: shipped, merged on `main`.

> **Provenance.** This document is reverse-engineered from the **shipped code** of the
> `schema_map` slice (backend `src-tauri/src/features/schema_map/`, frontend
> `src/features/schema_map/`) cross-checked against MILESTONES.md (M9) and
> DESIGN*SPEC §3.8. Source of truth = the code. Every **imperative** sentence
> ("the canvas renders…", "the backend stores…") is a build requirement; prose
> marked \_note* is rationale. Paths are absolute-from-repo-root.

## Goal

One **map tab per schema**: an interactive ER diagram built from real
introspection. Table cards (header + up to 12 column rows, with a "+N more
columns…" truncation row) are joined by bezier FK edges anchored to the FK
column's row. Cards drag with **live edge re-routing**; edges are individually
**movable** (a draggable bend handle) and resettable; the canvas pans and zooms
**50–150 %** with a reset/relayout control. Unknown schemas get an
**auto-layout** (FK-depth layered, degrading to a grid). The diagram **exports**
to PNG/SVG. User-dragged positions, edge bends, and zoom **persist per
(connection, schema)** and survive restarts.

The diagram is rendered **SVG-native** (cards are `<g>`+`<rect>`+`<text>`, edges
are `<path>`, all inside one pan/zoom `<g transform>`), _not_ HTML `<div>`s over
an SVG layer as the prototype `schemamap.jsx` did. _Note: this is a deliberate
divergence so the export can serialise the live tree to a standalone `.svg` /
rasterise to PNG without `<foreignObject>` canvas-taint — see
`src/features/schema_map/components/SchemaMap.tsx` header comment and
`export.ts`._

## Dependencies — M3 introspection, M4 tabs

- **M3 introspection** — the diagram is built entirely from
  `useIntrospectionStore`: `loadTables(handleId, schema)` for the table list +
  `approxRowCount` (header chips), and `loadTableMeta(handleId, schema, table)`
  per table for `columns` (name/dataType/`pk`/`fk`) and `foreignKeys`
  (`columns`, `refTable`, `refColumns`). Types live in
  `src/shared/api/engine.ts` (`TableMeta`, `ColumnInfo`, `ForeignKeyInfo`).
  There is **no bulk-meta command**, so the map loads every table's meta in
  parallel (the introspection cache de-dupes and warms the sidebar/grid).
- **M4 tabs** — the `map` tab kind lives in the workspaces tab system:
  `src/features/workspaces/types.ts` (`{ id; kind: "map"; schema }`),
  `state.ts` `openMapTab(schema)` (focus-not-duplicate by `schema`),
  `components/TabBar.tsx` (`case "map"`), `WorkspaceContent.tsx`
  (`case "map": <SchemaMap workspace={workspace} schema={tab.schema} />`),
  `Sidebar.tsx` ("Show in schema map" → `openMapTab`), and `StatusBar.tsx`
  (treats `map` like `table`). The open-table button calls M4's
  `openTableTab(schema, table)`.

## Backend (Rust core)

_Note: the backend is intentionally thin. The graph (nodes + FK edges) is built
**in the renderer** from introspection it already has; the backend owns only
**layout persistence** and the **export-write** of bytes the renderer produced.
Layering, dependencies point left: `domain ← application ← (infrastructure | commands)`._

### Domain — graph model (nodes/tables, FK edges), saved layout

File: `src-tauri/src/features/schema_map/domain/mod.rs`. Pure value objects;
only outward dependency is `serde`. All `#[serde(rename_all = "camelCase")]` so
the wire shape matches the TS literals exactly.

- **`NodePosition { table: String, x: f64, y: f64 }`** — one card's absolute
  position in the diagram's own coordinate space (before zoom/pan). `table` is
  the per-schema-unique table name and is the key the renderer matches a card
  to.
- **`EdgeWaypoint { id: String, dx: f64, dy: f64 }`** — a user-dragged
  **relative** offset for one FK edge's midpoint. `id` opaquely identifies the
  edge; the renderer owns the scheme (`child.col1,col2->refTable`) and the
  backend **never parses it**. `dx/dy` are relative to the edge's computed
  midpoint so a bent edge keeps its bend when both cards move.
- **`MapLayout { positions: Vec<NodePosition>, edges: Vec<EdgeWaypoint>, zoom: Option<f64> }`**
  — the full saved layout for one (connection, schema). `positions`/`edges` are
  `Vec`s (clean JSON arrays, `#[serde(default)]` → empty when absent). `zoom` is
  `Option`, `skip_serializing_if = "Option::is_none"` — omitted from the wire
  until the user has zoomed; the renderer then falls back to its default.
  **Pan is intentionally NOT persisted** (cheap to recompute; persisting it
  reopens scrolled off-screen if the card set changed). `Default` derive yields
  the empty layout.
- **`ExportFormat` (`#[serde(rename_all = "lowercase")]` → `Png` | `Svg`)** and
  **`ExportPayload { path: String, format: ExportFormat, data: String }`** — what
  `diagram_export` writes: SVG `data` is the document text written verbatim; PNG
  `data` is **base64-encoded** bytes (≈1.33× over IPC vs ~10× for a JSON number
  array). `path` is the user's native-save-dialog choice (the dialog is the
  consent — no scope check).

### Ports / Application — build graph from introspection; persist/load positions per connection+schema

- **Port** — `src-tauri/src/features/schema_map/ports.rs`:
  `trait MapLayoutRepository: Send + Sync` with
  `get(&self, connection_id, schema) -> Result<Option<MapLayout>, AppError>`
  and `save(&self, connection_id, schema, &MapLayout) -> Result<(), AppError>`.
  Deliberately **sync** (a tiny local JSON file); async commands call it inline.
- **Use-cases** — `src-tauri/src/features/schema_map/application/mod.rs`: thin
  pass-throughs `get_map_layout` / `save_map_layout` over a
  `R: MapLayoutRepository + ?Sized` (so trait objects and test fakes both
  work). No graph-building here — the graph is the renderer's job.
- **Adapter** — `src-tauri/src/features/schema_map/infrastructure/mod.rs`:
  `JsonFileMapLayoutRepository { path, write_lock: Mutex<()> }`.
  - One pretty-printed JSON object at `<app_config_dir>/map_layouts.json`,
    a **flat map** keyed `"connectionId\0schema"` (NUL join — `KEY_SEP`; a NUL
    appears in neither a UUID connection id nor a schema name) → `MapLayout`.
  - **Corrupt-file = error, not silent reset** (user-data policy, like
    connections/saved*queries): missing file → empty map (`get` → `None`);
    unparseable file → `AppError::Serialization` naming the file, file left
    untouched. \_Note: this is the "no silent data loss" stance from MEMORY.*
  - **Atomic saves**: write `*.json.tmp`, then `fs::rename` over the target;
    `create_dir_all` parents first. `write_lock` serialises read-modify-write so
    concurrent async commands can't interleave; lock poison maps to a graceful
    `AppError::Io` ("restart the app").
  - **`write_export(&ExportPayload)`** — SVG → write UTF-8 text verbatim; PNG →
    base64-decode (`base64::engine::general_purpose::STANDARD`, dep `base64 = "0.22"`)
    then write bytes. Bad base64 → `AppError::Invalid` (no file written);
    IO failure → `AppError::Io` naming the path (DESIGN_SPEC §5).

_Note: the in-tree tests are the executable spec — `domain` (wire shape,
zoom-omitted, empty-round-trip, partial-deserialize), `application` (get-none,
save/get round-trip, per-(conn,schema) independence), `infrastructure`
(missing/corrupt file, atomic temp cleanup, SVG-verbatim, PNG base64 decode,
bad-path/bad-base64 errors)._

### Tauri commands

File: `src-tauri/src/features/schema_map/commands.rs`. All `async fn`;
deserialize → use-case → serialize, no logic. Managed state
`SchemaMapState { repository: Box<dyn MapLayoutRepository + Send + Sync> }`
constructed in the composition root (`src-tauri/src/lib.rs`:
`JsonFileMapLayoutRepository::new(config_dir.join("map_layouts.json"))`,
`app.manage(SchemaMapState::new(Box::new(...)))`, all three commands in
`invoke_handler`).

| command           | args                                                           | returns                                       | errors                                                                                                  |
| ----------------- | -------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `map_layout_get`  | `connection_id: String`, `schema: String`                      | `Option<MapLayout>` (`null` when never saved) | `AppError::Serialization` if the store file is corrupt; `AppError::Io` on read failure                  |
| `map_layout_save` | `connection_id: String`, `schema: String`, `layout: MapLayout` | `()`                                          | `AppError::Io` (write/rename, or lock poisoned); `AppError::Serialization` if existing store is corrupt |
| `diagram_export`  | `payload: ExportPayload` (`{ path, format, data }`)            | `()`                                          | `AppError::Invalid` (PNG base64 undecodable); `AppError::Io` (`"Could not write {path}: …"`)            |

## Frontend (React)

### State — schema-map store (positions cache) + per-component interaction state

_Note: interaction state (positions, zoom, pan, waypoints, drag, selection)
lives in the `SchemaMap` component via `useState`/`useRef`. The Zustand store is
deliberately minimal — a backend-first cache of saved layouts only._

- **`src/features/schema_map/state.ts`** — `useSchemaMapStore`
  (`create<SchemaMapState>`): `layouts: Record<string, MapLayout | null>` keyed
  by `cacheKey(connectionId, schema)` = `${connectionId} ${schema}`.
  - `load(connectionId, schema)` → backend `mapLayoutGet`, caches the result
    (including `null` = "never saved"). **Backend-first, never optimistic.** A
    real `AppError` (e.g. corrupt store) **rethrows** (don't cache a misleading
    `null`); a plain-browser-dev failure (no Tauri) caches `null` so the diagram
    still lays out from scratch.
  - `save(connectionId, schema, layout)` → backend `mapLayoutSave`, then patch
    the cache from what was saved. Real `AppError` bubbles; browser-dev failure
    is swallowed so dragging stays responsive in-memory.
  - `cached(connectionId, schema)` — read without hitting the backend.
- **Component interaction state** (`SchemaMap.tsx`): `metas`, `rowCounts`,
  `loadError`, `loading`, `reloadKey`; `positions: Record<string, {x,y}> | null`,
  `zoom` (default `1`), `pan {x,y}`, `waypoints: Record<string, {dx,dy}>`,
  `selectedEdge: string | null`, `exportMenuOpen`, `exporting`; `dragRef`
  (a `Drag` union of `card` | `edge` | `pan`), `svgRef`, `saveTimer`,
  `waypointsRef` (mirrors `waypoints` so a debounced save writes current bends).

### API — typed invoke wrappers

File: `src/features/schema_map/api.ts` (the slice's public contract alongside
`state.ts`; field names camelCase to match the Rust serde). Mirrors the Rust
wire types: `NodePosition`, `EdgeWaypoint`, `MapLayout` (`zoom?: number | null`
to tolerate both absent and explicit null), `ExportFormat = "png" | "svg"`.

- `mapLayoutGet(connectionId, schema): Promise<MapLayout | null>` →
  `invoke("map_layout_get", { connectionId, schema })`.
- `mapLayoutSave(connectionId, schema, layout): Promise<void>` →
  `invoke("map_layout_save", { connectionId, schema, layout })`.
- `diagramExport(path, format, data): Promise<void>` →
  `invoke("diagram_export", { payload: { path, format, data } })`.

### Components

All in `src/features/schema_map/components/SchemaMap.tsx` (+ `SchemaMap.css`).
`SchemaMap({ workspace, schema })` is the map-tab body; `connectionId =
workspace.saved.id` (the durable `SavedConnection` id — layouts follow the
connection, not the ephemeral `ws-<uuid>`).

- **`SchemaMap` (the MapTab)** — load flow on `[handleId, schema, …, reloadKey]`:
  `loadTables` → set `rowCounts` from `approxRowCount` → `Promise.all` of
  `loadTableMeta` per table. A table with no resolvable meta is **dropped** from
  the map; only a _total_ wipe-out (zero metas for a non-empty list) sets
  `loadError`. States: `loading` (hub icon + "Loading schema map for {schema}…"),
  `loadError` (error icon + `<code>` + Retry → bump `reloadKey`), else the
  toolbar + canvas. After metas resolve, a second effect calls
  `loadLayout(connectionId, schema)`: if saved `positions.length > 0`, restore
  them (**merge** — saved wins, tables added since the save fall back to
  auto-layout), restore `waypoints` from `layout.edges`, restore `zoom` (clamped)
  if a number; else `autoLayout(...)` and empty waypoints.
- **`Card`** — an SVG `<g transform="translate(x,y)">`:
  - body `<rect rx=11>` with `filter="url(#mapCardShadow)"`;
  - header (`HEAD_H`=36): `<rect>` `--bg2` background (rounded top, squared
    bottom via a second rect), hairline rule at `y=HEAD_H`, table icon
    (`ICON_TABLE`, accent, 14px), name (mono 600, 12px, `truncate(table, 18)`),
    right-aligned row-count chip (`formatCount` → `12.3k`/`1.2M`) when known, and
    the **open-in-new button** (own `<g role=button>`, `ICON_OPEN`, stops
    pointer-down propagation, `onClick={() => openTableTab(schema, table)}`,
    Enter/Space activatable). The header `<g>` is the **drag handle**
    (`onPointerDown` → `onCardPointerDown`).
  - **Column rows (12-col truncation)**: `shownColumns` = first `MAX_COLS`=12;
    each row (`ROW_H`=21) has a pk icon (`ICON_KEY`, accent) or fk icon
    (`ICON_LINK`, dim), the column name (mono 11px, `truncate(name, 16)`,
    brighter when fk), and the type (mono 9px, right-aligned,
    `truncate(dataType.toLowerCase(), 12)`). If `hiddenCount > 0`, a final
    **"+ {hiddenCount} more columns…"** italic row.
- **`Edge` (FK edge renderer)** — an SVG `<g class="map-edge">` per FK:
  - wide transparent **hit-area** `<path>` (stroke-width 14, `pointer-events:
stroke`) so the thin curve is clickable → selects the edge;
  - the visible **bezier** `<path class="map-edge-path">` (1.5px,
    accent@55% mixed toward border);
  - **source dot** `<circle r=3.5>` at the child FK column row edge, **target
    ring** `<circle r=5>` + inner dot at the ref table **header**;
  - a draggable **bend handle** `<circle r=5>` shown when the edge is `selected`
    or already `bent`: `onPointerDown` → `onHandlePointerDown` (drag offsets the
    waypoint), **double-click → `resetEdge`** (straighten just this edge,
    `aria-label="Drag to bend relationship; double-click to straighten"`).
- **Zoom controls (50–150 % + reset)** — toolbar: `zoom_out` IconBtn (disabled
  at `ZOOM_MIN`=0.5), `{Math.round(zoom*100)}%` readout (`aria-live=polite`),
  `zoom_in` IconBtn (disabled at `ZOOM_MAX`=1.5). Step `ZOOM_STEP`=0.1.
  `applyZoom` clamps via `clampZoom` (`round(z*10)/10`, clamped 0.5–1.5) and
  persists. `onWheel` zooms only with Ctrl/Cmd held (`preventDefault`). A
  **`fit_screen`** IconBtn = `resetView`: re-run `autoLayout`, `zoom=1`,
  `pan={0,0}`, **clear all waypoints** (full reset to initial state), persist.
- **Reset-curves control** — an `ink_eraser` IconBtn shown **only when at least
  one edge is bent** (`hasBentEdges`): `resetCurves` straightens every edge
  (clear all waypoints) but leaves card positions + zoom untouched, then
  persists.
- **Export** (`download` IconBtn → popover menu, PNG image / SVG vector,
  `role=menu`/`menuitem`): `runExport(format)` reads `readExportColors()`,
  `embeddedFontFaceCss()`, builds `buildExportSvg(cards, edges, colors, fontCss)`,
  computes `contentBounds(cards, 48)`, opens the native save dialog (lazily
  imported `@tauri-apps/plugin-dialog`; default name `${schema}-schema-map.${ext}`),
  then for PNG `rasterizeToPngBase64(svg, w, h, 2)` else the SVG text, and calls
  `diagramExport(path, format, data)`. Empty diagram → info toast "Nothing to
  export yet."; dialog unavailable (browser dev) → info toast "Exporting requires
  the ByteTable desktop app."; success → ok toast; failure → err toast
  (`appErrorMessage`). The `download` icon swaps to `hourglass_top` while
  `exporting`.

_Geometry & layout helpers (no React/DOM) live in
`src/features/schema_map/diagram.ts`; the four inline icon `<path>`s in
`icons.ts`; export/rasterise in `export.ts`; font embedding in `fonts.ts`._

### Styling — §3.8 cards / edges / zoom

File: `src/features/schema_map/components/SchemaMap.css`. Re-expresses the
prototype's `.map*` look for SVG primitives, using the theme tokens.

- **Toolbar** (`.map-toolbar`): hub icon (accent) + `.map-title` (mono 12.5px
  600 `{schema} · schema map`) + `.map-sub` ("N tables · M relationships",
  faint) + spacer + `.map-hint` ("drag tables to rearrange") + zoom controls +
  reset-curves (conditional) + reset + export popover.
- **Canvas** (`.map-canvas-wrap`): `overflow:auto`, **dot-grid** via
  `radial-gradient` 1px dots, `background-size`/`background-position` set inline
  from `22 * zoom` and `pan` so the grid **pans and zooms with the content**.
  `.map-svg` is absolute, `cursor:grab` (→`grabbing` on `:active`),
  `touch-action:none`. `.map-extent` is an invisible spacer sizing the scroll
  area from `contentExtent`.
- **Pan/zoom group** (`.map-eased`): `transition: transform 130ms ease`, applied
  only when **not** dragging (the component drops the class during a drag so
  moves are 1:1 with the pointer; §1.6 motion).
- **Edges**: `.map-edge-path` accent@55% mixed toward border, 1.5px;
  hover (via hit-area sibling) → accent@80% 2px; `.is-selected` → solid accent
  2.5px. `.map-edge-dot` accent fill, `.map-edge-ring` accent@25%-over-bg0 fill +
  accent stroke. `.map-edge-handle` `--bg1` fill + accent stroke,
  `cursor:grab`/`grabbing`, brightens on hover, fills accent when selected.
- **Cards**: `.map-card-box` `--bg1` fill, `--border` stroke; hover →
  accent@55% border. `.map-card-head-bg` `--bg2`; `.map-card-head` `cursor:grab`.
  `.map-card-name` `--text` mono 12px 600; `.map-card-count` faint mono 10px.
  Column rows: `.map-col-pk` accent, `.map-col-fk` dim; `.map-col-name` dim mono
  11px (→`--text` when `.is-fk`); `.map-col-type` faint mono 9px; `.map-col-more`
  faint italic mono 11px. The soft card shadow is the SVG `<filter
id="mapCardShadow">` `feDropShadow dy=6 stdDeviation=9 opacity 0.4` (serialises
  into the export).
- **Export popover**: `.map-export-menu` `--bg2` card, `--border`, radius 10,
  shadow; `.map-export-item` hover `--bg3`.

## Shared data contracts — TS + Rust types

| concept        | Rust (`domain/mod.rs`, camelCase wire)                                                                        | TS (`api.ts`)                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| node position  | `NodePosition { table: String, x: f64, y: f64 }`                                                              | `NodePosition { table: string; x: number; y: number }`                                  |
| edge waypoint  | `EdgeWaypoint { id: String, dx: f64, dy: f64 }`                                                               | `EdgeWaypoint { id: string; dx: number; dy: number }`                                   |
| saved layout   | `MapLayout { positions: Vec<NodePosition>, edges: Vec<EdgeWaypoint>, zoom: Option<f64> }` (zoom skip-if-none) | `MapLayout { positions: NodePosition[]; edges: EdgeWaypoint[]; zoom?: number \| null }` |
| export format  | `ExportFormat` (`png` \| `svg`, lowercase)                                                                    | `ExportFormat = "png" \| "svg"`                                                         |
| export payload | `ExportPayload { path: String, format: ExportFormat, data: String }`                                          | `diagramExport(path, format, data)` → `{ payload: { path, format, data } }`             |

**Renderer-only graph models** (not on the wire — built from `TableMeta`,
`src/features/schema_map/diagram.ts`):

- `CardModel { table, x, y, w, h, shownColumns, hiddenCount, rowCount }`.
- `EdgeModel { id, childTable, refTable, path, sx, sy, tx, ty, mx, my }` — `id`
  = `edgeId(childTable, fk.columns, refTable)` = `` `${child}.${cols.join(",")}->${refTable}` `` (**the stable scheme `EdgeWaypoint.id` keys on — do not change without migrating saved waypoints**).
- Constants: `CARD_W`=224, `HEAD_H`=36, `ROW_H`=21, `MAX_COLS`=12,
  `CARD_PAD_B`=8, `GRID`=22.

## Behavior & edge cases

- **Drag persists across restarts.** Card drag updates only that card's position
  (transform-level; no relayout). Saves are **debounced** (`SAVE_DEBOUNCE`=400 ms)
  and fire on **drag END** (`endDrag`), never per `pointermove` — one
  `mapLayoutSave` carries `positions` + `edges` + `zoom` together
  (`waypointsRef` mirrors live bends). On next open, `loadLayout` restores them.
  Pan is **not** saved (recomputed). `connectionId = workspace.saved.id`, so a
  layout follows the connection across workspaces/restarts.
- **Auto-layout for unknown schemas** (`autoLayout`, deterministic so reset is
  stable): compute each table's **FK depth** (roots that reference no in-schema
  table = depth 0; a referencing table = 1 + max depth of its in-schema refs;
  self-refs ignored, cycles broken by an on-path guard → treated as root). `x` by
  depth column (`COL_GAP`=96), `y` by stacked index (`ROW_GAP`=40, `MARGIN`=40);
  an over-tall column wraps at `MAX_PER_COL`=8 into adjacent mini-columns;
  columns sorted alphabetically. **No in-schema FKs (maxDepth 0) → a tidy grid**
  (`ceil(sqrt(n))` per row). _This reads well for an e-commerce shape
  (users/products left, orders middle, order_items/payments right)._
- **Edge re-routing on drag.** `edges` are recomputed from `positions` +
  `waypoints` each render (`buildEdges` → `edgeGeometry`), so moving a card
  re-routes its edges live. `edgeGeometry` picks card sides by relative position;
  source anchor sits at the FK column's row (`colIndex` = index of `fk.columns[0]`
  in `meta.columns`, clamped to `0..MAX_COLS-1`), target at the ref header. With
  no waypoint it emits the **original single cubic** (byte-identical to the
  un-bent baseline); with a waypoint it emits **two cubics** meeting at
  `(mx,my) = naturalMid + (dx,dy)` (relative offset → the bend tracks the cards).
- **Movable edges + reset.** Drag a handle → set `waypoints[id]`; double-click
  the handle → `resetEdge(id)` (delete that waypoint). `resetCurves` clears all
  waypoints (shown only when `hasBentEdges`); `resetView` re-layouts + clears
  waypoints + zoom 1 + pan 0,0. Each persists.
- **40-table schema stays usable** — pan (drag empty canvas) + zoom (50–150 %,
  controls or Ctrl/Cmd+wheel) + the scroll spacer (`contentExtent`) keep large
  diagrams navigable.
- **Schema drift** — a table added since the last save falls back to auto-layout
  (merge); a table that lost its meta is dropped (not a hard error).
- **Browser dev (no Tauri)** — `load`/`save` swallow the missing-shell failure
  (in-memory only); export dialog/`diagram_export` unavailable → info toast.
- **Corrupt layout store** — surfaces as a real `AppError` from `load` (the
  backend never silently resets user data).

## Acceptance criteria

1. Opening a map tab for an **e-commerce-shaped** schema renders cards + FK
   edges **readable by default** via auto-layout (FK-depth layered; no overlaps
   in the common case).
2. **Drag persists across restarts** — drag cards/bend an edge/zoom, reopen the
   app → the same arrangement (saved per connection+schema in
   `<config>/map_layouts.json`).
3. A **40-table** schema stays usable: pan + zoom (clamped 50–150 %, reset to
   100 %/relayout) navigate it without jank.
4. Cards **truncate at 12 columns** with a "+N more columns…" row; the
   open-in-new button opens/focuses the table tab (`openTableTab`).
5. FK edges are **beziers anchored to the FK column row** (source dot) and the
   ref **header** (target ring); dragging a card **re-routes them live**.
6. Edges are **individually movable** (bend handle) and **resettable**
   (double-click handle straightens one; reset-curves straightens all; reset-view
   relayouts + straightens all).
7. **Export** writes a standalone **SVG** (verbatim) or **PNG** (base64 →
   decoded) to a user-chosen path; the file is self-contained (inline icons,
   embedded fonts, baked colours, no `<foreignObject>`).
8. Backend errors surface as §5-style messages; a **corrupt** `map_layouts.json`
   is an error (not a silent reset); a missing file is first-launch-OK.

## Pixel / UX checklist

- Card **224 px** wide; header **36 px** (`--bg2`, grab cursor, accent table
  icon, name mono 600, right-aligned row-count chip, open-in-new button);
  column rows **21 px**; dot-grid **22 px**; card radius **11 px**, soft layered
  drop shadow (`feDropShadow dy=6 stdDeviation=9 @0.4`); accent border on hover.
- Column rows: pk/fk icon + name (mono 11 px, brighter when fk) + type (mono
  9 px, right-aligned, lowercased, truncated at 12 chars); name truncated at 16,
  table name at 18 chars (`…`).
- FK edges: **1.5 px** bezier, accent**@55%** mixed toward border; **dot at the
  source FK column**, **ring at the target header**; hover → accent@80% 2 px;
  selected → solid accent 2.5 px; bend handle `--bg1`+accent.
- Zoom **50–150 %**, step 10 %, `{N}%` readout, reset to 100 % via `fit_screen`
  (also relayout + straighten); zoom-out/in disabled at the clamps.
- Pan/zoom transform eases **130 ms** except during a drag (1:1 with pointer).
- Toolbar copy exact: `{schema} · schema map` · `N tables · M relationships` ·
  `drag tables to rearrange`; correct singular/plural (`table`/`relationship`).
- Toast copy: "Nothing to export yet." (empty), "Exporting requires the
  ByteTable desktop app." (no shell), `Exported schema map to {file}` (ok).
