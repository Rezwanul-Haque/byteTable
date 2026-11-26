import { describe, expect, it } from "vitest";

import type { CellValue } from "../../shared/api/engine";
import {
  diff,
  dupes,
  firstList,
  norm,
  same,
  suggestKey,
  verdictOf,
  type Side,
} from "./compareModel";
import { isMultiStatement, isReadOnlySql } from "./readSql";

const side = (columns: string[], rows: CellValue[][]): Side => ({ columns, rows });

describe("equality (A1)", () => {
  it("compares numbers by value", () => {
    expect(same(1, 1.0)).toBe(true);
    expect(same("42", 42)).toBe(true);
    expect(same("1.50", 1.5)).toBe(true);
    expect(same("-3", -3)).toBe(true);
  });
  it("treats NULL as equal to NULL and to nothing else", () => {
    expect(same(null, null)).toBe(true);
    expect(same(null, undefined)).toBe(true);
    expect(same(null, 0)).toBe(false);
    expect(same(null, "")).toBe(false);
    expect(same(null, "null")).toBe(false);
  });
  it("compares text exactly", () => {
    expect(same("a", "a ")).toBe(false);
    expect(same("A", "a")).toBe(false);
    expect(same("a", "a")).toBe(true);
  });
  it("keeps long digit strings as text", () => {
    expect(same("9007199254740993", "9007199254740992")).toBe(false);
    expect(norm("12345678901234567")).toBe("s:12345678901234567");
  });
  it("compares booleans and JSON", () => {
    expect(same(true, true)).toBe(true);
    expect(same(true, "true")).toBe(false);
    expect(same({ a: 1, b: [2] } as unknown as CellValue, { a: 1, b: [2] } as unknown)).toBe(true);
  });
});

const A = side(
  ["id", "status", "total"],
  [
    [1, "shipped", 120],
    [2, "delivered", 300],
    [3, "delivered", 150],
  ],
);

describe("diff by key (A2)", () => {
  it("reports changed, only in A, only in B and same", () => {
    const B = side(
      ["id", "status", "total"],
      [
        [2, "delivered", 300],
        [3, "delivered", 175],
        [4, "shipped", 999],
      ],
    );
    const d = diff(A, B, { key: ["id"] });
    expect(d.mode).toBe("key");
    expect(d.counts).toMatchObject({ same: 1, changed: 1, onlyA: 1, onlyB: 1 });
    expect(d.changed[0]!.cols).toEqual([2]);
    expect(d.changed[0]!.a).toEqual([3, "delivered", 150]);
    expect(d.changed[0]!.b).toEqual([3, "delivered", 175]);
    expect(d.onlyA).toEqual([[1, "shipped", 120]]);
    expect(d.onlyB).toEqual([[4, "shipped", 999]]);
    expect(verdictOf(d)).toBe("differ");
    expect(firstList(d)).toBe("changed");
  });

  it("matches on a two-column key", () => {
    const a = side(
      ["day", "region", "n"],
      [
        ["mon", "eu", 1],
        ["mon", "us", 2],
      ],
    );
    const b = side(
      ["day", "region", "n"],
      [
        ["mon", "us", 3],
        ["mon", "eu", 1],
      ],
    );
    const d = diff(a, b, { key: ["day", "region"] });
    expect(d.counts).toMatchObject({ same: 1, changed: 1, onlyA: 0, onlyB: 0 });
    expect(d.changed[0]!.a).toEqual(["mon", "us", 2]);
    expect(d.dupA).toBe(0);
  });

  it("pairs a non-unique key in order and reports the duplicates", () => {
    const a = side(
      ["status", "total"],
      [
        ["open", 1],
        ["open", 2],
        ["paid", 3],
      ],
    );
    const b = side(
      ["status", "total"],
      [
        ["open", 1],
        ["open", 5],
        ["open", 6],
      ],
    );
    const d = diff(a, b, { key: ["status"] });
    expect(d.dupA).toBe(2);
    expect(d.dupB).toBe(3);
    expect(d.same).toEqual([["open", 1]]);
    expect(d.changed.map((c) => c.b)).toEqual([["open", 5]]);
    expect(d.onlyA).toEqual([["paid", 3]]);
    expect(d.onlyB).toEqual([["open", 6]]);
  });

  it("ignores a key column that is not shared", () => {
    const d = diff(side(["id", "x"], [[1, 1]]), side(["x"], [[1]]), { key: ["id"] });
    expect(d.mode).toBe("row");
  });
});

describe("diff by whole row (A3)", () => {
  it("counts duplicates: three copies against two is one only in A", () => {
    const row: CellValue[] = ["delivered", 10];
    const a = side(["status", "n"], [row, row, row]);
    const b = side(["status", "n"], [row, row]);
    const d = diff(a, b);
    expect(d.mode).toBe("row");
    expect(d.counts).toMatchObject({ same: 2, onlyA: 1, onlyB: 0, changed: 0 });
  });
  it("reports a changed value as one only in A and one only in B", () => {
    const B = side(
      ["id", "status", "total"],
      [
        [1, "shipped", 120],
        [2, "delivered", 300],
        [3, "delivered", 175],
      ],
    );
    const d = diff(A, B);
    expect(d.counts).toMatchObject({ same: 2, onlyA: 1, onlyB: 1, changed: 0 });
  });
});

describe("columns (A4)", () => {
  it("compares shared columns in A's order and lists the rest", () => {
    const a = side(["id", "status"], [[1, "x"]]);
    const b = side(["total", "id"], [[9, 1]]);
    const d = diff(a, b, { key: ["id"] });
    expect(d.cols).toEqual(["id"]);
    expect(d.onlyACols).toEqual(["status"]);
    expect(d.onlyBCols).toEqual(["total"]);
    expect(d.rowsEqual).toBe(true);
    expect(d.identical).toBe(false);
    expect(verdictOf(d)).toBe("colsDiffer");
  });
  it("has nothing to compare without shared columns", () => {
    const d = diff(side(["a"], [[1]]), side(["b"], [[1]]));
    expect(d.noShared).toBe(true);
    expect(verdictOf(d)).toBe("noShared");
  });
});

describe("order (A5)", () => {
  const b = side(
    ["id", "status", "total"],
    [
      [3, "delivered", 150],
      [1, "shipped", 120],
      [2, "delivered", 300],
    ],
  );
  it("notes a different order but ignores it by default", () => {
    const d = diff(A, b, { key: ["id"] });
    expect(d.orderDiffers).toBe(true);
    expect(d.identical).toBe(true);
    expect(verdictOf(d)).toBe("same");
  });
  it("counts the order when it matters", () => {
    const d = diff(A, b, { key: ["id"], ordered: true });
    expect(d.identical).toBe(false);
    expect(verdictOf(d)).toBe("order");
  });
  it("same order stays the same", () => {
    expect(diff(A, A, { ordered: true }).orderDiffers).toBe(false);
  });
});

describe("key suggestion (A6)", () => {
  it("prefers id over status when both qualify", () => {
    const a = side(
      ["status", "id"],
      [
        ["a", 1],
        ["b", 2],
      ],
    );
    expect(suggestKey(a, a)).toEqual(["id"]);
  });
  it("prefers a *_id column over a plain one", () => {
    const a = side(
      ["total", "order_id"],
      [
        [1, 10],
        [2, 11],
      ],
    );
    expect(suggestKey(a, a)).toEqual(["order_id"]);
  });
  it("chooses nothing when every shared column repeats", () => {
    const a = side(
      ["status", "n"],
      [
        ["x", 1],
        ["x", 1],
      ],
    );
    expect(suggestKey(a, a)).toEqual([]);
  });
  it("rejects a column with a NULL, or unique on one side only", () => {
    const a = side(
      ["id", "code"],
      [
        [1, null],
        [2, "b"],
      ],
    );
    const b = side(
      ["id", "code"],
      [
        [1, "a"],
        [1, "b"],
      ],
    );
    expect(suggestKey(a, b)).toEqual([]);
  });
});

describe("dupes", () => {
  it("counts every row in a repeated group", () => {
    expect(dupes([[1], [1], [2], [3], [3], [3]], [0])).toBe(5);
  });
});

describe("read-only check (A7)", () => {
  it("accepts reads", () => {
    expect(isReadOnlySql("SELECT * FROM orders WHERE status = 'delete'")).toBe(true);
    expect(isReadOnlySql("with x as (select 1) select * from x")).toBe(true);
    expect(isReadOnlySql("SELECT updated_at, replace(name, 'a', 'b') FROM t")).toBe(true);
  });
  it("refuses writes", () => {
    expect(isReadOnlySql("UPDATE orders SET status = 'x'")).toBe(false);
    expect(isReadOnlySql("DELETE FROM orders")).toBe(false);
    expect(isReadOnlySql("drop table t")).toBe(false);
    expect(isReadOnlySql("SELECT 1; DELETE FROM t")).toBe(false);
    expect(isReadOnlySql("WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x")).toBe(false);
    expect(isReadOnlySql("SELECT * INTO backup FROM t")).toBe(false);
    expect(isReadOnlySql("SELECT * FROM t FOR UPDATE")).toBe(false);
  });
  it("finds more than one statement", () => {
    expect(isMultiStatement("SELECT 1; SELECT 2")).toBe(true);
    expect(isMultiStatement("SELECT ';' ;")).toBe(false);
  });
});
