// JsonField — a JSON editor with live syntax highlighting and validation.
//
// A transparent-text <textarea> sits over a <pre> highlight layer, their scroll
// positions kept in sync; the caret and selection are the real textarea's, so
// this stays a plain editable field rather than a code-editor emulation. Below
// it, a footer says whether the text parses and offers format / minify.
//
// Shared by the SQL row inspector (JSON columns) and the DynamoDB item drawer
// (`M` maps, `L` lists and the three set types, which all edit as JSON). It
// lives in `browse/shared` so neither engine slice imports the other's.
//
// The caller owns the text and what an empty field means: SQL stores NULL for an
// empty JSON column, DynamoDB keeps an empty string. So `onChange` hands back
// the raw text and each host decides.

import { useRef } from "react";

import { Icon } from "../../../shared/ui/Icon";
import { highlightJSON, validateJSON } from "./jsonCell";
import "./CellEditors.css";
import "./JsonField.css";

/** Line height (px) of the code area, matched by `.ri-json-hl` / `.ri-json-ta`. */
const LINE_H = 17;
const PAD_Y = 14;

export function JsonField({
  text,
  onChange,
  placeholder = "null",
  minRows = 3,
  maxRows = 10,
}: {
  /** The exact text to show — the caller decides how a value becomes text. */
  text: string;
  onChange: (text: string) => void;
  placeholder?: string;
  minRows?: number;
  maxRows?: number;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const hlRef = useRef<HTMLPreElement>(null);

  const check = validateJSON(text);
  // The highlight layer must scroll with the textarea or the colours slide off
  // the characters they belong to.
  const syncScroll = () => {
    if (taRef.current && hlRef.current) {
      hlRef.current.scrollTop = taRef.current.scrollTop;
      hlRef.current.scrollLeft = taRef.current.scrollLeft;
    }
  };
  const rows = Math.min(maxRows, Math.max(minRows, text.split("\n").length));

  return (
    <div className={"ri-json" + (!check.ok ? " bad" : "")}>
      <div className="ri-json-code" style={{ height: rows * LINE_H + PAD_Y }}>
        <pre
          className="ri-json-hl"
          ref={hlRef}
          aria-hidden="true"
          // `highlightJSON` escapes &, < and > before wrapping tokens, so the
          // only markup here is its own.
          dangerouslySetInnerHTML={{ __html: highlightJSON(text) + "\n" }}
        />
        <textarea
          ref={taRef}
          className="ri-json-ta"
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          value={text}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onScroll={syncScroll}
          aria-label="JSON value"
        />
      </div>
      <div className="ri-json-foot">
        {check.ok ? (
          <span className="ri-json-ok">
            <Icon name="check_circle" size={12} /> valid json
          </span>
        ) : (
          <span className="ri-json-err">
            <Icon name="error" size={12} /> {check.message}
          </span>
        )}
        <div style={{ flex: 1 }} />
        <button
          type="button"
          className="ri-mini-btn"
          disabled={!check.ok || check.empty}
          title="Pretty-print"
          onClick={() => onChange(JSON.stringify(JSON.parse(text), null, 2))}
        >
          format
        </button>
        <button
          type="button"
          className="ri-mini-btn"
          disabled={!check.ok || check.empty}
          title="Minify"
          onClick={() => onChange(JSON.stringify(JSON.parse(text)))}
        >
          minify
        </button>
      </div>
    </div>
  );
}
