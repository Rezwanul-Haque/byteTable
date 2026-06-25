// Statement-at-cursor resolution for the SQL editor (⌘/Ctrl+Enter).
//
// A buffer may hold several `;`-separated statements. Running the WHOLE buffer
// when the cursor sits in (or just after) one statement is wrong — e.g. with
// the caret right after the first semicolon, only the statement BEFORE that
// semicolon should run. This module splits the buffer into statement ranges
// and picks the one the caret belongs to.
//
// Splitting respects SQL lexical context so a `;` inside a string, a quoted
// identifier, a line comment (-- …) or a block comment (/* … */) does NOT end
// a statement. The returned range is trimmed of surrounding whitespace and the
// trailing semicolon, so the engine receives just the statement text.

export interface StatementRange {
  /** Inclusive start offset of the trimmed statement. */
  from: number;
  /** Exclusive end offset of the trimmed statement. */
  to: number;
}

/** A Postgres dollar-quote OPENING delimiter at the current position: `$$` or a
 *  tagged `$tag$` (tag = letter/underscore then word chars). Sticky — only
 *  matches at `lastIndex`. A bare `$1` positional parameter does NOT match (no
 *  closing `$` after the digit). */
const DOLLAR_QUOTE_OPEN = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/y;

const WORD_CHAR = /[A-Za-z0-9_]/;
/** A transaction-control keyword right after `BEGIN` (so `BEGIN; …` /
 *  `BEGIN TRANSACTION` is NOT treated as a compound block). */
const TXN_AFTER_BEGIN = /^(transaction|deferred|immediate|exclusive|work)\b/i;

/** Offsets of every top-level `;` (those that actually terminate a statement).
 *  A `;` inside a `BEGIN … END` (trigger / routine body) or `CASE … END` block
 *  does NOT terminate the statement — those blocks raise the nesting depth and
 *  only a `;` at depth 0 splits. */
function topLevelSemicolons(doc: string): number[] {
  const semis: number[] = [];
  const n = doc.length;
  let i = 0;
  let depth = 0; // BEGIN/CASE block nesting
  while (i < n) {
    const c = doc[i];
    // Identifier / keyword: consume the whole word and track BEGIN/CASE/END
    // depth (skip it in one go so keywords inside words don't false-match).
    if (c !== undefined && /[A-Za-z_]/.test(c) && !(i > 0 && WORD_CHAR.test(doc[i - 1]!))) {
      let j = i + 1;
      while (j < n && WORD_CHAR.test(doc[j]!)) j++;
      const word = doc.slice(i, j).toUpperCase();
      if (word === "CASE") {
        depth++;
      } else if (word === "END") {
        if (depth > 0) depth--;
      } else if (word === "BEGIN") {
        // A compound-block BEGIN raises depth; a transaction BEGIN (`BEGIN;`,
        // `BEGIN TRANSACTION`, …) does not — it's its own statement.
        let k = j;
        while (k < n && /\s/.test(doc[k]!)) k++;
        const isTxn = k >= n || doc[k] === ";" || TXN_AFTER_BEGIN.test(doc.slice(k, k + 12));
        if (!isTxn) depth++;
      }
      i = j;
      continue;
    }
    // String literal or quoted identifier: skip to the matching quote,
    // treating a doubled quote ('' or "") as an escaped quote, not a close.
    if (c === "'" || c === '"') {
      const quote = c;
      i++;
      while (i < n) {
        if (doc[i] === quote) {
          if (doc[i + 1] === quote) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    // Line comment: skip to end of line.
    if (c === "-" && doc[i + 1] === "-") {
      i += 2;
      while (i < n && doc[i] !== "\n") i++;
      continue;
    }
    // Block comment: skip to the closing */.
    if (c === "/" && doc[i + 1] === "*") {
      i += 2;
      while (i < n && !(doc[i] === "*" && doc[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    // Dollar-quoted string (Postgres `$$ … $$` / `$tag$ … $tag$`): a `;` inside
    // a function/procedure body must NOT terminate the statement. Skip to the
    // matching closing delimiter.
    if (c === "$") {
      DOLLAR_QUOTE_OPEN.lastIndex = i;
      const m = DOLLAR_QUOTE_OPEN.exec(doc);
      if (m) {
        const delim = m[0];
        const end = doc.indexOf(delim, i + delim.length);
        i = end === -1 ? n : end + delim.length;
        continue;
      }
    }
    if (c === ";") {
      if (depth === 0) semis.push(i);
    }
    i++;
  }
  return semis;
}

/** Trim leading whitespace and trailing whitespace + semicolons from a range. */
function trim(doc: string, from: number, to: number): StatementRange {
  let a = from;
  let b = to;
  while (a < b && /\s/.test(doc.charAt(a))) a++;
  while (b > a && (/\s/.test(doc.charAt(b - 1)) || doc.charAt(b - 1) === ";")) b--;
  return { from: a, to: b };
}

/**
 * The range of the statement the caret belongs to. Segments run from one
 * top-level semicolon to the next (the semicolon belongs to the segment that
 * precedes it); a caret at offset `pos` belongs to the segment where
 * `from < pos <= to`, so a caret sitting immediately after a `;` resolves to
 * the statement that just ended — the one BEFORE the semicolon.
 *
 * If the resolved segment is empty after trimming (e.g. the caret is in the
 * trailing whitespace after the final `;`), the search walks backwards to the
 * nearest non-empty statement. Returns null when the buffer has no statement.
 */
export function statementRangeAt(doc: string, pos: number): StatementRange | null {
  const n = doc.length;
  const semis = topLevelSemicolons(doc);

  // Raw segments, each including its terminating semicolon (last runs to EOF).
  const segments: { from: number; to: number }[] = [];
  let start = 0;
  for (const s of semis) {
    segments.push({ from: start, to: s + 1 });
    start = s + 1;
  }
  segments.push({ from: start, to: n });

  let idx = segments.findIndex((seg) => pos > seg.from && pos <= seg.to);
  if (idx === -1) idx = pos <= 0 ? 0 : segments.length - 1;

  // Walk back over empty/whitespace-only segments (e.g. caret after final ;).
  for (let k = idx; k >= 0; k--) {
    const seg = segments[k];
    if (!seg) continue;
    const r = trim(doc, seg.from, seg.to);
    if (r.to > r.from) return r;
  }
  return null;
}

/**
 * Split a buffer into its top-level statements, in order. Lexically aware (a
 * `;` inside a string, quoted identifier, or comment does NOT split), and each
 * returned string is trimmed of surrounding whitespace and its trailing `;`.
 * Empty segments (blank runs, a lone trailing `;`) are dropped.
 *
 * Used to run a multi-statement selection one statement at a time: the engines'
 * prepared-query path (`run_query`) accepts only a SINGLE statement, so a
 * multi-statement string would otherwise error.
 */
export function splitStatements(doc: string): string[] {
  const semis = topLevelSemicolons(doc);
  const out: string[] = [];
  let start = 0;
  for (const s of semis) {
    const r = trim(doc, start, s + 1);
    if (r.to > r.from) out.push(doc.slice(r.from, r.to));
    start = s + 1;
  }
  const tail = trim(doc, start, doc.length);
  if (tail.to > tail.from) out.push(doc.slice(tail.from, tail.to));
  return out;
}

export interface StatementContext {
  /** The text of the statement the caret is in (trimmed). */
  text: string;
  /** Zero-based index of that statement among the non-empty statements. */
  index: number;
  /** Total non-empty statements in the buffer. */
  count: number;
}

/**
 * The statement the caret is in, plus its position among all non-empty
 * statements — for the clause-order minimap's "Statement N of M" label.
 *
 * Boundary rule (Prompt 5): each statement's character range includes its
 * trailing semicolon, and we pick the first statement whose END is
 * greater-than-or-equal-to the caret; a caret sitting immediately after a `;`
 * (== that statement's end) therefore belongs to the statement that just
 * ended, not the next one. The caret is clamped to the last statement when it
 * is past the final semicolon.
 */
export function statementContextAt(doc: string, caret: number): StatementContext {
  const n = doc.length;
  const semis = topLevelSemicolons(doc);

  // Statements as ranges, each including its terminating semicolon.
  const ranges: { text: string; start: number; end: number }[] = [];
  let start = 0;
  for (const s of semis) {
    ranges.push({ text: doc.slice(start, s), start, end: s + 1 });
    start = s + 1;
  }
  if (start < n) ranges.push({ text: doc.slice(start), start, end: n });

  const nonEmpty = ranges.filter((r) => r.text.trim());
  if (nonEmpty.length <= 1) {
    return { text: doc, index: 0, count: nonEmpty.length || 1 };
  }
  const c = Math.max(0, Math.min(caret, n));
  const pick = nonEmpty.find((r) => c <= r.end) ?? nonEmpty[nonEmpty.length - 1]!;
  return { text: pick.text, index: nonEmpty.indexOf(pick), count: nonEmpty.length };
}
