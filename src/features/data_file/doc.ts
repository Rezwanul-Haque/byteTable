// The derived document every data-file view reads (M35 Task 5).
//
// ONE memo per workspace, recomputed only when `workspace.file` changes —
// never per tab. Parsing + profiling a file is O(rows × columns) and the Data,
// Profile, Quality and SQL tabs would otherwise each redo it on every render,
// on every keystroke in the search box.

import { useMemo } from "react";

import {
  adhocSchema,
  analyze,
  parse,
  tableName,
  toObjects,
  type AdhocSchema,
  type Analysis,
  type DataFileValue,
  type Parsed,
  type Sniffed,
} from "./core";
import { sniff } from "./core";
import type { DataFileRef } from "../workspaces/types";

/** Everything the viewer renders, derived once from the file's text. */
export interface DataFileDoc {
  name: string;
  /** Absolute path when known, for the file chip's tooltip. */
  path: string | null;
  size: number;
  sniffed: Sniffed;
  parsed: Parsed;
  analysis: Analysis;
  /** The slugified table name — what the SQL tab queries. */
  table: string;
  /** Rows as `{column: value}` objects, coerced per column type. */
  objects: Record<string, DataFileValue>[];
  schema: AdhocSchema;
  /** Error-severity issue count (the sidebar/status-bar badge). */
  errors: number;
}

/** Build the doc for a file. Pure — {@link useDataFileDoc} is the memo. */
export function buildDoc(file: DataFileRef): DataFileDoc {
  const parsed = parse(file.text, file.opts);
  const analysis = analyze(parsed);
  const table = tableName(file.name);
  return {
    name: file.name,
    path: file.path,
    size: file.size,
    sniffed: sniff(file.text),
    parsed,
    analysis,
    table,
    objects: toObjects(analysis.cols, parsed.rows),
    schema: adhocSchema(table, analysis.cols, parsed.rows.length),
    errors: analysis.issues.filter((i) => i.sev === "error").length,
  };
}

/** The workspace-level memo the host holds and passes down to every tab. */
export function useDataFileDoc(file: DataFileRef): DataFileDoc {
  return useMemo(() => buildDoc(file), [file]);
}
