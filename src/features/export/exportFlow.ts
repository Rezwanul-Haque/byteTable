// Export / import flow (M15) — the shared "native dialog → backend I/O → toast"
// pipelines. Export ("generate text → save dialog → write → toast") is used by
// the table-actions menu, the table context menu, and the sidebar schema-row
// download. Import ("open dialog → read+run .sql → toast + refresh") is the I/O
// counterpart, used by the sidebar schema-row "Import .sql" button.
//
// The prototype downloaded via a browser Blob; ByteTable produces the export
// text server-side (handles the FULL table, not the grid's page) through the
// Task-1 wrappers, then writes it to a user-chosen path obtained from the
// Tauri native save dialog (`dialog:allow-save` capability); import reads from
// a path obtained from the native open dialog (`dialog:allow-open`). In
// plain-browser dev there is no Tauri, so the dynamic import of the dialog
// plugin rejects and we surface an info toast rather than a hard failure —
// mirroring the schema map export.

import { exportSchema, exportTable, exportSave, importSql } from "../../shared/api/engine";
import { appErrorMessage } from "../../shared/api/error";
import type { ToastFn } from "../../shared/ui/toastContext";
import { useIntrospectionStore } from "../introspection/state";
import { useWorkspacesStore } from "../workspaces/state";
import { useTabMetaStore } from "../workspaces/tabMeta";

/** Which export the flow runs. */
export type ExportKind = "tableCsv" | "tableSql" | "schemaSql";

export interface RunExportArgs {
  handleId: string;
  schema: string;
  /** Required for `tableCsv` / `tableSql`; ignored for `schemaSql`. */
  table?: string;
}

/**
 * Lazily import the dialog plugin so plain-browser dev (no Tauri) doesn't crash
 * at module load; the dynamic import rejects there and the caller shows an info
 * toast. Mirrors `schema_map`'s `saveDialog`.
 */
async function saveDialog(defaultName: string, ext: string, label: string) {
  const { save } = await import("@tauri-apps/plugin-dialog");
  return save({ defaultPath: defaultName, filters: [{ name: label, extensions: [ext] }] });
}

/** The default filename + extension + dialog filter label per export kind. */
function exportTarget(kind: ExportKind, schema: string, table: string | undefined) {
  switch (kind) {
    case "tableCsv":
      return { name: `${table}.csv`, ext: "csv", label: "CSV file" };
    case "tableSql":
      return { name: `${table}.sql`, ext: "sql", label: "SQL file" };
    case "schemaSql":
      return { name: `${schema}_schema.sql`, ext: "sql", label: "SQL file" };
  }
}

/** Generate the export text for the given kind via the Task-1 wrappers. */
function generate(kind: ExportKind, args: RunExportArgs): Promise<string> {
  const { handleId, schema, table } = args;
  switch (kind) {
    case "tableCsv":
      return exportTable(handleId, schema, table!, "csv");
    case "tableSql":
      return exportTable(handleId, schema, table!, "sql");
    case "schemaSql":
      return exportSchema(handleId, schema);
  }
}

/**
 * Run the full export flow: generate text → save dialog → write to disk →
 * toast. Swallows the user-cancelled dialog (no toast). Surfaces the §5
 * message on a real failure, and an info toast when the dialog plugin is
 * unavailable (browser dev).
 */
export async function runExport(
  kind: ExportKind,
  args: RunExportArgs,
  toast: ToastFn,
): Promise<void> {
  const { name, ext, label } = exportTarget(kind, args.schema, args.table);
  try {
    // Generate first so a backend error (unknown table, etc.) surfaces before
    // we bother the user with a file picker.
    const text = await generate(kind, args);

    let path: string | null;
    try {
      path = await saveDialog(name, ext, label);
    } catch {
      // Dialog plugin unavailable (browser dev) → not a real failure.
      toast("Export requires the desktop app", "info");
      return;
    }
    if (!path) return; // user cancelled the dialog

    await exportSave(path, text);
    const file = path.split(/[\\/]/).pop() ?? name;
    toast("Exported " + file, "ok");
  } catch (err) {
    toast(appErrorMessage(err, "Could not export."), "err");
  }
}

/** Args for {@link runImport}: import into the currently selected schema. */
export interface RunImportArgs {
  handleId: string;
  schema: string;
}

/**
 * Lazily import the dialog plugin's `open` (same browser-dev guard as
 * {@link saveDialog}) and prompt for a single `.sql` file. Returns the chosen
 * path, `null` when the user cancelled, and rejects when the plugin is
 * unavailable (browser dev) so the caller can show an info toast.
 */
async function openSqlDialog(): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const chosen = await open({
    multiple: false,
    filters: [{ name: "SQL", extensions: ["sql"] }],
  });
  // `open({ multiple: false })` resolves to a single path or null.
  return typeof chosen === "string" ? chosen : null;
}

/**
 * After a successful import, refresh the sidebar + any open data grids so the
 * new tables/rows appear immediately: drop the schema's introspection cache,
 * force-reload its table list, and bump the refetch nonce of every open table
 * tab in the imported schema (on the workspace bound to this handle).
 */
function refreshAfterImport(handleId: string, schema: string): void {
  const introspection = useIntrospectionStore.getState();
  introspection.invalidate(handleId, schema);
  void introspection.loadTables(handleId, schema, { force: true });

  // Bump open data grids showing tables in the imported schema so they re-fetch.
  const { workspaces } = useWorkspacesStore.getState();
  const { requestRefetch } = useTabMetaStore.getState();
  for (const ws of workspaces) {
    if (ws.handleId !== handleId) continue;
    for (const tab of ws.ui.tabs ?? []) {
      if (tab.kind === "table" && tab.schema === schema) requestRefetch(tab.id);
    }
  }
}

/**
 * Run the full import flow: open dialog → read+run the chosen `.sql` into the
 * schema → toast + refresh. Swallows the user-cancelled dialog (no toast).
 * Surfaces the §5 message on a real failure (bad file, script error — for MySQL
 * the message names how far a non-atomic import got), and an info toast when the
 * dialog plugin is unavailable (browser dev).
 */
export async function runImport(args: RunImportArgs, toast: ToastFn): Promise<void> {
  const { handleId, schema } = args;

  let path: string | null;
  try {
    path = await openSqlDialog();
  } catch {
    // Dialog plugin unavailable (browser dev) → not a real failure.
    toast("Import requires the desktop app", "info");
    return;
  }
  if (!path) return; // user cancelled the dialog

  try {
    const { statements } = await importSql(handleId, schema, path);
    const file = path.split(/[\\/]/).pop() ?? path;
    toast("Imported " + file + " — " + statements + " statements", "ok");
    refreshAfterImport(handleId, schema);
  } catch (err) {
    toast(appErrorMessage(err, "Could not import."), "err");
  }
}
