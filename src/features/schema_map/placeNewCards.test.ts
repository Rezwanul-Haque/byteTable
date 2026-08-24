// A saved layout only knows the tables that existed when it was saved. When the
// schema gains tables, the map used to place them at their auto-layout
// coordinates — computed for the whole schema from scratch, so they landed on
// top of wherever the user had dragged the existing cards.

import { describe, expect, it } from "vitest";

import type { TableMeta } from "../../shared/api/engine";
import { cardHeight, placeNewCards, CARD_W, type CardModel, type Occupied } from "./diagram";
import { rectHoldsCard } from "./groups";

const meta = (columns: number): TableMeta =>
  ({
    columns: Array.from({ length: columns }, (_, i) => ({
      name: `c${i}`,
      dataType: "int",
      pk: i === 0,
      fk: false,
      nullable: false,
    })),
    foreignKeys: [],
    indexes: [],
  }) as unknown as TableMeta;

const metas: Record<string, TableMeta> = {
  cms_users: meta(12),
  cms_roles: meta(6),
  cms_permissions: meta(7),
  cms_audit_log: meta(20),
};

/** Do two placed rectangles share any area? */
function overlaps(a: Occupied, b: Occupied): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function rects(
  pos: Record<string, { x: number; y: number }>,
  widths: Record<string, number> = {},
): Occupied[] {
  return Object.entries(pos).map(([t, p]) => ({
    x: p.x,
    y: p.y,
    w: widths[t] ?? CARD_W,
    h: cardHeight(metas[t] as TableMeta),
  }));
}

describe("placeNewCards", () => {
  const existing: Occupied[] = [
    { x: 40, y: 40, w: 224, h: 300 },
    { x: 400, y: 40, w: 224, h: 900 }, // the tallest card sets the band's top
    { x: 760, y: 40, w: 224, h: 200 },
  ];

  it("clears everything already on the canvas", () => {
    const placed = placeNewCards(Object.keys(metas), metas, existing);
    expect(Object.keys(placed)).toHaveLength(4);
    for (const card of rects(placed)) {
      for (const old of existing) expect(overlaps(card, old)).toBe(false);
    }
  });

  it("does not overlap the other new cards either", () => {
    const placed = rects(placeNewCards(Object.keys(metas), metas, existing));
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        expect(overlaps(placed[i] as Occupied, placed[j] as Occupied)).toBe(false);
      }
    }
  });

  it("counts group frames as occupied, so new tables land outside them", () => {
    // A frame stretched well below the cards it holds.
    const frame: Occupied = { x: 0, y: 0, w: 1200, h: 2000 };
    const placed = placeNewCards(Object.keys(metas), metas, [...existing, frame]);
    for (const card of rects(placed)) expect(overlaps(card, frame)).toBe(false);
  });

  it("leaves new tables out of the group — by the map's own membership rule", () => {
    // Not a proxy: this is the test `groupBoxes` applies to decide what a frame
    // contains, so a new table cannot silently join a saved group.
    const frame = { x: 0, y: 0, w: 1200, h: 1100 };
    const placed = placeNewCards(Object.keys(metas), metas, [...existing, frame]);
    for (const [table, p] of Object.entries(placed)) {
      const card = { table, x: p.x, y: p.y, w: CARD_W, h: cardHeight(metas[table] as TableMeta) };
      expect(rectHoldsCard(frame, card as CardModel)).toBe(false);
    }
  });

  it("is stable: the same schema re-opens with the same arrangement", () => {
    const a = placeNewCards(Object.keys(metas), metas, existing);
    const b = placeNewCards([...Object.keys(metas)].reverse(), metas, existing);
    expect(a).toEqual(b);
  });

  it("wraps into rows instead of one runaway line", () => {
    const many = Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [`t${i}`, meta(5)]),
    ) as Record<string, TableMeta>;
    const placed = placeNewCards(Object.keys(many), many, existing);
    const ys = new Set(Object.values(placed).map((p) => p.y));
    expect(ys.size).toBeGreaterThan(1);
    // …and every row starts back at the left edge of the existing layout.
    expect(Math.min(...Object.values(placed).map((p) => p.x))).toBe(40);
  });

  it("places from the origin when the canvas is empty", () => {
    const placed = placeNewCards(["cms_roles"], metas, []);
    expect(placed.cms_roles).toEqual({ x: 40, y: 40 });
  });
});
