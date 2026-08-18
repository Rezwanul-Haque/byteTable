// Acceptance tests for the data-file core (M35 Tasks 1–3). Pure functions, so
// no DOM and no Tauri shell is needed — this is exactly why detection lives in
// core.ts and not in a view.

import { describe, expect, it } from "vitest";

import {
  adhocSchema,
  analyze,
  coerce,
  delimLabel,
  fmtBytes,
  parse,
  sniff,
  tableName,
  toObjects,
} from "./core";
import { DEMOS } from "./demos";

const orders = DEMOS[0]!;
const stations = DEMOS[1]!;
const ledger = DEMOS[2]!;

describe("sniff", () => {
  it("picks the consistent delimiter, not the frequent one", () => {
    // Every prose cell is full of commas; the real delimiter is the semicolon,
    // and only its field count is stable across lines.
    const text =
      "id;note;city\n" + "1;a, b, c, d;Dhaka\n" + "2;e, f;Berlin\n" + "3;g, h, i, j, k, l;Tokyo\n";
    expect(sniff(text).delimiter).toBe(";");
  });

  it("detects comma, semicolon and tab across the three samples", () => {
    expect(sniff(orders.text).delimiter).toBe(",");
    expect(sniff(stations.text).delimiter).toBe("\t");
    expect(sniff(ledger.text).delimiter).toBe(";");
    expect(delimLabel("\t")).toBe("Tab");
  });

  it("reports a header when the second row is typed", () => {
    expect(sniff("a,b\n1,2\n3,4\n").header).toBe(true);
  });

  it("does not assume a header just because row 1 exists", () => {
    // Row 1 carries a number (so it is not header-like) and row 2 is all text
    // (so nothing typed sits below it) — this file has no header.
    expect(sniff("alpha,1\nbeta,x\ngamma,y\n").header).toBe(false);
  });

  it("reads BOM and CRLF", () => {
    const s = sniff("﻿a,b\r\n1,2\r\n");
    expect(s.bom).toBe(true);
    expect(s.crlf).toBe(true);
    expect(s.encoding).toBe("UTF-8 with BOM");
  });
});

describe("parse", () => {
  it("keeps quoted newlines, escaped quotes and delimiters inside values", () => {
    const text = 'a,b\n"line1\nline2","say ""hi"", now"\n';
    const p = parse(text, { delimiter: "," });
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0]![0]).toBe("line1\nline2");
    expect(p.rows[0]![1]).toBe('say "hi", now');
    expect(p.ragged).toHaveLength(0);
  });

  it("strips the BOM, normalises CRLF and tolerates no trailing newline", () => {
    const p = parse("﻿a,b\r\n1,2\r\n3,4", { delimiter: "," });
    expect(p.columns).toEqual(["a", "b"]);
    expect(p.rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("records every ragged row with its source line", () => {
    const p = parse("a,b,c\n1,2,3\n4,5\n6,7,8,9\n", { delimiter: "," });
    expect(p.ragged).toEqual([
      { row: 1, line: 3, got: 2, want: 3 },
      { row: 2, line: 4, got: 4, want: 3 },
    ]);
    // Short rows are padded, long rows truncated — but never silently.
    expect(p.rows[1]).toEqual(["4", "5", null]);
    expect(p.rows[2]).toEqual(["6", "7", "8"]);
    expect(p.lineOf).toEqual([2, 3, 4]);
  });

  it("names headerless columns column_1…N and dedupes duplicates", () => {
    expect(parse("1,2,3\n", { delimiter: ",", header: false }).columns).toEqual([
      "column_1",
      "column_2",
      "column_3",
    ]);
    expect(parse("total,total,,x\n1,2,3,4\n", { delimiter: "," }).columns).toEqual([
      "total",
      "total_2",
      "column_3",
      "x",
    ]);
  });

  it("trims unquoted fields only", () => {
    const p = parse('a,b\n  x  ,"  y  "\n', { delimiter: ",", trim: true });
    expect(p.rows[0]).toEqual(["x", "  y  "]);
  });

  it("turns null tokens into real nulls", () => {
    const p = parse("a,b,c,d\nNULL,N/A,-,\n", { delimiter: "," });
    expect(p.rows[0]).toEqual([null, null, null, null]);
  });
});

describe("analyze", () => {
  const parsed = parse(orders.text, { delimiter: ",", header: true });
  const a = analyze(parsed);
  const col = (name: string) => a.cols.find((c) => c.name === name)!;

  it("types the messy sample's columns", () => {
    expect(col("subtotal").type).toBe("decimal");
    expect(col("ordered_at").type).toBe("datetime");
    expect(col("customer_email").type).toBe("email");
    expect(col("internal_note").type).toBe("text");
    expect(col("items").type).toBe("integer");
  });

  it("flags the quoted thousands separator as off-type", () => {
    const total = col("total");
    expect(total.type).toBe("decimal");
    const badValues = total.bad.map((ri) => parsed.rows[ri]![total.index]);
    expect(badValues).toContain("1,299.00");
  });

  it("does not infer a type from fewer than three values", () => {
    // 1 typed value in a 4-row column: no type, and therefore no off-type noise.
    const p = parse("n,m\n7,a\n,b\n,c\n,d\n", { delimiter: "," });
    const c = analyze(p).cols[0]!;
    expect(c.type).toBe("text");
    expect(c.bad).toHaveLength(0);
  });

  it("computes numeric stats a spot-check agrees with", () => {
    const p = parse("n\n1\n2\n3\n4\n100\n", { delimiter: "," });
    const s = analyze(p).cols[0]!.stats!;
    expect(s.sum).toBe(110);
    expect(s.mean).toBe(22);
    expect(s.median).toBe(3);
    expect(s.min).toBe(1);
    expect(s.max).toBe(100);
  });

  it("does not call a nearly-empty column unique", () => {
    // One present value in six rows makes `distinct === present` arithmetically
    // true. Treating that as a key is what let a 215/216-empty column win an
    // ad-hoc primary key and get locked read-only in the row inspector.
    const p = parse("note,other\nx,1\n,2\n,3\n,4\n,5\n,6\n", { delimiter: "," });
    const note = analyze(p).cols[0]!;
    expect(note.present).toBe(1);
    expect(note.distinct).toBe(1);
    expect(note.unique).toBe(false);
  });

  it("still calls a genuinely unique column unique", () => {
    const p = parse("id\n1\n2\n3\n4\n", { delimiter: "," });
    expect(analyze(p).cols[0]!.unique).toBe(true);
  });

  it("finds exact duplicate rows", () => {
    const p = parse("a,b\n1,2\n3,4\n1,2\n", { delimiter: "," });
    expect(analyze(p).dups).toEqual([{ row: 2, first: 0 }]);
  });
});

describe("findIssues", () => {
  const messy = analyze(parse(orders.text, { delimiter: "," }));
  const has = (id: string) => messy.issues.some((i) => i.id === id);

  it("reports the ragged rows, off-type values, whitespace and duplicates", () => {
    expect(has("ragged")).toBe(true);
    expect(has("type-total")).toBe(true);
    expect(has("pad-customer_email")).toBe(true);
    expect(has("duprows")).toBe(true);
  });

  it("sorts errors before warnings before notes", () => {
    const rank = { error: 0, warn: 1, note: 2 } as const;
    const seq = messy.issues.map((i) => rank[i.sev]);
    expect([...seq].sort((a, b) => a - b)).toEqual(seq);
  });

  it("pluralises correctly", () => {
    const one = analyze(parse("a,b\n1,2\n3\n", { delimiter: "," })).issues.find(
      (i) => i.id === "ragged",
    )!;
    expect(one.title).toContain("1 row has");
    const many = messy.issues.find((i) => i.id === "ragged")!;
    expect(many.title).toContain("rows have");
  });

  it("finds nothing structural in the clean TSV", () => {
    const clean = analyze(parse(stations.text, { delimiter: "\t" }));
    expect(clean.issues.filter((i) => i.sev === "error")).toHaveLength(0);
    expect(clean.issues.some((i) => i.id === "duprows")).toBe(false);
    expect(clean.issues.some((i) => i.id.startsWith("pad-"))).toBe(false);
  });

  it("never reports a key column as repeating zero times", () => {
    // `user_id` has one value in six rows: not unique any more (above), but it
    // repeats nothing either — "0 duplicate values" would be nonsense.
    const p = parse("user_id,x\n7,1\n,2\n,3\n,4\n,5\n,6\n", { delimiter: "," });
    const issues = analyze(p).issues;
    expect(issues.some((i) => i.id === "dupkey-user_id")).toBe(false);
  });

  it("still flags a key column that really does repeat", () => {
    const p = parse("user_id\n1\n1\n2\n3\n", { delimiter: "," });
    const issue = analyze(p).issues.find((i) => i.id === "dupkey-user_id");
    expect(issue?.detail).toContain("1 duplicate value");
  });

  it("flags the ledger's sparse debit column and its constant currency", () => {
    const l = analyze(parse(ledger.text, { delimiter: ";" }));
    expect(l.issues.some((i) => i.id === "sparse-debit")).toBe(true);
    expect(l.issues.find((i) => i.id === "const-currency")?.sev).toBe("note");
  });
});

describe("coercion and the ad-hoc schema", () => {
  it("coerces numbers and booleans, leaving unparseable values as text", () => {
    expect(coerce("42", "integer")).toBe(42);
    expect(coerce("1,299.00", "decimal")).toBe("1,299.00");
    expect(coerce("yes", "boolean")).toBe(true);
    expect(coerce("", "text")).toBeNull();
  });

  it("builds row objects keyed by column name", () => {
    const p = parse("a,b\n1,x\n", { delimiter: "," });
    const cols = analyze(p).cols;
    expect(toObjects(cols, p.rows)).toEqual([{ a: 1, b: "x" }]);
  });

  it("slugifies the file name into a table name", () => {
    expect(tableName("orders_export_2026-08.csv")).toBe("orders_export_2026_08");
    expect(tableName("weather stations.tsv")).toBe("weather_stations");
    expect(tableName(".csv")).toBe("data");
  });

  it("describes every column with its SQL type, and declares no primary key", () => {
    // A delimited file has no key — see `adhocSchema`.
    const p = parse("id,name\n1,a\n2,b\n3,c\n", { delimiter: "," });
    const cols = analyze(p).cols;
    const schema = adhocSchema("t", cols, p.rows.length);
    expect(schema).not.toHaveProperty("pk");
    expect(schema.columns).toEqual([
      { name: "id", type: "INTEGER", nullable: false },
      { name: "name", type: "TEXT", nullable: false },
    ]);
    expect(schema.rows).toBe(3);
  });
});

describe("fmtBytes", () => {
  it("scales to B / KB / MB", () => {
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(2048)).toBe("2.0 KB");
    expect(fmtBytes(3 * 1048576)).toBe("3.00 MB");
  });
});
