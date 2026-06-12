// Native file-picker wrapper for "Open SQLite file…". Lives in the
// connections slice next to api.ts: which files count as a database is a
// connections concern, not a workspaces one.

import { open } from "@tauri-apps/plugin-dialog";

/**
 * Show the native open-file dialog filtered to SQLite databases.
 * Resolves to the picked absolute path, or null when the user cancels.
 *
 * In plain browser dev the dialog plugin is unavailable and this rejects —
 * callers catch and show the "requires the desktop app" info toast.
 */
export async function pickSqliteFile(): Promise<string | null> {
  return await open({
    multiple: false,
    directory: false,
    filters: [
      { name: "SQLite database", extensions: ["db", "sqlite", "sqlite3", "db3"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
}
