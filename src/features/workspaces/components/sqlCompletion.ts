// Context-aware SQL autocomplete for the query editor (PROMPT_autocomplete).
//
// WHY a CodeMirror CompletionSource (not the prototype's mirror-a-textarea
// popup): the real editor is CodeMirror 6 (SqlCodeEditor), so caret-positioned
// popup placement, ↑/↓ navigation, Enter/Tab/Esc handling, mouse hover/click,
// and dismiss-on-blur all come from `@codemirror/autocomplete` for free. We
// supply only the *content* (a `CompletionSource`) and the *look* — the design's
// `.ac-popup` / `.ac-item` / `.ac-label` / `.ac-hint` / `.ac-kind` rows, themed
// onto CM's tooltip structure (see SqlCodeEditor.css).
//
// SUGGESTION SOURCE (spec Note): the active connection's introspected schema —
// table names + each table's columns (with primary-key flags) — passed in from
// the SQL tab's cache. No per-keystroke backend calls: the source reads a live
// snapshot the tab keeps warm.
//
// BEHAVIOUR:
//   - Right after FROM / JOIN / INTO / UPDATE (incl. comma-separated lists),
//     suggest TABLE names — even before any letters are typed.
//   - Otherwise suggest COLUMN names first, prioritising columns of tables
//     already referenced in the current statement (each row shows its source
//     table as a hint and a key icon for primary keys), then table names, then
//     SQL keywords and functions.
//   - Matching is case-insensitive PREFIX match on the current word (filtering
//     and ordering are ours; CM's fuzzy filter is turned off).

import {
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";

import { statementRangeAt } from "./sqlStatement";

/** One column the editor can suggest (subset of the introspected ColumnInfo). */
export interface EditorSchemaColumn {
  name: string;
  /** Part of the primary key — drives the key icon. */
  pk: boolean;
}

/** One table the editor can suggest, with whatever columns are cached. */
export interface EditorSchemaTable {
  name: string;
  /** Columns, when the table's introspection has been loaded (else empty). */
  columns: EditorSchemaColumn[];
}

/** The schema snapshot the completion source reads (active connection/schema). */
export interface EditorSchema {
  tables: EditorSchemaTable[];
}

/** Kind tag shown on each row (and used to pick the leading icon). */
type Kind = "table" | "column" | "keyword" | "fn";

/** A completion enriched with the fields the design's row renders. */
export interface BtCompletion extends Completion {
  btKind: Kind;
  /** Source table for a column row (the `.ac-hint`). */
  btSource?: string;
  /** Material Symbols glyph name for the leading icon. */
  btIcon: string;
  /** Primary-key column — renders the key icon in accent. */
  btPk?: boolean;
}

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

/** Hard cap on rows shown — keeps the popup scroll bounded on wide schemas. */
const MAX_OPTIONS = 60;

/** Material Symbols glyph per kind (matches the sidebar's table/key icons). */
const ICON: Record<Kind, string> = {
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

function tableOption(name: string): BtCompletion {
  return { label: name, btKind: "table", btIcon: ICON.table };
}

function columnOption(col: EditorSchemaColumn, source: string): BtCompletion {
  return {
    label: col.name,
    btKind: "column",
    btSource: source,
    btPk: col.pk,
    btIcon: col.pk ? "key" : ICON.column,
  };
}

function keywordOption(kw: string): BtCompletion {
  return { label: kw, btKind: "keyword", btIcon: ICON.keyword };
}

function functionOption(fn: string): BtCompletion {
  // displayLabel keeps the `(` visible; the insert (label) carries it too, so
  // the caret ends just inside the parens with no trailing space.
  return { label: fn, displayLabel: fn, btKind: "fn", btIcon: ICON.fn };
}

/**
 * Build the CompletionSource. `getSchema` is read on every invocation so the
 * source always sees the latest cached schema (columns stream in as the tab
 * warms them) without re-creating the editor's extensions.
 */
export function makeSqlCompletionSource(getSchema: () => EditorSchema) {
  return (context: CompletionContext): CompletionResult | null => {
    const { state, pos, explicit } = context;
    const doc = state.doc.toString();

    // Scope context to the statement the caret sits in (multi-statement buffers).
    const range = statementRangeAt(doc, pos) ?? { from: 0, to: doc.length };
    const stmtStart = Math.min(range.from, pos);
    const beforeStripped = stripNonCode(doc.slice(stmtStart, pos));

    const wordMatch = context.matchBefore(/[\w$]+/);
    const word = wordMatch ? wordMatch.text : "";
    const wl = word.toLowerCase();
    const prefix = (s: string): boolean => s.toLowerCase().startsWith(wl);

    // Table context: caret right after FROM/JOIN/INTO/UPDATE — allowing a
    // partly-typed name and comma-separated table lists (`FROM a, b█`).
    const tableMode = /\b(?:from|join|into|update)\s+(?:[a-z_][\w$]*\s*,\s*)*[\w$]*$/i.test(
      beforeStripped,
    );

    // Otherwise only fire once a word has begun (or on explicit Ctrl/Cmd+Space)
    // — typing whitespace shouldn't pop the column/keyword list.
    if (!tableMode && !word && !explicit) return null;

    const schema = getSchema();
    const from = wordMatch ? wordMatch.from : pos;
    const options: BtCompletion[] = [];

    if (tableMode) {
      for (const t of schema.tables) {
        if (prefix(t.name)) options.push(tableOption(t.name));
      }
    } else {
      const referenced = referencedTables(stripNonCode(doc.slice(range.from, range.to)));
      // Columns first, with referenced-table columns ahead of the rest.
      const refCols: BtCompletion[] = [];
      const otherCols: BtCompletion[] = [];
      for (const t of schema.tables) {
        const bucket = referenced.has(t.name.toLowerCase()) ? refCols : otherCols;
        for (const c of t.columns) {
          if (prefix(c.name)) bucket.push(columnOption(c, t.name));
        }
      }
      options.push(...refCols, ...otherCols);
      // Then tables, then keywords + functions.
      for (const t of schema.tables) {
        if (prefix(t.name)) options.push(tableOption(t.name));
      }
      for (const kw of KEYWORDS) {
        if (prefix(kw)) options.push(keywordOption(kw));
      }
      for (const fn of FUNCTIONS) {
        if (prefix(fn)) options.push(functionOption(fn));
      }
    }

    if (options.length === 0) return null;
    // filter:false — we already prefix-filtered and ordered; CM must not
    // re-sort or fuzzy-narrow. No validFor, so the source re-runs per keystroke
    // (cheap, pure JS) and re-derives context/ordering each time.
    return { from, to: pos, options: options.slice(0, MAX_OPTIONS), filter: false };
  };
}

// ---- row rendering (themed to the design's .ac-* row) ---------------------

const KIND_LABEL: Record<Kind, string> = {
  table: "table",
  column: "column",
  keyword: "keyword",
  fn: "fn",
};

/** Class added to every option `<li>` so the design's `.ac-item` flex row
 *  applies. (Selected state is CM's `[aria-selected]`, themed in the CSS.) */
export function completionOptionClass(): string {
  return "ac-item";
}

/** Class added to the popup container so the design's `.ac-popup` box applies. */
export function completionTooltipClass(): string {
  return "ac-popup";
}

/** Leading type/key icon (position 10 — before CM's empty default icon slot). */
function renderIcon(completion: Completion): Node | null {
  const c = completion as BtCompletion;
  const span = document.createElement("span");
  span.className = "msym ac-icon ac-icon-" + c.btKind + (c.btPk ? " ac-icon-pk" : "");
  span.textContent = c.btIcon;
  return span;
}

/** Source-table hint for a column row (position 70). */
function renderHint(completion: Completion): Node | null {
  const c = completion as BtCompletion;
  if (c.btKind !== "column" || !c.btSource) return null;
  const span = document.createElement("span");
  span.className = "ac-hint";
  span.textContent = c.btSource;
  return span;
}

/** Kind tag at the right edge (position 90). */
function renderKind(completion: Completion): Node | null {
  const c = completion as BtCompletion;
  const span = document.createElement("span");
  span.className = "ac-kind";
  span.textContent = KIND_LABEL[c.btKind];
  return span;
}

/** Extra render columns injected into each option, alongside CM's default
 *  label slot (themed as `.ac-label`). */
export const completionAddToOptions = [
  { render: renderIcon, position: 10 },
  { render: renderHint, position: 70 },
  { render: renderKind, position: 90 },
];
