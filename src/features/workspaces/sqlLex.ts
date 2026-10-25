// Minimal lexical skipping for SQL text scanners.
//
// Several modules walk a SQL buffer looking for ONE kind of character and must
// not be fooled by one that sits inside a string, a quoted identifier or a
// comment: `sqlStatement.ts` hunts statement-terminating semicolons, and
// `sqlParams.ts` hunts `:param` placeholders. The "is this position real code?"
// rules are identical for both and live here so there is a single place where
// SQL's quoting quirks are encoded.
//
// Deliberately NOT a tokenizer: it recognises only the spans a scanner has to
// jump OVER, and knows nothing about keywords, operators or expressions.

/** A Postgres dollar-quote OPENING delimiter at the current position: `$$` or a
 *  tagged `$tag$` (tag = letter/underscore then word chars). Sticky — only
 *  matches at `lastIndex`. A bare `$1` positional parameter does NOT match (no
 *  closing `$` after the digit). */
const DOLLAR_QUOTE_OPEN = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/y;

/**
 * If a non-code span starts at `i`, the offset just past its end; otherwise
 * `null` (the character at `i` is code — the caller handles it).
 *
 * The spans recognised, with the dialect each comes from:
 *
 * - `'…'` string literals and `"…"` quoted identifiers, where a DOUBLED quote
 *   (`''` / `""`) is an escaped quote rather than the close.
 * - `` `…` `` MySQL backtick identifiers.
 * - `[…]` SQL Server bracket identifiers. Narrowly gated (see below) because
 *   `[` is also an array subscript in Postgres.
 * - `-- …` line comments, to end of line.
 * - `/* … *\/` block comments. Unterminated ones run to end of buffer, which
 *   matches how engines treat them: everything after is commented out.
 * - `$$ … $$` / `$tag$ … $tag$` Postgres dollar-quoted bodies (function and
 *   procedure sources), where a `;` is routine body, not a statement end.
 *
 * An unterminated literal consumes the rest of the buffer. That is the right
 * answer for a half-typed query: the characters after an open quote are inside
 * a string as far as the engine is concerned, so a scanner must not act on
 * them.
 */
export function skipNonCode(doc: string, i: number): number | null {
  const n = doc.length;
  const c = doc[i];

  // String literal / quoted identifier. A doubled quote is an escape.
  if (c === "'" || c === '"' || c === "`") {
    let j = i + 1;
    while (j < n) {
      if (doc[j] === c) {
        if (doc[j + 1] === c) {
          j += 2;
          continue;
        }
        return j + 1;
      }
      j++;
    }
    return n;
  }

  // Line comment.
  if (c === "-" && doc[i + 1] === "-") {
    let j = i + 2;
    while (j < n && doc[j] !== "\n") j++;
    return j;
  }

  // Block comment. Unterminated runs to the end of the buffer.
  if (c === "/" && doc[i + 1] === "*") {
    const end = doc.indexOf("*/", i + 2);
    return end === -1 ? n : end + 2;
  }

  // Postgres dollar-quoted body.
  if (c === "$") {
    DOLLAR_QUOTE_OPEN.lastIndex = i;
    const m = DOLLAR_QUOTE_OPEN.exec(doc);
    if (m) {
      const delim = m[0];
      const end = doc.indexOf(delim, i + delim.length);
      return end === -1 ? n : end + delim.length;
    }
  }

  return null;
}

/**
 * Like {@link skipNonCode} but also treats a SQL Server `[bracket identifier]`
 * as a non-code span.
 *
 * Separate from `skipNonCode` on purpose: `[` is a bracket identifier in T-SQL
 * but an array subscript in Postgres (`tags[1]`), so skipping it unconditionally
 * would swallow real code. Only callers that gain something from it opt in —
 * the parameter scanner does, because `WHERE [a:b] = 1` is not a placeholder
 * and a subscript never contains one either, so skipping brackets is safe for
 * BOTH dialects there. The statement splitter does not, because a `;` cannot
 * appear in a subscript anyway and it must stay dialect-neutral.
 */
export function skipNonCodeOrBracket(doc: string, i: number): number | null {
  if (doc[i] === "[") {
    const end = doc.indexOf("]", i + 1);
    return end === -1 ? doc.length : end + 1;
  }
  return skipNonCode(doc, i);
}
