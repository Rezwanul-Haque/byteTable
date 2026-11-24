import { describe, expect, it } from "vitest";

import type { DebugPlan, DebugStep, StepOutcome } from "./debugServer";
import {
  clauseCounts,
  condRowsOf,
  focusOf,
  headOf,
  largestSource,
  lastStepOfClause,
  notesOf,
  queryBudget,
  stagesOf,
  type Msg,
} from "./debugModel";

const step = (key: string, extra: Partial<DebugStep> = {}): DebugStep => ({
  key,
  clause: key.startsWith("join") ? "from" : key,
  kw: key.toUpperCase(),
  text: key,
  range: [0, 1],
  sql: "SELECT 1",
  countSql: [],
  notes: [],
  ...extra,
});

const ok = (count: number, extra: Partial<StepOutcome> = {}): StepOutcome => ({
  count,
  columns: [],
  rows: [],
  ms: 1,
  ...extra,
});

const planOf = (...steps: DebugStep[]): DebugPlan => ({ steps, sources: [], canSample: true });

/** The acceptance query, as the backend plans and runs it on the fixture. */
const acceptance = () => {
  const plan = planOf(
    step("from", { table: "orders" }),
    step("join0", {
      table: "payments",
      join: { left: false, on: "p.order_id = o.id", alias: "p", noneSql: "", manySql: "" },
    }),
    step("where", {
      conds: [
        { text: "o.total > 100", sql: "" },
        { text: "p.status = 'zzz'", sql: "" },
      ],
    }),
    step("select"),
  );
  const outcomes = [ok(6), ok(5, { join: { none: 2, many: 1 } }), ok(0, { conds: [4, 0] }), ok(0)];
  return stagesOf(plan, outcomes, null);
};

const keys = (msgs: Msg[]) => msgs.map((m) => m.key);

describe("stagesOf", () => {
  it("carries the previous count forward and marks the step in flight", () => {
    const plan = planOf(step("from"), step("where"), step("select"));
    const s = stagesOf(plan, [ok(10)], 1);
    expect(s.map((x) => x.status)).toEqual(["done", "running", "pending"]);
    expect(s[1]!.prev).toBe(10);
  });

  it("skips every step after a failure", () => {
    const plan = planOf(step("from"), step("where"), step("select"));
    const s = stagesOf(plan, [ok(10), { ...ok(0), count: null, error: "boom" }], null);
    expect(s.map((x) => x.status)).toEqual(["done", "error", "skipped"]);
  });
});

describe("focusOf", () => {
  it("opens where the rows run out", () => {
    expect(focusOf(acceptance()).zeroAt).toBe(2);
  });

  it("points at the biggest JOIN or WHERE loss when nothing empties", () => {
    const plan = planOf(step("from"), step("join0"), step("where"), step("limit"));
    const s = stagesOf(plan, [ok(100), ok(90), ok(10), ok(1)], null);
    expect(focusOf(s)).toEqual({ zeroAt: -1, drop: 2 });
  });

  it("treats a failing step as where to look", () => {
    const plan = planOf(step("from"), step("where"));
    const s = stagesOf(plan, [ok(3), { ...ok(0), count: null, error: "bad column" }], null);
    expect(focusOf(s).zeroAt).toBe(1);
  });

  it("reports nothing for a query that keeps its rows", () => {
    const plan = planOf(step("from"), step("select"));
    expect(focusOf(stagesOf(plan, [ok(3), ok(3)], null))).toEqual({ zeroAt: -1, drop: -1 });
  });
});

describe("headOf", () => {
  it("writes each step's sentence from its counts", () => {
    const s = acceptance();
    expect(headOf(s[0]!, null)).toMatchObject({
      key: "debug.head.from",
      vars: { table: "orders" },
    });
    expect(headOf(s[1]!, null)).toMatchObject({ key: "debug.head.join", vars: { from: 6 } });
    expect(headOf(s[2]!, null)).toMatchObject({
      key: "debug.head.where",
      vars: { kept: 0, removed: 5 },
    });
  });

  it("chooses between the SELECT sentences", () => {
    const plan = planOf(step("from"), step("select", { aggregate: true }));
    const s = stagesOf(plan, [ok(6), ok(1)], null);
    expect(headOf(s[1]!, null)?.key).toBe("debug.head.selectAgg");
    const g = stagesOf(
      planOf(step("groupBy"), step("select", { grouped: true })),
      [ok(3), ok(3)],
      null,
    );
    expect(headOf(g[1]!, null)?.key).toBe("debug.head.selectGrouped");
  });

  it("says when a LIMIT or DISTINCT changes nothing", () => {
    const s = stagesOf(
      planOf(step("select"), step("distinct"), step("limit")),
      [ok(4), ok(4), ok(4)],
      null,
    );
    expect(headOf(s[1]!, null)?.key).toBe("debug.head.distinctNone");
    expect(headOf(s[2]!, null)?.key).toBe("debug.head.limitNone");
  });

  it("labels every sentence of a sampled run", () => {
    const s = acceptance();
    const head = headOf(s[0]!, { rows: 1000, table: "orders" });
    expect(head?.key).toBe("debug.head.sampled");
    expect((head?.vars?.head as Msg).key).toBe("debug.head.from");
  });

  it("has nothing to say before a step has run", () => {
    const s = stagesOf(planOf(step("from")), [], 0);
    expect(headOf(s[0]!, null)).toBeNull();
  });
});

describe("notesOf", () => {
  it("explains the acceptance query's JOIN and WHERE", () => {
    const s = acceptance();
    expect(keys(notesOf(s[1]!))).toEqual(["debug.note.joinDropped", "debug.note.joinRepeated"]);
    expect(keys(notesOf(s[2]!))).toEqual(["debug.note.runOut", "debug.note.condEmpty"]);
  });

  it("keeps LEFT JOIN rows instead of calling them dropped", () => {
    const plan = planOf(
      step("from"),
      step("join0", { join: { left: true, on: "a = b", alias: "p", noneSql: "", manySql: "" } }),
    );
    const s = stagesOf(plan, [ok(6), ok(6, { join: { none: 2, many: 0 } })], null);
    expect(keys(notesOf(s[1]!))).toEqual(["debug.note.joinLeftKept"]);
  });

  it("says when every row matched exactly once", () => {
    const plan = planOf(
      step("from"),
      step("join0", { join: { left: false, on: "a = b", alias: "p", noneSql: "", manySql: "" } }),
    );
    const s = stagesOf(plan, [ok(6), ok(6, { join: { none: 0, many: 0 } })], null);
    expect(keys(notesOf(s[1]!))).toEqual(["debug.note.joinExact"]);
  });

  it("leaves out a note whose probe failed", () => {
    const plan = planOf(
      step("from"),
      step("join0", { join: { left: false, on: "a = b", alias: "p", noneSql: "", manySql: "" } }),
    );
    const s = stagesOf(plan, [ok(6), ok(6, { join: { none: null, many: null } })], null);
    expect(notesOf(s[1]!)).toEqual([]);
  });

  it("flags a condition that removes nothing and the OR case", () => {
    const plan = planOf(
      step("from"),
      step("where", {
        conds: [
          { text: "a > 0", sql: "" },
          { text: "b = 1", sql: "" },
        ],
      }),
    );
    const s = stagesOf(plan, [ok(10), ok(4, { conds: [10, 4] })], null);
    expect(keys(notesOf(s[1]!))).toEqual(["debug.note.condNoop"]);
    const or = stagesOf(
      planOf(step("from"), step("where", { hasOr: true })),
      [ok(10), ok(4)],
      null,
    );
    expect(keys(notesOf(or[1]!))).toEqual(["debug.note.or"]);
  });

  it("warns about LIMIT without ORDER BY only when rows were cut", () => {
    const plan = planOf(step("select"), step("limit", { ordered: false }));
    expect(keys(notesOf(stagesOf(plan, [ok(10), ok(3)], null)[1]!))).toEqual([
      "debug.note.limitUnordered",
    ]);
    expect(notesOf(stagesOf(plan, [ok(2), ok(2)], null)[1]!)).toEqual([]);
    const ordered = planOf(step("select"), step("limit", { ordered: true }));
    expect(notesOf(stagesOf(ordered, [ok(10), ok(3)], null)[1]!)).toEqual([]);
  });

  it("warns about an aggregate over nothing", () => {
    const plan = planOf(step("where"), step("select", { aggregate: true }));
    const s = stagesOf(plan, [ok(0), ok(1)], null);
    expect(keys(notesOf(s[1]!))).toEqual(["debug.note.aggEmpty"]);
  });

  it("shows the statement's fixed notes even before a run", () => {
    const s = stagesOf(planOf(step("groupBy", { notes: [{ kind: "having" }] })), [], 0);
    expect(keys(notesOf(s[0]!))).toEqual(["debug.note.having"]);
  });
});

describe("condRowsOf", () => {
  it("lists each AND-ed condition's own count", () => {
    expect(condRowsOf(acceptance()[2]!)).toEqual([
      { text: "o.total > 100", keeps: 4 },
      { text: "p.status = 'zzz'", keeps: 0 },
    ]);
  });
});

describe("clause stepper", () => {
  it("folds joins into FROM and picks the clause's last step", () => {
    const s = acceptance();
    expect(clauseCounts(s)).toEqual({ from: 5, where: 0, select: 0 });
    expect(lastStepOfClause(s, "from")).toBe(1);
  });
});

describe("large tables", () => {
  it("asks about the biggest table over the threshold", () => {
    const plan: DebugPlan = { steps: [], sources: ["orders", "events"], canSample: true };
    const rows = (t: string) => ({ orders: 2_000_000, events: 5_000_000 })[t] ?? null;
    expect(largestSource(plan, rows)).toEqual({ table: "events", rows: 5_000_000 });
    expect(largestSource(plan, () => 10)).toBeNull();
    expect(largestSource(plan, () => null)).toBeNull();
  });

  it("budgets each step, its count and its probes", () => {
    const s = acceptance();
    expect(queryBudget({ steps: s.map((x) => x.step), sources: [], canSample: true })).toBe(12);
  });
});

describe("UPDATE / DELETE dry run", () => {
  const write = { kind: "update" as const, table: "orders", joined: true, preview: true };
  const plan = planOf(step("from"), step("where"), step("write", { notes: [{ kind: "dryRun" }] }));

  it("says how many rows would change, and that nothing did", () => {
    const s = stagesOf(plan, [ok(6), ok(3), ok(3, { countSource: 0 })], null);
    expect(headOf(s[2]!, null, write)).toMatchObject({
      key: "debug.head.update",
      vars: { table: "orders" },
    });
    expect(headOf(s[2]!, null, { ...write, kind: "delete" })?.key).toBe("debug.head.delete");
    expect(keys(notesOf(s[2]!, write))).toEqual(["debug.note.dryRun"]);
  });

  it("warns when a joined write had to be counted per joined row", () => {
    const s = stagesOf(plan, [ok(6), ok(5), ok(5, { countSource: 1 })], null);
    expect(keys(notesOf(s[2]!, write))).toEqual(["debug.note.dryRun", "debug.note.perJoinedRow"]);
    // Not joined: no such note.
    expect(keys(notesOf(s[2]!, { ...write, joined: false }))).toEqual(["debug.note.dryRun"]);
  });
});
