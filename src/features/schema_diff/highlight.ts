// DDL syntax highlighting for the migration plan and the Change DDL modal
// (M28) — the prototype's `sdHighlight`, as tokens rather than HTML.
//
// The prototype built an HTML string and injected it. We return segments the
// component renders as <span>s: same three classes (`sd-kw` / `sd-ty` /
// `sd-cm`), no `dangerouslySetInnerHTML`, and no chance of a table or column
// name being interpreted as markup.

/** A highlight class, or `null` for plain text. */
export type SqlTokenClass = "kw" | "ty" | "cm" | null;

/** One rendered run of SQL text. */
export interface SqlToken {
  text: string;
  cls: SqlTokenClass;
}

// Order matters: a `--` comment swallows the rest of the line before keywords
// or types inside it are considered, so the whole comment reads as one faint
// run (the prototype nested them; one flat comment run is calmer and matches
// the `-- was <oldtype>` trailer's intent).
const TOKEN =
  /(--[^\n]*)|\b(CREATE|TABLE|ALTER|ADD|DROP|COLUMN|MODIFY|TYPE|INDEX|ON|PRIMARY|KEY|NOT|NULL)\b|\b(?:INTEGER|BIGINT|TEXT|VARCHAR|CHAR|NUMERIC|BOOLEAN|TIMESTAMP|DATE|JSONB|UUID)(?:\(\d+(?:,\s*\d+)?\))?/g;

/**
 * Split `sql` into rendered runs: comments, keywords, types, and the plain text
 * between them. Concatenating every `text` reproduces the input exactly.
 */
export function highlightSql(sql: string): SqlToken[] {
  const out: SqlToken[] = [];
  let last = 0;
  // A fresh RegExp per call — the module-level literal carries `lastIndex`.
  const re = new RegExp(TOKEN.source, "g");
  let match = re.exec(sql);
  while (match !== null) {
    if (match.index > last) out.push({ text: sql.slice(last, match.index), cls: null });
    const cls: SqlTokenClass = match[1] !== undefined ? "cm" : match[2] !== undefined ? "kw" : "ty";
    out.push({ text: match[0], cls });
    last = match.index + match[0].length;
    match = re.exec(sql);
  }
  if (last < sql.length) out.push({ text: sql.slice(last), cls: null });
  return out;
}
