// Built-in starter snippets. The point of these tests is that a starter which
// does not RUN is worse than no starter: each engine must get its own dialect,
// and nothing may leak a construct that engine does not have.

import { describe, expect, it } from "vitest";

import type { Engine } from "../../shared/types";
import type { Snippet } from "./api";
import { builtinSnippets, isBuiltinSnippet, libraryForEngine, BUILTIN_PREFIX } from "./builtins";

const SQL_ENGINES: Engine[] = ["postgres", "mysql", "sqlite", "mssql", "clickhouse", "cassandra"];

/** The body of one built-in, by abbreviation. */
function bodyOf(engine: Engine, abbreviation: string): string | undefined {
  return builtinSnippets(engine).find((s) => s.abbreviation === abbreviation)?.body;
}

describe("builtinSnippets", () => {
  it("covers the everyday statements on every SQL engine", () => {
    for (const engine of SQL_ENGINES) {
      const abbreviations = builtinSnippets(engine).map((s) => s.abbreviation);
      expect(abbreviations, engine).toEqual(
        expect.arrayContaining(["sel", "ins", "upd", "del", "ct", "ci"]),
      );
    }
  });

  it("gives a non-SQL engine none, since it has no SQL editor to insert into", () => {
    expect(builtinSnippets("redis")).toEqual([]);
    expect(builtinSnippets("mongodb")).toEqual([]);
    expect(builtinSnippets("dynamodb")).toEqual([]);
    expect(builtinSnippets("typesense")).toEqual([]);
  });

  it("marks every entry as built-in and restricts it to its engine", () => {
    for (const engine of SQL_ENGINES) {
      for (const snippet of builtinSnippets(engine)) {
        expect(isBuiltinSnippet(snippet), snippet.id).toBe(true);
        expect(snippet.id.startsWith(BUILTIN_PREFIX)).toBe(true);
        expect(snippet.engine).toBe(engine);
        expect(snippet.name).not.toBe("");
        expect(snippet.body.trim()).not.toBe("");
      }
    }
  });

  it("gives every entry a unique abbreviation within its engine", () => {
    for (const engine of SQL_ENGINES) {
      const abbreviations = builtinSnippets(engine).map((s) => s.abbreviation);
      expect(new Set(abbreviations).size, engine).toBe(abbreviations.length);
    }
  });

  it("uses the #{…} field syntax, never the parameter form ${…}", () => {
    // A `${name}` in a body would be eaten as a tab stop on insert instead of
    // surviving into the buffer as a run-time parameter.
    for (const engine of SQL_ENGINES) {
      for (const snippet of builtinSnippets(engine)) {
        expect(snippet.body, snippet.id).not.toMatch(/\$\{/);
        expect(snippet.body, snippet.id).toMatch(/#\{\d+:/);
      }
    }
  });

  it("pages SQL Server with TOP and everything else with LIMIT", () => {
    expect(bodyOf("mssql", "sel")).toContain("TOP");
    expect(bodyOf("mssql", "sel")).not.toContain("LIMIT");
    for (const engine of ["postgres", "mysql", "sqlite", "clickhouse"] as Engine[]) {
      expect(bodyOf(engine, "sel"), engine).toContain("LIMIT");
    }
  });

  it("mutates ClickHouse through ALTER TABLE, which is its only mutation path", () => {
    expect(bodyOf("clickhouse", "upd")).toContain("ALTER TABLE");
    expect(bodyOf("clickhouse", "upd")).toContain("UPDATE");
    expect(bodyOf("clickhouse", "del")).toContain("ALTER TABLE");
    expect(bodyOf("clickhouse", "del")).toContain("DELETE WHERE");
  });

  it("gives ClickHouse a table ENGINE and sort key, without which CREATE TABLE fails", () => {
    expect(bodyOf("clickhouse", "ct")).toContain("ENGINE = MergeTree");
    expect(bodyOf("clickhouse", "ct")).toContain("ORDER BY");
  });

  it("uses each engine's own auto-increment and timestamp spelling", () => {
    expect(bodyOf("postgres", "ct")).toContain("bigserial");
    expect(bodyOf("mysql", "ct")).toContain("AUTO_INCREMENT");
    expect(bodyOf("sqlite", "ct")).toContain("AUTOINCREMENT");
    expect(bodyOf("mssql", "ct")).toContain("IDENTITY");
    expect(bodyOf("cassandra", "ct")).toContain("PRIMARY KEY");
  });

  it("upserts the way each engine spells it, and omits it where it has none", () => {
    expect(bodyOf("postgres", "ups")).toContain("ON CONFLICT");
    expect(bodyOf("postgres", "ups")).toContain("EXCLUDED");
    expect(bodyOf("sqlite", "ups")).toContain("ON CONFLICT");
    expect(bodyOf("mysql", "ups")).toContain("ON DUPLICATE KEY UPDATE");
    // SQL Server's MERGE is too easy to half-fill, ClickHouse has no upsert,
    // and a Cassandra INSERT already is one.
    expect(bodyOf("mssql", "ups")).toBeUndefined();
    expect(bodyOf("clickhouse", "ups")).toBeUndefined();
    expect(bodyOf("cassandra", "ups")).toBeUndefined();
  });

  it("omits joins, CTEs and GROUP BY from CQL, which has none of them", () => {
    const abbreviations = builtinSnippets("cassandra").map((s) => s.abbreviation);
    expect(abbreviations).not.toContain("join");
    expect(abbreviations).not.toContain("cte");
    expect(abbreviations).not.toContain("grp");
  });

  it("makes CQL reads and writes name a partition key", () => {
    for (const abbreviation of ["sel", "upd", "del"]) {
      expect(bodyOf("cassandra", abbreviation), abbreviation).toContain("partition_key");
    }
  });

  it("drops the COLUMN keyword for SQL Server's ADD, which does not take it", () => {
    expect(bodyOf("mssql", "addcol")).toContain("ADD ");
    expect(bodyOf("mssql", "addcol")).not.toContain("ADD COLUMN");
    expect(bodyOf("postgres", "addcol")).toContain("ADD COLUMN");
  });

  it("links the repeated field in the GROUP BY skeleton so both edit together", () => {
    // Same field number twice is what makes CodeMirror link them.
    const body = bodyOf("postgres", "grp") ?? "";
    expect(body.match(/#\{1:column\}/g)).toHaveLength(2);
  });
});

describe("libraryForEngine", () => {
  const mine: Snippet = {
    id: "u1",
    name: "Mine",
    abbreviation: "sel",
    body: "SELECT 2",
    savedAt: 1,
  };

  it("puts the user's snippets ahead of the built-ins", () => {
    const library = libraryForEngine([mine], "postgres");
    expect(library[0]).toBe(mine);
    expect(library.slice(1).every(isBuiltinSnippet)).toBe(true);
  });

  it("keeps a user snippet that shadows a built-in abbreviation, ranked first", () => {
    const library = libraryForEngine([mine], "postgres");
    const sel = library.filter((s) => s.abbreviation === "sel");
    expect(sel.length).toBe(2);
    expect(isBuiltinSnippet(sel[0]!)).toBe(false);
  });

  it("is just the user's list for an engine with no built-ins", () => {
    expect(libraryForEngine([mine], "redis")).toEqual([mine]);
  });
});
