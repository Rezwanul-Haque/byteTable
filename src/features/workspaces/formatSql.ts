// Lightweight SQL beautifier for the editor's Format action (⇧⌥F / wand FAB).
// Ported from the prototype's formatSQL/formatOne. It is intentionally simple —
// a regex pretty-printer, not a parser — and aims to make hand-written queries
// readable, not to canonicalize every dialect.
//
// Layout rules:
//   • each major clause (SELECT/FROM/WHERE/GROUP BY/…/joins/UNION/…) on its own line
//   • a multi-column SELECT list breaks one column per indented line
//   • AND / OR break onto indented lines
//   • keywords and common functions upper-case
//
// Multi-statement input (Prompt 3): split on TOP-LEVEL semicolons (ignoring
// semicolons inside quoted strings), format each statement independently, and
// join them with a blank line between statements, each keeping a trailing `;`.

const CLAUSES = [
  "select",
  "from",
  "where",
  "group by",
  "having",
  "order by",
  "limit",
  "offset",
  "union all",
  "union",
  "left join",
  "right join",
  "inner join",
  "outer join",
  "join",
  "values",
  "set",
];

const INLINE_KEYWORDS =
  /\b(as|on|using|distinct|asc|desc|in|is|not|null|like|between|case|when|then|else|end|count|sum|avg|min|max|coalesce)\b/gi;

/** Format a single statement (no trailing semicolon). */
function formatOne(sql: string): string {
  let s = sql.replace(/\s+/g, " ").trim();
  if (!s) return s;
  // Newline before each major clause (and upper-case it).
  CLAUSES.forEach((kw) => {
    const pat = kw.replace(/ /g, "\\s+");
    s = s.replace(new RegExp("\\s+" + pat + "\\b", "gi"), "\n" + kw.toUpperCase());
    s = s.replace(new RegExp("^" + pat + "\\b", "i"), kw.toUpperCase());
  });
  // AND / OR onto indented new lines (within WHERE/HAVING/ON).
  s = s.replace(/\s+\b(and|or)\b\s+/gi, (_m, op: string) => "\n  " + op.toUpperCase() + " ");
  // Upper-case common inline keywords / functions.
  s = s.replace(INLINE_KEYWORDS, (m) => m.toUpperCase());
  // Indent SELECT-list items: one per line under SELECT when there's >1.
  s = s.replace(/^SELECT\s+([\s\S]*?)(?=\nFROM\b)/i, (_m, cols: string) => {
    const parts = cols
      .split(/,(?![^(]*\))/)
      .map((p) => p.trim())
      .filter(Boolean);
    return parts.length > 1 ? "SELECT\n  " + parts.join(",\n  ") : "SELECT " + cols.trim();
  });
  return s;
}

/** Split on top-level semicolons (ignoring those inside quoted strings). */
function splitStatements(sql: string): string[] {
  const stmts: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === ";") {
      if (cur.trim()) stmts.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) stmts.push(cur.trim());
  return stmts;
}

/** Beautify the editor buffer (one or many statements). */
export function formatSql(sql: string): string {
  const raw = (sql || "").trim();
  if (!raw) return sql;
  const stmts = splitStatements(raw);
  if (stmts.length === 0) return sql;
  return stmts.map((st) => formatOne(st) + ";").join("\n\n");
}
