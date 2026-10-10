// The in-place editor a board object swaps to on double-click (M37 Task 2).
//
// An auto-growing textarea rather than contenteditable: the committed value is
// plain text with newlines (a sticky's body, a sketch's title + one field per
// line), and a textarea gives that for free with no sanitising.
//
// `data-nodrag` is what keeps a drag from starting under the caret — the canvas
// ignores pointerdowns inside anything carrying it (see BoardCanvas.onDown).
// Keydowns are stopped here too, so the board's single-key tool shortcuts never
// fire while someone is typing "note".

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { indentEdit } from "../indent";

interface BoardTextEditorProps {
  value: string;
  /** Called with the final text on blur — which ⌘↩ and Esc both trigger. */
  onCommit: (value: string) => void;
  /**
   * Render the text in colour BEHIND the editor, keeping syntax highlighting
   * alive while typing (the sample-data snippet's JSON).
   *
   * A textarea cannot hold styled runs, so the standard trick applies: an
   * identical, inert copy of the text underneath, with the textarea's own glyphs
   * made transparent and only its caret and selection left visible. The two must
   * agree on every metric that moves a glyph — family, size, line-height,
   * padding, wrapping — which is why the snippet's CSS sets them on both at once
   * rather than separately. The highlighter must also be LOSSLESS for the same
   * reason: one dropped space and the caret drifts off the colours.
   */
  highlight?: (text: string) => ReactNode;
  /**
   * Select the existing text instead of placing the caret after it.
   *
   * True only for a JUST-CREATED object, whose text is a stand-in the user is
   * expected to replace — a frame arrives labelled "Zone", a sketch "Thing", a
   * flow node "Source" — so the first keystroke should overwrite it.
   *
   * False when re-opening something already written: double-clicking a note to
   * add a line must not arm the whole note for deletion by the next key.
   */
  selectAll?: boolean;
  /**
   * Let Tab indent instead of leaving the field (⇧Tab outdents).
   *
   * Only for the editor that holds code — a pasted JSON payload is lined up by
   * hand, and a Tab that jumps focus away makes that impossible. Everywhere else
   * Tab keeps its normal job of moving on. Esc and ⌘↩ still close the editor, so
   * capturing Tab never traps the keyboard here.
   */
  indentWithTab?: boolean;
  className?: string;
  placeholder?: string;
}

export function BoardTextEditor({
  value,
  onCommit,
  highlight,
  selectAll,
  indentWithTab,
  className,
  placeholder,
}: BoardTextEditorProps) {
  const [text, setText] = useState(value ?? "");
  const ref = useRef<HTMLTextAreaElement | null>(null);

  const fit = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  };

  // Focus on mount and size to the existing text before the first paint.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    if (selectAll) el.select();
    else {
      // Caret after the last character, so editing continues the note. Without
      // this the whole note is selected and the next keystroke wipes it.
      const end = el.value.length;
      el.setSelectionRange(end, end);
    }
    fit();
    // Mount-only: `selectAll` describes how THIS editing session opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Apply a Tab/⇧Tab edit to the live textarea.
   *
   * Through `execCommand("insertText")` rather than by setting state, because
   * that is the only way to put the change on the textarea's NATIVE undo stack —
   * ⌘Z inside the editor should step back through typing and indenting alike,
   * and a React-driven value swap is invisible to it. It also fires `input`, so
   * the controlled value and the highlight layer follow along for free.
   */
  const applyIndent = (outdent: boolean) => {
    const el = ref.current;
    if (!el) return;
    const edit = indentEdit(el.value, el.selectionStart, el.selectionEnd, outdent);
    if (!edit) return;
    el.setSelectionRange(edit.from, edit.to);
    if (!document.execCommand("insertText", false, edit.text)) {
      // No `execCommand` (it is deprecated, if universally implemented): still
      // make the edit, just without native undo. React's value tracker has not
      // seen this write, so the dispatched event does reach onChange.
      el.setRangeText(edit.text, edit.from, edit.to, "end");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    el.setSelectionRange(edit.selectionStart, edit.selectionEnd);
    fit();
  };

  const field = (
    <textarea
      ref={ref}
      data-nodrag="1"
      rows={1}
      className={
        "bb-edit" + (highlight ? " bb-edit-over" : "") + (className ? " " + className : "")
      }
      value={text}
      placeholder={placeholder}
      onChange={(e) => {
        setText(e.target.value);
        fit();
      }}
      onBlur={() => onCommit(text)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (indentWithTab && e.key === "Tab") {
          e.preventDefault();
          applyIndent(e.shiftKey);
          return;
        }
        // ⌘↩ commits (Enter alone inserts a line — a sketch is a list), Esc
        // commits too: the text is already in the object's shape, and losing a
        // paragraph to a stray Esc is worse than keeping an unwanted edit that
        // one ⌘Z undoes.
        if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
    />
  );

  if (!highlight) return field;

  return (
    <div className={"bb-edit-wrap" + (className ? " " + className : "")} data-nodrag="1">
      {/* Inert and unreachable: it exists only to be looked at. A trailing
          newline gets a space so the mirror keeps the blank last line the
          textarea shows. */}
      <pre className="bb-edit-hl" aria-hidden="true">
        {highlight(text.endsWith("\n") ? text + " " : text)}
      </pre>
      {field}
    </div>
  );
}
