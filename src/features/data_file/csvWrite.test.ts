// The writer's contract: change exactly what was edited, and nothing else.
//
// The identity tests are the important ones. If `serializeFile` with an empty
// batch is not byte-identical to the input, the feature is silently rewriting
// people's files — which is the bug this whole viewer exists to catch.

import { describe, expect, it } from "vitest";

import { analyze, parse } from "./core";
import { DEMOS } from "./demos";
import { emptyBatch, isEmptyBatch, batchSize, quoteField, serializeFile } from "./csvWrite";
import type { EditBatch } from "./csvWrite";

/** Parse `text`, apply `batch`, return the new file text. */
function write(text: string, batch: Partial<EditBatch> = {}, delimiter = ",") {
  const parsed = parse(text, { delimiter });
  return serializeFile(text, parsed, { ...emptyBatch(), ...batch });
}

describe("serializeFile — identity", () => {
  const files: [string, string, string][] = [
    ["plain", "a,b\n1,2\n3,4\n", ","],
    ["no trailing newline", "a,b\n1,2\n3,4", ","],
    ["CRLF", "a,b\r\n1,2\r\n3,4\r\n", ","],
    ["BOM", "﻿a,b\n1,2\n", ","],
    ["quoted values", 'a,b\n"x,y","say ""hi"""\n1,2\n', ","],
    ["embedded newline", 'a,b\n"line1\nline2",2\n', ","],
    ["blank lines between rows", "a,b\n1,2\n\n\n3,4\n", ","],
    ["trailing blank lines", "a,b\n1,2\n\n\n", ","],
    ["ragged rows", "a,b,c\n1,2,3\n4,5\n6,7,8,9\n", ","],
    ["null spellings", "a,b,c\nNULL,N/A,-\n1,2,3\n", ","],
    ["padded values", "a,b\n  x  ,y\n", ","],
    ["semicolons", "a;b\n1;2\n", ";"],
    ["tabs", "a\tb\n1\t2\n", "\t"],
    ["single column", "a\n1\n2\n", ","],
    ["header only", "a,b\n", ","],
    ["empty", "", ","],
  ];

  for (const [name, text, delimiter] of files) {
    it("round-trips " + name + " byte for byte", () => {
      expect(write(text, {}, delimiter)).toBe(text);
    });
  }

  it("round-trips all three sample files byte for byte", () => {
    for (const [demo, delimiter] of [
      [DEMOS[0]!, ","],
      [DEMOS[1]!, "\t"],
      [DEMOS[2]!, ";"],
    ] as const) {
      expect(write(demo.text, {}, delimiter)).toBe(demo.text);
    }
  });
});

describe("serializeFile — cell edits", () => {
  it("changes only the edited cell", () => {
    const text = "a,b,c\n1,2,3\n4,5,6\n";
    expect(write(text, { cells: { 1: { 1: "NEW" } } })).toBe("a,b,c\n1,2,3\n4,NEW,6\n");
  });

  it("leaves the other fields of an edited row byte-identical", () => {
    // `N/A` and the quoted value are untouched cells in a row that IS edited —
    // they must not be re-serialized into `` and `x,y`.
    const text = 'a,b,c\nN/A,"x,y",3\n';
    expect(write(text, { cells: { 0: { 2: "9" } } })).toBe('a,b,c\nN/A,"x,y",9\n');
  });

  it("quotes a new value only when the format needs it", () => {
    const text = "a,b\n1,2\n";
    expect(write(text, { cells: { 0: { 0: "plain" } } })).toBe("a,b\nplain,2\n");
    expect(write(text, { cells: { 0: { 0: "has,comma" } } })).toBe('a,b\n"has,comma",2\n');
    expect(write(text, { cells: { 0: { 0: 'has"quote' } } })).toBe('a,b\n"has""quote",2\n');
    expect(write(text, { cells: { 0: { 0: "two\nlines" } } })).toBe('a,b\n"two\nlines",2\n');
  });

  it("keeps a ragged row ragged", () => {
    // Row 1 has 2 of 3 fields. Editing its first column must not pad it to 3.
    const text = "a,b,c\n1,2,3\n4,5\n";
    expect(write(text, { cells: { 1: { 0: "X" } } })).toBe("a,b,c\n1,2,3\nX,5\n");
  });

  it("extends a short row only when the edit itself needs the column", () => {
    const text = "a,b,c\n1,2\n";
    expect(write(text, { cells: { 0: { 2: "Z" } } })).toBe("a,b,c\n1,2,Z\n");
  });

  it("preserves CRLF and the BOM through an edit", () => {
    const text = "﻿a,b\r\n1,2\r\n";
    expect(write(text, { cells: { 0: { 1: "9" } } })).toBe("﻿a,b\r\n1,9\r\n");
  });

  it("edits the last row of a file with no trailing newline", () => {
    expect(write("a,b\n1,2", { cells: { 0: { 1: "9" } } })).toBe("a,b\n1,9");
  });

  it("edits a row that follows blank lines", () => {
    expect(write("a,b\n1,2\n\n3,4\n", { cells: { 1: { 0: "X" } } })).toBe("a,b\n1,2\n\nX,4\n");
  });
});

describe("serializeFile — added and deleted rows", () => {
  it("drops a deleted row and nothing else", () => {
    expect(write("a,b\n1,2\n3,4\n5,6\n", { deleted: [1] })).toBe("a,b\n1,2\n5,6\n");
  });

  it("appends staged rows at the end", () => {
    const batch = { added: [{ key: 1, cells: { 0: "9", 1: "10" } }] };
    expect(write("a,b\n1,2\n", batch)).toBe("a,b\n1,2\n9,10\n");
  });

  it("pads an appended row to the column count and quotes as needed", () => {
    const batch = { added: [{ key: 1, cells: { 0: "x,y" } }] };
    expect(write("a,b,c\n1,2,3\n", batch)).toBe('a,b,c\n1,2,3\n"x,y",,\n');
  });

  it("adds the missing newline before appending to a file without one", () => {
    const batch = { added: [{ key: 1, cells: { 0: "3", 1: "4" } }] };
    expect(write("a,b\n1,2", batch)).toBe("a,b\n1,2\n3,4\n");
  });

  it("applies edits, deletions and additions together", () => {
    const batch = {
      cells: { 0: { 1: "TWO" } },
      deleted: [1],
      added: [{ key: 1, cells: { 0: "7", 1: "8" } }],
    };
    expect(write("a,b\n1,2\n3,4\n5,6\n", batch)).toBe("a,b\n1,TWO\n5,6\n7,8\n");
  });
});

describe("serializeFile — re-parsing the result", () => {
  it("yields the edited values and keeps the rest", () => {
    const text = DEMOS[0]!.text;
    const parsed = parse(text, { delimiter: "," });
    const emailCol = parsed.columns.indexOf("customer_email");
    const next = serializeFile(text, parsed, {
      ...emptyBatch(),
      cells: { 0: { [emailCol]: "changed@example.com" } },
    });
    const reparsed = parse(next, { delimiter: "," });
    expect(reparsed.rows[0]![emailCol]).toBe("changed@example.com");
    expect(reparsed.rows).toHaveLength(parsed.rows.length);
    // The messy sample's ragged rows are still ragged — a save is not a repair.
    expect(reparsed.ragged.map((r) => r.got)).toEqual(parsed.ragged.map((r) => r.got));
    // And the file still profiles the same way.
    expect(analyze(reparsed).cols.map((c) => c.type)).toEqual(
      analyze(parsed).cols.map((c) => c.type),
    );
  });
});

describe("batch helpers", () => {
  it("reports emptiness and counts", () => {
    expect(isEmptyBatch(emptyBatch())).toBe(true);
    expect(isEmptyBatch({ cells: { 0: {} }, added: [], deleted: [] })).toBe(true);
    const batch: EditBatch = {
      cells: { 0: { 1: "x" }, 3: { 0: "y" } },
      added: [{ key: 1, cells: {} }],
      deleted: [7],
    };
    expect(isEmptyBatch(batch)).toBe(false);
    expect(batchSize(batch)).toEqual({ edited: 2, added: 1, deleted: 1 });
  });
});

describe("quoteField", () => {
  const opts = parse("a\n", { delimiter: "," }).opts;
  it("leaves plain values alone", () => {
    expect(quoteField("abc", opts)).toBe("abc");
    expect(quoteField("", opts)).toBe("");
    expect(quoteField("  spaced  ", opts)).toBe("  spaced  ");
  });
  it("quotes and doubles when required", () => {
    expect(quoteField("a,b", opts)).toBe('"a,b"');
    expect(quoteField('a"b', opts)).toBe('"a""b"');
  });
});
