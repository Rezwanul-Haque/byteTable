import { describe, expect, it } from "vitest";

import { boxOf, unionBox, type Box } from "./geometry";
import type { BoardObject } from "./model";
import { seedBoard } from "./seed";

/**
 * The WIDEST an object can render, from the caps its CSS actually declares
 * (Board.css). Content-sized objects have no measured size in a node test, so
 * the layout assertions below use this worst case — which makes them a real
 * guarantee rather than an approximation of one.
 */
function widthCeiling(object: BoardObject): number {
  switch (object.type) {
    case "sticky":
      return 150; // fixed width
    case "flow":
      return 156; // fixed width
    case "table":
      return 232; // fixed width
    case "text":
      return 520; // max-width
    case "snippet":
      return 300; // stated width
    case "frame":
      return object.w;
    case "sketch":
      return object.w;
    case "ink":
      return 0; // bounded by its own points
  }
}

/** The widest box an object could occupy, ink included. */
function worstCaseBox(object: BoardObject): Box {
  const measured = boxOf(object, {});
  if (object.type === "ink") return measured!;
  return { ...measured!, x2: object.x + widthCeiling(object) };
}

/** A group's outline, at the members' worst-case widths. The canvas pads the
 *  members' union by 18px on every side. */
const GROUP_PAD = 18;
function groupBox(groupId: string): Box {
  const doc = seedBoard();
  const group = doc.groups.find((g) => g.id === groupId)!;
  const union = unionBox(group.ids.map((id) => worstCaseBox(doc.objects[id]!)))!;
  return {
    x1: union.x1 - GROUP_PAD,
    y1: union.y1 - GROUP_PAD,
    x2: union.x2 + GROUP_PAD,
    y2: union.y2 + GROUP_PAD,
  };
}

describe("the example board's layout", () => {
  it("leaves clear air between the Discovery and Menu schema outlines", () => {
    // Two abutting group frames read as one container — the whole point of a
    // group outline is that you can tell where it ends. The margin is checked at
    // the snippet's WORST case (its 360px max-width); as the example actually
    // renders, the gap is roughly four times this.
    const discovery = groupBox("g_disc");
    const schema = groupBox("g_schema");
    expect(schema.x1 - discovery.x2).toBeGreaterThanOrEqual(24);
  });

  it("leaves clear air above the Menu ingest flow", () => {
    const schema = groupBox("g_schema");
    const flow = groupBox("g_ingest");
    expect(flow.y1 - schema.y2).toBeGreaterThan(0);
  });

  it("puts every group on the board it belongs to", () => {
    const doc = seedBoard();
    for (const group of doc.groups) {
      expect(group.ids.length).toBeGreaterThan(0);
      for (const id of group.ids) expect(doc.objects[id]).toBeDefined();
    }
  });

  it("links the sketch and the table it was promoted to, both ways", () => {
    const doc = seedBoard();
    const sketch = doc.objects.sk1;
    const promoted = sketch?.type === "sketch" ? sketch.promotedTo : null;
    expect(promoted).toBe("tb_items");
    const table = doc.objects[promoted!];
    expect(table?.type === "table" ? table.from : null).toBe("sk1");
  });

  it("draws every edge between objects that exist", () => {
    const doc = seedBoard();
    for (const edge of doc.edges) {
      expect(doc.objects[edge.from]).toBeDefined();
      expect(doc.objects[edge.to]).toBeDefined();
    }
  });
});
