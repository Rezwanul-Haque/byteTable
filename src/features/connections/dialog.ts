// Native file-picker wrappers for "Open SQLite file…" and the
// new-connection modal's Browse buttons. Lives in the connections slice next
// to api.ts: which files count as a database (or an SSH key) is a
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

/**
 * Show the native open-file dialog for picking an SSH private key — no
 * extension filter, since keys commonly have none (id_ed25519, id_rsa).
 * Resolves to the picked absolute path, or null when the user cancels;
 * rejects in plain browser dev like pickSqliteFile above.
 */
export async function pickPrivateKeyFile(): Promise<string | null> {
  return await open({ multiple: false, directory: false });
}
