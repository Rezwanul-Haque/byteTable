import { describe, expect, it } from "vitest";

import { boardDdl, diffBoard, diffInfoOf, tableStateLabel } from "./diff";
import { cloneColumns, type BoardDoc, type TableObject } from "./model";
import { emptyBoard, SAMPLE_LIVE, seedBoard } from "./seed";

/** A board holding just these table cards, in the order given. */
function boardOf(tables: TableObject[]): BoardDoc {
  const objects: Record<string, TableObject> = {};
  for (const t of tables) objects[t.id] = t;
  return {
    name: "Test",
    scope: "attached",
    objects,
    order: tables.map((t) => t.id),
    edges: [],
    groups: [],
  };
}

function table(
  id: string,
  name: string,
  columns: { name: string; type: string; pk?: boolean; fk?: string | null; nullable?: boolean }[],
  origin: "live" | "draft" = "draft",
): TableObject {
  return {
    id,
    type: "table",
    layer: "schema",
    origin,
    x: 0,
    y: 0,
    name,
    columns: cloneColumns(columns),
  };
}

describe("diffBoard", () => {
  it("has nothing to say about a blank board", () => {
    const diff = diffBoard(emptyBoard("public"), SAMPLE_LIVE);
    expect(diff).toEqual({ creates: [], alters: [], count: 0 });
    expect(boardDdl(diff)).toBe("-- No changes: the board matches the live schema.");
  });

  it("reports the example board as 4 CREATEs in FK order and 1 ALTER", () => {
    const diff = diffBoard(seedBoard(), SAMPLE_LIVE);
    expect(diff.creates.map((t) => t.name)).toEqual([
      "menus",
      "menu_sections",
      "menu_items",
      "item_channel_prices",
    ]);
    expect(diff.alters).toHaveLength(1);
    expect(diff.alters[0]!.table.name).toBe("restaurants");
    expect(diff.alters[0]!.adds.map((c) => c.name)).toEqual(["timezone"]);
    expect(diff.count).toBe(5);
  });

  it("generates the sample's DDL with the ALTER last", () => {
    const sql = boardDdl(diffBoard(seedBoard(), SAMPLE_LIVE));
    const statements = sql.split("\n\n");
    expect(statements[0]!).toContain("CREATE TABLE menus");
    expect(statements[3]!).toContain("CREATE TABLE item_channel_prices");
    expect(statements[4]).toBe("ALTER TABLE restaurants\n  ADD COLUMN timezone text NOT NULL;");
    // Every referenced table is created before the table referencing it.
    expect(sql.indexOf("CREATE TABLE menu_sections")).toBeLessThan(
      sql.indexOf("CREATE TABLE menu_items"),
    );
  });

  it("detects dropped columns and changed types", () => {
    const doc = boardOf([
      table("t1", "cities", [
        { name: "id", type: "bigint", pk: true },
        { name: "name", type: "text" },
        // `country` dropped; `name` kept; nothing added.
      ]),
      table("t2", "users", [
        { name: "id", type: "bigint", pk: true },
        { name: "email", type: "text" },
        { name: "name", type: "text" },
        { name: "created_at", type: "date" },
      ]),
    ]);
    const diff = diffBoard(doc, SAMPLE_LIVE);
    expect(diff.creates).toHaveLength(0);
    const cities = diff.alters.find((a) => a.table.name === "cities")!;
    expect(cities.drops.map((c) => c.name)).toEqual(["country"]);
    const users = diff.alters.find((a) => a.table.name === "users")!;
    expect(users.types).toEqual([
      { column: expect.objectContaining({ name: "created_at" }), from: "timestamptz" },
    ]);
    const sql = boardDdl(diff);
    expect(sql).toContain("ALTER TABLE cities\n  DROP COLUMN country;");
    expect(sql).toContain("ALTER COLUMN created_at TYPE date");
  });

  it("orders adds, type changes and drops within one ALTER", () => {
    const doc = boardOf([
      table("t1", "cities", [
        { name: "id", type: "bigint", pk: true },
        { name: "name", type: "integer" },
        { name: "slug", type: "text" },
      ]),
    ]);
    expect(boardDdl(diffBoard(doc, SAMPLE_LIVE))).toBe(
      "ALTER TABLE cities\n" +
        "  ADD COLUMN slug text NOT NULL,\n" +
        "  ALTER COLUMN name TYPE integer,\n" +
        "  DROP COLUMN country;",
    );
  });

  it("emits a cyclic pair rather than dropping either table", () => {
    const doc = boardOf([
      table("t1", "a", [
        { name: "id", type: "bigint", pk: true },
        { name: "b_id", type: "bigint", fk: "b" },
      ]),
      table("t2", "b", [
        { name: "id", type: "bigint", pk: true },
        { name: "a_id", type: "bigint", fk: "a" },
      ]),
    ]);
    const diff = diffBoard(doc, {});
    expect(diff.creates.map((t) => t.name).sort()).toEqual(["a", "b"]);
  });

  it("does not block a CREATE on a reference to a table nobody is creating", () => {
    const doc = boardOf([
      table("t1", "menus", [
        { name: "id", type: "bigint", pk: true },
        // `couriers` is neither live nor on the board — a dangling reference.
        { name: "courier_id", type: "bigint", fk: "couriers" },
      ]),
    ]);
    expect(diffBoard(doc, {}).creates.map((t) => t.name)).toEqual(["menus"]);
  });

  it("renders a PRIMARY KEY, NOT NULL and REFERENCES in a CREATE", () => {
    const doc = boardOf([
      table("t1", "menus", [
        { name: "id", type: "bigint", pk: true },
        { name: "restaurant_id", type: "bigint", fk: "restaurants" },
        { name: "note", type: "text", nullable: true },
      ]),
    ]);
    expect(boardDdl(diffBoard(doc, SAMPLE_LIVE))).toBe(
      "CREATE TABLE menus (\n" +
        "  id bigint PRIMARY KEY,\n" +
        "  restaurant_id bigint NOT NULL REFERENCES restaurants(id),\n" +
        "  note text\n" +
        ");",
    );
  });

  it("says so rather than returning nothing when the board matches live", () => {
    const doc = boardOf([table("t1", "cities", SAMPLE_LIVE.cities, "live")]);
    const diff = diffBoard(doc, SAMPLE_LIVE);
    expect(diff.count).toBe(0);
    expect(boardDdl(diff)).toBe("-- No changes: the board matches the live schema.");
  });

  it("treats a live reference card by name, not by origin", () => {
    // A `draft` card named after a real table is an ALTER, not a CREATE.
    const doc = boardOf([
      table("t1", "cities", [...SAMPLE_LIVE.cities, { name: "timezone", type: "text" }], "draft"),
    ]);
    const diff = diffBoard(doc, SAMPLE_LIVE);
    expect(diff.creates).toHaveLength(0);
    expect(diff.alters[0]!.adds.map((c) => c.name)).toEqual(["timezone"]);
  });
});

describe("diffInfoOf", () => {
  it("indexes the diff by card id for the renderers", () => {
    const info = diffInfoOf(diffBoard(seedBoard(), SAMPLE_LIVE));
    expect(info.status.tb_menus).toBe("create");
    expect(info.status.tb_rest).toBe("changed");
    expect(info.added.tb_rest?.has("timezone")).toBe(true);
    expect(info.typed.tb_rest?.size).toBe(0);
  });
});

describe("tableStateLabel", () => {
  it("names each of the four card states", () => {
    const live = table("t", "cities", [], "live");
    const draft = table("t", "menus", [], "draft");
    expect(tableStateLabel(live, undefined)).toBe("live");
    expect(tableStateLabel(live, "changed")).toBe("live · changed");
    expect(tableStateLabel(draft, "create")).toBe("draft · new");
    expect(tableStateLabel(draft, "changed")).toBe("draft · alter");
  });
});
