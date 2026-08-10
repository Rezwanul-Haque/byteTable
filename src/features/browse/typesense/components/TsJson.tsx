// JSON syntax highlighter for the HTTP console (M30 Task 8, ported from
// typesense-shell.jsx `TsJson`): keys accent, strings green, numbers amber,
// booleans/null purple, punctuation faint, wrapped for long values.
//
// Tokenizing with a single regex over `JSON.stringify(value, null, 2)` keeps
// this dependency-free and — because every run is rendered as a React text node
// — injection-safe by construction.

const TOKEN =
  /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([{}[\],])/g;

interface Part {
  text: string;
  cls: string | null;
}

/** Split pretty-printed JSON into classified runs. Module-private: this file
 *  exports a component, and mixing component + non-component exports breaks
 *  react-refresh. */
function highlightJson(source: string): Part[] {
  const parts: Part[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(source))) {
    if (m.index > last) parts.push({ text: source.slice(last, m.index), cls: null });
    if (m[1]) {
      // A quoted string; the trailing colon (if any) makes it a key.
      parts.push({ text: m[1], cls: m[2] ? "tsj-k" : "tsj-s" });
      if (m[2]) parts.push({ text: m[2], cls: "tsj-p" });
    } else if (m[3]) {
      parts.push({ text: m[3], cls: "tsj-b" });
    } else if (m[4]) {
      parts.push({ text: m[4], cls: "tsj-n" });
    } else if (m[5]) {
      parts.push({ text: m[5], cls: "tsj-p" });
    }
    last = m.index + m[0].length;
  }
  if (last < source.length) parts.push({ text: source.slice(last), cls: null });
  return parts;
}

export function TsJson({ value }: { value: unknown }) {
  // A non-JSON body (an HTML error page from a proxy, say) arrives as a plain
  // string; print it as-is rather than quoting it.
  const source =
    typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? String(value));
  return (
    <pre className="ts-json">
      {highlightJson(source).map((p, i) =>
        p.cls ? (
          <span key={i} className={p.cls}>
            {p.text}
          </span>
        ) : (
          p.text
        ),
      )}
    </pre>
  );
}
