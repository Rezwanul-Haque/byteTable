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
//   - Matching is case-insensitive PREFIX match on the current word; ordering
//     is the array order returned here (no fuzzy re-sort downstream).

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

/** Curated SQL keywords offered as completions (multi-word phrases included so
 *  e.g. "gro" → "GROUP BY"). Uppercased on insert to match SQL house style. */
const KEYWORDS = [
  "SELECT",
  "FROM",
  "WHERE",
  "GROUP BY",
  "ORDER BY",
  "HAVING",
  "LIMIT",
  "OFFSET",
  "JOIN",
  "LEFT JOIN",
  "RIGHT JOIN",
  "INNER JOIN",
  "OUTER JOIN",
  "ON",
  "AS",
  "AND",
  "OR",
  "NOT",
  "IN",
  "IS NULL",
  "IS NOT NULL",
  "LIKE",
  "BETWEEN",
  "EXISTS",
  "DISTINCT",
  "UNION",
  "UNION ALL",
  "ASC",
  "DESC",
  "INSERT INTO",
  "VALUES",
  "UPDATE",
  "SET",
  "DELETE FROM",
  "CREATE TABLE",
  "ALTER TABLE",
  "DROP TABLE",
];

/** Aggregate / scalar functions. The trailing `(` is part of the insert, and
 *  the caret lands inside the parens (no trailing space — per the spec). */
const FUNCTIONS = [
  "COUNT(",
  "SUM(",
  "AVG(",
  "MIN(",
  "MAX(",
  "COALESCE(",
  "NOW(",
  "LENGTH(",
  "LOWER(",
  "UPPER(",
  "ABS(",
  "ROUND(",
];

/** Hard cap on rows returned — keeps the popup scroll bounded on wide schemas. */
const MAX_OPTIONS = 60;

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
 */
export function suggestSql(
  text: string,
  caret: number,
  schema: EditorSchema,
  opts?: { explicit?: boolean },
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
    items.push(...refCols, ...otherCols);
    // Then tables, then keywords + functions.
    for (const t of schema.tables) {
      if (prefix(t.name)) items.push(tableSuggestion(t.name));
    }
    for (const kw of KEYWORDS) {
      if (prefix(kw)) items.push(keywordSuggestion(kw));
    }
    for (const fn of FUNCTIONS) {
      if (prefix(fn)) items.push(functionSuggestion(fn));
    }
  }

  if (items.length === 0) return null;
  return { from, to: caret, items: items.slice(0, MAX_OPTIONS) };
}
