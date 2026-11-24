import { describe, expect, it } from "vitest";

import example from "./example.md?raw";
import {
  blank,
  fileOf,
  isUntitled,
  titleFromFile,
  fromCell,
  fromMarkdown,
  newQuery,
  splitRow,
  toCell,
  toMarkdown,
  type Notebook,
  type QueryCell,
} from "./format";

const queries = (nb: Notebook) => nb.cells.filter((c): c is QueryCell => c.type === "query");

describe("cell escaping (A2)", () => {
  it("writes and reads every kind of value", () => {
    expect(toCell(null)).toBe("NULL");
    expect(fromCell("NULL")).toBeNull();
    expect(toCell(42.5)).toBe("42.5");
    expect(fromCell("42.5")).toBe(42.5);
    expect(fromCell("-3")).toBe(-3);
    // Leading zeros and long digit runs stay text.
    expect(fromCell("007")).toBe("007");
    expect(fromCell("1234567890123456")).toBe("1234567890123456");
    expect(toCell("a|b")).toBe("a\\|b");
    expect(toCell("C:\\temp")).toBe("C:\\\\temp");
    // A line break becomes one space, by design not reversible.
    expect(toCell("two\nlines")).toBe("two lines");
    expect(toCell({ a: [1, 2] })).toBe('{"a":[1,2]}');
    expect(fromCell('{"a":[1,2]}')).toBe('{"a":[1,2]}');
  });

  it("splits a row on unescaped pipes only", () => {
    expect(splitRow("| a | b \\| c | d\\\\e |")).toEqual(["a", "b | c", "d\\e"]);
  });
});

describe("writer (A1)", () => {
  it("writes front matter, notes, sql blocks and current results", () => {
    const nb = blank("byteshop_dev", "public", "Review");
    nb.cells = [
      { id: "1", type: "note", text: "  # Review\n\nWhy.  " },
      {
        ...newQuery("SELECT 1 AS one   \n"),
        ranSql: "SELECT 1 AS one   \n",
        result: {
          columns: ["one"],
          rows: [[1]],
          rowCount: 1,
          ms: 2,
          at: "2026-11-22T11:41Z",
          saved: false,
        },
      },
      { id: "3", type: "note", text: "   " },
    ];
    expect(toMarkdown(nb)).toBe(
      [
        "---",
        "bytetable: notebook/1",
        "title: Review",
        "connection: byteshop_dev",
        "schema: public",
        "---",
        "",
        "# Review",
        "",
        "Why.",
        "",
        "```sql",
        "SELECT 1 AS one",
        "```",
        "",
        "<!-- bt:result rows=1 ms=2 at=2026-11-22T11:41Z -->",
        "| one |",
        "| --- |",
        "| 1 |",
        "<!-- /bt:result -->",
        "",
      ].join("\n"),
    );
  });

  it("leaves out empty connection and schema, edited results, and all results when asked", () => {
    const nb = blank("", "");
    const q = queries(nb)[0]!;
    q.sql = "SELECT 2";
    q.ranSql = "SELECT 1";
    q.result = { columns: ["x"], rows: [[1]], rowCount: 1, ms: 1, at: "x", saved: false };
    const md = toMarkdown(nb);
    expect(md).not.toContain("connection:");
    expect(md).not.toContain("schema:");
    expect(md).not.toContain("bt:result");
    q.ranSql = "SELECT 2";
    expect(toMarkdown(nb)).toContain("bt:result");
    expect(toMarkdown(nb, { results: false })).not.toContain("bt:result");
  });

  it("keeps the first 20 rows and says how many there were", () => {
    const nb = blank("", "");
    const q = queries(nb)[0]!;
    q.sql = q.ranSql = "SELECT n";
    q.result = {
      columns: ["n"],
      rows: Array.from({ length: 200 }, (_, i) => [i]),
      rowCount: 10000,
      ms: 9,
      at: "t",
      saved: false,
    };
    const md = toMarkdown(nb);
    expect(md).toContain("<!-- bt:result rows=10000 shown=20 ms=9 at=t -->");
    expect(md.split("\n").filter((l) => /^\| \d+ \|$/.test(l))).toHaveLength(20);
  });

  it("ends with exactly one newline", () => {
    expect(toMarkdown(blank("", ""))).toMatch(/[^\n]\n$/);
  });

  it("suggests a file name from the title", () => {
    expect(fileOf("Cancelled orders review")).toBe("cancelled-orders-review.md");
    expect(fileOf("  ")).toBe("untitled.md");
  });
});

describe("reader (A3)", () => {
  it("reads front matter and attaches a saved result to its query", () => {
    const nb = fromMarkdown(example);
    expect(nb).toMatchObject({
      title: "Cancelled orders review",
      connection: "byteshop_dev",
      schema: "public",
      version: 1,
      hadResults: true,
    });
    const q = queries(nb);
    expect(q).toHaveLength(4);
    expect(q[0]!.result).toMatchObject({
      columns: ["status", "orders", "revenue"],
      rowCount: 4,
      ms: 4,
      at: "2026-11-22T11:41Z",
      saved: true,
    });
    expect(q[0]!.result!.rows[1]).toEqual(["shipped", 1, 19.99]);
    expect(q[0]!.ranSql).toBe(q[0]!.sql);
    expect(q[2]!.result).toBeNull();
  });

  it("opens a file with no front matter, titled by its first heading", () => {
    const nb = fromMarkdown(
      "# Weekly check\n\nSome text.\n\n```sql\nSELECT 1\n```\n\n```SQL\nSELECT 2\n```\n",
    );
    expect(nb.title).toBe("Weekly check");
    expect(nb.connection).toBe("");
    expect(queries(nb).map((q) => q.sql)).toEqual(["SELECT 1", "SELECT 2"]);
    expect(fromMarkdown("just prose").title).toBe("Untitled notebook");
  });

  it("keeps a code block in another language inside its note", () => {
    const nb = fromMarkdown(
      "Intro\n\n```js\nconst q = 1;\n```\n\nAfter\n\n```sql\nSELECT 1\n```\n",
    );
    expect(nb.cells).toHaveLength(2);
    expect(nb.cells[0]).toMatchObject({
      type: "note",
      text: "Intro\n\n```js\nconst q = 1;\n```\n\nAfter",
    });
  });

  it("ignores a trailing line inside a result block that is not table", () => {
    const nb = fromMarkdown(
      "```sql\nSELECT n\n```\n\n<!-- bt:result rows=50 shown=1 ms=1 at=t -->\n| n |\n| --- |\n| 1 |\n…and 49 more rows\n<!-- /bt:result -->\n",
    );
    const r = queries(nb)[0]!.result!;
    expect(r.rows).toEqual([[1]]);
    expect(r.rowCount).toBe(50);
  });

  it("reads Windows line endings", () => {
    const nb = fromMarkdown(example.replace(/\n/g, "\r\n"));
    expect(nb.title).toBe("Cancelled orders review");
    expect(queries(nb)[0]!.sql).toBe(
      "SELECT status, COUNT(*) AS orders, SUM(total) AS revenue\nFROM orders\nGROUP BY status\nORDER BY orders DESC",
    );
    expect(queries(nb)[0]!.result!.rows).toHaveLength(4);
  });

  it("does not take a result comment that follows a note", () => {
    const nb = fromMarkdown(
      "```sql\nSELECT 1\n```\n\nA note.\n\n<!-- bt:result rows=1 ms=1 at=t -->\n| a |\n| --- |\n| 1 |\n<!-- /bt:result -->\n",
    );
    expect(queries(nb)[0]!.result).toBeNull();
  });
});

describe("round trip (A4)", () => {
  it("writes the example back byte for byte", () => {
    expect(toMarkdown(fromMarkdown(example))).toBe(example);
  });

  it("survives every escaping case", () => {
    const nb = blank("c", "s", "Escapes");
    const q = queries(nb)[0]!;
    q.sql = q.ranSql = "SELECT *\nFROM weird";
    q.result = {
      columns: ["a|b", "back\\slash", "n"],
      rows: [
        [null, "x|y", 7],
        ["007", "C:\\dir", -1.5],
        ['{"k":1}', "two\nlines", 0],
      ],
      rowCount: 3,
      ms: 1,
      at: "2026-01-01T00:00Z",
      saved: false,
    };
    const once = toMarkdown(nb);
    const back = fromMarkdown(once);
    expect(toMarkdown(back)).toBe(once);
    expect(queries(back)[0]!.result!.columns).toEqual(["a|b", "back\\slash", "n"]);
    expect(queries(back)[0]!.result!.rows).toEqual([
      [null, "x|y", 7],
      ["007", "C:\\dir", -1.5],
      ['{"k":1}', "two lines", 0],
    ]);
  });
});

describe("version (A5)", () => {
  it("reads the version a file was written with", () => {
    expect(fromMarkdown("---\nbytetable: notebook/2\ntitle: Future\n---\n\nText\n").version).toBe(
      2,
    );
    expect(fromMarkdown("no front matter").version).toBe(1);
  });
});

describe("naming after the file", () => {
  it("turns a file name into a title", () => {
    expect(titleFromFile("/Users/me/notes/some-queries-notebook.md")).toBe("Some queries notebook");
    expect(titleFromFile("C:\\work\\weekly_check.markdown")).toBe("Weekly check");
    expect(titleFromFile("/tmp/.md")).toBe("Untitled notebook");
  });

  it("only renames a notebook still carrying the default title", () => {
    expect(isUntitled("Untitled notebook")).toBe(true);
    expect(isUntitled("  ")).toBe(true);
    expect(isUntitled("Cancelled orders review")).toBe(false);
  });
});
