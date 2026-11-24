import { describe, expect, it } from "vitest";

import type { CellValue, ColumnMeta } from "../../shared/api/engine";
import {
  columnsSig,
  donutSlices,
  donutUnfit,
  firstCfg,
  fmt,
  infer,
  NULL_LABEL,
  numOf,
  profile,
  series,
  short,
  ticks,
  type ChartCfg,
} from "./chartModel";

const col = (name: string, typeHint = ""): ColumnMeta => ({ name, typeHint });
const text = {
  rowLabel: (n: number) => `row ${n}`,
  countName: "row count",
  colName: (i: number) => ["a", "b", "c", "d"][i] ?? `c${i}`,
};

/** `SELECT status, COUNT(*) AS n, SUM(total) AS revenue FROM orders GROUP BY status`. */
const byStatus = {
  columns: [col("status", "TEXT"), col("n", "INT8"), col("revenue", "NUMERIC")],
  rows: [
    ["delivered", 24, "20359.64"],
    ["pending", 7, "5035.98"],
    ["cancelled", 5, "4210.10"],
  ] as CellValue[][],
};

describe("profile (A1)", () => {
  it("reads an aggregate alias as a number, even as an exact-decimal string", () => {
    const p = profile(byStatus.columns, byStatus.rows);
    expect(p.map((c) => c.kind)).toEqual(["text", "number", "number"]);
  });

  it("reads timestamps as time and flags ID-like names", () => {
    const p = profile(
      [col("created_at", "TIMESTAMPTZ"), col("user_id", "INT4"), col("o.id"), col("idea")],
      [["2026-11-22 11:41:00+00", 1, 3, "x"]],
    );
    expect(p.map((c) => c.kind)).toEqual(["time", "number", "number", "text"]);
    expect(p.map((c) => c.idLike)).toEqual([false, true, true, false]);
  });

  it("keeps a numeric-looking code in a text column as text", () => {
    const p = profile([col("zip", "VARCHAR")], [["007"], ["123"]]);
    expect(p[0]!.kind).toBe("text");
  });

  it("falls back to the values when the driver gives no type (SQLite expressions)", () => {
    const p = profile(
      [col("x"), col("y")],
      [
        [1.5, "a"],
        [null, "b"],
      ],
    );
    expect(p.map((c) => c.kind)).toEqual(["number", "text"]);
  });

  it("parses numbers out of numeric strings only", () => {
    expect(numOf("12.5")).toBe(12.5);
    expect(numOf("-3")).toBe(-3);
    expect(numOf("12a")).toBeNull();
    expect(numOf(null)).toBeNull();
  });
});

describe("infer (A2) — each §4 test query opens on its state", () => {
  const first = (columns: ColumnMeta[], rows: CellValue[][]) => infer(profile(columns, rows), rows);

  it("bar, one value: label by the text column, the first non-ID number", () => {
    expect(first(byStatus.columns, byStatus.rows)).toEqual({
      type: "bar",
      x: 0,
      ys: [1],
      count: false,
    });
  });

  it("line: a time column and a number", () => {
    const r = first(
      [col("created_at", "TIMESTAMP"), col("total", "NUMERIC")],
      [
        ["2026-01-01 10:00:00", 5],
        ["2026-01-02 10:00:00", 7],
      ],
    );
    expect(r).toMatchObject({ type: "line", x: 0, ys: [1] });
  });

  it("row count: no number column, label by the text column that repeats most", () => {
    const r = first(
      [col("full_name", "TEXT"), col("country", "TEXT")],
      [
        ["Ada", "UK"],
        ["Grace", "US"],
        ["Linus", "FI"],
        ["Guido", "NL"],
        ["Yukihiro", "JP"],
        ["Bjarne", "DK"],
        ["Anders", "DK"],
      ],
    );
    expect(r).toEqual({ type: "bar", x: 1, ys: [], count: true });
  });

  it("single number: one bar labelled by row number", () => {
    expect(first([col("n", "INT8")], [[42]])).toEqual({
      type: "bar",
      x: null,
      ys: [0],
      count: false,
    });
  });

  it("only numbers: the ID-like column labels the next one", () => {
    expect(first([col("id", "INT4"), col("total", "NUMERIC")], [[1, 5]])).toMatchObject({
      x: 0,
      ys: [1],
    });
  });
});

describe("series (A3)", () => {
  const cfg = (over: Partial<ChartCfg>): ChartCfg => ({
    type: "bar",
    x: 0,
    ys: [1],
    count: false,
    agg: "sum",
    sort: "asis",
    ...over,
  });
  const rows: CellValue[][] = [
    ["paid", 10],
    ["open", 4],
    ["paid", 6],
    [null, 1],
  ];

  it("groups rows by label in first-seen order and combines with each agg", () => {
    const sum = series(rows, cfg({}), "text", text);
    expect(sum.points.map((p) => [p.label, p.values[0], p.n])).toEqual([
      ["paid", 16, 2],
      ["open", 4, 1],
      [NULL_LABEL, 1, 1],
    ]);
    expect(sum.grouped).toBe(true);
    const at = (agg: ChartCfg["agg"]) =>
      series(rows, cfg({ agg }), "text", text).points[0]!.values[0];
    expect(at("avg")).toBe(8);
    expect(at("min")).toBe(6);
    expect(at("max")).toBe(10);
  });

  it("keeps null labels as their own point", () => {
    expect(series(rows, cfg({}), "text", text).points.some((p) => p.label === NULL_LABEL)).toBe(
      true,
    );
  });

  it("orders time and number labels ascending, text as returned or largest first", () => {
    const t = series(
      [
        ["2026-02", 1],
        ["2026-01", 2],
      ],
      cfg({}),
      "time",
      text,
    );
    expect(t.points.map((p) => p.label)).toEqual(["2026-01", "2026-02"]);
    const n = series(
      [
        [10, 1],
        [2, 2],
      ],
      cfg({}),
      "number",
      text,
    );
    expect(n.points.map((p) => p.label)).toEqual(["2", "10"]);
    const asis = series(rows, cfg({}), "text", text);
    expect(asis.points[0]!.label).toBe("paid");
    const big = series(
      [
        ["a", 1],
        ["b", 9],
      ],
      cfg({ sort: "value" }),
      "text",
      text,
    );
    expect(big.points.map((p) => p.label)).toEqual(["b", "a"]);
  });

  it("counts rows per label, and labels rows by number with no label column", () => {
    const c = series(rows, cfg({ count: true, ys: [] }), "text", text);
    expect(c.names).toEqual(["row count"]);
    expect(c.points[0]!.values).toEqual([2]);
    const r = series([[5], [6]], cfg({ x: null, ys: [0] }), undefined, text);
    expect(r.points.map((p) => p.label)).toEqual(["row 1", "row 2"]);
    expect(r.grouped).toBe(false);
  });

  it("flags two series on very different scales", () => {
    const s = series(byStatus.rows, cfg({ ys: [1, 2] }), "text", {
      ...text,
      colName: (i) => byStatus.columns[i]!.name,
    });
    expect(s.lopsided).toEqual({ big: "revenue", small: "n" });
    expect(series(rows, cfg({}), "text", text).lopsided).toBeNull();
  });
});

describe("ticks and numbers (A4)", () => {
  it("steps on 1 / 2 / 5 × 10ⁿ and includes zero", () => {
    expect(ticks(0, 2199.9, 3)).toEqual([0, 1000, 2000, 3000]);
    expect(ticks(-50, 120, 4)).toEqual([-50, 0, 50, 100, 150]);
  });

  it("formats values and axis labels", () => {
    expect(fmt(1234.567)).toBe("1,235");
    expect(fmt(12.345)).toBe("12.35");
    expect(short(9999)).toBe("9,999");
    expect(short(12_500)).toBe("12.5k");
    expect(short(3_000_000)).toBe("3M");
    expect(short(-2_100_000_000)).toBe("-2.1B");
  });
});

describe("settings", () => {
  it("start from the suggestion with sum and as-returned order", () => {
    const c = firstCfg(profile(byStatus.columns, byStatus.rows), byStatus.rows);
    expect(c).toMatchObject({ agg: "sum", sort: "asis", ys: [1] });
  });

  it("change signature only when the column list changes", () => {
    expect(columnsSig(byStatus.columns)).toBe(columnsSig([...byStatus.columns]));
    expect(columnsSig(byStatus.columns)).not.toBe(columnsSig(byStatus.columns.slice(1)));
  });
});

describe("donut", () => {
  const first = (columns: ColumnMeta[], rows: CellValue[][]) => infer(profile(columns, rows), rows);

  it("profiles booleans, including SQL Server's 0 / 1 bit", () => {
    expect(profile([col("active", "BOOL")], [[true], [false], [null]])[0]!.kind).toBe("bool");
    expect(profile([col("active", "bit")], [[1], [0]])[0]!.kind).toBe("bool");
    // MySQL: a TINYINT(1) / TINYINT holding only 0 and 1.
    expect(profile([col("is_active", "tinyint(1)")], [[1], [0], [null]])[0]!.kind).toBe("bool");
    expect(profile([col("is_active", "TINYINT")], [[1], [0]])[0]!.kind).toBe("bool");
    // …but not one holding other values, and 0 / 1 in a wider integer is a number.
    expect(profile([col("level", "TINYINT")], [[1], [3]])[0]!.kind).toBe("number");
    expect(profile([col("n", "INT4")], [[1], [0]])[0]!.kind).toBe("number");
  });

  it("is suggested when counting a boolean or a handful of statuses", () => {
    expect(first([col("active", "BOOL")], [[true], [false], [true]]).type).toBe("donut");
    const statuses = [["paid"], ["open"], ["void"], ["paid"]];
    expect(first([col("status", "TEXT")], statuses).type).toBe("donut");
    // Five or more distinct labels, or a value column: stays a bar.
    const many = [["a"], ["b"], ["c"], ["d"], ["e"]];
    expect(first([col("status", "TEXT")], many).type).toBe("bar");
    expect(first(byStatus.columns, byStatus.rows).type).toBe("bar");
  });

  const cfg = (over: Partial<ChartCfg> = {}): ChartCfg => ({
    type: "donut",
    x: 0,
    ys: [1],
    count: false,
    agg: "sum",
    sort: "asis",
    ...over,
  });

  it("fits one series of non-negative totals only", () => {
    const one = series(
      [
        ["a", 3],
        ["b", 1],
      ],
      cfg(),
      "text",
      text,
    );
    expect(donutUnfit(one, cfg())).toBeNull();
    expect(donutUnfit(one, cfg({ agg: "avg" }))).toBe("agg");
    const two = series([["a", 3, 1]], cfg({ ys: [1, 2] }), "text", text);
    expect(donutUnfit(two, cfg({ ys: [1, 2] }))).toBe("series");
    const neg = series(
      [
        ["a", -3],
        ["b", 1],
      ],
      cfg(),
      "text",
      text,
    );
    expect(donutUnfit(neg, cfg())).toBe("negative");
    const zero = series([["a", 0]], cfg(), "text", text);
    expect(donutUnfit(zero, cfg())).toBe("empty");
  });

  it("keeps the six largest slices and folds the rest into Other", () => {
    const rows: CellValue[][] = "abcdefghij".split("").map((l, i) => [l, 10 - i]);
    const { slices, total, folded } = donutSlices(series(rows, cfg(), "text", text), "Other");
    expect(slices.map((s) => s.label)).toEqual(["a", "b", "c", "d", "e", "f", "Other"]);
    expect(slices[6]).toMatchObject({ value: 4 + 3 + 2 + 1, other: true });
    expect(folded).toBe(4);
    expect(total).toBe(55);
    expect(slices.reduce((s, x) => s + x.share, 0)).toBeCloseTo(1);
  });
});
