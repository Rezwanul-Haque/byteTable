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

import {
  acceptCompletion,
  autocompletion,
  closeCompletion,
  completionKeymap,
  startCompletion,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { sql, SQLite } from "@codemirror/lang-sql";
import {
  bracketMatching,
  HighlightStyle,
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap, drawSelection, lineNumbers } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import {
  completionAddToOptions,
  completionOptionClass,
  completionTooltipClass,
  makeSqlCompletionSource,
  type EditorSchema,
} from "./sqlCompletion";
import { statementRangeAt } from "./sqlStatement";
import "./SqlCodeEditor.css";

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
  /** Dismiss the open autocomplete popup, if any (used when loading a file). */
  dismissCompletion: () => void;
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
    // Line-number gutter: blends into the editor bg, faint digits, no border,
    // right-aligned with a small gap before the code.
    ".cm-gutters": {
      backgroundColor: "var(--bg0)",
      color: "var(--text-faint)",
      border: "none",
    },
    ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 12px" },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text)" },
  },
  { dark: true },
);

// Editor font zoom (Mod-+/Mod-=/Mod--/Mod-0). The size lives in a compartment
// so the keymap can reconfigure it live, and is persisted so it survives tab
// switches and restarts. Owns `fontSize` (removed from sqlTheme above).
const FONT_MIN = 9;
const FONT_MAX = 28;
const FONT_DEFAULT = 13;
const FONT_STORE_KEY = "bytetable.sqlEditorFontPx";

function readStoredFontPx(): number {
  const raw = Number(localStorage.getItem(FONT_STORE_KEY));
  return Number.isFinite(raw) && raw >= FONT_MIN && raw <= FONT_MAX ? raw : FONT_DEFAULT;
}

function fontSizeTheme(px: number) {
  return EditorView.theme({ "&": { fontSize: px + "px" } });
}

/** macOS shows ⌘/⌥ glyphs in the context-menu shortcut hints; other platforms
 *  show Ctrl/Alt words. Best-effort — hints are cosmetic. */
const IS_MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
const RUN_HINT = IS_MAC ? "⌘↵" : "Ctrl+↵";
const FORMAT_HINT = IS_MAC ? "⇧⌥F" : "Shift+Alt+F";

/** An open editor context menu: viewport coords + whether a selection exists
 *  (drives the Copy/Cut enablement). */
interface CtxMenu {
  x: number;
  y: number;
  hasSelection: boolean;
}

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
  /** Reports whether the WHOLE buffer is selected (Mod-A / drag-select-all),
   *  so the toolbar can show "Run All". Fires on every selection change. */
  onAllSelected?: (all: boolean) => void;
  /**
   * Schema metadata (tables + each table's cached columns) for the
   * context-aware autocomplete. Read live on every keystroke via a ref, so the
   * editor never re-mounts as columns stream into the cache. Defaults to empty.
   */
  schema?: EditorSchema;
}

export const SqlCodeEditor = forwardRef<SqlCodeEditorHandle, SqlCodeEditorProps>(
  function SqlCodeEditor(
    { value, onChange, onRun, onFormat, onCaret, onAllSelected, schema },
    ref,
  ) {
    const hostRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    // Live editor font size (px) + the compartment that applies it, so Mod-+/-
    // can reconfigure the font without re-mounting the view.
    const fontCompartmentRef = useRef(new Compartment());
    const fontPxRef = useRef(readStoredFontPx());
    // Keep the latest callbacks reachable from the (mount-once) CM extensions
    // without re-creating the EditorView on every parent render.
    const onChangeRef = useRef(onChange);
    const onRunRef = useRef(onRun);
    const onFormatRef = useRef(onFormat);
    const onCaretRef = useRef(onCaret);
    const onAllSelectedRef = useRef(onAllSelected);
    // Latest schema, read by the completion source on each keystroke (so columns
    // streaming into the cache appear without re-mounting the editor).
    const schemaRef = useRef<EditorSchema>(schema ?? { tables: [] });
    onChangeRef.current = onChange;
    onRunRef.current = onRun;
    onFormatRef.current = onFormat;
    onCaretRef.current = onCaret;
    onAllSelectedRef.current = onAllSelected;
    schemaRef.current = schema ?? { tables: [] };

    // The Run/Explain buttons resolve the statement at the caret through this
    // handle — the same logic as ⌘/Ctrl+Enter. Falls back to the buffer (or "")
    // before the view exists.
    useImperativeHandle(ref, () => ({
      pickStatement: () => {
        const view = viewRef.current;
        return view ? pickAndSelect(view) : value;
      },
      dismissCompletion: () => {
        const view = viewRef.current;
        if (view) closeCompletion(view);
      },
    }));

    useLayoutEffect(() => {
      // Apply a new font size: clamp, persist, and live-reconfigure the
      // compartment. Returns true so the binding swallows the native zoom.
      const setFontPx = (view: EditorView, px: number) => {
        const next = Math.max(FONT_MIN, Math.min(FONT_MAX, px));
        fontPxRef.current = next;
        try {
          localStorage.setItem(FONT_STORE_KEY, String(next));
        } catch {
          // Private mode / blocked storage — zoom still works for this session.
        }
        view.dispatch({
          effects: fontCompartmentRef.current.reconfigure(fontSizeTheme(next)),
        });
        return true;
      };
      const runKeymap = keymap.of([
        // Editor font zoom. Both "Mod-=" (unshifted +) and "Mod-+" (shifted)
        // grow; "Mod--" shrinks; "Mod-0" resets. preventDefault stops the
        // webview's own Ctrl/Cmd +/- page zoom from firing too.
        {
          key: "Mod-=",
          preventDefault: true,
          run: (view) => setFontPx(view, fontPxRef.current + 1),
        },
        {
          key: "Mod-+",
          preventDefault: true,
          run: (view) => setFontPx(view, fontPxRef.current + 1),
        },
        {
          key: "Mod--",
          preventDefault: true,
          run: (view) => setFontPx(view, fontPxRef.current - 1),
        },
        {
          key: "Mod-0",
          preventDefault: true,
          run: (view) => setFontPx(view, FONT_DEFAULT),
        },
        {
          key: "Mod-Enter",
          preventDefault: true,
          run: (view) => {
            onRunRef.current(pickAndSelect(view));
            return true;
          },
        },
        // Format (⇧⌥F) is handled via a physical-key dom handler below, NOT a
        // keymap binding: on macOS Option+F yields a special char as event.key,
        // so a key-based binding never matches and the char gets inserted.
        // Tab accepts the highlighted completion when the popup is open;
        // acceptCompletion returns false otherwise, so Tab falls through to
        // indentWithTab (two-space indent) below.
        { key: "Tab", run: acceptCompletion },
        // Ctrl/Cmd+Space triggers the popup manually (spec). Mod = Cmd on macOS,
        // Ctrl elsewhere; the default completionKeymap also binds Ctrl-Space.
        { key: "Mod-Space", preventDefault: true, run: startCompletion },
      ]);
      const view = new EditorView({
        parent: hostRef.current!,
        state: EditorState.create({
          doc: value,
          extensions: [
            lineNumbers(),
            history(),
            drawSelection(),
            bracketMatching(),
            // Mod-Enter must win over any default binding; indentWithTab makes
            // Tab insert indentation (configured to two spaces below).
            runKeymap,
            // Format shortcut (⇧⌥F) by PHYSICAL key — event.code is layout- and
            // Option-char-independent, so it fires on macOS where Option+F would
            // otherwise insert a special char instead of triggering the keymap.
            EditorView.domEventHandlers({
              keydown: (e) => {
                if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === "KeyF") {
                  e.preventDefault();
                  onFormatRef.current?.();
                  return true;
                }
                return false;
              },
            }),
            // Context-aware SQL autocomplete. The source reads the live schema
            // ref; CM owns caret-positioning, ↑/↓, hover/click, and blur-dismiss.
            // closeOnBlur (default) dismisses on blur; activateOnTyping pops it as
            // the user types (and right after FROM/JOIN/INTO/UPDATE).
            autocompletion({
              override: [makeSqlCompletionSource(() => schemaRef.current)],
              icons: false,
              tooltipClass: completionTooltipClass,
              optionClass: completionOptionClass,
              addToOptions: completionAddToOptions,
            }),
            // completionKeymap binds ↑/↓ (when open), Enter/Tab accept, Esc close,
            // Ctrl-Space trigger. Before defaultKeymap so Enter accepts (and only
            // inserts a newline when the popup is closed).
            keymap.of(completionKeymap),
            keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
            sql({ dialect: SQLite }),
            syntaxHighlighting(sqlHighlight),
            sqlTheme,
            // Font size lives in a compartment so Mod-+/- can reconfigure it
            // live; seeded from the persisted value. Placed after sqlTheme so
            // its `&` fontSize wins.
            fontCompartmentRef.current.of(fontSizeTheme(fontPxRef.current)),
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
              // clause minimap can follow the cursor across statements, and
              // whether the whole buffer is selected (Mod-A) so the toolbar can
              // show "Run All".
              if (update.docChanged || update.selectionSet) {
                const sel = update.state.selection.main;
                const len = update.state.doc.length;
                onCaretRef.current?.(sel.head);
                onAllSelectedRef.current?.(len > 0 && sel.from === 0 && sel.to === len);
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

    // ---- right-click context menu (Run Selected / Run All / Format / clipboard) ----
    const [menu, setMenu] = useState<CtxMenu | null>(null);
    const closeMenu = () => setMenu(null);

    const openMenu = (e: React.MouseEvent) => {
      const view = viewRef.current;
      if (!view) return;
      e.preventDefault();
      // Point the caret at the click when there is no selection, or the click
      // lands outside the current selection — so "Run Selected" resolves to the
      // statement the user pointed at (matching native right-click behaviour).
      const sel = view.state.selection.main;
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
      if (pos != null && (sel.empty || pos < sel.from || pos > sel.to)) {
        view.dispatch({ selection: { anchor: pos } });
      }
      view.focus();
      // Clamp so the menu stays on screen (approx menu box ~190×230).
      const x = Math.min(e.clientX, window.innerWidth - 196);
      const y = Math.min(e.clientY, window.innerHeight - 236);
      setMenu({ x, y, hasSelection: !view.state.selection.main.empty });
    };

    // Dismiss on Escape, scroll, or window resize while the menu is open.
    useEffect(() => {
      if (!menu) return;
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") closeMenu();
      };
      window.addEventListener("keydown", onKey);
      window.addEventListener("resize", closeMenu);
      window.addEventListener("scroll", closeMenu, true);
      return () => {
        window.removeEventListener("keydown", onKey);
        window.removeEventListener("resize", closeMenu);
        window.removeEventListener("scroll", closeMenu, true);
      };
    }, [menu]);

    const runSelected = () => {
      const view = viewRef.current;
      if (view) onRunRef.current(pickAndSelect(view));
      closeMenu();
    };
    const runAll = () => {
      onRunRef.current();
      closeMenu();
    };
    const format = () => {
      onFormatRef.current?.();
      closeMenu();
    };
    const copySelection = async () => {
      const view = viewRef.current;
      const sel = view?.state.selection.main;
      if (view && sel && !sel.empty) {
        try {
          await navigator.clipboard.writeText(view.state.sliceDoc(sel.from, sel.to));
        } catch {
          // Clipboard blocked (permissions) — nothing to do.
        }
      }
      closeMenu();
    };
    const cutSelection = async () => {
      const view = viewRef.current;
      const sel = view?.state.selection.main;
      if (view && sel && !sel.empty) {
        try {
          await navigator.clipboard.writeText(view.state.sliceDoc(sel.from, sel.to));
          view.dispatch({ changes: { from: sel.from, to: sel.to, insert: "" } });
          view.focus();
        } catch {
          // Clipboard blocked — leave the buffer untouched.
        }
      }
      closeMenu();
    };
    const pasteAtCursor = async () => {
      const view = viewRef.current;
      if (view) {
        try {
          const text = await navigator.clipboard.readText();
          const sel = view.state.selection.main;
          view.dispatch({
            changes: { from: sel.from, to: sel.to, insert: text },
            selection: { anchor: sel.from + text.length },
          });
          view.focus();
        } catch {
          // Clipboard read blocked — nothing pasted.
        }
      }
      closeMenu();
    };

    return (
      <>
        <div className="sql-cm" ref={hostRef} onContextMenu={openMenu} />
        {menu
          ? createPortal(
              <div
                className="sql-ctx-overlay"
                onMouseDown={closeMenu}
                onContextMenu={(e) => {
                  e.preventDefault();
                  closeMenu();
                }}
              >
                <div
                  className="sql-ctx-menu"
                  role="menu"
                  style={{ left: menu.x, top: menu.y }}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <button className="sql-ctx-item" role="menuitem" onClick={runSelected}>
                    <span>Run Selected</span>
                    <span className="sql-ctx-key">{RUN_HINT}</span>
                  </button>
                  <button className="sql-ctx-item" role="menuitem" onClick={runAll}>
                    <span>Run All</span>
                  </button>
                  <button className="sql-ctx-item" role="menuitem" onClick={format}>
                    <span>Format</span>
                    <span className="sql-ctx-key">{FORMAT_HINT}</span>
                  </button>
                  <div className="sql-ctx-sep" />
                  <button
                    className="sql-ctx-item"
                    role="menuitem"
                    onClick={copySelection}
                    disabled={!menu.hasSelection}
                  >
                    <span>Copy</span>
                  </button>
                  <button
                    className="sql-ctx-item"
                    role="menuitem"
                    onClick={cutSelection}
                    disabled={!menu.hasSelection}
                  >
                    <span>Cut</span>
                  </button>
                  <button className="sql-ctx-item" role="menuitem" onClick={pasteAtCursor}>
                    <span>Paste</span>
                  </button>
                </div>
              </div>,
              document.body,
            )
          : null}
      </>
    );
  },
);
