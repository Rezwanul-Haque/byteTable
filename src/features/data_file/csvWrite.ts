// Writing an edited data file back out (M35 in-place editing).
//
// THE RULE: a save must change exactly the cells the user changed, and nothing
// else. That is not a nicety — this feature's whole premise is that silently
// reshaping data is the one unforgivable bug in a CSV tool, and a viewer that
// "fixes" your file behind your back on the way out is the same bug wearing a
// different hat.
//
// So this is a SPLICE, not a re-serialization. Every record the user did not
// touch is sliced straight out of the original text, byte for byte — its
// quoting, its spacing, its null spelling (`N/A` vs `-` vs empty), and its field
// count if it was ragged. Even within an EDITED record, the fields that were not
// edited are copied verbatim; only the edited ones are re-quoted. The header
// line, leading and trailing blank lines, the BOM and CRLF endings all survive.
//
// What a save DOES normalize, honestly and unavoidably:
//   - mixed line endings collapse to the file's dominant one (parsing normalizes
//     to \n, and the writer re-applies CRLF only if the file was CRLF);
//   - a file with no trailing newline grows one if rows were appended.

import type { Parsed, ResolvedParseOptions } from "./core";
import { normalize } from "./core";

/** A staged cell change: row index → column index → the new raw text. */
export type CellEdits = Record<number, Record<number, string>>;

/** A staged new row: its cells by column index, in the file's column order. */
export interface StagedRow {
  /** Stable key for React + the save bar; never written to the file. */
  key: number;
  cells: Record<number, string>;
}

/** Everything a save applies to the original text. */
export interface EditBatch {
  /** Edits to existing rows, keyed by index into `parsed.rows`. */
  cells: CellEdits;
  /** Rows to append, in the order they were staged. */
  added: StagedRow[];
  /** Indexes into `parsed.rows` to drop entirely. */
  deleted: number[];
}

/** True when the batch would change nothing. */
export function isEmptyBatch(batch: EditBatch): boolean {
  return (
    batch.added.length === 0 &&
    batch.deleted.length === 0 &&
    Object.values(batch.cells).every((row) => Object.keys(row).length === 0)
  );
}

/** How many rows a batch touches — the save bar's count. */
export function batchSize(batch: EditBatch): { edited: number; added: number; deleted: number } {
  const edited = Object.values(batch.cells).filter((r) => Object.keys(r).length > 0).length;
  return { edited, added: batch.added.length, deleted: batch.deleted.length };
}

/** An empty batch (a freshly opened file, or one just saved/discarded). */
export function emptyBatch(): EditBatch {
  return { cells: {}, added: [], deleted: [] };
}

/**
 * One field's extent inside a record's source text, so an untouched field can be
 * copied out with its original quoting intact.
 */
interface FieldSpan {
  start: number;
  end: number;
}

/**
 * Re-scan one record's source text into field spans. Same grammar as `parse`,
 * but it records WHERE each field was rather than what it decoded to — the
 * writer wants the bytes, not the value.
 *
 * `text` is the record's span with its trailing newline already removed.
 */
function fieldSpans(text: string, opts: ResolvedParseOptions): FieldSpan[] {
  const D = opts.delimiter;
  const Q = opts.quote;
  const out: FieldSpan[] = [];
  let start = 0;
  let inq = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (inq) {
      if (ch === Q) {
        if (text[i + 1] === Q) {
          i += 2;
          continue;
        }
        inq = false;
      }
      i++;
      continue;
    }
    if (ch === Q && i === start) {
      inq = true;
      i++;
      continue;
    }
    if (ch === D) {
      out.push({ start, end: i });
      i++;
      start = i;
      continue;
    }
    i++;
  }
  out.push({ start, end: text.length });
  return out;
}

/**
 * Quote a value only when the format requires it: when it contains the
 * delimiter, the quote character, or a newline. Embedded quotes are doubled.
 *
 * Deliberately minimal — quoting a value that does not need it would be a
 * gratuitous difference in a file the user is going to diff.
 */
export function quoteField(value: string, opts: ResolvedParseOptions): string {
  const Q = opts.quote;
  const needs = value.includes(opts.delimiter) || value.includes(Q) || /[\r\n]/.test(value);
  if (!needs) return value;
  return Q + value.split(Q).join(Q + Q) + Q;
}

/** Build a whole record's text from field values (used for appended rows). */
function serializeRow(cells: string[], opts: ResolvedParseOptions): string {
  return cells.map((c) => quoteField(c, opts)).join(opts.delimiter);
}

/**
 * Rebuild ONE edited record: untouched fields are copied verbatim from the
 * source, edited fields are re-quoted from their new value.
 *
 * A ragged record keeps its own field count — an edit to column 2 of a row that
 * only has 5 of 13 fields must not silently pad it out to 13. Editing a column
 * the record does not reach is the one case that appends: the row is extended
 * with empty fields up to that column, which is the only way to store the value
 * at all, and it is a change the user explicitly asked for.
 */
function rebuildRecord(
  source: string,
  edits: Record<number, string>,
  opts: ResolvedParseOptions,
): string {
  const spans = fieldSpans(source, opts);
  const highest = Math.max(...Object.keys(edits).map(Number));
  const width = Math.max(spans.length, highest + 1);
  const out: string[] = [];
  for (let c = 0; c < width; c++) {
    const edited = edits[c];
    if (edited !== undefined) {
      out.push(quoteField(edited, opts));
      continue;
    }
    const span = spans[c];
    out.push(span ? source.slice(span.start, span.end) : "");
  }
  return out.join(opts.delimiter);
}

/**
 * The file's text with `batch` applied.
 *
 * `text` is the ORIGINAL file contents (BOM and CRLF included); `parsed` must be
 * the parse of that same text, since every span indexes into it.
 */
export function serializeFile(text: string, parsed: Parsed, batch: EditBatch): string {
  const s = normalize(text);
  const opts = parsed.opts;
  const hadBom = text.charCodeAt(0) === 0xfeff;
  const crlf = /\r\n/.test(text.slice(0, 4000));

  const deleted = new Set(batch.deleted);
  const out: string[] = [];

  // Everything before the first data record: the header line and any blank
  // lines above it, verbatim.
  out.push(s.slice(0, parsed.bodyStart));

  let lastEnd = parsed.bodyStart;
  parsed.spans.forEach((span, row) => {
    lastEnd = span.end;
    if (deleted.has(row)) {
      // Deleting a row does not delete the blank lines that happened to sit
      // above it — those are the file's formatting, not this row's data.
      out.push(s.slice(span.start, span.textStart));
      return;
    }
    const edits = batch.cells[row];
    if (!edits || Object.keys(edits).length === 0) {
      // Untouched: straight through, newline and all.
      out.push(s.slice(span.start, span.end));
      return;
    }
    // Blank lines folded into this span are not part of the record — copy them
    // through, then rebuild only the record's own text. The trailing newline is
    // held back too, so the body has fields and nothing else.
    out.push(s.slice(span.start, span.textStart));
    const raw = s.slice(span.textStart, span.end);
    const terminator = raw.endsWith("\n") ? "\n" : "";
    const body = terminator ? raw.slice(0, -1) : raw;
    out.push(rebuildRecord(body, edits, opts) + terminator);
  });

  // Anything after the last record — trailing blank lines, a stray newline.
  const suffix = s.slice(lastEnd);

  if (batch.added.length > 0) {
    let appended = out.join("") + suffix;
    // Appending to a file whose last line has no newline would otherwise glue
    // the new row onto it.
    if (appended !== "" && !appended.endsWith("\n")) appended += "\n";
    const width = parsed.columns.length;
    for (const row of batch.added) {
      const cells = Array.from({ length: width }, (_, c) => row.cells[c] ?? "");
      appended += serializeRow(cells, opts) + "\n";
    }
    return restore(appended, hadBom, crlf);
  }

  return restore(out.join("") + suffix, hadBom, crlf);
}

/** Put back what {@link normalize} took off. */
function restore(s: string, bom: boolean, crlf: boolean): string {
  const withEndings = crlf ? s.replace(/\n/g, "\r\n") : s;
  return bom ? "﻿" + withEndings : withEndings;
}
