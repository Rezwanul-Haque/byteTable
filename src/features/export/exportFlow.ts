// Export flow (M15 Task 2) — the shared "generate text → native save dialog →
// write to disk → toast" pipeline used by both the table-actions menu (table
// tab) and the sidebar (table context menu + schema-row download).
//
// The prototype downloaded via a browser Blob; ByteTable produces the export
// text server-side (handles the FULL table, not the grid's page) through the
// Task-1 wrappers, then writes it to a user-chosen path obtained from the
// Tauri native save dialog (`dialog:allow-save` capability). In plain-browser
// dev there is no Tauri, so the dynamic import of the dialog plugin rejects and
// we surface an info toast rather than a hard failure — mirroring the schema
// map export.

import { exportSchema, exportTable, exportSave } from "../../shared/api/engine";
import { appErrorMessage } from "../../shared/api/error";
import type { ToastFn } from "../../shared/ui/toastContext";

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
