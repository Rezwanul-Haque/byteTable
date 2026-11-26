import { describe, expect, it } from "vitest";

import type { ColumnInfo, TableMeta } from "../../shared/api/engine";
import {
  badgeText,
  curve,
  dock,
  factCols,
  fitWorld,
  keyFull,
  keyText,
  isLinked,
  labelOf,
  LN_HUES,
  LN_W,
  lnHue,
  put,
  shapeOf,
  spread,
  stackWidth,
  walk,
  worldHeight,
} from "./model";

const col = (name: string, extra: Partial<ColumnInfo> = {}): ColumnInfo => ({
  name,
  dataType: "text",
  nullable: true,
  pk: false,
  fk: null,
  ...extra,
});

const meta = (m: Partial<TableMeta>): TableMeta => ({
  columns: [],
  indexes: [],
  foreignKeys: [],
  referencedBy: [],
  ...m,
});

describe("shapeOf / isLinked", () => {
  it("reads both directions from declared constraints and skips composite keys", () => {
    const s = shapeOf(
      "orders",
      meta({
        columns: [col("id", { pk: true }), col("user_id")],
        foreignKeys: [
          {
            name: null,
            columns: ["user_id"],
            refTable: "users",
            refColumns: ["id"],
            onDelete: null,
            onUpdate: null,
          },
          {
            name: null,
            columns: ["a", "b"],
            refTable: "pairs",
            refColumns: ["a", "b"],
            onDelete: null,
            onUpdate: null,
          },
        ],
        referencedBy: [
          { table: "order_items", columns: ["order_id"], refColumns: ["id"], onDelete: null },
        ],
      }),
    );
    expect(s.pk).toBe("id");
    expect(s.fks).toEqual([{ col: "user_id", refTable: "users", refCol: "id" }]);
    expect(s.refs).toEqual([{ table: "order_items", col: "order_id", refCol: "id" }]);
    expect(isLinked(s)).toBe(true);
  });

  it("a column named like a foreign key is not one without a constraint", () => {
    const s = shapeOf("orders", meta({ columns: [col("id", { pk: true }), col("user_id")] }));
    expect(s.fks).toEqual([]);
    expect(isLinked(s)).toBe(false);
  });

  it("needs a single-column primary key", () => {
    const s = shapeOf(
      "links",
      meta({
        columns: [col("a", { pk: true }), col("b", { pk: true })],
        referencedBy: [{ table: "x", columns: ["l"], refColumns: ["a"], onDelete: null }],
      }),
    );
    expect(s.pk).toBeNull();
    expect(isLinked(s)).toBe(false);
  });
});

describe("labelOf", () => {
  const cols = [col("id"), col("email"), col("name")];
  it("takes the first name-like column that is not empty", () => {
    expect(labelOf(cols, { id: 1, email: "a@b.c", name: "" })).toEqual({
      text: "a@b.c",
      col: "email",
    });
    expect(labelOf(cols, { id: 1, email: "a@b.c", name: "Ada" })).toEqual({
      text: "Ada",
      col: "name",
    });
  });
  it("cuts a UUID to its first block", () => {
    const c = [col("public_id")];
    expect(labelOf(c, { public_id: "0f8fad5b-d9cb-469f-a165-70867728950e" }).text).toBe(
      "0f8fad5b…",
    );
  });
  it("goes through the masking entry point", () => {
    expect(labelOf(cols, { email: "a@b.c" }, () => "•••").text).toBe("•••");
  });
  it("has no label without a name-like column", () => {
    expect(labelOf([col("id")], { id: 5 })).toEqual({ text: "", col: null });
  });
});

describe("factCols", () => {
  it("skips the key, foreign keys, the label column, objects and long values", () => {
    const cols = [
      col("id", { pk: true }),
      col("product_id"),
      col("name"),
      col("qty"),
      col("meta"),
      col("note"),
      col("price"),
    ];
    const row = {
      id: 1,
      product_id: 2,
      name: "x",
      qty: 3,
      meta: null,
      note: "y".repeat(50),
      price: 9,
    };
    expect(factCols(cols, row, ["product_id"], "name", 2, 40)).toEqual(["qty", "price"]);
  });
});

describe("colour and badge", () => {
  it("gives a table the same hue every time, from the palette", () => {
    expect(lnHue("orders")).toBe(lnHue("orders"));
    expect(LN_HUES).toContain(lnHue("order_items"));
  });
  it("uses the initials of the first two words, else the first two letters", () => {
    expect(badgeText("order_items")).toBe("OI");
    expect(badgeText("users")).toBe("US");
  });
});

describe("walk", () => {
  const trail = [
    { table: "orders", key: 1 },
    { table: "order_items", key: 1 },
  ];
  it("appends and moves to the new row", () => {
    expect(walk(trail, 1, { table: "products", key: 7 })).toEqual({
      trail: [...trail, { table: "products", key: 7 }],
      at: 2,
    });
  });
  it("walking from the middle drops what came after", () => {
    expect(walk(trail, 0, { table: "users", key: 5 })).toEqual({
      trail: [trail[0], { table: "users", key: 5 }],
      at: 1,
    });
  });
  it("walking to the centre row changes nothing", () => {
    expect(walk(trail, 1, { table: "order_items", key: "1" })).toEqual({ trail, at: 1 });
  });
});

describe("geometry", () => {
  it("sizes the world for the taller column", () => {
    expect(worldHeight(1, 2)).toBe(480);
    expect(worldHeight(1, 5)).toBe(5 * 158 + 110);
  });
  it("spreads a column 158 apart around the middle", () => {
    expect(spread(1, 0, 480)).toBe(240);
    expect(spread(3, 0, 600) - spread(3, 1, 600)).toBe(-158);
    expect(spread(3, 1, 600)).toBe(300);
  });
  it("links leave heading left and arrive from the right", () => {
    expect(curve(400, 100, 200, 300)).toBe("M400 100 C290 100 310 300 200 300");
    // a short hop still bends at least 40
    expect(curve(210, 0, 200, 0)).toBe("M210 0 C170 0 240 0 200 0");
  });
  it("fans links out at the centre, at most 22px apart", () => {
    expect(dock(1, 0, 100)).toBe(100);
    expect(dock(3, 0, 100)).toBe(78);
    expect(dock(3, 2, 100)).toBe(122);
  });
  it("thickens a stack's link with its count, up to 3", () => {
    expect(stackWidth(1)).toBe(1.6);
    expect(stackWidth(4)).toBe(3.6);
    expect(stackWidth(1_000_000)).toBe(4.6);
  });
  it("adds a dragged offset", () => {
    expect(put({ a: { dx: 10.4, dy: -3 } }, "a", 100, 100)).toEqual({ x: 110, y: 97 });
    expect(put({}, "a", 100, 100)).toEqual({ x: 100, y: 100 });
  });
  it("fits never above 100% and centres the world", () => {
    expect(fitWorld(2000, 1000, 480)).toEqual({ k: 1, x: (2000 - LN_W) / 2, y: 260 });
    const f = fitWorld(520, 1000, 480);
    expect(f.k).toBe(0.5);
    expect(f.x).toBe(0);
  });
});

describe("keyText", () => {
  it("reads a 16-byte binary key as a UUID and keeps its first block", () => {
    const bin = "0x01a1cfe866b677a5949ff9e36aba0fa9";
    expect(keyFull(bin)).toBe("01a1cfe8-66b6-77a5-949f-f9e36aba0fa9");
    expect(keyText(bin)).toBe("01a1cfe8…");
  });
  it("leaves short keys alone and cuts long ones", () => {
    expect(keyText(42)).toBe("42");
    expect(keyText("ord_2024_000001")).toBe("ord_2024_000001");
    expect(keyText("a-very-long-natural-key-value")).toBe("a-very-long-…");
    expect(keyText(null)).toBe("");
  });
});
