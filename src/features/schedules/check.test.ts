import { describe, expect, it } from "vitest";

import type { RunRecord, Schedule } from "./api";
import type { Translate } from "./recurrence";

/** Renders `key(vars)`, so assertions pin the key chosen, not the wording. */
const t: Translate = (key, vars) =>
  vars ? `${key}(${Object.entries(vars).map(([k, v]) => `${k}=${v}`)})` : key;
import {
  checkChoice,
  checkRows,
  describeCheck,
  failingCount,
  isFailing,
  sampleCell,
  withCheckChoice,
  withCheckRows,
} from "./check";

function schedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: "s1",
    name: "Orphan orders",
    enabled: true,
    connectionId: "conn-1",
    sql: "SELECT 1",
    recurrence: { kind: "daily", hour: 3, minute: 0 },
    format: "csv",
    check: null,
    writeFile: true,
    notify: false,
    directory: "/tmp",
    filename: "{{name}}",
    keep: 30,
    rowLimit: 100_000,
    createdAt: 0,
    nextRunAt: 0,
    ...overrides,
  };
}

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    scheduleId: "s1",
    startedAt: 1,
    durationMs: 1,
    trigger: "scheduled",
    rowCount: 0,
    truncated: false,
    ...overrides,
  };
}

describe("check choice", () => {
  it("reads the select value and row count off the rule", () => {
    expect(checkChoice(null)).toBe("none");
    expect(checkChoice(undefined)).toBe("none");
    expect(checkChoice({ kind: "noRows" })).toBe("noRows");
    expect(checkRows({ kind: "noRows" })).toBeUndefined();
    expect(checkRows({ kind: "atMost", rows: 4 })).toBe(4);
  });

  it("turning a check on also turns notify on", () => {
    const next = withCheckChoice(schedule(), "noRows");
    expect(next.check).toEqual({ kind: "noRows" });
    expect(next.notify).toBe(true);
  });

  it("switching between checks keeps the user's notify choice and the count", () => {
    const atMost = schedule({ check: { kind: "atMost", rows: 7 }, notify: false });
    const atLeast = withCheckChoice(atMost, "atLeast");
    expect(atLeast.check).toEqual({ kind: "atLeast", rows: 7 });
    expect(atLeast.notify).toBe(false);
  });

  it("at least never starts at 0, which always passes", () => {
    const next = withCheckChoice(schedule({ check: { kind: "atMost", rows: 0 } }), "atLeast");
    expect(next.check).toEqual({ kind: "atLeast", rows: 1 });
  });

  it("turning the check off turns the file back on", () => {
    const checkOnly = schedule({ check: { kind: "noRows" }, writeFile: false });
    const plain = withCheckChoice(checkOnly, "none");
    expect(plain.check).toBeNull();
    expect(plain.writeFile).toBe(true);
  });

  it("clamps the row count to the rule's floor", () => {
    const atLeast = schedule({ check: { kind: "atLeast", rows: 3 } });
    expect(withCheckRows(atLeast, 0).check).toEqual({ kind: "atLeast", rows: 1 });
    expect(withCheckRows(atLeast, Number.NaN).check).toEqual({ kind: "atLeast", rows: 1 });
    const atMost = schedule({ check: { kind: "atMost", rows: 3 } });
    expect(withCheckRows(atMost, -2).check).toEqual({ kind: "atMost", rows: 0 });
    expect(withCheckRows(atMost, 12.7).check).toEqual({ kind: "atMost", rows: 12 });
    const noRows = schedule({ check: { kind: "noRows" } });
    expect(withCheckRows(noRows, 5)).toBe(noRows);
  });
});

describe("failing", () => {
  it("an error or a check failure is failing; a clean run is not", () => {
    expect(isFailing(undefined)).toBe(false);
    expect(isFailing(run())).toBe(false);
    expect(isFailing(run({ error: "boom" }))).toBe(true);
    expect(isFailing(run({ checkFailure: "Returned 2 rows; expected none." }))).toBe(true);
  });

  it("counts active schedules by their LATEST run only", () => {
    const schedules = [
      schedule({ id: "a" }),
      schedule({ id: "b" }),
      schedule({ id: "c", enabled: false }),
      schedule({ id: "d" }),
    ];
    const runs = {
      // Failed, then recovered: not failing.
      a: [run({ error: "boom" }), run()],
      // Passed, then tripped: failing.
      b: [run(), run({ checkFailure: "Returned 1 row; expected none." })],
      // Failing but paused: left out.
      c: [run({ error: "boom" })],
      // d has never run.
    };
    expect(failingCount(schedules, runs)).toBe(1);
  });
});

describe("display", () => {
  it("describes each rule by its own key", () => {
    expect(describeCheck({ kind: "noRows" }, t)).toBe("sched.desc.noRows");
    expect(describeCheck({ kind: "atMost", rows: 10 }, t)).toBe("sched.desc.atMost(rows=10)");
    expect(describeCheck({ kind: "atLeast", rows: 1 }, t)).toBe("sched.desc.atLeast(rows=1)");
  });

  it("renders sampled cells as text", () => {
    expect(sampleCell(null)).toBe("NULL");
    expect(sampleCell("say hi")).toBe("say hi");
    expect(sampleCell(42)).toBe("42");
    expect(sampleCell(true)).toBe("true");
  });
});
