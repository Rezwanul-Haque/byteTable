// CodeMirror 6 SQL editor (spec §3.7), themed to match the prototype's
// highlighted-textarea look byte-for-byte: transparent --bg0 background, mono
// 13px / line-height 1.65, accent caret, 12px/16px padding, Tab inserts two
// spaces, ⌘/Ctrl+Enter runs. The highlight palette is the §3.7 normative one:
//   keyword  → var(--accent)  (weight 500)
//   string   → #e5c07b
//   number   → #7fb8e8
//   function → #c678dd  (builtin/standard function names)
//   comment  → var(--text-faint), italic
//
// WHY CodeMirror over the prototype's regex-highlighted textarea: the spec
// recommends CM6, it parses SQL properly (no regex false-positives on e.g.
// `select` inside a string), and gives us bracket matching / undo for free.
// The visual is matched via a custom theme + HighlightStyle so the editor
// area looks like the prototype.
//
// React integration is imperative (the documented CM pattern): one EditorView
// instance per mount, created in a layout effect. The buffer is controlled by
// the parent (the SQL tab's store-backed `text`): `value` prop changes that
// did NOT originate from typing (snippet/history/saved load) are reconciled
// into the view via a dispatched transaction. `onChange` fires on user edits.

import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { sql, SQLite } from "@codemirror/lang-sql";
import {
  bracketMatching,
  HighlightStyle,
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, drawSelection } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from "react";

import { statementRangeAt } from "./sqlStatement";

/**
 * Resolve what ⌘/Ctrl+Enter (or the Run/Explain buttons) should execute from
 * the current editor state: an explicit selection wins; otherwise the single
 * statement the caret sits in. The matched range is selected in the view so
 * the user sees exactly what ran. Falls back to the whole buffer only if no
 * statement can be resolved. Returns the SQL string to run.
 */
function pickAndSelect(view: EditorView): string {
  const sel = view.state.selection.main;
  const doc = view.state.doc.toString();
  if (!sel.empty) return doc.slice(sel.from, sel.to);
  const range = statementRangeAt(doc, sel.head);
  if (!range) return doc;
  view.dispatch({ selection: { anchor: range.from, head: range.to } });
  return doc.slice(range.from, range.to);
}

/** Imperative handle: lets the toolbar's Run/Explain buttons resolve the same
 *  statement-at-cursor the keyboard shortcut uses. */
export interface SqlCodeEditorHandle {
  /** Select and return the statement at the caret (or the selection). */
  pickStatement: () => string;
}

/** §3.7 highlight palette, mapped onto lezer tags. Colors are literal where
 *  the spec gives a hex; the keyword color reads the live --accent token. */
const sqlHighlight = HighlightStyle.define([
  { tag: t.keyword, color: "var(--accent)", fontWeight: "500" },
  { tag: [t.operatorKeyword, t.modifier], color: "var(--accent)", fontWeight: "500" },
  { tag: [t.string, t.special(t.string)], color: "#e5c07b" },
  { tag: [t.number, t.bool, t.null], color: "#7fb8e8" },
  { tag: [t.function(t.variableName), t.standard(t.name)], color: "#c678dd" },
  {
    tag: [t.comment, t.lineComment, t.blockComment],
    color: "var(--text-faint)",
    fontStyle: "italic",
  },
  // Identifiers / punctuation fall back to the editor's default --text color.
]);

/** Editor chrome theme — matches the prototype's .sql-input / .sql-highlight
 *  rules (transparent bg over --bg0, mono 13px/1.65, 12px 16px padding, accent
 *  caret, no outline). */
const sqlTheme = EditorView.theme(
  {
    "&": {
      height: "100%",
      backgroundColor: "var(--bg0)",
      color: "var(--text)",
      fontSize: "13px",
    },
    ".cm-scroller": {
      fontFamily: "var(--mono)",
      lineHeight: "1.65",
      overflow: "auto",
    },
    ".cm-content": {
      padding: "12px 0",
      caretColor: "var(--accent)",
    },
    ".cm-line": { padding: "0 16px" },
    "&.cm-focused": { outline: "none" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "color-mix(in oklab, var(--accent) 24%, transparent)",
    },
    ".cm-gutters": { display: "none" },
  },
  { dark: true },
);

interface SqlCodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  /**
   * ⌘/Ctrl+Enter handler. Receives the SQL to run: the active selection if
   * one exists, otherwise the single statement the caret sits in (see
   * statementRangeAt). Called with no argument from elsewhere means "run the
   * whole buffer" — the caller decides.
   */
  onRun: (sql?: string) => void;
  /** Shift+Alt+F handler — beautify the buffer (also bound to the wand FAB). */
  onFormat?: () => void;
  /** Caret offset, reported on every selection / document change (for the
   *  cursor-aware clause minimap). */
  onCaret?: (pos: number) => void;
}

export const SqlCodeEditor = forwardRef<SqlCodeEditorHandle, SqlCodeEditorProps>(
  function SqlCodeEditor({ value, onChange, onRun, onFormat, onCaret }, ref) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Keep the latest callbacks reachable from the (mount-once) CM extensions
  // without re-creating the EditorView on every parent render.
  const onChangeRef = useRef(onChange);
  const onRunRef = useRef(onRun);
  const onFormatRef = useRef(onFormat);
  const onCaretRef = useRef(onCaret);
  onChangeRef.current = onChange;
  onRunRef.current = onRun;
  onFormatRef.current = onFormat;
  onCaretRef.current = onCaret;

  // The Run/Explain buttons resolve the statement at the caret through this
  // handle — the same logic as ⌘/Ctrl+Enter. Falls back to the buffer (or "")
  // before the view exists.
  useImperativeHandle(ref, () => ({
    pickStatement: () => {
      const view = viewRef.current;
      return view ? pickAndSelect(view) : value;
    },
  }));

  useLayoutEffect(() => {
    const runKeymap = keymap.of([
      {
        key: "Mod-Enter",
        preventDefault: true,
        run: (view) => {
          onRunRef.current(pickAndSelect(view));
          return true;
        },
      },
      {
        key: "Shift-Alt-f",
        preventDefault: true,
        run: () => {
          onFormatRef.current?.();
          return true;
        },
      },
    ]);
    const view = new EditorView({
      parent: hostRef.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          drawSelection(),
          bracketMatching(),
          // Mod-Enter must win over any default binding; indentWithTab makes
          // Tab insert indentation (configured to two spaces below).
          runKeymap,
          keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
          sql({ dialect: SQLite }),
          syntaxHighlighting(sqlHighlight),
          sqlTheme,
          EditorState.tabSize.of(2),
          // Tab inserts two spaces (spec §3.7), via indentWithTab + a 2-space
          // indent unit (so Tab/Shift-Tab indent in two-space steps).
          indentUnit.of("  "),
          // No lineWrapping: the prototype's editor scrolls horizontally
          // (white-space: pre), so long lines extend rather than wrap.
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              onChangeRef.current(update.state.doc.toString());
            }
            // Report caret moves (click / key / select / typing) so the
            // clause minimap can follow the cursor across statements.
            if (update.docChanged || update.selectionSet) {
              onCaretRef.current?.(update.state.selection.main.head);
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Mount once; the buffer is reconciled via the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reconcile external `value` changes (snippet / history / saved-query load)
  // into the view. Skip when the doc already matches — typing updates `value`
  // through onChange, so without this guard we would dispatch a redundant
  // (cursor-resetting) transaction on every keystroke.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  return <div className="sql-cm" ref={hostRef} />;
  },
);
