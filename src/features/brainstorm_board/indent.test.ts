import { describe, expect, it } from "vitest";

import { indentEdit, INDENT } from "./indent";

/**
 * Apply an edit the way the editor does, and mark the resulting selection with
 * `|` (or `[…]` for a range) so the assertions read like what you would see.
 */
function apply(value: string, start: number, end: number, outdent = false): string | null {
  const edit = indentEdit(value, start, end, outdent);
  if (!edit) return null;
  const next = value.slice(0, edit.from) + edit.text + value.slice(edit.to);
  const { selectionStart: s, selectionEnd: e } = edit;
  return s === e
    ? next.slice(0, s) + "|" + next.slice(s)
    : next.slice(0, s) + "[" + next.slice(s, e) + "]" + next.slice(e);
}

/** Index of `needle` in `text` — for writing selections readably. */
const at = (text: string, needle: string) => text.indexOf(needle);

describe("indentEdit — Tab", () => {
  it("inserts one indent at a collapsed caret", () => {
    expect(apply('{ "a": 1 }', 2, 2)).toBe("{ " + INDENT + '|"a": 1 }');
  });

  it("indents from the front of the line when there is a selection, not from the caret", () => {
    // Any selection means "these lines", so the indent lands at the start of the
    // line rather than in the middle of a token.
    const text = '  "price": 249';
    expect(apply(text, 4, 6)).toBe('[      "price": 249]');
  });

  it("indents every line a selection touches", () => {
    const text = '{\n"a": 1,\n"b": 2\n}';
    expect(apply(text, at(text, '"a"'), at(text, '"b"') + 3)).toBe(
      "{\n[" + INDENT + '"a": 1,\n' + INDENT + '"b": 2]\n}',
    );
  });

  it("leaves the selection over the indented block, so Tab can repeat", () => {
    const text = '"a": 1\n"b": 2';
    const result = apply(text, 0, text.length)!;
    expect(result).toBe("[" + INDENT + '"a": 1\n' + INDENT + '"b": 2]');
  });

  it("does not indent the line after a selection that ends on a line break", () => {
    const text = '"a": 1\n"b": 2';
    // Selection covers the first line plus its newline.
    expect(apply(text, 0, 7)).toBe("[" + INDENT + '"a": 1]\n"b": 2');
  });

  it("indents an empty line", () => {
    expect(apply("\n\n", 1, 1)).toBe("\n" + INDENT + "|\n");
  });
});

describe("indentEdit — Shift-Tab", () => {
  it("removes one indent from the caret's line", () => {
    const text = INDENT + '"a": 1';
    expect(apply(text, text.length, text.length, true)).toBe('"a": 1|');
  });

  it("removes a partial indent rather than nothing", () => {
    expect(apply('  "a": 1', 8, 8, true)).toBe('"a": 1|');
  });

  it("removes a literal tab as one level", () => {
    expect(apply('\t"a": 1', 7, 7, true)).toBe('"a": 1|');
  });

  it("never pulls the caret off the front of its line", () => {
    const text = INDENT + '"a"';
    // Caret sits inside the leading whitespace.
    expect(apply(text, 2, 2, true)).toBe('|"a"');
  });

  it("outdents every line a selection touches", () => {
    const text = INDENT + '"a": 1\n' + INDENT + '"b": 2';
    expect(apply(text, 0, text.length, true)).toBe('["a": 1\n"b": 2]');
  });

  it("outdents the lines that can, and leaves the rest alone", () => {
    const text = INDENT + '"a": 1\n"b": 2';
    expect(apply(text, 0, text.length, true)).toBe('["a": 1\n"b": 2]');
  });

  it("is a no-op when there is nothing to remove", () => {
    expect(indentEdit('"a": 1', 0, 6, true)).toBeNull();
    expect(indentEdit('"a": 1', 3, 3, true)).toBeNull();
  });
});
