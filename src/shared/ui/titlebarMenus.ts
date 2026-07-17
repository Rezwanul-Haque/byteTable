// buildMenus — the app menu model for the window title bar (spec §2).
//
// A pure function of the current context: it returns the File/Edit/View/Query/
// Help menus with their exact items, order, and shortcut hints. Every item is
// either a separator ("—") or a command that does REAL work through one of
// three dispatch paths, or is visibly disabled when it has no backing (we never
// fake a toast):
//
//  1. App-level `ctx.*` callbacks (New Connection, Close Workspace, Check for
//     Updates, About, Keyboard Shortcuts, Zoom) — App.tsx owns that state.
//  2. `emitCmd(id)` onto the bt:cmd bus — claimed by the active workspace /
//     query tab surface (see btCmd.ts). Gated on that surface being present.
//  3. `execEdit(cmd)` → document.execCommand against whatever is focused,
//     failing silently if nothing is.

import { emitCmd } from "./btCmd";

/** App-level handlers the title bar dispatches to (App.tsx owns the state). */
export interface TitleBarCtx {
  onNewConnection: () => void;
  onCloseWorkspace: () => void;
  onCheckUpdates: () => void;
  onAbout: () => void;
  onShortcuts: () => void;
  onZoom: (dir: "in" | "out" | "reset") => void;
  /** Open the Settings modal (same as the rail gear / ⌘,). */
  onSettings: () => void;
  /** Quit the whole app (after a confirm). */
  onQuit: () => void;
}

/** Per-render enablement inputs, derived from the active workspace + zoom. */
export interface MenuCtx {
  /** A workspace is open (not the connect screen). */
  hasWs: boolean;
  /** The active workspace is a relational (SQL) one. */
  isSql: boolean;
  /** The active workspace has a command palette (SQL or Redis/kv). */
  hasPalette: boolean;
  /** The app is zoomed away from 100% (font-size setting != base). */
  zoomChanged: boolean;
  ctx: TitleBarCtx;
}

export type MenuItem =
  | "—"
  | {
      id: string;
      label: string;
      /** Shown as a right-aligned keycap when enabled, or a tooltip when not. */
      hint?: string;
      enabled: boolean;
      run?: () => void;
    };

export interface Menu {
  label: string;
  items: MenuItem[];
}

/** Standard editing commands against the focused element; silent no-op if none. */
export function execEdit(cmd: "undo" | "redo" | "cut" | "copy" | "paste"): void {
  // execCommand remains the only synchronous hook into the browser's native
  // undo/clipboard stack for whatever element has focus.
  document.execCommand(cmd);
}

const IMPORT_EXPORT_HINT = "via a table's ⋯ menu";

export function buildMenus(m: MenuCtx): Menu[] {
  const { hasWs, isSql, hasPalette, zoomChanged, ctx } = m;

  return [
    {
      label: "File",
      items: [
        { id: "new-connection", label: "New Connection…", enabled: true, run: ctx.onNewConnection },
        {
          id: "new-query",
          label: "New Query Tab",
          hint: "⌘T",
          enabled: isSql,
          run: () => emitCmd("new-query"),
        },
        {
          id: "open-sql-file",
          label: "Open .sql File…",
          enabled: isSql,
          run: () => emitCmd("open-sql-file"),
        },
        "—",
        // Import/Export live on a table's ⋯ context menu, not the app menu —
        // permanently disabled here with a hint pointing at their real home.
        { id: "import", label: "Import Data…", hint: IMPORT_EXPORT_HINT, enabled: false },
        { id: "export", label: "Export Data…", hint: IMPORT_EXPORT_HINT, enabled: false },
        "—",
        {
          id: "close-workspace",
          label: "Close Workspace",
          enabled: hasWs,
          run: ctx.onCloseWorkspace,
        },
        "—",
        { id: "settings", label: "Settings…", hint: "⌘,", enabled: true, run: ctx.onSettings },
        { id: "quit", label: "Close ByteTable", enabled: true, run: ctx.onQuit },
      ],
    },
    {
      label: "Edit",
      items: [
        { id: "undo", label: "Undo", enabled: true, run: () => execEdit("undo") },
        { id: "redo", label: "Redo", enabled: true, run: () => execEdit("redo") },
        "—",
        { id: "cut", label: "Cut", enabled: true, run: () => execEdit("cut") },
        { id: "copy", label: "Copy", enabled: true, run: () => execEdit("copy") },
        { id: "paste", label: "Paste", enabled: true, run: () => execEdit("paste") },
      ],
    },
    {
      label: "View",
      items: [
        {
          id: "palette",
          label: "Command Palette…",
          hint: "⌘K",
          enabled: hasPalette,
          run: () => emitCmd("palette"),
        },
        {
          id: "toggle-terminal",
          label: "Toggle Terminal",
          hint: "Ctrl+`",
          enabled: hasWs,
          run: () => emitCmd("toggle-terminal"),
        },
        { id: "schema-map", label: "Schema Map", enabled: isSql, run: () => emitCmd("schema-map") },
        "—",
        { id: "zoom-in", label: "Zoom In", hint: "⌘+", enabled: true, run: () => ctx.onZoom("in") },
        {
          id: "zoom-out",
          label: "Zoom Out",
          hint: "⌘-",
          enabled: true,
          run: () => ctx.onZoom("out"),
        },
        {
          id: "actual-size",
          label: "Actual Size",
          enabled: zoomChanged,
          run: () => ctx.onZoom("reset"),
        },
      ],
    },
    {
      label: "Query",
      items: [
        { id: "run", label: "Run", hint: "⌘↩", enabled: isSql, run: () => emitCmd("run") },
        {
          id: "format",
          label: "Format Query",
          hint: "⇧⌥F",
          enabled: isSql,
          run: () => emitCmd("format"),
        },
        { id: "explain", label: "Explain Plan", enabled: isSql, run: () => emitCmd("explain") },
        "—",
        {
          id: "save-query",
          label: "Save Query…",
          hint: "⌘S",
          enabled: isSql,
          run: () => emitCmd("save-query"),
        },
        {
          id: "query-history",
          label: "Query History",
          enabled: isSql,
          run: () => emitCmd("query-history"),
        },
      ],
    },
    {
      label: "Help",
      items: [
        { id: "shortcuts", label: "Keyboard Shortcuts", enabled: true, run: ctx.onShortcuts },
        "—",
        {
          id: "check-updates",
          label: "Check for Updates…",
          enabled: true,
          run: ctx.onCheckUpdates,
        },
        { id: "about", label: "About ByteTable", enabled: true, run: ctx.onAbout },
      ],
    },
  ];
}
