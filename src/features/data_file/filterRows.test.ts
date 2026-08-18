// The Data tab's filter evaluator. Every operator the engine's builder offers
// has to mean the same thing over a file as it does over a table, so each one
// is exercised here against a small fixture.

import { describe, expect, it } from "vitest";

import type { FilterDraft, UiCondition } from "../workspaces/types";
import type { FilterOp } from "../../shared/api/engine";
import { analyze, parse, toObjects } from "./core";
import { evaluateDraft, filterColumns } from "./filterRows";

const CSV =
  "id,name,total,paid,note\n" +
  "1,ada,100,true,alpha\n" +
  "2,Grace,250.5,false,beta\n" +
  "3,linus,,true,\n" +
  "4,ada,50,false,gamma\n";

const parsed = parse(CSV, { delimiter: "," });
const { cols } = analyze(parsed);
/** The coerced row objects, exactly as the Data tab builds them. */
const rows = toObjects(cols, parsed.rows);

let seq = 0;
function cond(column: string, op: FilterOp, value = ""): UiCondition {
  seq += 1;
  return { id: "c" + seq, enabled: true, column, op, value };
}

function draft(conditions: UiCondition[], combinator: "and" | "or" = "and"): FilterDraft {
  return { conditions, combinator, rawMode: false, rawSql: "" };
}

/** Evaluate and return the matched `name` values, which read better than ids. */
function names(d: FilterDraft): (string | number | boolean | null)[] {
  const idx = evaluateDraft(d, cols, rows);
  return (idx ?? rows.map((_, i) => i)).map((i) => rows[i]!.name ?? null);
}

describe("evaluateDraft", () => {
  it("returns null when nothing is active, meaning the whole file", () => {
    expect(evaluateDraft(draft([]), cols, rows)).toBeNull();
    // A value-taking operator with no value contributes nothing.
    expect(evaluateDraft(draft([cond("name", "eq", "")]), cols, rows)).toBeNull();
    // Nor does a disabled row.
    const off = { ...cond("name", "eq", "ada"), enabled: false };
    expect(evaluateDraft(draft([off]), cols, rows)).toBeNull();
  });

  it("compares numbers numerically, not as text", () => {
    // "100" > "50" is false as text; 100 > 50 is true.
    expect(names(draft([cond("total", "gt", "60")]))).toEqual(["ada", "Grace"]);
    expect(names(draft([cond("total", "lte", "100")]))).toEqual(["ada", "ada"]);
  });

  it("matches equality, inequality and lists", () => {
    expect(names(draft([cond("name", "eq", "ada")]))).toEqual(["ada", "ada"]);
    expect(names(draft([cond("name", "ne", "ada")]))).toEqual(["Grace", "linus"]);
    expect(names(draft([cond("id", "inList", "1, 3")]))).toEqual(["ada", "linus"]);
  });

  it("matches the text operators case-insensitively", () => {
    expect(names(draft([cond("name", "contains", "RAC")]))).toEqual(["Grace"]);
    // "Grace" counts as containing "a" — the match ignores case on both sides.
    expect(names(draft([cond("name", "notContains", "a")]))).toEqual(["linus"]);
    expect(names(draft([cond("name", "beginsWith", "L")]))).toEqual(["linus"]);
    expect(names(draft([cond("name", "endsWith", "US")]))).toEqual(["linus"]);
  });

  it("treats an empty cell as NULL for the null checks only", () => {
    expect(names(draft([cond("total", "isNull")]))).toEqual(["linus"]);
    expect(names(draft([cond("total", "isNotNull")]))).toEqual(["ada", "Grace", "ada"]);
    // Every other comparison against NULL is false, as in SQL.
    expect(names(draft([cond("total", "ne", "1")]))).toEqual(["ada", "Grace", "ada"]);
  });

  it("matches booleans", () => {
    expect(names(draft([cond("paid", "eq", "true")]))).toEqual(["ada", "linus"]);
    expect(names(draft([cond("paid", "eq", "false")]))).toEqual(["Grace", "ada"]);
  });

  it("stacks conditions with AND and OR", () => {
    const both = draft([cond("name", "eq", "ada"), cond("total", "gt", "60")]);
    expect(names(both)).toEqual(["ada"]);
    const either = draft([cond("name", "eq", "linus"), cond("total", "gt", "200")], "or");
    expect(names(either)).toEqual(["Grace", "linus"]);
  });

  it("skips disabled rows but keeps the enabled ones", () => {
    const mixed = draft([
      cond("name", "eq", "ada"),
      { ...cond("total", "gt", "60"), enabled: false },
    ]);
    expect(names(mixed)).toEqual(["ada", "ada"]);
  });

  it("ignores a condition naming a column the file does not have", () => {
    // Re-opening on another file can leave a stale column behind; it must not
    // silently match nothing (which would look like an empty file).
    expect(evaluateDraft(draft([cond("gone", "eq", "x")]), cols, rows)).toBeNull();
  });

  it("matches nothing when a non-numeric value is typed against a number", () => {
    expect(names(draft([cond("total", "gt", "abc")]))).toEqual([]);
  });
});

describe("filterColumns", () => {
  it("describes each column to the panel with its scratch-table SQL type", () => {
    const infos = filterColumns(cols);
    expect(infos.map((c) => c.name)).toEqual(["id", "name", "total", "paid", "note"]);
    expect(infos.find((c) => c.name === "id")?.dataType).toBe("INTEGER");
    expect(infos.find((c) => c.name === "total")?.dataType).toBe("REAL");
    expect(infos.find((c) => c.name === "paid")?.dataType).toBe("BOOLEAN");
    expect(infos.find((c) => c.name === "total")?.nullable).toBe(true);
    expect(infos.find((c) => c.name === "id")?.nullable).toBe(false);
  });
});
