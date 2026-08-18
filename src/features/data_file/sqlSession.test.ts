// The pure half of "SQL over the file" (M35 Task 6): the script that loads a
// parsed file into its scratch SQLite database, and the four starter queries.
//
// Worth its own tests because a quoting or batching bug here surfaces only as a
// driver error at open time, with the whole generated script as the message.

import { describe, expect, it } from "vitest";

import { adhocSchema, analyze, parse, tableName } from "./core";
import { DEMOS } from "./demos";
import { buildLoadScript, ReadOnlyError, sampleQueries } from "./sqlSession";

/** Parse + profile a file the way the workspace does. */
function load(text: string, delimiter: string) {
  const parsed = parse(text, { delimiter });
  const analysis = analyze(parsed);
  const schema = adhocSchema(
    tableName("orders_export_2026-08.csv"),
    analysis.cols,
    parsed.rows.length,
  );
  return { parsed, analysis, schema };
}

describe("buildLoadScript", () => {
  it("creates the table with the inferred SQL types and inserts every row", () => {
    const { parsed, analysis, schema } = load("id,name,paid\n1,ada,true\n2,grace,false\n", ",");
    const script = buildLoadScript(schema, analysis.cols, parsed.rows);
    expect(script).toContain('CREATE TABLE "orders_export_2026_08" (');
    expect(script).toContain('"id" INTEGER');
    expect(script).toContain('"name" TEXT');
    expect(script).toContain('"paid" BOOLEAN');
    expect(script).toContain('INSERT INTO "orders_export_2026_08" ("id", "name", "paid") VALUES');
    expect(script).toContain("(1, 'ada', true)");
    expect(script).toContain("(2, 'grace', false)");
  });

  it("declares no primary key, so rowid stays the file's row ordinal", () => {
    // An INTEGER PRIMARY KEY column IS the rowid in SQLite, which would make
    // `rowid` the id VALUE — and the raw-WHERE filter maps rowid back to a file
    // row position.
    const { parsed, analysis, schema } = load("id,name\n1,a\n2,b\n3,c\n", ",");
    expect(buildLoadScript(schema, analysis.cols, parsed.rows)).not.toContain("PRIMARY KEY");
  });

  it("opens a file whose key column repeats", () => {
    // A duplicate key is a Data quality warning, never a load failure.
    const { parsed, analysis, schema } = load("id,name\n1,a\n1,a\n2,a\n", ",");
    const script = buildLoadScript(schema, analysis.cols, parsed.rows);
    expect(script).toContain("(1, 'a')");
    expect(script.match(/\n\(|VALUES\n\(/g)).toHaveLength(3);
  });

  it("escapes quotes in identifiers and values", () => {
    const { parsed, analysis, schema } = load('a"b,c\nit\'s,"say ""hi"""\n', ",");
    const script = buildLoadScript(schema, analysis.cols, parsed.rows);
    expect(script).toContain('"a""b"');
    expect(script).toContain("'it''s'");
    expect(script).toContain("'say \"hi\"'");
  });

  it("writes nulls for missing values rather than empty strings", () => {
    const { parsed, analysis, schema } = load("a,b\n1,\n2,x\n", ",");
    const script = buildLoadScript(schema, analysis.cols, parsed.rows);
    expect(script).toContain("(1, NULL)");
  });

  it("batches large files into several INSERT statements", () => {
    const rows = Array.from({ length: 450 }, (_, i) => i + ",x").join("\n");
    const { parsed, analysis, schema } = load("n,s\n" + rows + "\n", ",");
    const script = buildLoadScript(schema, analysis.cols, parsed.rows);
    // 450 rows at 200 per statement → 3 INSERTs.
    expect(script.match(/INSERT INTO/g)).toHaveLength(3);
    expect(parsed.rows).toHaveLength(450);
  });

  it("loads every sample file without producing an empty script", () => {
    for (const [demo, delimiter] of [
      [DEMOS[0]!, ","],
      [DEMOS[1]!, "\t"],
      [DEMOS[2]!, ";"],
    ] as const) {
      const { parsed, analysis, schema } = load(demo.text, delimiter);
      const script = buildLoadScript(schema, analysis.cols, parsed.rows);
      expect(script.startsWith("CREATE TABLE")).toBe(true);
      expect(script).toContain("INSERT INTO");
      // Every column of every row is represented: one tuple per row.
      expect(script.match(/\n\(|VALUES\n\(/g)?.length).toBe(parsed.rows.length);
    }
  });
});

describe("sampleQueries", () => {
  it("generates four runnable starter queries over the file's own columns", () => {
    const { analysis, schema } = load(DEMOS[0]!.text, ",");
    const queries = sampleQueries(schema, analysis.cols);
    expect(queries).toHaveLength(4);
    for (const q of queries) {
      expect(q.sql).toMatch(/^SELECT /);
      expect(q.sql).toContain('"orders_export_2026_08"');
    }
    // The group-by picks a low-cardinality text column, not an id.
    expect(queries[2]!.sql).toContain("GROUP BY");
    expect(queries[3]!.sql).toContain("ORDER BY");
  });

  it("falls back to the only column when a file has just one", () => {
    // No text dimension and no numeric column to pick from — the generated
    // GROUP BY / ORDER BY must still name a column that exists.
    const { analysis, schema } = load("only\na\nb\nc\n", ",");
    const queries = sampleQueries(schema, analysis.cols);
    expect(queries).toHaveLength(4);
    expect(queries[2]!.sql).toContain('GROUP BY "only"');
    expect(queries[3]!.sql).toContain('ORDER BY "only" DESC');
  });
});

describe("ReadOnlyError", () => {
  it("says this tab is SELECT-only and points at the one that can edit", () => {
    const message = new ReadOnlyError().message;
    expect(message).toContain("SELECT");
    expect(message).toContain("Data tab");
  });
});
