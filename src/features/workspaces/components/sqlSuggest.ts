// Context-aware SQL suggestion engine — the CM-agnostic core shared by the
// query editor's CodeMirror autocomplete (sqlCompletion.ts) and the SQL
// terminal's manual popup (console/SqlTerminalTab). Pure functions over
// (text, caret, schema) — no editor, no DOM — so both surfaces rank identically.
//
// SUGGESTION SOURCE (spec Note): the active connection's introspected schema —
// table names + each table's columns (with primary-key flags). Callers pass a
// live snapshot; this module never touches the backend.
//
// BEHAVIOUR (PROMPT_autocomplete):
//   - Right after FROM / JOIN / INTO / UPDATE (incl. comma-separated lists),
//     suggest TABLE names — even before any letters are typed.
//   - Otherwise suggest COLUMN names first, prioritising columns of tables
//     already referenced in the current statement (each carries its source
//     table and a pk flag), then table names, then SQL keywords and functions.
//   - Matching is case-insensitive PREFIX match on the current word — or on the
//     multi-word phrase ending at the caret, so "ON DUP" still finds ON
//     DUPLICATE KEY UPDATE. Ordering is the array order returned here (no fuzzy
//     re-sort downstream).
//   - Keywords/functions are DIALECT-SPECIFIC (sqlKeywords.ts, keyed by the
//     caller's `engine`): Postgres offers RETURNING/ILIKE, ClickHouse PREWHERE
//     and its camelCase functions, Cassandra a CQL-only set with no joins.

import type { Engine } from "../../../shared/types";

import { functionsFor, keywordsFor } from "./sqlKeywords";
import { statementRangeAt } from "./sqlStatement";

/** One column the engine can suggest (subset of the introspected ColumnInfo). */
export interface EditorSchemaColumn {
  name: string;
  /** Part of the primary key — drives the key icon. */
  pk: boolean;
}

/** One table the engine can suggest, with whatever columns are cached. */
export interface EditorSchemaTable {
  name: string;
  /** Columns, when the table's introspection has been loaded (else empty). */
  columns: EditorSchemaColumn[];
}

/** The schema snapshot the suggester reads (active connection/schema). */
export interface EditorSchema {
  tables: EditorSchemaTable[];
}

/** Kind tag shown on each row (and used to pick the leading icon). */
export type SuggestKind = "table" | "column" | "keyword" | "fn";

/** One ranked suggestion — surface-agnostic (no DOM, no CM types). */
export interface Suggestion {
  /** Text inserted into the buffer when accepted (e.g. "GROUP BY", "COUNT("). */
  insert: string;
  /** Text shown in the row (equals `insert` today; kept distinct for callers). */
  label: string;
  kind: SuggestKind;
  /** Source table for a column row (the `.ac-hint`). */
  source?: string;
  /** Primary-key column — renders the key icon in accent. */
  pk?: boolean;
  /** Material Symbols glyph name for the leading icon. */
  icon: string;
}

/** A suggestion result: replace `[from, to)` in the text with a chosen insert. */
export interface SuggestResult {
  from: number;
  to: number;
  items: Suggestion[];
}

/** Human label per kind (right-edge `.ac-kind` tag). */
export const SUGGEST_KIND_LABEL: Record<SuggestKind, string> = {
  table: "table",
  column: "column",
  keyword: "keyword",
  fn: "fn",
};

/** Hard cap on rows returned — keeps the popup scroll bounded on wide schemas. */
const MAX_OPTIONS = 60;

/**
 * Rows RESERVED for keyword/function matches inside {@link MAX_OPTIONS}.
 *
 * WHY: schema rows are pushed first, so on a wide schema a common prefix ("co",
 * "de") could match enough columns to fill the cap and silently drop every
 * keyword — `COUNT(` / `CREATE TABLE` would just never appear. Columns+tables
 * are therefore trimmed to leave room for whatever keywords matched.
 */
const KEYWORD_SLOTS = 20;

/** How many words back a phrase match may reach (the longest keyword phrases —
 *  ON CONFLICT DO UPDATE SET, CREATE TABLE IF NOT EXISTS — are five words). */
const MAX_PHRASE_WORDS = 4;

/** Material Symbols glyph per kind (matches the sidebar's table/key icons). */
const ICON: Record<SuggestKind, string> = {
  table: "table",
  column: "view_column",
  keyword: "code",
  fn: "function",
};

/**
 * Blank out string literals and comments so the keyword/table regexes below
 * never match inside quoted text or a comment (same defence as highlightSql).
 * Replacement preserves length so any offsets stay valid.
 */
function stripNonCode(s: string): string {
  return s
    .replace(/'(?:[^']|'')*'/g, (m) => " ".repeat(m.length))
    .replace(/--[^\n]*/g, (m) => " ".repeat(m.length))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length));
}

/** Lower-cased names of tables referenced (FROM/JOIN/INTO/UPDATE) in a stmt. */
function referencedTables(stmt: string): Set<string> {
  const out = new Set<string>();
  const re = /\b(?:from|join|into|update)\s+([a-z_][\w$]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stmt)) !== null) out.add(m[1]!.toLowerCase());
  return out;
}

function tableSuggestion(name: string): Suggestion {
  return { insert: name, label: name, kind: "table", icon: ICON.table };
}

function columnSuggestion(col: EditorSchemaColumn, source: string): Suggestion {
  return {
    insert: col.name,
    label: col.name,
    kind: "column",
    source,
    pk: col.pk,
    icon: col.pk ? "key" : ICON.column,
  };
}

function keywordSuggestion(kw: string): Suggestion {
  return { insert: kw, label: kw, kind: "keyword", icon: ICON.keyword };
}

function functionSuggestion(fn: string): Suggestion {
  // The `(` is part of both insert and label, so the caret ends just inside the
  // parens with no trailing space.
  return { insert: fn, label: fn, kind: "fn", icon: ICON.fn };
}

/**
 * Rank SQL suggestions for `text` with the caret at `caret`.
 *
 * Returns the replace range `[from, to)` (the current word, empty when none)
 * and the ordered suggestions, or `null` when nothing should pop up. With no
 * partial word and no table context, returns null unless `opts.explicit`
 * (manual trigger — Ctrl/Cmd+Space), so plain whitespace never opens the popup.
 *
 * `opts.engine` selects the keyword/function vocabulary; omitted, the shared
 * ANSI core is used (no dialect extras).
 */
export function suggestSql(
  text: string,
  caret: number,
  schema: EditorSchema,
  opts?: { explicit?: boolean; engine?: Engine },
): SuggestResult | null {
  // Scope context to the statement the caret sits in (multi-statement buffers).
  const range = statementRangeAt(text, caret) ?? { from: 0, to: text.length };
  const stmtStart = Math.min(range.from, caret);
  const before = text.slice(stmtStart, caret);
  const beforeStripped = stripNonCode(before);

  const wordMatch = /[\w$]+$/.exec(before);
  const word = wordMatch ? wordMatch[0] : "";
  const from = caret - word.length;
  const wl = word.toLowerCase();
  const prefix = (s: string): boolean => s.toLowerCase().startsWith(wl);

  // Starts of the multi-word phrases ending at the caret, LONGEST FIRST — so a
  // half-typed PHRASE still finds its keyword: "ON DUP" → ON DUPLICATE KEY
  // UPDATE, "CREATE TABLE IF" → CREATE TABLE IF NOT EXISTS. Without this only
  // the FIRST word of a phrase matches and everything past it dead-ends.
  // Every suffix is a candidate (in "FROM t ON DUP" the phrase is "ON DUP", not
  // the whole tail), and the longest one that matches something wins.
  // Separators are spaces/tabs only — never a newline — which keeps the replace
  // range inside the caret's line, as the SQL terminal maps `from` back into
  // its live input line.
  const phraseStarts: number[] = [];
  for (let i = from, n = 0; n < MAX_PHRASE_WORDS; n++) {
    const sep = /[\w$]+[ \t]+$/.exec(text.slice(stmtStart, i));
    if (!sep) break;
    i -= sep[0].length;
    phraseStarts.unshift(i);
  }

  // Table context: caret right after FROM/JOIN/INTO/UPDATE — allowing a
  // partly-typed name and comma-separated table lists (`FROM a, b█`).
  const tableMode = /\b(?:from|join|into|update)\s+(?:[a-z_][\w$]*\s*,\s*)*[\w$]*$/i.test(
    beforeStripped,
  );

  // Otherwise only fire once a word has begun (or on explicit trigger) — typing
  // whitespace shouldn't pop the column/keyword list.
  if (!tableMode && !word && !opts?.explicit) return null;

  const items: Suggestion[] = [];

  if (tableMode) {
    for (const t of schema.tables) {
      if (prefix(t.name)) items.push(tableSuggestion(t.name));
    }
  } else {
    const referenced = referencedTables(stripNonCode(text.slice(range.from, range.to)));
    // Columns first, with referenced-table columns ahead of the rest.
    const refCols: Suggestion[] = [];
    const otherCols: Suggestion[] = [];
    for (const t of schema.tables) {
      const bucket = referenced.has(t.name.toLowerCase()) ? refCols : otherCols;
      for (const c of t.columns) {
        if (prefix(c.name)) bucket.push(columnSuggestion(c, t.name));
      }
    }
    // Then tables, then the dialect's keywords + functions.
    const schemaItems = [...refCols, ...otherCols];
    for (const t of schema.tables) {
      if (prefix(t.name)) schemaItems.push(tableSuggestion(t.name));
    }
    // Keywords matched as a PHRASE (longest candidate that hits anything).
    // These lead the list: they account for more of what the user typed than a
    // single-word match does.
    const keywords = keywordsFor(opts?.engine);
    const phraseItems: Suggestion[] = [];
    let phraseFrom = from;
    for (const start of phraseStarts) {
      const pl = text
        .slice(start, caret)
        .toLowerCase()
        .replace(/[ \t]+/g, " ");
      for (const kw of keywords) {
        if (kw.toLowerCase().startsWith(pl)) phraseItems.push(keywordSuggestion(kw));
      }
      if (phraseItems.length > 0) {
        phraseFrom = start;
        break;
      }
    }
    // Then the plain single-word matches — SUPPRESSED when a phrase matched:
    // re-basing them onto the wider range would spell nonsense ("IS " + "NOT
    // IN") or duplicate a phrase row ("LEFT " + "ARRAY JOIN").
    const wordItems: Suggestion[] = [];
    if (phraseItems.length === 0) {
      for (const kw of keywords) {
        if (prefix(kw)) wordItems.push(keywordSuggestion(kw));
      }
      for (const fn of functionsFor(opts?.engine)) {
        if (prefix(fn)) wordItems.push(functionSuggestion(fn));
      }
    }
    // Trim schema rows (never the keywords) so the reserved slots survive the
    // MAX_OPTIONS slice below — see KEYWORD_SLOTS.
    const kwCount = phraseItems.length + wordItems.length;
    const schemaRows = schemaItems.slice(0, MAX_OPTIONS - Math.min(kwCount, KEYWORD_SLOTS));
    // A phrase match replaces MORE text than a column row does, and a result
    // carries ONE range — so widen the range to the phrase and re-base the
    // schema inserts onto it by re-attaching the words it spans ("ON " + col).
    if (phraseItems.length > 0) {
      const lead = text.slice(phraseFrom, from);
      for (const it of schemaRows) it.insert = lead + it.insert;
    }
    items.push(...phraseItems, ...schemaRows, ...wordItems);
    if (items.length === 0) return null;
    return { from: phraseFrom, to: caret, items: items.slice(0, MAX_OPTIONS) };
  }

  if (items.length === 0) return null;
  return { from, to: caret, items: items.slice(0, MAX_OPTIONS) };
}
