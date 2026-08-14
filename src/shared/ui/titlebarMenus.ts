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
//  3. `execEdit(cmd)` → the last-focused CodeMirror editor for undo/redo (see
//     activeCodeEditor.ts), else document.execCommand against whatever is
//     focused, failing silently if nothing is.
//
// Every label — the five menus and all their items — is localized (M31
// `menu.*`). Because they are read at build time, the title bar re-runs this on
// a locale change (it subscribes through useT). Two things stay untranslated by
// design: the product name, interpolated as `{app}` so it can sit anywhere in
// the sentence, and the shortcut hints (⌘T), which are key names.

import { t } from "../i18n";
import { runCodeEditorHistory } from "./activeCodeEditor";
import { emitCmd } from "./btCmd";

/** The product name. Interpolated into labels rather than translated. */
const APP_NAME = "ByteTable";

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
  /** The active workspace exposes a server process list (SQL, Redis, Mongo). */
  hasProcesses: boolean;
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

/** Standard editing commands against the focused element; silent no-op if none.
 *
 *  Undo/redo go to the last-focused SQL editor first: CodeMirror keeps its own
 *  history, and clicking this menu item has already moved focus out of the
 *  editor, so `execCommand` would find nothing to act on. Plain inputs and
 *  textareas (and the clipboard commands) still take the execCommand path,
 *  which remains the only synchronous hook into the browser's native stacks. */
export function execEdit(cmd: "undo" | "redo" | "cut" | "copy" | "paste"): void {
  if ((cmd === "undo" || cmd === "redo") && runCodeEditorHistory(cmd)) return;
  document.execCommand(cmd);
}

export function buildMenus(m: MenuCtx): Menu[] {
  const { hasWs, isSql, hasPalette, hasProcesses, zoomChanged, ctx } = m;

  return [
    {
      label: t("menu.file"),
      items: [
        {
          id: "new-connection",
          label: t("menu.file.newConnection"),
          enabled: true,
          run: ctx.onNewConnection,
        },
        {
          id: "new-query",
          label: t("menu.file.newQuery"),
          hint: "⌘T",
          enabled: isSql,
          run: () => emitCmd("new-query"),
        },
        {
          id: "open-sql-file",
          label: t("menu.file.openSqlFile"),
          enabled: isSql,
          run: () => emitCmd("open-sql-file"),
        },
        "—",
        {
          id: "close-workspace",
          label: t("menu.file.closeWorkspace"),
          enabled: hasWs,
          run: ctx.onCloseWorkspace,
        },
        "—",
        {
          id: "settings",
          label: t("menu.file.settings"),
          hint: "⌘,",
          enabled: true,
          run: ctx.onSettings,
        },
        {
          id: "quit",
          label: t("menu.file.quit", { app: APP_NAME }),
          enabled: true,
          run: ctx.onQuit,
        },
      ],
    },
    {
      label: t("menu.edit"),
      items: [
        { id: "undo", label: t("menu.edit.undo"), enabled: true, run: () => execEdit("undo") },
        { id: "redo", label: t("menu.edit.redo"), enabled: true, run: () => execEdit("redo") },
        "—",
        { id: "cut", label: t("menu.edit.cut"), enabled: true, run: () => execEdit("cut") },
        { id: "copy", label: t("menu.edit.copy"), enabled: true, run: () => execEdit("copy") },
        { id: "paste", label: t("menu.edit.paste"), enabled: true, run: () => execEdit("paste") },
      ],
    },
    {
      label: t("menu.view"),
      items: [
        {
          id: "palette",
          label: t("menu.view.palette"),
          hint: "⌘K",
          enabled: hasPalette,
          run: () => emitCmd("palette"),
        },
        {
          id: "toggle-terminal",
          label: t("menu.view.terminal"),
          hint: "Ctrl+`",
          enabled: hasWs,
          run: () => emitCmd("toggle-terminal"),
        },
        {
          id: "schema-map",
          label: t("menu.view.schemaMap"),
          enabled: isSql,
          run: () => emitCmd("schema-map"),
        },
        {
          id: "processes",
          label: t("menu.view.processes"),
          hint: "Ctrl+Shift+P",
          enabled: hasProcesses,
          run: () => emitCmd("processes"),
        },
        "—",
        {
          id: "zoom-in",
          label: t("menu.view.zoomIn"),
          hint: "⌘+",
          enabled: true,
          run: () => ctx.onZoom("in"),
        },
        {
          id: "zoom-out",
          label: t("menu.view.zoomOut"),
          hint: "⌘-",
          enabled: true,
          run: () => ctx.onZoom("out"),
        },
        {
          id: "actual-size",
          label: t("menu.view.actualSize"),
          enabled: zoomChanged,
          run: () => ctx.onZoom("reset"),
        },
      ],
    },
    {
      label: t("menu.query"),
      items: [
        {
          id: "run",
          label: t("menu.query.run"),
          hint: "⌘↩",
          enabled: isSql,
          run: () => emitCmd("run"),
        },
        {
          id: "format",
          label: t("menu.query.format"),
          hint: "⇧⌥F",
          enabled: isSql,
          run: () => emitCmd("format"),
        },
        {
          id: "explain",
          label: t("menu.query.explain"),
          enabled: isSql,
          run: () => emitCmd("explain"),
        },
        "—",
        {
          id: "save-query",
          label: t("menu.query.save"),
          hint: "⌘S",
          enabled: isSql,
          run: () => emitCmd("save-query"),
        },
        {
          id: "query-history",
          label: t("menu.query.history"),
          enabled: isSql,
          run: () => emitCmd("query-history"),
        },
      ],
    },
    {
      label: t("menu.help"),
      items: [
        { id: "shortcuts", label: t("menu.help.shortcuts"), enabled: true, run: ctx.onShortcuts },
        "—",
        {
          id: "check-updates",
          label: t("menu.help.checkUpdates"),
          enabled: true,
          run: ctx.onCheckUpdates,
        },
        {
          id: "about",
          label: t("menu.help.about", { app: APP_NAME }),
          enabled: true,
          run: ctx.onAbout,
        },
      ],
    },
  ];
}
