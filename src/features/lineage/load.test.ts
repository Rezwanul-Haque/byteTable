import { describe, expect, it } from "vitest";

import type { CellValue, ColumnInfo, FetchRowsRequest, RowsPage } from "../../shared/api/engine";
import { graphOf } from "./graph";
import { initialData, loadGroup, loadLineage, type LineageApi, type LineageData } from "./load";
import type { Row, TableShape } from "./model";

// A tiny in-memory ByteShop: orders → users, order_items → orders + products,
// payments → orders, reviews → orders (no rows).
const col = (name: string, pk = false): ColumnInfo => ({
  name,
  dataType: "text",
  nullable: true,
  pk,
  fk: null,
});

function shop(items = 3) {
  const tables: Record<string, Row[]> = {
    users: [
      { id: 5, name: "Ada Lovelace", email: "ada@example.com" },
      { id: 6, name: "Alan Turing", email: "alan@example.com" },
    ],
    products: [{ id: 9, name: "External HDD 8TB", sku: "HDD-8" }],
    orders: [
      { id: 1, user_id: 5, total: 120, status: "paid" },
      { id: 2, user_id: 404, total: 10, status: "paid" },
      { id: 3, user_id: null, total: 7, status: "open" },
    ],
    order_items: Array.from({ length: items }, (_, i) => ({
      id: i + 1,
      order_id: 1,
      product_id: 9,
      qty: 1,
    })),
    payments: [{ id: 1, order_id: 1, amount: 120 }],
    reviews: [],
  };
  const shapes: Record<string, TableShape> = {
    users: {
      name: "users",
      pk: "id",
      columns: [col("id", true), col("name"), col("email")],
      fks: [],
      refs: [{ table: "orders", col: "user_id", refCol: "id" }],
    },
    products: {
      name: "products",
      pk: "id",
      columns: [col("id", true), col("name"), col("sku")],
      fks: [],
      refs: [{ table: "order_items", col: "product_id", refCol: "id" }],
    },
    orders: {
      name: "orders",
      pk: "id",
      columns: [col("id", true), col("user_id"), col("total"), col("status")],
      fks: [{ col: "user_id", refTable: "users", refCol: "id" }],
      refs: [
        { table: "order_items", col: "order_id", refCol: "id" },
        { table: "payments", col: "order_id", refCol: "id" },
        { table: "reviews", col: "order_id", refCol: "id" },
      ],
    },
    order_items: {
      name: "order_items",
      pk: "id",
      columns: [col("id", true), col("order_id"), col("product_id"), col("qty")],
      fks: [
        { col: "order_id", refTable: "orders", refCol: "id" },
        { col: "product_id", refTable: "products", refCol: "id" },
      ],
      refs: [],
    },
    payments: {
      name: "payments",
      pk: "id",
      columns: [col("id", true), col("order_id"), col("amount")],
      fks: [{ col: "order_id", refTable: "orders", refCol: "id" }],
      refs: [],
    },
    reviews: {
      name: "reviews",
      pk: "id",
      columns: [col("id", true), col("order_id")],
      fks: [{ col: "order_id", refTable: "orders", refCol: "id" }],
      refs: [],
    },
  };
  const calls: { rows: Omit<FetchRowsRequest, "schema">[]; counts: number } = {
    rows: [],
    counts: 0,
  };
  const fail = { rows: new Set<string>(), counts: new Set<string>() };

  const match = (r: Row, req: Omit<FetchRowsRequest, "schema">) => {
    const f = req.filter;
    if (!f || f.mode !== "conditions") return true;
    return f.items.every((c) => {
      const v = String(r[c.column]);
      if (c.op === "eq") return v === String(c.value);
      if (c.op === "inList") return (c.value as CellValue[]).map(String).includes(v);
      return false;
    });
  };
  const api: LineageApi = {
    shape: async (t) => shapes[t] ?? null,
    rows: async (req) => {
      calls.rows.push(req);
      if (fail.rows.has(req.table)) throw new Error("boom");
      const cols = shapes[req.table]!.columns;
      const all = (tables[req.table] ?? []).filter((r) => match(r, req));
      const page: RowsPage = {
        columns: cols.map((c) => ({ name: c.name, typeHint: "" })),
        rows: all
          .slice(req.offset, req.offset + req.limit)
          .map((r) => cols.map((c) => r[c.name] ?? null)),
        offset: req.offset,
        limit: req.limit,
        totalRows: req.skipCount ? null : all.length,
        elapsedMs: 0,
      };
      return page;
    },
    count: async (t, c, v) => {
      calls.counts++;
      if (fail.counts.has(t)) throw new Error("slow");
      return (tables[t] ?? []).filter((r) => String(r[c]) === String(v)).length;
    },
  };
  return { api, calls, fail };
}

async function run(api: LineageApi, table: string, key: CellValue): Promise<LineageData> {
  let d = initialData(table, key);
  await loadLineage(
    api,
    table,
    key,
    (fn) => (d = fn(d)),
    () => true,
  );
  return d;
}

const plain = (v: CellValue) => String(v);

describe("loadLineage", () => {
  it("draws an order with its customer, its items and its payments", async () => {
    const { api } = shop();
    const g = graphOf(await run(api, "orders", 1), plain)!;
    expect(g.label.text).toBe("");
    expect(g.parents).toHaveLength(1);
    expect(g.parents[0]).toMatchObject({
      refTable: "users",
      state: "ok",
      key: 5,
      label: "Ada Lovelace",
    });
    expect(g.children.map((c) => [c.table, c.count])).toEqual([
      ["order_items", 3],
      ["payments", 1],
    ]);
    const items = g.children[0]!;
    expect(items.rows[0]!.hops).toEqual([
      { col: "product_id", refTable: "products", refCol: "id", key: 9, label: "External HDD 8TB" },
    ]);
    // the reference back at the centre is not a hop
    expect(items.rows[0]!.hops.some((h) => h.col === "order_id")).toBe(false);
    expect(g.empty).toEqual([{ table: "reviews", col: "order_id" }]);
    expect(g.up).toBe(1);
    expect(g.down).toBe(4);
    expect(g.broken).toBe(0);
  });

  it("shows a deleted target as a broken reference, and an empty key as not linked", async () => {
    const { api } = shop();
    const broken = graphOf(await run(api, "orders", 2), plain)!;
    expect(broken.parents[0]).toMatchObject({ state: "missing", value: 404 });
    expect(broken.broken).toBe(1);
    const unlinked = graphOf(await run(api, "orders", 3), plain)!;
    expect(unlinked.parents[0]!.state).toBe("null");
  });

  it("a row that no longer exists is said so", async () => {
    const { api } = shop();
    expect((await run(api, "orders", 999)).status).toBe("no-row");
  });

  it("runs the same number of queries however many rows point here", async () => {
    const few = shop(3);
    const many = shop(5000);
    await run(few.api, "orders", 1);
    await run(many.api, "orders", 1);
    expect(many.calls.rows.length).toBe(few.calls.rows.length);
    expect(many.calls.counts).toBe(few.calls.counts);
    // a stack lists at most 8 rows, and its count is the true total
    const g = graphOf(await run(many.api, "orders", 1), plain)!;
    const items = g.children.find((c) => c.table === "order_items")!;
    expect(items.rows).toHaveLength(8);
    expect(items.count).toBe(5000);
    // every row read skips the count, and is bounded
    expect(many.calls.rows.every((r) => r.skipCount && r.limit <= 200)).toBe(true);
  });

  it("a failed count leaves the rows and says the count is unavailable", async () => {
    const s = shop(20);
    s.fail.counts.add("order_items");
    const g = graphOf(await run(s.api, "orders", 1), plain)!;
    const items = g.children.find((c) => c.table === "order_items")!;
    expect(items.rows).toHaveLength(8);
    expect(items.count).toBeNull();
    expect(items.countState).toBe("unavailable");
  });

  it("a short stack's row list is its count; no wait on the count query", async () => {
    const s = shop(3);
    s.fail.counts.add("order_items");
    const g = graphOf(await run(s.api, "orders", 1), plain)!;
    expect(g.children.find((c) => c.table === "order_items")).toMatchObject({
      count: 3,
      countState: "ready",
    });
  });

  it("a failed stack does not block the rest, and Retry reloads it", async () => {
    const s = shop();
    s.fail.rows.add("payments");
    let d = await run(s.api, "orders", 1);
    const g = graphOf(d, plain)!;
    expect(g.children.find((c) => c.table === "payments")!.status).toBe("error");
    expect(g.children.find((c) => c.table === "order_items")!.status).toBe("ready");

    s.fail.rows.delete("payments");
    const i = d.groups.findIndex((x) => x.table === "payments");
    await loadGroup(
      s.api,
      { ...d.groups[i]!, status: "loading" },
      i,
      (fn) => (d = fn(d)),
      () => true,
    );
    expect(graphOf(d, plain)!.children.find((c) => c.table === "payments")!.rows).toHaveLength(1);
  });

  it("walking to an order item finds its parents and their labels", async () => {
    const { api } = shop();
    const g = graphOf(await run(api, "order_items", 1), plain)!;
    expect(g.parents.map((p) => [p.refTable, p.label])).toEqual([
      ["orders", ""],
      ["products", "External HDD 8TB"],
    ]);
    // the order's own customer is the parent's hop
    expect(g.parents[0]!.hops.map((h) => h.label)).toEqual(["Ada Lovelace"]);
    expect(g.children).toEqual([]);
  });
});
