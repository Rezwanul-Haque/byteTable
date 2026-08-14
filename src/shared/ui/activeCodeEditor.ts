// The CodeMirror view the user was last editing, so window-level commands can
// reach it after focus has moved away.
//
// WHY: the title bar's Edit ▸ Undo ran `document.execCommand("undo")`, which
// acts on the FOCUSED element. Clicking a menu item takes focus out of the
// editor first, so by the time the command runs there is nothing to undo —
// the item looked like it did one step and then stopped working. CodeMirror
// owns its own history anyway (`@codemirror/commands`), and its `undo`/`redo`
// take a view rather than reading focus, so all we need is a handle on the
// right view.
//
// The registry holds the LAST-FOCUSED view, not the currently-focused one:
// that is exactly the view the user means when they reach for the menu.
// SqlCodeEditor registers on focus and clears on unmount (a destroyed view
// would throw if a command reached it).

import { redo, undo } from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";

let active: EditorView | null = null;

/** Remember `view` as the editor the user is working in (called on focus). */
export function setActiveCodeEditor(view: EditorView): void {
  active = view;
}

/** Forget `view` if it is still the registered one (called on unmount). */
export function clearActiveCodeEditor(view: EditorView): void {
  if (active === view) active = null;
}

/**
 * Run undo / redo against the last-focused editor. Returns false when there is
 * no editor to act on, so the caller can fall back to `execCommand` for plain
 * inputs and textareas.
 */
export function runCodeEditorHistory(cmd: "undo" | "redo"): boolean {
  if (!active) return false;
  const ran = cmd === "undo" ? undo(active) : redo(active);
  // Keep the caret where the user can see it — the menu click blurred it.
  active.focus();
  // `undo`/`redo` return false with an empty history; the command still
  // "belongs" to the editor, so report handled either way rather than letting
  // execCommand loose on a contenteditable CodeMirror manages.
  return ran || true;
}
