// Lexical JSON highlighting for the board's sample-data snippets.
//
// A LEXER, NOT A PARSER, on purpose. A snippet is free text that happens to be
// JSON most of the time: it is pasted mid-document, trimmed to the interesting
// fields, annotated with `…`, and — while someone is typing into it — invalid
// for most keystrokes. `JSON.parse` would give up on all of those and leave the
// block unstyled exactly when it is being worked on. Scanning for tokens instead
// degrades one token at a time: an unterminated string is simply not yet a
// string, and everything around it still colours.
//
// The output is LOSSLESS — concatenating every token's text returns the input
// verbatim, whitespace and all. That is what lets the same tokens back both the
// rendered block and the highlight layer behind the editor, where a single
// dropped character would slide the text out of line with the caret.

/** What a run of characters is. `punct` covers braces, colons, commas and the
 *  whitespace between them — everything that is not a value. */
export type JsonTokenKind = "key" | "string" | "number" | "keyword" | "punct";

export interface JsonToken {
  kind: JsonTokenKind;
  text: string;
}

/**
 * Strings, numbers and the three bare words. Order matters only for overlap,
 * and these cannot overlap; every alternative consumes at least one character,
 * so the scan below always advances.
 *
 * The string pattern allows newlines inside the quotes. Strict JSON does not,
 * but a snippet is often a pretty-printed payload someone has hand-wrapped, and
 * refusing to colour it would be pedantry at the user's expense.
 */
const TOKEN = /"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(?:true|false|null)\b/g;

/** Split `text` into highlightable runs. Never throws; any input is valid. */
export function highlightJson(text: string): JsonToken[] {
  const tokens: JsonToken[] = [];
  let last = 0;
  TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN.exec(text)) !== null) {
    if (match.index > last) tokens.push({ kind: "punct", text: text.slice(last, match.index) });
    const raw = match[0];
    last = match.index + raw.length;
    tokens.push({ kind: kindOf(raw, text.slice(last)), text: raw });
  }
  if (last < text.length) tokens.push({ kind: "punct", text: text.slice(last) });
  return tokens;
}

/** A quoted run is a KEY when the next non-space character is a colon — the one
 *  piece of context worth tracking, and the one that makes a payload readable
 *  at a glance. */
function kindOf(raw: string, rest: string): JsonTokenKind {
  if (raw.startsWith('"')) return /^\s*:/.test(rest) ? "key" : "string";
  if (raw === "true" || raw === "false" || raw === "null") return "keyword";
  return "number";
}
