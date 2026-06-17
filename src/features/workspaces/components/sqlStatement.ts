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

/** Offsets of every top-level `;` (those that actually terminate a statement). */
function topLevelSemicolons(doc: string): number[] {
  const semis: number[] = [];
  const n = doc.length;
  let i = 0;
  while (i < n) {
    const c = doc[i];
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
    if (c === ";") {
      semis.push(i);
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
