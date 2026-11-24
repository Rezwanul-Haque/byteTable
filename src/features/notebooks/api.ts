// Typed wrappers for the notebooks slice (M47). The notebook itself — format,
// cells, what runs when — lives in the renderer; these are the parts that need
// the OS or a connection.

import { invoke } from "@tauri-apps/api/core";

import type { QueryResult } from "../../shared/api/engine";

export type StatementKind = "read" | "write" | "transaction";

/** One cell's run: its result, or that Stop cancelled it. */
export interface CellRun {
  result?: QueryResult;
  cancelled?: boolean;
}

/** Run one cell's statement; stoppable with {@link cancelCell}. Up to 10,000
 *  rows come back so the count is exact up to there. */
export function runCell(
  handleId: string,
  runId: string,
  sql: string,
  schema: string,
): Promise<CellRun> {
  return invoke<CellRun>("notebook_query_run", { handleId, runId, sql, schema });
}

export function cancelCell(runId: string): Promise<void> {
  return invoke<void>("notebook_query_cancel", { runId });
}

/** Read / write / transaction control, per statement. */
export function classify(statements: string[]): Promise<StatementKind[]> {
  return invoke<StatementKind[]>("notebook_classify", { statements });
}

export function readNotebookFile(path: string): Promise<string> {
  return invoke<string>("notebook_read", { path });
}

/** Write atomically (temporary file, then rename). Markdown paths only. */
export function writeNotebookFile(path: string, text: string): Promise<void> {
  return invoke<void>("notebook_write", { path, text });
}

export interface FileStat {
  modifiedMs: number;
  size: number;
}

/** When the file last changed; null when it is gone. */
export function statNotebookFile(path: string): Promise<FileStat | null> {
  return invoke<FileStat | null>("notebook_stat", { path });
}

/** Tell the backend whether a quit would lose notebook edits. */
export function setAppUnsaved(unsaved: boolean): Promise<void> {
  return invoke<void>("app_set_unsaved", { unsaved });
}

/** Quit, after the unsaved-notebooks prompt (or with nothing unsaved). */
export function quitApp(): Promise<void> {
  return invoke<void>("app_quit");
}

/** The backend's nudge: a quit is waiting on the unsaved-notebooks prompt. */
export const QUIT_REQUESTED_EVENT = "app://quit-requested";

/** Native save dialog for a notebook; null when cancelled. */
export async function saveDialog(suggested: string): Promise<string | null> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({
    defaultPath: suggested,
    filters: [{ name: "Markdown notebook", extensions: ["md"] }],
  });
  if (!path) return null;
  return /\.(md|markdown)$/i.test(path) ? path : path + ".md";
}

/** Native open dialog for a notebook; null when cancelled. */
export async function openDialog(): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const chosen = await open({
    multiple: false,
    filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
  });
  return typeof chosen === "string" ? chosen : null;
}
