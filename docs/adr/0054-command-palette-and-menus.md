# ADR-0054 — In-window app menus, a `bt:cmd` bus, the command palette and shared context menus

- **Status:** Accepted (retroactive — documented 2026-11-26 from the shipped implementation)
- **Date:** 2026-06-13 (`e104b43 feat(workspaces): tab system, status bar, command palette (M4 Task 2)`; title-bar app menu `e19c134`, 2026-07-08; full menu set in the palette `25e4578`, 2026-10-26)
- **Area:** App shell
- **Related:** ADR-0005, ADR-0007, ADR-0041, ADR-0048, ADR-0050, ADR-0051, ADR-0053

## Context

The main window is `decorations: false` (`src-tauri/tauri.conf.json`), and ByteTable draws its own
title bar. Menu items such as Run, Format, Explain and New notebook act on whichever workspace or
query tab is active. Those surfaces differ by engine and mount and unmount as tabs change. The
menu should not import them, and it should not show an item that would do nothing. Keyboard users
also want one searchable entry point, and right-click menus recur across tab strips, connection
cards, grid rows and sidebars.

## Decision

- **No native application menu.** Rust builds only the tray menu (`build_tray_menu` in
  `src-tauri/src/lib.rs`, ADR-0053). `src/shared/ui/TitleBar.tsx` says so: "Tauri has no native
  menu built from buildMenus, so the app menu is always in-window — on macOS too, overlaid in the
  inset title area." `TitleMenuBar.tsx` renders it.
- **Menus as a pure model.** `src/shared/ui/titlebarMenus.ts::buildMenus(ctx)` returns File, Edit,
  View, Query and Help with their items, order and shortcut hints. Every item uses one of three
  dispatch paths:
  1. `TitleBarCtx` callbacks owned by `App.tsx`: new connection, close workspace, check updates,
     about, shortcuts, zoom, settings, quit, open file.
  2. `emitCmd(id)` onto the `bt:cmd` bus.
  3. `execEdit`, which targets the last-focused CodeMirror editor or falls back to `document.execCommand`.
  An item with nothing behind it is disabled, driven by `MenuCtx` flags such as `hasWs`, `isSql`,
  `hasPalette` and `hasProcesses`, never by faking a toast. Labels come from `t()` at build time,
  and the title bar re-runs `buildMenus` on a locale change (ADR-0050).
- **The `bt:cmd` bus** (`src/shared/ui/btCmd.ts`). `emitCmd(id)` dispatches a `CustomEvent` on
  `window`. `useBtCmd(id, handler)` claims it for as long as the owning component is mounted, and
  keeps the handler in a ref so callers need not memoize. `BtCmdId` is a closed union of about 30
  ids (`run`, `format`, `explain`, `debug`, `compare`, `toggle-terminal`, `new-notebook`,
  `schedules`, …). App-level modals use `ctx.*` instead. The exception is `new-connection`: App
  claims it on the bus so the deeply nested palette can reach it.
- **Command palette.** There is one per palette-owning workspace:
  - SQL: `src/features/workspaces/components/CommandPalette.tsx`. It lists tables in the current
    schema with row hints, schema switches, and then the menu commands in menu order (File, View,
    Query). Those include new connection, new SQL tab, brainstorm board, schema map, processes,
    privileges, schema diff, saved queries, snippets, value search, masking and assistant entries.
    Saved queries come last. Commands reuse `menu.*` label keys and reach drawers through
    `emitCmd`. Fixed ids are `cmd-` prefixed so they cannot collide with user-named tables
    (comment in `25e4578`). Filtering is a case-insensitive substring match on label and hint.
  - Redis: `src/features/browse/redis/components/RedisCommandPalette.tsx`. It lists a bounded SCAN
    sample of up to 200 keys, plus Redis commands.
  - Openers: ⌘/Ctrl+K toggles the palette (`WorkspaceShell.tsx`, `RedisWorkspace.tsx`). A
    double-tap on Shift also opens it, through `src/shared/hooks/useDoubleShift.ts`. That hook is
    a pure state machine, `trackShiftTaps`, plus a hook wrapper. It counts clean key releases
    within 400 ms and ignores Shift used as a modifier. It only opens: it is disabled while the
    palette is up, so typing in the palette's search field cannot close it. It is pure so it can be
    tested without a DOM (no renderer DOM tests exist).
- **Context menus.** `src/shared/hooks/useContextMenu.tsx` is the generic hook: items are built from
  the right-clicked subject, it supports one level of flyout `children` and `separate` rules, and
  it renders through a portal. `src/shared/hooks/useTabMenu.tsx` is the tab-strip menu (Close,
  Close others, Close to the right/left, optional Close all, extra `TabMenuAction`s). It is shared
  by the SQL, DynamoDB, MongoDB and Redis tab strips and by the terminal panel (ADR-0051). Both use
  `TabMenu.css`. In production builds `src/main.tsx` suppresses the webview's native context menu
  outside editable fields.

## Alternatives considered

- **A native Tauri menu bar.** Not used. The code does not record why. Inferred: the custom title
  bar is drawn in the renderer on every OS, and an in-window menu can be enabled, disabled and
  localized from renderer state without IPC.
- **Generate the palette from `buildMenus`.** Not done. The palette builds its own `Command[]`
  following the menu order, so that "the two surfaces are learnable as one". Keeping them in step
  is manual.
- **Build `useTabMenu` on `useContextMenu`.** Rejected for now in `useContextMenu.tsx`: the tab menu
  "hard-codes close-tab semantics across five tab strips". It is flagged as the obvious candidate
  if it ever needs changing.
- **Direct imports or store calls from the menu into surfaces.** Rejected in `btCmd.ts`. The bus
  keeps the title bar decoupled from engine surfaces (ADR-0002).

## Consequences

- **Positive:** The menus behave the same on all three OSes and are fully localized. Engine
  surfaces opt into commands without the title bar knowing them. Everything in the menus is one
  ⌘K or double-Shift away in SQL workspaces.
- **Negative / trade-offs:** There is no OS-level menu bar on macOS, so system services and
  menu-bar accessibility affordances are missing. An emit with no listener does nothing, and
  enablement depends on `MenuCtx` predicting correctly which surface is mounted. The palette's
  command list and `buildMenus` can drift apart.
- **Follow-ups:** Only the SQL and Redis workspaces have a palette. DynamoDB, MongoDB, Cassandra
  and Typesense have none, and `MenuCtx.hasPalette` greys the item there. The header comment of
  `CommandPalette.tsx` still describes the original "MINIMAL" scope.
