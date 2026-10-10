import { describe, expect, it } from "vitest";

import {
  exactGroup,
  groupObjects,
  groupsTouching,
  layerCounts,
  moveObjects,
  removeObjects,
} from "./doc";
import type { BoardDoc } from "./model";
import { emptyBoard, seedBoard } from "./seed";

describe("emptyBoard", () => {
  it("is what a new board is: blank, named after its schema", () => {
    const board = emptyBoard("public");
    expect(board.order).toEqual([]);
    expect(board.objects).toEqual({});
    expect(board.edges).toEqual([]);
    expect(board.groups).toEqual([]);
    expect(board.name).toBe("public");
  });

  it("diffs against the attached workspace, not the sample database", () => {
    expect(emptyBoard("public").liveSource).toBe("workspace");
  });
});

describe("removeObjects", () => {
  it("drops the object, its edges and its group membership together", () => {
    const doc = removeObjects(seedBoard(), ["f_norm"]);
    expect(doc.objects.f_norm).toBeUndefined();
    expect(doc.order).not.toContain("f_norm");
    // e1/e2 fed it, e3 left it.
    expect(doc.edges.map((e) => e.id)).toEqual(["e4", "e5", "e6", "e7"]);
    expect(doc.groups.find((g) => g.id === "g_ingest")!.ids).not.toContain("f_norm");
  });

  it("un-links the sketch when its promoted table is deleted", () => {
    const doc = removeObjects(seedBoard(), ["tb_items"]);
    const sketch = doc.objects.sk1;
    expect(sketch?.type).toBe("sketch");
    expect(sketch?.type === "sketch" ? sketch.promotedTo : undefined).toBeNull();
  });

  it("leaves no orphan edge or group id behind for any delete", () => {
    const seed = seedBoard();
    const doc = removeObjects(seed, Object.keys(seed.objects).slice(0, 8));
    for (const edge of doc.edges) {
      expect(doc.objects[edge.from]).toBeDefined();
      expect(doc.objects[edge.to]).toBeDefined();
    }
    for (const group of doc.groups) {
      expect(group.ids.length).toBeGreaterThan(0);
      for (const id of group.ids) expect(doc.objects[id]).toBeDefined();
    }
  });

  it("drops a group once its last member is gone", () => {
    const doc = removeObjects(seedBoard(), [
      "f_pos",
      "f_portal",
      "f_norm",
      "f_db",
      "f_cache",
      "f_search",
      "f_app",
    ]);
    expect(doc.groups.map((g) => g.id)).toEqual(["g_disc", "g_schema"]);
  });

  it("does not mutate the input document (the undo stack holds snapshots)", () => {
    const seed = seedBoard();
    removeObjects(seed, ["st1"]);
    expect(seed.objects.st1).toBeDefined();
  });
});

describe("moveObjects", () => {
  it("translates a placed object", () => {
    const doc = moveObjects(seedBoard(), ["st1"], 10, -5);
    expect(doc.objects.st1).toMatchObject({ x: 54, y: 123 });
  });

  it("translates every point of an ink stroke", () => {
    const doc = moveObjects(seedBoard(), ["ink1"], 10, 10);
    const ink = doc.objects.ink1;
    expect(ink?.type === "ink" ? ink.points[0] : undefined).toEqual([210, 370]);
  });
});

describe("groupObjects", () => {
  it("takes the ids out of whichever group held them", () => {
    const doc = groupObjects(seedBoard(), ["st1", "st2"]);
    expect(doc.groups.find((g) => g.id === "g_disc")!.ids).not.toContain("st1");
    expect(doc.groups.at(-1)!.ids).toEqual(["st1", "st2"]);
    expect(doc.groups.at(-1)!.name).toBe("Group 4");
  });

  it("drops a group that loses every member to the new one", () => {
    const seed = seedBoard();
    const schema = seed.groups.find((g) => g.id === "g_schema")!;
    const doc = groupObjects(seed, schema.ids);
    expect(doc.groups.map((g) => g.id)).not.toContain("g_schema");
    expect(doc.groups).toHaveLength(3);
  });

  it("groups may span layers", () => {
    const doc = groupObjects(seedBoard(), ["st1", "tb_menus", "f_pos"]);
    const group = doc.groups.at(-1)!;
    const layers = new Set(group.ids.map((id) => doc.objects[id]!.layer));
    expect(layers).toEqual(new Set(["domain", "schema", "flow"]));
  });
});

describe("exactGroup", () => {
  const seed = seedBoard();
  const schema = seed.groups.find((g) => g.id === "g_schema")!;

  it("matches a selection that is exactly a group", () => {
    expect(exactGroup(seed, { ids: [...schema.ids].reverse(), edge: null })?.id).toBe("g_schema");
  });

  it("does not match a subset or a superset", () => {
    expect(exactGroup(seed, { ids: schema.ids.slice(1), edge: null })).toBeNull();
    expect(exactGroup(seed, { ids: [...schema.ids, "st1"], edge: null })).toBeNull();
    expect(exactGroup(seed, { ids: [], edge: null })).toBeNull();
  });
});

describe("groupsTouching", () => {
  it("names every group the selection overlaps", () => {
    expect(groupsTouching(seedBoard(), ["st1", "tb_menus"]).map((g) => g.id)).toEqual([
      "g_disc",
      "g_schema",
    ]);
  });
});

describe("layerCounts", () => {
  it("counts the sample's objects per layer", () => {
    expect(layerCounts(seedBoard())).toEqual({ domain: 10, schema: 5, flow: 7 });
  });

  it("reports nothing for an empty board", () => {
    const empty: BoardDoc = {
      name: "",
      scope: "",
      objects: {},
      order: [],
      edges: [],
      groups: [],
    };
    expect(layerCounts(empty)).toEqual({});
  });
});
