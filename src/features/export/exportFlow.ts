// Export flow (M15) — the building blocks the `ExportProgressModal` orchestrates:
// the per-kind filename target, the native save dialog, and the text generator.
// (The import counterpart lives in the `import` feature's modals, which preview
// client-side before applying.)
//
// The prototype downloaded via a browser Blob; ByteTable produces the export
// text server-side (handles the FULL table, not the grid's page) through the
// engine wrappers, then writes it to a user-chosen path obtained from the Tauri
// native save dialog (`dialog:allow-save` capability). In plain-browser dev
// there is no Tauri, so the dynamic import of the dialog plugin rejects and the
// modal surfaces an info toast rather than a hard failure — mirroring the
// schema map export. Progress is streamed back over the backend Channel and the
// modal renders it as a live bar.

import {
  exportSchema,
  exportTable,
  type ExportScope,
  type ProgressFn,
} from "../../shared/api/engine";

/** Which export the flow runs. */
export type ExportKind = "tableCsv" | "tableSql" | "schemaSql";

export interface RunExportArgs {
  handleId: string;
  schema: string;
  /** Required for `tableCsv` / `tableSql`; ignored for `schemaSql`. */
  table?: string;
  /**
   * SQL only: structure-only / data-only / both (the export "middleware"
   * picker). Defaults to `"both"`. CSV ignores it (always data).
   */
  scope?: ExportScope;
}

/**
 * Filename suffix for a SQL scope, mirroring the prototype's `suffix()`
 * (`export-progress.jsx`): `_schema` for structure-only, `_data` for data-only,
 * nothing for both. CSV / unset scope add no suffix.
 */
export function scopeSuffix(scope: ExportScope | undefined): string {
  if (scope === "schema") return "_schema";
  if (scope === "data") return "_data";
  return "";
}

/**
 * Lazily import the dialog plugin so plain-browser dev (no Tauri) doesn't crash
 * at module load; the dynamic import rejects there and the caller shows an info
 * toast. Mirrors `schema_map`'s `saveDialog`. Returns the chosen path, or `null`
 * when the user cancels the dialog.
 */
export async function saveDialog(
  defaultName: string,
  ext: string,
  label: string,
): Promise<string | null> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  return save({ defaultPath: defaultName, filters: [{ name: label, extensions: [ext] }] });
}

/**
 * The default filename + extension + dialog filter label per export kind. SQL
 * exports get a scope suffix (`_schema` / `_data`; nothing for both), matching
 * the prototype's `export-progress.jsx`.
 */
export function exportTarget(
  kind: ExportKind,
  schema: string,
  table: string | undefined,
  scope: ExportScope | undefined,
) {
  const suffix = scopeSuffix(scope);
  switch (kind) {
    case "tableCsv":
      return { name: `${table}.csv`, ext: "csv", label: "CSV file" };
    case "tableSql":
      return { name: `${table}${suffix}.sql`, ext: "sql", label: "SQL file" };
    case "schemaSql":
      return { name: `${schema}${suffix}.sql`, ext: "sql", label: "SQL file" };
  }
}

/**
 * Generate the export text for the given kind via the engine wrappers,
 * streaming progress (rows for a table, tables for a schema dump) through
 * `onProgress`.
 */
export function generate(
  kind: ExportKind,
  args: RunExportArgs,
  onProgress?: ProgressFn,
): Promise<string> {
  const { handleId, schema, table, scope = "both" } = args;
  switch (kind) {
    case "tableCsv":
      return exportTable(handleId, schema, table!, "csv", scope, onProgress);
    case "tableSql":
      return exportTable(handleId, schema, table!, "sql", scope, onProgress);
    case "schemaSql":
      return exportSchema(handleId, schema, scope, onProgress);
  }
}
