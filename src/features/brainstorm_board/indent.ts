// Tab-to-indent for the board's code-ish editor (the sample-data snippet).
//
// Pure: given the text and where the selection is, work out the replacement and
// where the caret should land. The component does the DOM part. Keeping the
// string work out here is what makes the awkward cases — a selection that ends
// exactly on a line break, an outdent that has nothing to remove — testable at
// all, since the editor itself only exists in a browser.
//
// The rules are the ones every code editor has trained people to expect:
//
//   - Tab with a collapsed caret inserts one indent at the caret.
//   - Tab with a selection indents every line the selection TOUCHES, rather than
//     replacing the selection with four spaces. Replacing is what a bare
//     textarea does, and it silently eats whatever was highlighted.
//   - ⇧Tab outdents the same lines, removing up to one indent's worth of leading
//     whitespace (or a literal tab) from each.

/** One level of indentation. Spaces, not a tab: the snippet is JSON being lined
 *  up by eye, and a literal tab renders at whatever width the next viewer picks. */
export const INDENT = "    ";

/** A replacement for `[from, to)` plus where the selection goes afterwards. */
export interface IndentEdit {
  text: string;
  from: number;
  to: number;
  selectionStart: number;
  selectionEnd: number;
}

/**
 * What Tab (or ⇧Tab, with `outdent`) should do to `value` at the given
 * selection, or `null` when it would change nothing — an outdent on lines that
 * have no leading whitespace left to take.
 */
export function indentEdit(
  value: string,
  start: number,
  end: number,
  outdent: boolean,
): IndentEdit | null {
  const collapsed = start === end;

  // The simple case: no selection, indenting. Insert and move on.
  if (collapsed && !outdent) {
    return {
      text: INDENT,
      from: start,
      to: start,
      selectionStart: start + INDENT.length,
      selectionEnd: start + INDENT.length,
    };
  }

  // Otherwise operate on whole lines. `from` is the start of the line the
  // selection begins on; `to` is the end of the line it ends on.
  const from = value.lastIndexOf("\n", start - 1) + 1;
  // A selection that ends ON a line break stops at the previous line — dragging
  // through a line should not quietly indent the one after it.
  const lastLineProbe = !collapsed && value[end - 1] === "\n" ? end - 1 : end;
  const nextBreak = value.indexOf("\n", lastLineProbe);
  const to = nextBreak === -1 ? value.length : nextBreak;

  const block = value.slice(from, to);
  const lines = block.split("\n");
  const next = lines
    .map((line) => (outdent ? line.replace(/^(?: {1,4}|\t)/, "") : INDENT + line))
    .join("\n");
  if (next === block) return null;

  if (collapsed) {
    // Keep the caret on the same character it was before, shifted by whatever
    // this line gained or lost, and never pushed outside the line.
    const delta = next.length - block.length;
    const caret = Math.max(from, Math.min(start + delta, from + next.length));
    return { text: next, from, to, selectionStart: caret, selectionEnd: caret };
  }
  // Keep the whole affected block selected, so Tab can be pressed again.
  return { text: next, from, to, selectionStart: from, selectionEnd: from + next.length };
}
