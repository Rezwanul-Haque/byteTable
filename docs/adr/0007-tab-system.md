# ADR-0007 — A closed `Tab` union per workspace, with per-tab staged state

- **Status:** Accepted (retroactive — documented 2026-11-26 from the shipped implementation)
- **Date:** 2026-06-13 (first commit that shipped the feature)
- **Area:** Data browsing
- **Related:** ADR-0005, ADR-0006, ADR-0010, ADR-0012, ADR-0018, ADR-0029, `docs/M4-tab-system-data-grid.md`

## Context

Each workspace needs several independent views open at once: table grids,
SQL editors, the schema map, and later notebooks, lineage, processes,
privileges, diff, object viewers and more. Each view keeps its own state across
tab switches and workspace switches. Only the active tab is mounted
(`WorkspaceContent`), so state held in a component is lost when the user leaves
the tab. Before August 2026 this silently discarded typed-but-unsaved grid edits
on a tab switch (`docs/M4-tab-system-data-grid.md`). The tab system shipped with
M4 (`e104b43`, 2026-06-13). "Open in a second tab" (`7795bea`) and per-tab
staged edits with close-confirm (`a73e6a4`) followed on 2026-08-12.

## Decision

- **A closed discriminated union.** `Tab` in `src/features/workspaces/types.ts` is
  discriminated on `kind`: `table` (with `mode: "data" | "structure"`), `sql`
  (carrying `SqlTabState` inline), `map`, `board`, `notebook`, `history`,
  `lineage`, `processes`, `privileges`, `diff`, `object`, `objexplorer`,
  `tableoverview`. The content router switches over it exhaustively. A tab
  carries only its identity plus state that must outlive the unmount (for
  example the lineage `trail`, or the `tableoverview` `view`).
- **Tabs belong to the workspace.** `WorkspaceUiState.tabs` / `activeTabId` live
  on each `Workspace.ui`. Every tab action in `useWorkspacesStore` goes through
  `patchWorkspaceUi` on the active workspace, so switching workspaces keeps
  each workspace's strip as it was. Tab ids are `tab-<kind>-<uuid>`.
- **Per-tab side state is keyed by tab id on `ui`.** `filters`, `tableViews` (sort,
  pending sort, hidden columns), `structureEdits` (ALTER op batch, ADR-0029) and
  `gridEdits` (`TabGridEdits`: staged row edits and new rows, ADR-0012) are all
  sparse, and `closeTab` prunes them. High-frequency or result state (row
  counts, timing, `closeRequest`) lives in the separate ephemeral `tabMeta`
  store.
- **Focus-or-open by default, and a second copy on request.**
  `openTableTab(schema, table, mode, { newTab })` focuses an existing tab for
  the same table. The sidebar's "Open in new tab" (also ⌘-click and
  middle-click) passes `{ newTab: true }`. `findTableTab` prefers the *active*
  copy, so actions that rewrite the filter, such as the FK hop, land on the
  copy on screen. `tabLabels.ts` numbers duplicate copies in the strip.
- **Unsaved tabs.** `unsavedTabIds(ui)` is the single definition of a dirty tab:
  one with staged grid rows or a pending structure batch. SQL tabs never count,
  because their buffer is persisted. `TabBar` marks dirty tabs with
  `.tab.unsaved`. Every close entry point (×, Delete, middle-click, context
  menu, ⌘W) parks ids on `tabMeta.closeRequest`. One `UnsavedTabsModal`
  (`intent="close"`) then lists each dirty tab with `unsavedSummary` ("2 edited
  rows, 1 new row"). A batch close asks once: confirm closes all of it, cancel
  closes none. The same modal with `intent="discard"` backs the strip's
  discard-all button.
- **Persistence:** `session.ts` `forStorage` writes tabs to `localStorage` but
  drops SQL `runs`, `pendingSnippet`, structure drafts and `gridEdits`. Staged
  edits never outlive the app session.

## Alternatives considered

- **Keep every tab mounted (hide inactive).** Not used. Inferred: grids and
  CodeMirror instances are heavy, and mounting only the active tab keeps memory
  flat. The cost is that state must be lifted onto `ui`, which this ADR
  formalises.
- **Hold staged edits in component state.** This was the original behaviour.
  It lost data on a tab switch and was replaced by `gridEdits` (`a73e6a4`).
- **Persist staged edits across restarts.** Rejected. Per `TabGridEdits`, "committing
  values typed against a previous session's rows would be a footgun".
- **Always dedupe table tabs.** This was the M4 behaviour (spec §3.4). It was
  relaxed with an explicit opt-out because users wanted the same table side
  by side with different filters (inferred from the feature name).
- **One confirm per dirty tab on a batch close.** Rejected. The modal header
  calls it turning "one gesture into a quiz".

## Consequences

- **Positive:** adding a tab kind is a union arm, a store opener and a router case.
  The type checker flags any switch that misses the new kind. Workspace
  switches cost nothing. Unsaved work is visible and confirmed in one
  place.
- **Negative / trade-offs:** `workspaces/state.ts` carries every tab kind's
  openers and setters, which makes it the largest store. Per-tab maps on `ui`
  must be pruned by hand in `closeTab`. Session restore drops unknown kinds
  (`KNOWN_KINDS`), so a newer build's tabs disappear when an older build opens
  the session.
- **Follow-ups:** notebooks keep a separate unsaved guard
  (`UnsavedNotebooksModal`, `guardWorkspaceClose`) and are not part of
  `unsavedTabIds`.
