// Query-parameter detection and substitution. The rules worth pinning are the
// ones where a near-miss produces WRONG SQL rather than an obvious failure:
// what counts as a placeholder (and what only looks like one), how a value is
// quoted per engine, and that an unfilled placeholder is left alone instead of
// becoming an empty literal.

import { describe, expect, it } from "vitest";

import {
  applyParams,
  defsToStore,
  detectParams,
  effectiveValues,
  mergeDefs,
  missingParams,
  paramError,
  paramKey,
  paramToken,
  pruneDef,
  quoteLiteral,
  renderParam,
  scanParams,
  valuesToStore,
  type ParamDef,
} from "./sqlParams";

const names = (sql: string, engine: Parameters<typeof detectParams>[1] = "postgres") =>
  detectParams(sql, engine).map((p) => p.name);

describe("scanParams", () => {
  it("finds named placeholders in both spellings", () => {
    expect(names("SELECT * FROM t WHERE a = :one AND b = ${two}")).toEqual(["one", "two"]);
  });

  it("collapses a repeated name into one parameter but counts the occurrences", () => {
    const [param] = detectParams("WHERE created >= :day AND updated >= :day", "postgres");
    expect(param).toEqual({ name: "day", positional: false, count: 2 });
  });

  it("ignores placeholders inside string literals, identifiers and comments", () => {
    expect(names("SELECT ':nope' AS \":nope\" -- :nope\n/* :nope */ FROM t")).toEqual([]);
  });

  it("ignores a placeholder inside a Postgres dollar-quoted body", () => {
    expect(names("CREATE FUNCTION f() AS $body$ SELECT :nope; $body$ LANGUAGE sql")).toEqual([]);
  });

  it("does not read a cast as a placeholder", () => {
    expect(names("SELECT id::text, n::numeric FROM t")).toEqual([]);
  });

  it("still finds a real parameter next to a cast", () => {
    expect(names("WHERE id::text = :id")).toEqual(["id"]);
  });

  it("ignores a braced form with an empty name", () => {
    expect(names("SELECT ${} FROM t")).toEqual([]);
  });

  it("reports offsets covering the whole token", () => {
    const sql = "a = :x";
    const [ref] = scanParams(sql, "postgres");
    expect(sql.slice(ref!.from, ref!.to)).toBe(":x");

    const braced = "a = ${x}";
    const [bracedRef] = scanParams(braced, "postgres");
    expect(braced.slice(bracedRef!.from, bracedRef!.to)).toBe("${x}");
  });

  it("numbers positional placeholders in order, never collapsing them", () => {
    const found = detectParams("WHERE a = ? AND b = ?", "mysql");
    expect(found).toEqual([
      { name: "1", positional: true, count: 1 },
      { name: "2", positional: true, count: 1 },
    ]);
  });

  it("leaves ? alone on Postgres, where it is a jsonb operator", () => {
    expect(names("SELECT * FROM t WHERE data ? 'key'", "postgres")).toEqual([]);
  });

  it("does not read the jsonb ?| / ?& operators as placeholders", () => {
    expect(names("WHERE data ?| array['a'] AND other ?& array['b']", "mysql")).toEqual([]);
  });

  it("ignores a colon inside a bracket identifier or array subscript", () => {
    expect(names("SELECT [a:b] FROM t", "mssql")).toEqual([]);
    expect(names("SELECT tags[1:2] FROM t", "mysql")).toEqual([]);
  });

  it("treats an unterminated literal as swallowing the rest of the buffer", () => {
    expect(names("SELECT 'open :nope")).toEqual([]);
  });
});

describe("quoteLiteral", () => {
  it("doubles single quotes", () => {
    expect(quoteLiteral("O'Hara", "postgres")).toBe("'O''Hara'");
  });

  it("doubles backslashes only where they are escape characters", () => {
    // MySQL / ClickHouse read `\` as an escape, so it has to be doubled.
    expect(quoteLiteral("a\\b", "mysql")).toBe("'a\\\\b'");
    expect(quoteLiteral("a\\b", "clickhouse")).toBe("'a\\\\b'");
    // Everywhere else it is an ordinary character; doubling would corrupt it.
    expect(quoteLiteral("a\\b", "postgres")).toBe("'a\\b'");
    expect(quoteLiteral("a\\b", "sqlite")).toBe("'a\\b'");
    expect(quoteLiteral("a\\b", "mssql")).toBe("'a\\b'");
  });

  it("neutralises an injection attempt by quoting it as data", () => {
    expect(quoteLiteral("x'; DROP TABLE t; --", "postgres")).toBe("'x''; DROP TABLE t; --'");
  });
});

describe("renderParam", () => {
  it("renders numbers bare, including signs, decimals and exponents", () => {
    expect(renderParam("42", "number", "postgres")).toBe("42");
    expect(renderParam(" -2.5 ", "number", "postgres")).toBe("-2.5");
    expect(renderParam("1e5", "number", "postgres")).toBe("1e5");
  });

  it("falls back to a quoted literal for a non-numeric number, never bare text", () => {
    // The point: a typo must not become arbitrary SQL. The engine then reports
    // a type error, which names the real problem.
    expect(renderParam("1 OR 1=1", "number", "postgres")).toBe("'1 OR 1=1'");
  });

  it("renders booleans per engine", () => {
    expect(renderParam("yes", "boolean", "postgres")).toBe("TRUE");
    expect(renderParam("false", "boolean", "mysql")).toBe("FALSE");
    // No boolean type: SQL Server and SQLite compare against 0/1.
    expect(renderParam("true", "boolean", "mssql")).toBe("1");
    expect(renderParam("0", "boolean", "sqlite")).toBe("0");
  });

  it("renders NULL for the null kind whatever the value is", () => {
    expect(renderParam("ignored", "null", "postgres")).toBe("NULL");
  });

  it("passes raw values through verbatim", () => {
    expect(renderParam("public.users", "raw", "postgres")).toBe("public.users");
  });

  it("renders a list with numeric items bare and text items quoted", () => {
    expect(renderParam("1, 2, 3", "list", "postgres")).toBe("1, 2, 3");
    expect(renderParam("paid, due", "list", "postgres")).toBe("'paid', 'due'");
    expect(renderParam("a, O'Hara", "list", "postgres")).toBe("'a', 'O''Hara'");
  });

  it("renders an empty list as NULL, which matches nothing and still parses", () => {
    expect(renderParam(" , ", "list", "postgres")).toBe("NULL");
  });

  it("quotes a date like a string", () => {
    expect(renderParam("2026-10-25", "date", "postgres")).toBe("'2026-10-25'");
  });
});

describe("applyParams", () => {
  const defs: ParamDef[] = [
    { name: "status", kind: "text" },
    { name: "min", kind: "number" },
    { name: "table", kind: "raw" },
  ];

  it("substitutes every occurrence of a repeated name", () => {
    const out = applyParams(
      "WHERE a = :status OR b = :status",
      { status: "paid" },
      defs,
      "postgres",
    );
    expect(out).toBe("WHERE a = 'paid' OR b = 'paid'");
  });

  it("substitutes both spellings and keeps the surrounding text intact", () => {
    const out = applyParams(
      "SELECT * FROM ${table} WHERE total > :min",
      { table: "orders", min: "100" },
      defs,
      "postgres",
    );
    expect(out).toBe("SELECT * FROM orders WHERE total > 100");
  });

  it("substitutes positional placeholders by position", () => {
    const out = applyParams("WHERE a = ? AND b = ?", { "1": "x", "2": "y" }, [], "mysql");
    expect(out).toBe("WHERE a = 'x' AND b = 'y'");
  });

  it("falls back to a declared default when no value was entered", () => {
    const out = applyParams(
      "WHERE s = :status",
      {},
      [{ name: "status", default: "paid" }],
      "postgres",
    );
    expect(out).toBe("WHERE s = 'paid'");
  });

  it("prefers an entered value over the default", () => {
    const out = applyParams(
      "WHERE s = :status",
      { status: "due" },
      [{ name: "status", default: "paid" }],
      "postgres",
    );
    expect(out).toBe("WHERE s = 'due'");
  });

  it("leaves an unfilled placeholder exactly as written", () => {
    // A preview with nothing entered yet must show `:status`, not `''`.
    expect(applyParams("WHERE s = :status", {}, defs, "postgres")).toBe("WHERE s = :status");
  });

  it("fills a null-kind placeholder with no value at all", () => {
    const out = applyParams("WHERE s IS :nil", {}, [{ name: "nil", kind: "null" }], "postgres");
    expect(out).toBe("WHERE s IS NULL");
  });

  it("does not re-scan a substituted value, so a value is never a placeholder", () => {
    const out = applyParams("WHERE a = :x", { x: ":y and ${z}" }, [], "postgres");
    expect(out).toBe("WHERE a = ':y and ${z}'");
  });

  it("does not touch text that only looks like a placeholder", () => {
    const sql = "SELECT ':keep', id::text FROM t -- :keep";
    expect(applyParams(sql, { keep: "no" }, [], "postgres")).toBe(sql);
  });

  it("returns the buffer unchanged when there is nothing to substitute", () => {
    expect(applyParams("SELECT 1", { a: "b" }, [], "postgres")).toBe("SELECT 1");
  });

  it("keeps offsets correct when a value is longer than its placeholder", () => {
    const out = applyParams(
      "SELECT :a, :b, :c",
      { a: "aaaaaaaa", b: "bbbbbbbb", c: "cccccccc" },
      [],
      "postgres",
    );
    expect(out).toBe("SELECT 'aaaaaaaa', 'bbbbbbbb', 'cccccccc'");
  });

  it("builds a usable IN list", () => {
    const out = applyParams(
      "SELECT * FROM orders WHERE status IN (:statuses)",
      { statuses: "paid, due" },
      [{ name: "statuses", kind: "list" }],
      "postgres",
    );
    expect(out).toBe("SELECT * FROM orders WHERE status IN ('paid', 'due')");
  });
});

describe("effectiveValues / missingParams", () => {
  const detected = detectParams("WHERE a = :a AND b = :b AND c IS :c", "postgres");
  const defs: ParamDef[] = [
    { name: "b", default: "fallback" },
    { name: "c", kind: "null" },
  ];

  it("resolves each parameter to its value, else its default, else empty", () => {
    expect(effectiveValues(detected, defs, { a: "entered" })).toEqual({
      a: "entered",
      b: "fallback",
      c: "",
    });
  });

  it("treats an empty entered value as absent so the default still applies", () => {
    expect(effectiveValues(detected, defs, { b: "" }).b).toBe("fallback");
  });

  it("reports only the parameters a run would have to ask about", () => {
    // `b` has a default and `c` needs no value, so only `a` is missing.
    expect(missingParams(detected, defs, {})).toEqual(["a"]);
    expect(missingParams(detected, defs, { a: "x" })).toEqual([]);
  });

  it("counts a whitespace-only value as missing", () => {
    expect(missingParams(detected, defs, { a: "   " })).toEqual(["a"]);
  });
});

describe("paramError", () => {
  it("flags a non-numeric number and an unrecognised boolean", () => {
    // Codes, not messages — the module is locale-free and the UI translates.
    expect(paramError("number", "abc")).toBe("notNumber");
    expect(paramError("boolean", "maybe")).toBe("notBoolean");
  });

  it("accepts valid values and anything for the free-form kinds", () => {
    expect(paramError("number", "12.5")).toBeNull();
    expect(paramError("boolean", "YES")).toBeNull();
    expect(paramError("text", "anything at all")).toBeNull();
    expect(paramError("raw", "public.users")).toBeNull();
  });
});

describe("paramToken / paramKey", () => {
  it("spells a named parameter with its colon and a positional one as ?", () => {
    expect(paramToken({ name: "status", positional: false, count: 1 })).toBe(":status");
    expect(paramToken({ name: "1", positional: true, count: 1 })).toBe("?");
  });

  it("keys a positional parameter apart from a name that looks like it", () => {
    expect(paramKey({ name: "1", positional: true, count: 1 })).not.toBe(
      paramKey({ name: "1", positional: false, count: 1 }),
    );
  });
});

describe("pruneDef", () => {
  it("drops empty fields and an explicitly-default kind", () => {
    expect(pruneDef({ name: "a", label: "  ", kind: "text", default: "", choices: [] })).toEqual({
      name: "a",
    });
  });

  it("keeps everything that says something", () => {
    const def: ParamDef = {
      name: "a",
      label: "Status",
      kind: "list",
      default: "paid",
      choices: ["paid", "due"],
    };
    expect(pruneDef(def)).toEqual(def);
  });
});

describe("mergeDefs", () => {
  it("adds a declaration for a name that has none", () => {
    expect(mergeDefs([], "status", { kind: "number" })).toEqual([
      { name: "status", kind: "number" },
    ]);
  });

  it("patches one declaration and leaves the others untouched", () => {
    const defs: ParamDef[] = [
      { name: "a", label: "Alpha" },
      { name: "b", kind: "number" },
    ];
    expect(mergeDefs(defs, "b", { default: "10" })).toEqual([
      { name: "a", label: "Alpha" },
      { name: "b", kind: "number", default: "10" },
    ]);
  });

  it("keeps declarations for names that are no longer in the buffer", () => {
    // Commenting a clause out for a minute must not discard its type.
    const defs: ParamDef[] = [{ name: "gone", kind: "raw" }];
    expect(mergeDefs(defs, "here", { kind: "number" })).toEqual([
      { name: "gone", kind: "raw" },
      { name: "here", kind: "number" },
    ]);
  });
});

describe("defsToStore", () => {
  const detected = detectParams("WHERE a = :a AND b = :b", "postgres");

  it("stores only declarations that say more than the default", () => {
    const defs: ParamDef[] = [
      { name: "a", kind: "text" }, // pure default — nothing to say
      { name: "b", kind: "number", default: "10" },
    ];
    expect(defsToStore(detected, defs)).toEqual([{ name: "b", kind: "number", default: "10" }]);
  });

  it("drops declarations for parameters the query no longer has", () => {
    const defs: ParamDef[] = [{ name: "removed", kind: "raw" }];
    expect(defsToStore(detected, defs)).toEqual([]);
  });

  it("stores nothing for an all-default query, so the save is unchanged", () => {
    expect(defsToStore(detected, [])).toEqual([]);
  });
});

describe("valuesToStore", () => {
  const detected = detectParams("WHERE a = :a AND b = :b AND c = :c", "postgres");

  it("remembers the effective value, so an accepted default is what is stored", () => {
    const defs: ParamDef[] = [{ name: "b", default: "fallback" }];
    expect(valuesToStore(detected, defs, { a: "typed" })).toEqual({
      a: "typed",
      b: "fallback",
    });
  });

  it("omits blanks rather than storing empty strings", () => {
    expect(valuesToStore(detected, [], { a: "x", b: "" })).toEqual({ a: "x" });
  });

  it("ignores values for parameters the query no longer has", () => {
    expect(valuesToStore(detected, [], { a: "x", removed: "stale" })).toEqual({ a: "x" });
  });
});
