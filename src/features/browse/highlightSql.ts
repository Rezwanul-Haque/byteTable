// SQL syntax highlighter for static, read-only display (M7 structure view's
// DDL preview + modal, §3.6). Ported from the prototype's `highlightSQL`
// (editor.jsx) so the palette matches the §3.7 SqlCodeEditor:
//   keyword  → .sql-kw     (var(--accent), weight 500)
//   string   → .sql-string (#e5c07b)
//   number   → .sql-num    (#7fb8e8)
//   function → .sql-func   (#c678dd)
//   comment  → .sql-comment(var(--text-faint), italic)
//
// WHY regex (not CodeMirror): the DDL is shown read-only — a CodeMirror
// instance (SqlCodeEditor) is an interactive editor with onChange/onRun and
// is the wrong tool for static markup. The input is HTML-escaped first, then
// tokens are stashed behind control-char placeholders (NUL + repeated SOH,
// neither a word char nor a digit), so no later pass can match inside an
// already-emitted span. The returned string is safe to inject via
// dangerouslySetInnerHTML.

const SQL_KEYWORDS =
  /\b(select|from|where|and|or|not|order|group|by|asc|desc|limit|offset|like|in|is|null|as|distinct|insert|update|delete|set|values|join|left|right|inner|on|having|union|create|table|drop|alter|primary|key|foreign|references|default|unique|index|constraint|check|collate|autoincrement|without|rowid|integer|text|real|blob|numeric|boolean|date|timestamp|varchar|char|bigint|cascade|restrict|action|deferrable)\b/gi;
const SQL_FUNCS = /\b(count|sum|avg|min|max|coalesce|now|length|lower|upper|abs|round)\s*(?=\()/gi;

// Control-char placeholder delimiters (NUL = U+0000, SOH = U+0001).
const NUL = String.fromCharCode(0);
const SOH = String.fromCharCode(1);
const PLACEHOLDER_RE = new RegExp(NUL + "(" + SOH + "+)" + NUL, "g");

/** Highlight SQL into HTML markup (escaped + token spans). */
export function highlightSql(sql: string): string {
  let html = sql.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const slots: string[] = [];
  const stash = (str: string, cls: string): string => {
    slots.push('<span class="sql-' + cls + '">' + str + "</span>");
    return NUL + SOH.repeat(slots.length) + NUL;
  };
  html = html.replace(/--[^\n]*/g, (m) => stash(m, "comment"));
  html = html.replace(/'(?:[^']|'')*'/g, (m) => stash(m, "string"));
  html = html.replace(SQL_FUNCS, (m) => stash(m, "func"));
  html = html.replace(SQL_KEYWORDS, (m) => stash(m, "kw"));
  html = html.replace(/\b\d+(\.\d+)?\b/g, (m) => stash(m, "num"));
  html = html.replace(PLACEHOLDER_RE, (_, ones: string) => slots[ones.length - 1] ?? "");
  return html;
}
