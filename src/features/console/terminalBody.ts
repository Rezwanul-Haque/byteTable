// Shared behaviour of the REPL bodies (the SQL terminal tab and the Redis /
// Cassandra / Typesense sessions): what a click in the transcript does, and
// what the transcript looks like on the clipboard.

import type { CellValue } from "../../shared/api/engine";
import type { TermLine } from "./state";

/**
 * Focus the prompt when the transcript is clicked — unless that click just
 * finished selecting text.
 *
 * The bodies focus their input on any click so typing works wherever you click.
 * But focusing an `<input>` collapses the document selection, so a drag-select
 * over the output vanished the instant the mouse button came up and the output
 * could not be copied at all. A click that ends on a non-empty selection *in
 * this body* leaves focus where it is, and ⌘C / Ctrl+C then works normally.
 */
export function focusPromptUnlessSelecting(
  body: HTMLElement | null,
  input: HTMLInputElement | null,
): void {
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed && sel.anchorNode && body?.contains(sel.anchorNode)) return;
  input?.focus();
}

/** One cell as the terminal prints it: booleans as `t`/`f`, NULL spelled out. */
function cellText(value: CellValue | undefined): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "t" : "f";
  return String(value);
}

/**
 * A result as its header row plus tab-separated rows — the form that pastes
 * unchanged into a spreadsheet, an editor, or another query. Deliberately not
 * the ASCII table the terminal draws: that is for reading, this is for reusing.
 */
export function gridToTsv(columns: string[], rows: CellValue[][]): string {
  const header = columns.join("\t");
  const body = rows.map((row) => columns.map((_, i) => cellText(row[i])).join("\t"));
  return [header, ...body].join("\n");
}

/** The whole transcript as one block of text, results included. */
export function transcriptToText(lines: TermLine[]): string {
  return lines.map((l) => ("kind" in l ? gridToTsv(l.columns, l.rows) : l.text)).join("\n");
}
