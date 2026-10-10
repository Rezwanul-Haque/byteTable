// Syntax-coloured JSON, used twice: as the sample-data snippet's rendered body,
// and as the highlight layer behind that snippet's editor.
//
// Both callers get the SAME element tree from the same tokens, which is what
// keeps the text in the editor sitting exactly on top of the colours behind it.

import { highlightJson } from "../json";

/** Token kind → class. Colours live in Board.css with the rest of the board. */
const CLASS = {
  key: "bb-json-key",
  string: "bb-json-string",
  number: "bb-json-number",
  keyword: "bb-json-keyword",
  punct: "bb-json-punct",
} as const;

export function JsonText({ text }: { text: string }) {
  return (
    <>
      {highlightJson(text).map((token, i) => (
        <span key={i} className={CLASS[token.kind]}>
          {token.text}
        </span>
      ))}
    </>
  );
}
