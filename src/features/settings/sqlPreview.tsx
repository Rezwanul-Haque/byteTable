// Tiny syntax highlighter for the Fonts tab preview (M20.4). The prototype
// reuses the editor's window.highlightSQL; here we tokenize the fixed sample
// into colored spans with no dependency and — crucially — no `.sql-highlight`
// overlay class (which is position:absolute and would escape the modal).

import { Fragment, type ReactNode } from "react";

const KEYWORDS = new Set([
  "SELECT",
  "FROM",
  "WHERE",
  "ORDER",
  "BY",
  "LIMIT",
  "GROUP",
  "HAVING",
  "JOIN",
  "LEFT",
  "RIGHT",
  "INNER",
  "ON",
  "AS",
  "AND",
  "OR",
  "NOT",
  "DESC",
  "ASC",
  "INSERT",
  "UPDATE",
  "DELETE",
]);

// One regex, alternation ordered so comments/strings win over words/numbers.
const TOKEN = /(--[^\n]*)|('[^']*')|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)/g;

function colorFor(
  text: string,
  kind: "comment" | "string" | "number" | "word",
): string | undefined {
  if (kind === "comment") return "var(--text-faint)";
  if (kind === "string") return "var(--string)";
  if (kind === "number") return "var(--number)";
  if (kind === "word" && KEYWORDS.has(text.toUpperCase())) return "var(--purple)";
  return undefined;
}

/** Render the SQL sample as highlighted spans. */
export function renderSqlPreview(sample: string): ReactNode {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(sample)) !== null) {
    if (m.index > last) out.push(<Fragment key={key++}>{sample.slice(last, m.index)}</Fragment>);
    const [text] = m;
    const kind = m[1] ? "comment" : m[2] ? "string" : m[3] ? "number" : "word";
    const color = colorFor(text, kind);
    out.push(
      color ? (
        <span key={key++} style={{ color }}>
          {text}
        </span>
      ) : (
        <Fragment key={key++}>{text}</Fragment>
      ),
    );
    last = m.index + text.length;
  }
  if (last < sample.length) out.push(<Fragment key={key++}>{sample.slice(last)}</Fragment>);
  return out;
}
