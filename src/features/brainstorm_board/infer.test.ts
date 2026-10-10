import { describe, expect, it } from "vitest";

import { freeTableName, inferColumn, promoteSketch } from "./infer";
import { snake, tableName } from "./naming";

describe("snake", () => {
  it("drops parenthesised asides so a note does not become part of the name", () => {
    expect(snake("price (per channel?)")).toBe("price");
  });

  it("collapses punctuation and trims the edges", () => {
    expect(snake("  Sold-out / stock level!  ")).toBe("sold_out_stock_level");
  });
});

describe("tableName", () => {
  it("pluralises only the last word", () => {
    expect(tableName("Menu item")).toBe("menu_items");
    expect(tableName("delivery address")).toBe("delivery_addresses");
    expect(tableName("City")).toBe("cities");
  });

  it("falls back rather than producing an empty identifier", () => {
    expect(tableName("???")).toBe("new_table");
  });
});

describe("inferColumn", () => {
  const known = ["menu_sections", "menus", "restaurants"];

  it("types an explicit id as the primary key", () => {
    expect(inferColumn("id", known)).toEqual({
      name: "id",
      type: "bigint",
      pk: true,
      fk: null,
      nullable: false,
    });
  });

  it("resolves an arrow line to the matching table on the board", () => {
    expect(inferColumn("section -> Mains, Drinks", known)).toEqual({
      name: "section_id",
      type: "bigint",
      pk: false,
      fk: "menu_sections",
      nullable: false,
    });
  });

  it("treats a bare _id suffix as a reference too", () => {
    expect(inferColumn("restaurant_id", known)?.fk).toBe("restaurants");
  });

  it("falls back to the plural when nothing on the board matches", () => {
    expect(inferColumn("courier -> who delivers it", known)?.fk).toBe("couriers");
  });

  it("turns a question into an is_ boolean and drops a trailing 'now'", () => {
    expect(inferColumn("is it available now?", known)).toMatchObject({
      name: "is_available",
      type: "boolean",
    });
    expect(inferColumn("refundable?", known)).toMatchObject({
      name: "is_refundable",
      type: "boolean",
    });
  });

  it("ignores a question mark inside a parenthesised aside", () => {
    expect(inferColumn("price (per channel?)", known)).toMatchObject({
      name: "price",
      type: "numeric(10,2)",
    });
  });

  it("types money, time, counts and json by keyword", () => {
    expect(inferColumn("total", known)?.type).toBe("numeric(10,2)");
    expect(inferColumn("published_at", known)?.type).toBe("timestamptz");
    expect(inferColumn("sort position", known)?.type).toBe("integer");
    expect(inferColumn("options", known)?.type).toBe("jsonb");
  });

  it("makes an image a nullable text url and suffixes the name", () => {
    expect(inferColumn("photo", known)).toEqual({
      name: "photo_url",
      type: "text",
      pk: false,
      fk: null,
      nullable: true,
    });
    // Already suffixed: left alone.
    expect(inferColumn("banner_url", known)?.name).toBe("banner_url");
  });

  it("returns null for a line with no identifier in it", () => {
    expect(inferColumn("???", known)).toBeNull();
    expect(inferColumn("   ", known)).toBeNull();
  });

  it("defaults to text", () => {
    expect(inferColumn("name", known)?.type).toBe("text");
  });
});

describe("promoteSketch", () => {
  // The milestone's acceptance case for Task 5.
  const sketch = {
    title: "Menu item",
    lines: [
      "name",
      "price (per channel?)",
      "section -> Mains, Drinks",
      "is it available now?",
      "photo",
    ],
  };

  it("previews the sample sketch exactly as the milestone specifies", () => {
    const preview = promoteSketch(sketch, ["menu_sections", "menus"]);
    expect(preview.name).toBe("menu_items");
    expect(preview.columns).toEqual([
      { name: "id", type: "bigint", pk: true, fk: null, nullable: false },
      { name: "name", type: "text", pk: false, fk: null, nullable: false },
      { name: "price", type: "numeric(10,2)", pk: false, fk: null, nullable: false },
      { name: "section_id", type: "bigint", pk: false, fk: "menu_sections", nullable: false },
      { name: "is_available", type: "boolean", pk: false, fk: null, nullable: false },
      { name: "photo_url", type: "text", pk: false, fk: null, nullable: true },
    ]);
  });

  it("keeps the sketch's own primary key instead of prepending one", () => {
    const preview = promoteSketch({ title: "Tag", lines: ["id", "label"] }, []);
    expect(preview.columns.filter((c) => c.pk)).toHaveLength(1);
    expect(preview.columns[0]!.name).toBe("id");
  });

  it("de-duplicates lines that infer the same column name", () => {
    const preview = promoteSketch({ title: "Thing", lines: ["photo", "photo_url"] }, []);
    expect(preview.columns.map((c) => c.name)).toEqual(["id", "photo_url"]);
  });

  it("drops unusable lines", () => {
    const preview = promoteSketch({ title: "Thing", lines: ["???", "name"] }, []);
    expect(preview.columns.map((c) => c.name)).toEqual(["id", "name"]);
  });
});

describe("freeTableName", () => {
  it("suffixes a collision with another board table", () => {
    expect(freeTableName("menus", ["menus"], {})).toBe("menus_2");
    expect(freeTableName("menus", ["menus", "menus_2"], {})).toBe("menus_3");
  });

  it("allows a collision with a live table, so the card becomes an ALTER", () => {
    expect(freeTableName("restaurants", ["restaurants"], { restaurants: [] })).toBe("restaurants");
  });

  it("leaves a free name alone", () => {
    expect(freeTableName("menus", ["orders"], {})).toBe("menus");
  });
});
