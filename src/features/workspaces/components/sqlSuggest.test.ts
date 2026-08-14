// Unit tests for the autocomplete suggester (sqlSuggest + its per-dialect
// vocabulary in sqlKeywords). A keyword table is exactly the kind of data that
// rots silently — a word dropped from the wrong list just stops being
// suggested, with nothing to notice it — so every dialect gets coverage here.
//
//     pnpm test            (all suites)
//     pnpm test:watch      (re-run on change)

import { describe, expect, it } from "vitest";

import type { Engine } from "../../../shared/types";

import { suggestSql, type EditorSchema } from "./sqlSuggest";

const NO_SCHEMA: EditorSchema = { tables: [] };

/** Suggest with the caret at the END of `text` — i.e. how you type. */
function inserts(text: string, engine?: Engine, schema: EditorSchema = NO_SCHEMA): string[] {
  const res = suggestSql(text, text.length, schema, { engine });
  return (res?.items ?? []).map((i) => i.insert);
}

/** The slice of the buffer a suggestion would replace, or null for no popup. */
function replaced(text: string, engine: Engine): string | null {
  const res = suggestSql(text, text.length, NO_SCHEMA, { engine });
  return res ? text.slice(res.from, res.to) : null;
}

/** Every SQL engine that reaches the query editor / terminal (CQL is separate:
 *  its vocabulary REPLACES the core rather than extending it). */
const SQL_ENGINES = ["postgres", "mysql", "sqlite", "mssql", "clickhouse"] as const;

describe("suggestSql", () => {
  describe("offers each dialect's own keywords and functions", () => {
    it.each([
      ["postgres", "SELECT * FROM t RET", "RETURNING"],
      ["postgres", "SELECT * FROM t WHERE a IL", "ILIKE"],
      ["postgres", "SELECT date_tr", "DATE_TRUNC("],
      ["mysql", "SELECT * FROM t ON DUP", "ON DUPLICATE KEY UPDATE"],
      ["mysql", "SHO", "SHOW CREATE TABLE"],
      ["mysql", "SELECT group_c", "GROUP_CONCAT("],
      ["sqlite", "PRA", "PRAGMA"],
      ["sqlite", "SELECT * FROM t ORDER BY a NULLS", "NULLS FIRST"],
      ["sqlite", "SELECT strf", "STRFTIME("],
      ["mssql", "SELECT TO", "SELECT TOP"],
      ["mssql", "SELECT * FROM a CROSS AP", "CROSS APPLY"],
      ["mssql", "SELECT isn", "ISNULL("],
      ["clickhouse", "SELECT * FROM t PREW", "PREWHERE"],
      ["clickhouse", "SELECT * FROM t LEFT ARRAY", "LEFT ARRAY JOIN"],
      // ClickHouse identifiers are case-SENSITIVE, so the camelCase spelling
      // has to survive into the suggestion.
      ["clickhouse", "SELECT toDat", "toDateTime("],
      ["clickhouse", "SELECT uniqE", "uniqExact("],
      ["cassandra", "SELECT * FROM t ALLOW", "ALLOW FILTERING"],
      ["cassandra", "SELECT * FROM t PER PARTITION", "PER PARTITION LIMIT"],
      ["cassandra", "SELECT wri", "WRITETIME("],
    ] as [Engine, string, string][])("%s: %s → %s", (engine, text, want) => {
      expect(inserts(text, engine)).toContain(want);
    });
  });

  describe("offers the shared ANSI core to every SQL engine", () => {
    it.each(SQL_ENGINES)("%s", (engine) => {
      expect(inserts("SELECT CAS", engine)).toContain("CASE WHEN");
      expect(inserts("SELECT * FROM a FULL", engine)).toContain("FULL OUTER JOIN");
      expect(inserts("SELECT row_n", engine)).toContain("ROW_NUMBER(");
      expect(inserts("WIT", engine)).toContain("WITH");
    });
  });

  describe("never leaks one dialect's syntax into another", () => {
    it.each([
      ["mysql", "RET", "RETURNING"],
      ["mssql", "PREW", "PREWHERE"],
      ["sqlite", "ILI", "ILIKE"],
      ["postgres", "PRA", "PRAGMA"],
      // CQL has no joins, no set operations and no HAVING.
      ["cassandra", "RIGHT", "RIGHT JOIN"],
      ["cassandra", "UNI", "UNION ALL"],
      ["cassandra", "HAV", "HAVING"],
    ] as [Engine, string, string][])("%s: %s must not offer %s", (engine, text, unwanted) => {
      expect(inserts(text, engine)).not.toContain(unwanted);
    });
  });

  describe("with no engine, falls back to the ANSI core", () => {
    it("offers core keywords", () => {
      expect(inserts("CAS")).toEqual(expect.arrayContaining(["CASE", "CASE WHEN", "CAST"]));
    });

    it("offers no dialect extras", () => {
      expect(inserts("RET")).toHaveLength(0);
    });
  });

  describe("phrase matching", () => {
    // Without this, only the FIRST word of a phrase matches and everything past
    // it dead-ends — which would strand most of the multi-word dialect entries.
    it.each([
      ["mysql", "SELECT * FROM t ON DUP", "ON DUP"],
      ["postgres", "CREATE TABLE IF", "CREATE TABLE IF"],
      ["postgres", "INSERT INTO t VALUES (1) ON CONFLICT DO", "ON CONFLICT DO"],
    ] as [Engine, string, string][])("%s: %s replaces the whole phrase", (engine, text, want) => {
      expect(replaced(text, engine)).toBe(want);
    });

    it("picks the longest phrase that matches, not the whole tail", () => {
      // "FROM t ON DUP" matches nothing; "ON DUP" is the phrase.
      expect(inserts("SELECT * FROM t ON DUP", "mysql")).toEqual(["ON DUPLICATE KEY UPDATE"]);
    });

    it("still replaces only the word when no phrase matches", () => {
      expect(replaced("SELECT * FROM t GRO", "postgres")).toBe("GRO");
      expect(inserts("SELECT * FROM t GRO", "postgres")).toContain("GROUP BY");
    });

    it("suppresses single-word keyword rows once a phrase matched", () => {
      // Re-basing them onto the wider range would spell nonsense: "IS " + "NOT
      // IN" → "IS NOT IN".
      expect(inserts("SELECT * FROM t WHERE a IS NOT", "postgres")).toEqual(["IS NOT NULL"]);
    });

    it("re-bases column rows onto the widened range", () => {
      const schema: EditorSchema = {
        tables: [{ name: "orders", columns: [{ name: "duplicate_of", pk: false }] }],
      };
      expect(inserts("SELECT * FROM orders o ON DUP", "mysql", schema)).toEqual([
        "ON DUPLICATE KEY UPDATE",
        "ON duplicate_of",
      ]);
    });
  });

  describe("popup budget", () => {
    // 80 columns all match the prefix "co". Schema rows are pushed first, so
    // without the reserved keyword slots they fill the cap and COUNT( /
    // COMMIT never render — the bug this guards.
    const wide: EditorSchema = {
      tables: [
        {
          name: "customers",
          columns: Array.from({ length: 80 }, (_, i) => ({ name: `co_col_${i}`, pk: i === 0 })),
        },
      ],
    };

    it("caps the row count", () => {
      expect(inserts("SELECT co", "postgres", wide).length).toBeLessThanOrEqual(60);
    });

    it("keeps keywords visible behind a wide schema", () => {
      const keywords = inserts("SELECT co", "postgres", wide).filter(
        (l) => !l.startsWith("co_col_"),
      );
      expect(keywords).toEqual(expect.arrayContaining(["COUNT(", "COMMIT"]));
    });
  });

  describe("table context", () => {
    it("suggests only tables right after FROM", () => {
      const schema: EditorSchema = { tables: [{ name: "orders", columns: [] }] };
      expect(inserts("SELECT * FROM ord", "postgres", schema)).toEqual(["orders"]);
    });
  });
});
