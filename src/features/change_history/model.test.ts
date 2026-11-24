import { describe, expect, it } from "vitest";

import type { CheckView, Entry, Summary, Verdict } from "./api";
import { actionLabel, statusOf, titleOf, undoable, verdictOf } from "./model";

const summary = (over: Partial<Summary> = {}): Summary => ({
  id: "e",
  at: 0,
  source: "statement",
  schemaName: "public",
  sql: "",
  verb: "UPDATE",
  rows: 3,
  tables: ["orders"],
  inserted: 0,
  updated: 3,
  deleted: 0,
  changes: 3,
  undone: 0,
  ...over,
});

const entry = (over: Partial<Entry> = {}): Entry => ({
  id: "e",
  connectionId: "c",
  at: 0,
  source: "statement",
  schemaName: "public",
  sql: "",
  verb: "UPDATE",
  changes: [],
  rows: 3,
  tables: ["orders"],
  sideEffects: false,
  undone: [],
  history: [],
  ...over,
});

const view = (states: Verdict["state"][], redo = false): CheckView => ({
  redo,
  verdicts: states.map((state, i) => ({ i, state })),
  statements: [],
  sql: "",
});

describe("statusOf", () => {
  it("reads done, partial, undone and can't", () => {
    expect(statusOf(summary())).toBe("done");
    expect(statusOf(summary({ undone: 1 }))).toBe("partial");
    expect(statusOf(summary({ undone: 3 }))).toBe("undone");
    expect(statusOf(summary({ cant: "structure" }))).toBe("cant");
    expect(undoable(summary({ undone: 1 }))).toBe(true);
    expect(undoable(summary({ undone: 3 }))).toBe(false);
  });
});

describe("titleOf", () => {
  it("names one kind, a mix, and the can't cases", () => {
    expect(titleOf(summary())).toBe("Updated 3 rows in orders");
    expect(titleOf(summary({ changes: 1, updated: 1 }))).toBe("Updated 1 row in orders");
    expect(titleOf(summary({ tables: ["a", "b"], inserted: 1, updated: 3, changes: 4 }))).toBe(
      "Changed 4 rows in 2 tables (1 added, 3 updated)",
    );
    expect(titleOf(summary({ cant: "structure", verb: "ALTER" }))).toBe("Structure change (ALTER)");
    expect(titleOf(summary({ cant: "large", rows: null, limit: 1000 }))).toBe(
      "Update more than 1,000 rows in orders",
    );
  });
});

describe("verdictOf and actionLabel", () => {
  it("says what undo can do", () => {
    expect(verdictOf(entry(), view(["ok", "ok"])).tone).toBe("ok");
    expect(verdictOf(entry(), view(["ok", "conflict"])).text).toBe(
      "1 of 2 rows can be put back. 1 was changed again by something else and will be left alone.",
    );
    expect(verdictOf(entry(), view(["conflict"])).tone).toBe("cant");
    expect(verdictOf(entry(), view(["noop"])).tone).toBe("info");
    expect(verdictOf(entry({ cant: "nokey" }), null).tone).toBe("cant");
    expect(actionLabel(view(["ok", "ok", "ok"]))).toBe("Undo 3 rows");
    expect(actionLabel(view(["ok", "conflict", "ok"]))).toBe("Undo 2 of 3 rows");
    expect(actionLabel(view(["ok", "done"], true))).toBe("Redo 1 row");
  });
});
