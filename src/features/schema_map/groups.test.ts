import { describe, expect, it } from "vitest";

import type { CardModel, EdgeModel } from "./diagram";
import {
  clampRect,
  createGroup,
  groupBoxes,
  groupRect,
  rectAroundCards,
  rectHoldsCard,
  resizeRect,
  scopeToGroup,
  GROUP_PAD,
  GROUP_PAD_TOP,
  MIN_GROUP_H,
  MIN_GROUP_W,
  type GroupRect,
  type TableGroup,
} from "./groups";

/** A card at (x,y) with a fixed 200×100 box — enough to check bounding maths. */
function card(table: string, x: number, y: number): CardModel {
  return { table, x, y, w: 200, h: 100, shownColumns: [], hiddenCount: 0 };
}

function cards(...list: CardModel[]): Record<string, CardModel> {
  return Object.fromEntries(list.map((c) => [c.table, c]));
}

/** A minimal edge — only the two endpoint tables matter for scoping. */
function edge(childTable: string, refTable: string): EdgeModel {
  return {
    id: `${childTable}->${refTable}`,
    childTable,
    refTable,
    path: "",
    sx: 0,
    sy: 0,
    tx: 0,
    ty: 0,
    mx: 0,
    my: 0,
    childEnd: "many",
    parentEnd: "one",
    sOut: 1,
    tOut: -1,
  };
}

const rect = (x: number, y: number, w: number, h: number): GroupRect => ({ x, y, w, h });

describe("framing tables", () => {
  it("draws a frame around them, with room for the title bar on top", () => {
    const r = rectAroundCards(cards(card("a", 100, 100), card("b", 400, 300)), ["a", "b"]);
    expect(r).toEqual({
      x: 100 - GROUP_PAD,
      y: 100 - GROUP_PAD_TOP,
      w: 400 + 200 - 100 + 2 * GROUP_PAD,
      h: 300 + 100 - 100 + GROUP_PAD_TOP + GROUP_PAD,
    });
  });

  it("ignores tables that are not on the canvas", () => {
    const only = cards(card("a", 60, 60));
    expect(rectAroundCards(only, ["a", "gone"])?.x).toBe(40);
    expect(rectAroundCards(only, ["gone"])).toBeNull();
  });

  it("keeps a new frame on the canvas and names groups without collisions", () => {
    const a = createGroup([], rect(-40, -80, 10, 10));
    expect(a.group.name).toBe("Group 1");
    // Clamped: never off the top-left, never below the minimum size.
    expect(a.group.rect).toEqual({ x: 0, y: 0, w: MIN_GROUP_W, h: MIN_GROUP_H });
    const b = createGroup(a.groups, rect(0, 0, 300, 200));
    expect(b.group.name).toBe("Group 2");
    expect(b.groups).toHaveLength(2);
    expect(a.group.color).not.toBe(b.group.color);
  });

  it("falls back to the old member list when a group has no frame of its own", () => {
    const legacy: TableGroup = { id: "g1", name: "Auth", tables: ["a"] };
    const seeded = groupRect(legacy, cards(card("a", 100, 100)));
    expect(seeded).toEqual(rectAroundCards(cards(card("a", 100, 100)), ["a"]));
    // …and nothing to draw once those tables are gone.
    expect(groupRect(legacy, cards(card("b", 0, 0)))).toBeNull();
  });
});

describe("membership follows the frame", () => {
  it("counts a card in when its centre is inside", () => {
    const r = rect(0, 0, 300, 300);
    expect(rectHoldsCard(r, card("in", 50, 50))).toBe(true); // centre 150,100
    expect(rectHoldsCard(r, card("out", 260, 50))).toBe(false); // centre 360,100
  });

  it("resolves each frame's tables from the layout, first frame wins an overlap", () => {
    const all = cards(card("a", 20, 20), card("b", 400, 20), card("far", 900, 900));
    const boxes = groupBoxes(
      [
        { id: "g1", name: "One", rect: rect(0, 0, 340, 300) },
        { id: "g2", name: "Two", rect: rect(0, 0, 700, 300) }, // overlaps g1
      ],
      all,
    );
    expect(boxes.map((b) => b.tables)).toEqual([["a"], ["b"]]);
    // A frame keeps its own rectangle whatever it happens to contain.
    expect(boxes[1]).toMatchObject({ x: 0, y: 0, w: 700, h: 300 });
  });

  it("keeps an empty frame — it is a rectangle waiting to be resized", () => {
    const boxes = groupBoxes(
      [{ id: "g1", name: "Empty", rect: rect(0, 0, 200, 200) }],
      cards(card("far", 900, 900)),
    );
    expect(boxes).toHaveLength(1);
    expect(boxes[0]?.tables).toEqual([]);
  });
});

describe("resizing a frame", () => {
  const base = rect(100, 100, 400, 300);

  it("moves the edges the grabbed handle touches", () => {
    expect(resizeRect(base, "se", 50, 20)).toEqual(rect(100, 100, 450, 320));
    expect(resizeRect(base, "nw", 50, 20)).toEqual(rect(150, 120, 350, 280));
    expect(resizeRect(base, "n", 50, -20)).toEqual(rect(100, 80, 400, 320));
    expect(resizeRect(base, "e", -50, 999)).toEqual(rect(100, 100, 350, 300));
  });

  it("stops at the minimum size instead of inverting, anchoring the far edge", () => {
    const squashed = resizeRect(base, "nw", 9999, 9999);
    expect(squashed.w).toBe(MIN_GROUP_W);
    expect(squashed.h).toBe(MIN_GROUP_H);
    // The south-east corner stayed put.
    expect(squashed.x + squashed.w).toBe(base.x + base.w);
    expect(squashed.y + squashed.h).toBe(base.y + base.h);
  });

  it("never leaves the canvas", () => {
    expect(resizeRect(base, "nw", -9999, -9999)).toMatchObject({ x: 0, y: 0 });
    expect(clampRect(rect(-5, -5, 10, 10))).toEqual(rect(0, 0, MIN_GROUP_W, MIN_GROUP_H));
  });

  it("holds the anchored edges still, even when the dragged edge hits the canvas", () => {
    // Dragging the bottom-left corner far past the origin: the left edge stops
    // at 0 and the bottom keeps going — the right and top edges must not budge.
    const r = resizeRect(base, "sw", -9999, 120);
    expect(r.x).toBe(0);
    expect(r.x + r.w).toBe(base.x + base.w); // right edge held
    expect(r.y).toBe(base.y); // top edge held
    expect(r.y + r.h).toBe(base.y + base.h + 120);

    // Same for the other three corners: only the grabbed edges move.
    const ne = resizeRect(base, "ne", 60, -9999);
    expect(ne.x).toBe(base.x);
    expect(ne.y).toBe(0);
    expect(ne.y + ne.h).toBe(base.y + base.h);
    expect(ne.x + ne.w).toBe(base.x + base.w + 60);

    // And for a single edge: dragging "w" leaves top/bottom/right alone.
    const w = resizeRect(base, "w", -9999, 500);
    expect(w).toEqual(rect(0, base.y, base.x + base.w, base.h));
  });
});

describe("group-scoped export", () => {
  it("keeps only the framed cards and the relationships wholly inside", () => {
    const all = cards(card("a", 20, 20), card("b", 200, 20), card("outside", 900, 20));
    const box = groupBoxes([{ id: "g1", name: "One", rect: rect(0, 0, 460, 300) }], all)[0];
    expect(box?.tables).toEqual(["a", "b"]);
    const scoped = scopeToGroup(box!, Object.values(all), [
      edge("a", "b"),
      edge("b", "outside"), // one end outside the frame → dropped
      edge("outside", "a"),
    ]);
    expect(scoped.cards.map((c) => c.table)).toEqual(["a", "b"]);
    expect(scoped.edges.map((e) => e.id)).toEqual(["a->b"]);
    expect(scoped.groups).toEqual([box]);
  });
});
