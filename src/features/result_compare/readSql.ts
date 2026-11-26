// Which statements Compare will send (M51 rule 3: read-only). A port of the
// backend's `shared::readonly::sql_is_read_only`, so a refused side never
// leaves the renderer; the backend runs the same test again before it sends
// anything, and that one is the guard.
//
// Lexical and conservative: comments, string literals and quoted identifiers
// are blanked out, then every `;`-separated statement must open with a read
// keyword and carry no keyword that turns it into a write.

const READ_LEADERS = new Set([
  "select",
  "with",
  "show",
  "describe",
  "desc",
  "explain",
  "table",
  "values",
  "pragma",
]);

const TAIL_HAZARDS = new Set(
  (
    "insert update delete drop create alter truncate merge into grant revoke call exec execute " +
    "do copy load attach detach vacuum analyze refresh reindex optimize rename lock unlock begin " +
    "commit rollback savepoint set reset kill flush shutdown checkpoint repair prepare deallocate " +
    "declare backup restore"
  ).split(" "),
);

/** Blank comments, quoted spans and `[bracketed]` identifiers, keeping positions. */
function strip(sql: string): string {
  let out = "";
  let i = 0;
  const blank = (n: number) => " ".repeat(n);
  while (i < sql.length) {
    const ch = sql[i]!;
    if ((ch === "-" && sql[i + 1] === "-") || ch === "#") {
      const nl = sql.indexOf("\n", i);
      const end = nl < 0 ? sql.length : nl;
      out += blank(end - i);
      i = end;
    } else if (ch === "/" && sql[i + 1] === "*") {
      const close = sql.indexOf("*/", i + 2);
      const end = close < 0 ? sql.length : close + 2;
      out += blank(end - i);
      i = end;
    } else if (ch === "'" || ch === '"' || ch === "`") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) {
            j += 2; // a doubled quote is an escaped quote
            continue;
          }
          j += 1;
          break;
        }
        j += 1;
      }
      out += blank(j - i);
      i = j;
    } else if (ch === "[") {
      const close = sql.indexOf("]", i);
      const end = close < 0 ? sql.length : close + 1;
      out += blank(end - i);
      i = end;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

/** The non-blank statements of `sql`, literals blanked. */
function statements(sql: string): string[] {
  return strip(sql)
    .split(";")
    .filter((s) => s.trim() !== "");
}

/** True when `sql` provably only reads (see the module comment). */
export function isReadOnlySql(sql: string): boolean {
  for (const stmt of statements(sql)) {
    const words = [...stmt.matchAll(/[\p{L}\p{N}_]+/gu)].map((m) => ({
      word: m[0].toLowerCase(),
      call: stmt[m.index + m[0].length] === "(",
    }));
    const leader = words[0]?.word;
    if (!leader || !READ_LEADERS.has(leader)) return false;
    if (leader === "show" || leader === "describe" || leader === "desc") continue;
    if (leader === "pragma") {
      if (stmt.includes("=")) return false;
      continue;
    }
    if (words.some((w) => TAIL_HAZARDS.has(w.word) && !w.call)) return false;
  }
  return true;
}

/** More than one statement (Compare runs exactly one per side). */
export function isMultiStatement(sql: string): boolean {
  return statements(sql).length > 1;
}
