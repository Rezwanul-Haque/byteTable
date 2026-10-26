// Native file-picker wrappers for "Open SQLite file…" and the
// new-connection modal's Browse buttons. Lives in the connections slice next
// to api.ts: which files count as a database (or an SSH key) is a
// connections concern, not a workspaces one.

import { open, save } from "@tauri-apps/plugin-dialog";

import { t } from "../../shared/i18n";
import { BUNDLE_EXTENSION } from "./bundle";

/**
 * Show the native open-file dialog filtered to SQLite databases.
 * Resolves to the picked absolute path, or null when the user cancels.
 *
 * In plain browser dev the dialog plugin is unavailable and this rejects —
 * callers catch and show the "requires the desktop app" info toast.
 *
 * The filter names are read from the locale at call time (not module load), so
 * the OS dialog is labelled in the language the user picked.
 */
export async function pickSqliteFile(): Promise<string | null> {
  return await open({
    multiple: false,
    directory: false,
    filters: [
      { name: t("conn.dlg.sqlite"), extensions: ["db", "sqlite", "sqlite3", "db3"] },
      { name: t("common.allFiles"), extensions: ["*"] },
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

/**
 * Where to write an encrypted connection bundle (M40). Resolves to the chosen
 * absolute path, or null when the user cancels.
 *
 * The suggested name carries the date, because the thing a user ends up with
 * in ~/Downloads months later needs to say which export it was.
 */
export async function pickBundleSaveFile(): Promise<string | null> {
  const stamp = new Date().toISOString().slice(0, 10);
  return await save({
    defaultPath: `bytetable-connections-${stamp}.${BUNDLE_EXTENSION}`,
    filters: [{ name: t("conn.dlg.bundle"), extensions: [BUNDLE_EXTENSION] }],
  });
}

/**
 * Pick an encrypted connection bundle to import. The All-files fallback is
 * deliberate: a bundle that travelled by email or chat often arrives with the
 * extension stripped, and the backend validates the format anyway.
 */
export async function pickBundleOpenFile(): Promise<string | null> {
  return await open({
    multiple: false,
    directory: false,
    filters: [
      { name: t("conn.dlg.bundle"), extensions: [BUNDLE_EXTENSION] },
      { name: t("common.allFiles"), extensions: ["*"] },
    ],
  });
}
