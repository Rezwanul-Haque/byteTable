# ADR-0030 — Schema map (ER diagram) with persisted layout, groups, and visual editing

- **Status:** Accepted (retroactive — documented 2026-11-26 from the shipped implementation)
- **Date:** 2026-06-13 (first commit that shipped the feature: `486779c feat(schema_map): layout persistence + diagram export-write (M9 T1)`)
- **Area:** Schema
- **Related:** ADR-0002, ADR-0006, ADR-0018, ADR-0028, ADR-0029, ADR-0031, `docs/M9-schema-map.md`, `docs/superpowers/specs/2026-07-17-schema-map-cardinality-design.md`, `docs/superpowers/specs/2026-07-16-schema-map-remove-link-design.md`

## Context

Users want to see a schema's tables and FK relationships as a diagram, arrange it by
hand, and have it reopen as they left it. The diagram must export to PNG or SVG on all
three platforms. Later the map also became a visual DDL editor (add tables and columns,
draw FK links) and an annotation surface (groups, free arrows, cardinality). A hard
platform fact shaped the export: WebKitGTK on Linux cannot draw an SVG onto a `<canvas>`
and read it back as PNG (recorded in `src-tauri/src/features/schema_map/domain/mod.rs`
and the `resvg` note in `src-tauri/Cargo.toml`).

## Decision

- **SVG-native diagram.** `src/features/schema_map/components/SchemaMap.tsx` renders cards
  and FK edges in one `<svg>` with a pan/zoom group. The pure geometry is in
  `src/features/schema_map/diagram.ts`. Inputs come from the introspection cache
  (ADR-0028); the slice keeps no schema copy of its own. Pan and zoom go through the shared
  `src/shared/hooks/useCanvasNavigation.ts`, and the minimap is the shared
  `src/shared/ui/Minimap.tsx` (`8441886`, `841c051`, 2026-11-11), both also used by the
  brainstorm board (ADR-0031).
- **Layout persistence in Rust.** The `features/schema_map` slice (domain / application /
  ports / infrastructure / commands) stores a `MapLayout` per `connectionId \0 schema`:
  - Fields: `positions`, `edges` (waypoint `dx/dy`), `cardinalities`, `groups`,
    `group_links`, `zoom`.
  - Storage: `MapLayoutRepository` is a sync port. The infrastructure writes
    `<app_config_dir>/map_layouts.json` atomically via a `.json.tmp` file.
  - Key: the *saved connection* id, not the ephemeral workspace id, so layouts survive
    restarts.
  - A corrupt file is an error, not a silent reset, because layouts are user data.
  - Pan is not persisted on purpose (comment on `MapLayout`).
  - New fields are optional and serde-defaulted, so older layout files still load.
  - Commands: `map_layout_get`, `map_layout_save`. The renderer cache is
    `src/features/schema_map/state.ts`, which writes to the backend first and then patches
    its own copy.
- **Export rasterised in Rust.** `src/features/schema_map/export.ts` builds a standalone
  SVG: literal colours, embedded base64 fonts (`fonts.ts`), icons as paths
  (`icons.ts`), and no `<foreignObject>`. The `diagram_export` command writes SVG as-is
  and turns PNG into an image with `render::svg_to_png` (`resvg`, 2× scale), at a path
  the user picked in the native save dialog. An export can be limited to one group
  (`scopeToGroup`; group exports leave out the arrows). `src/features/schema_map/cardMapExport.ts`
  uses the same writer for the HTML-card maps of Mongo, DynamoDB, and Cassandra.
- **Cardinality** (2026-07-17 spec). The diagram works out crow's-foot ends from the
  schema. The parent end is always one. The child end is many unless the FK columns are
  the PK or covered by a UNIQUE index (then it is 1:1). `detectJunctions` finds M:N
  junction tables and draws a dashed derived edge. The spec's "Phase B" manual override
  (`[Auto] [1:1] [1:N] [M:N]`) shipped and is saved as `EdgeCardinality { id, kind }`.
- **Groups and arrows** (`ffae946` 2026-08-24, `c3097e8` 2026-10-10).
  - `groups.ts`: a group stores only its frame `rect` and colour. Its members are the
    cards whose centre sits inside the frame, so no membership list can drift.
    `tables` is a legacy seed field.
  - `groupLinks.ts`: user-drawn arrows connect group or table *identities*. Only the bend
    offset is stored, relative to the arrow's midpoint. The persisted name stays
    `groupLinks` so saved layouts are not orphaned.
  - The backend stores both without reading them.
- **Visual edit mode** (`cf4e49f` 2026-06-24; `81dee1d` 2026-07-17).
  - Who can edit: only engines in `EDITABLE_ENGINES = {sqlite, mysql, postgres}`, and not
    on read-only workspaces.
  - `editModel.ts` (pure) builds an `EditSchema` from `TableMeta`s and writes
    engine-aware DDL strings (`ddlFor(engine)`).
  - `hooks/useSchemaEditor.ts` keeps `pending: StagedOp[]` (`{ sql, apply, tag }`) and a
    snapshot taken before the first edit.
  - `unstage(index)` rebuilds the model by replaying the remaining ops onto the snapshot.
    Removing a link drawn in the same session un-stages its `ADD CONSTRAINT` instead of
    staging a `DROP` (remove-link spec).
  - Commit: `SchemaCommitModal.tsx` flags destructive statements. On production it asks
    for the typed phrase `apply to <schema>`. It then joins the SQL and runs it through
    `executeScriptText`, invalidates the introspection cache, and re-reads the schema.

## Alternatives considered

- **Rasterise PNG in the webview canvas.** This was the first approach. It was replaced
  because it fails on Linux WebKitGTK (recorded).
- **Serialise the live DOM for export.** Rejected (recorded in `export.ts`): the live DOM
  carries view transforms, CSS variables that do not resolve outside the app, and a
  webfont dependency.
- **Store group membership lists.** Tried first and dropped (recorded in `groups.ts`): a
  frame derived from a member list cannot be resized.
- **Key layouts by workspace id.** Rejected: workspace ids are per session.
- **Stage edits as `AlterOp`s through `alter_apply` (ADR-0029).** Not used. The map edits
  many tables, including creating and dropping them, while `AlterOp` covers one table.
  That this is the reason is inferred.

## Consequences

- **Positive:** Layouts survive restarts and are per connection. Export looks the same on
  every OS. Groups and arrows add domain notes the schema itself cannot express. The
  NoSQL maps reuse the same export path.
- **Negative / trade-offs:** `SchemaMap.tsx` is about 2,900 lines. Edit-mode DDL is
  generated in TypeScript, apart from the Rust adapters, so dialect rules exist twice.
  The commit is one transaction only where the engine's DDL is transactional; MySQL
  auto-commits (caveat in `editModel.ts`). On SQLite, in-place retype and PK changes
  fail at commit.
- **Follow-ups:** Edit mode for SQL Server and ClickHouse. Optionality markers (a
  nullable FK shown as "zero-or") are a non-goal in the cardinality spec.
