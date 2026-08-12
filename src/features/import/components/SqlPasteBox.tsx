// Editable SQL box with syntax highlighting, for the import modals' paste area.
//
// Same overlay recipe the row inspector's JSON editor uses: a `<pre>` holding
// the highlighted markup, with a transparent-text `<textarea>` on top carrying
// the caret, selection and every keystroke. The two layers share font, metrics,
// padding and wrapping so the glyphs line up exactly; the textarea's scroll is
// mirrored onto the `<pre>`.
//
// WHY not `SqlCodeEditor` (the real CodeMirror one): that is the SQL tab's
// editor — line numbers, autocomplete, a format FAB, a required `onRun` — all
// wrong for "paste a dump here", and a heavy instance to mount in a dialog.
// `highlightSql` is the same palette the read-only DDL previews use, so a dump
// reads the same everywhere in the app.

import { useEffect, useRef } from "react";

import { highlightSql } from "../../browse/shared/highlightSql";

export function SqlPasteBox({
  value,
  onChange,
  placeholder,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  ariaLabel: string;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const hlRef = useRef<HTMLPreElement>(null);

  const syncScroll = () => {
    if (taRef.current && hlRef.current) {
      hlRef.current.scrollTop = taRef.current.scrollTop;
      hlRef.current.scrollLeft = taRef.current.scrollLeft;
    }
  };
  // Loading a file replaces the whole buffer without a scroll event, which can
  // leave the layers offset — re-sync whenever the value changes from outside.
  useEffect(syncScroll, [value]);

  return (
    <div className="sql-paste">
      <pre
        className="sql-paste-hl"
        ref={hlRef}
        aria-hidden="true"
        // Trailing newline so a final empty line still gets a line box and the
        // two layers keep the same scroll height.
        dangerouslySetInnerHTML={{ __html: highlightSql(value) + "\n" }}
      />
      <textarea
        ref={taRef}
        className="sql-paste-ta"
        value={value}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        aria-label={ariaLabel}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onScroll={syncScroll}
      />
    </div>
  );
}
