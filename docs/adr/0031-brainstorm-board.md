# ADR-0031 — Brainstorm board: renderer-only canvas that diffs sketches against the live schema

- **Status:** Accepted (retroactive — documented 2026-11-26 from the shipped implementation)
- **Date:** 2026-10-11 (first commit that shipped the feature: `34cf867 feat: brainstorm board added`)
- **Area:** Schema
- **Related:** ADR-0005, ADR-0007, ADR-0018, ADR-0028, ADR-0030, ADR-0036, ADR-0048

## Context

Before a schema exists, users sketch domain ideas, data flows, and draft tables.
The goal was a free-form board in a SQL workspace with three layers (Domain, Flow,
Schema). Sketched entities can be promoted to draft tables, and the board can diff those
tables against the attached database and produce DDL. Firm rules apply: the
board never writes to the database, column inference is a reviewable rule-based guess
rather than AI, and a board belongs to one connection and schema. (At the time
ByteTable had no AI assistant. One shipped later, ADR-0048, but the board does not use
it.)

## Decision

- **Renderer-only slice.** `src/features/brainstorm_board/` has no Rust feature folder.
  The only backend call it added is `export_save_bytes` in the export slice
  (`src-tauri/src/features/export/commands.rs`; wrapper in
  `src/features/brainstorm_board/api.ts`). That command writes base64 PNG bytes to a path
  the user chose in the save dialog. SVG export uses the existing `exportSave`.
- **Pure document model.**
  - `model.ts` defines the doc (objects map + `order` z-order, edges, groups), the object
    types (sticky, text, frame, sketch, snippet, ink, flow, table), and `LAYERS`.
  - `doc.ts` holds pure mutations, so the undo stack in `hooks/useBoardDoc.ts` is just a
    list of snapshots.
  - `removeObjects` is the only way to delete. It also drops edges, group membership,
    empty groups, and the sketch's `promotedTo` back-link.
  - FK relations are not stored as edges. They are worked out from `column.fk` on every
    render, so a rename or delete cannot leave a line pointing at nothing.
- **Persistence in `localStorage`, per connection + schema.** `persist.ts` stores the doc
  under `bytetable.board.v2.<connectionId>.<schema>`, debounced `SAVE_DEBOUNCE_MS = 300`.
  - Loading tolerates bad data: it checks the structural fields and falls back to an
    *empty* board, never the example.
  - A version bump replaces older stores.
  - A new board starts empty. The menu-service example in `seed.ts` loads only when asked.
  - View state that must survive the tab unmounting (pan, zoom, selection, isolated
    layer) sits in a plain module map in `viewState.ts`. It is kept out of
    `workspace.ui` because of the churn rule for high-frequency state.
- **Rule-based promotion.** `infer.ts` and `naming.ts` turn sketch lines into typed columns
  by priority rules:
  - `id` becomes a PK; `x -> y` and `x_id` become FKs.
  - Names like `is …`, price, `*_at`, and json map to boolean, `numeric(10,2)`,
    `timestamptz`, and `jsonb`.
  - Text in parentheses is ignored.

  The inspector shows exactly what `promoteSketch` will return, and the user reviews it.
- **Live diff → DDL text only.**
  - `live.ts` narrows the introspected `TableMeta` (from `hooks/useBoardLive.ts`, through
    the introspection cache, ADR-0028) to the board's column shape and lowercases types.
  - `diff.ts` matches tables by name. A card missing from the database becomes `CREATE`,
    and a card that differs becomes `ALTER`. CREATEs are emitted in FK order.
  - The source can be `sample`, `workspace`, or `none`.
  - `BoardDdlSheet.tsx` shows the script, copies it, or opens it in a SQL tab
    (ADR-0018). Nothing is executed.
- **Rendering and export.** `BoardCanvas.tsx` is an HTML world div with a
  `translate/scale` transform and one pointer state machine. Pan and zoom go through the
  shared `useCanvasNavigation` and `Minimap` (`841c051`, `8441886`, 2026-11-11), also
  used by the schema map. `exportImage.ts` exports the whole board, one layer, the
  selection, or one group. It uses `html-to-image` (`package.json`), loaded on first use,
  and filters out `.bb-noexport` chrome and `.msym` ligature icons.
- **Workspace integration.** Tab kind `{ kind: "board", schema }`
  (`src/features/workspaces/types.ts`), opened via `openBoardTab` from the sidebar button
  and the `brainstorm-board` command (`WorkspaceShell.tsx`). Keyboard shortcuts apply only
  while the tab is active and no field has focus.

## Alternatives considered

- **Store boards in a backend JSON file like schema-map layouts (ADR-0030).** Deferred
  (recorded in `persist.ts`): localStorage is "the right size
  for one board per schema". The trade-off is that boards do not travel with connection
  bundles (ADR-0009) and are lost if webview storage is cleared (inferred consequence).
- **Re-emit the board as SVG like the schema map.** Rejected (recorded in
  `exportImage.ts`): the board is HTML, and a second renderer would have to be kept in
  step with the first.
- **Rasterise PNG in Rust with resvg.** Not needed: `html-to-image` already returns pixels,
  so the backend only writes bytes (recorded in `api.ts`).
- **AI-driven column inference.** Rejected in favour of rules the user can
  predict and review.
- **Execute the generated DDL directly.** Rejected: "The board never writes to the
  database."

## Consequences

- **Positive:** No new backend surface beyond one byte writer. The board cannot change a
  database, and its pure modules are unit-tested (`infer`, `diff`, `doc`, `geometry`,
  `indent`, `json`, `seed` `*.test.ts`).
- **Negative / trade-offs:**
  - There is one board per connection + schema, kept only in this machine's webview
    storage.
  - The DDL uses Postgres types (`timestamptz`, `jsonb` in `TYPES`) and unquoted names,
    whatever the engine. Inferred from `model.ts` and `diff.ts`: there is no dialect
    switch.
  - Diffing by name has no notion of renames.
- **Follow-ups (deferred):** multiple boards per workspace, marquee selection
  and snapping, group collapse, reverse sync from live tables, engine-specific Schema
  layers for Mongo, Cassandra, Dynamo, and Neo4j, and Markdown/PDF export.
