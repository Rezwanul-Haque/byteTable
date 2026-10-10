import { describe, expect, it } from "vitest";

import {
  bendGroupLink,
  buildGroupLinks,
  createGroupLink,
  findGroupLink,
  flipGroupLink,
  hasBentGroupLinks,
  labelGroupLink,
  linkGeometry,
  pruneGroupLinks,
  removeGroupLink,
  straightenGroupLink,
  straightenGroupLinks,
  type GroupLink,
  type LinkEnd,
} from "./groupLinks";
import type { GroupBox, GroupRect } from "./groups";
import type { CardModel } from "./diagram";

const rect = (x: number, y: number, w: number, h: number): GroupRect => ({ x, y, w, h });

function box(
  id: string,
  r: GroupRect,
  name = id,
  color = "#4f9dff",
  tables: string[] = [],
): GroupBox {
  return { ...r, id, name, color, tables };
}

function card(table: string, x: number, y: number, w = 200, h = 120): CardModel {
  return { table, x, y, w, h, shownColumns: [], hiddenCount: 0 };
}

function cards(...list: CardModel[]): Record<string, CardModel> {
  return Object.fromEntries(list.map((c) => [c.table, c]));
}

/** An endpoint shorthand. */
const g = (id: string): LinkEnd => ({ kind: "group", id });
const t = (id: string): LinkEnd => ({ kind: "table", id });

/** The numbers in a path `d`, in order — enough to assert endpoints/controls. */
function nums(d: string): number[] {
  return (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
}

describe("where an arrow attaches", () => {
  it("joins the facing sides when the frames sit side by side", () => {
    const a = rect(0, 0, 200, 200);
    const b = rect(400, 0, 200, 200);
    const g = linkGeometry(a, b);
    // Out of a's right edge, into b's left edge, level at the shared centre.
    expect([g.sx, g.sy]).toEqual([200, 100]);
    expect([g.tx, g.ty]).toEqual([400, 100]);
    // Mirrored when the target is to the left.
    const back = linkGeometry(b, a);
    expect([back.sx, back.tx]).toEqual([400, 200]);
  });

  it("joins top and bottom when the frames are stacked", () => {
    const g = linkGeometry(rect(0, 0, 200, 200), rect(0, 500, 200, 200));
    expect([g.sx, g.sy]).toEqual([100, 200]);
    expect([g.tx, g.ty]).toEqual([100, 500]);
  });

  it("keeps an anchor clear of the frame's corners", () => {
    // A short frame beside a tall one: the shared-centre anchor would fall below
    // the short frame, so it clamps inside that side instead of at its corner.
    const short = rect(0, 0, 200, 60);
    const tall = rect(400, 0, 200, 900);
    const g = linkGeometry(short, tall);
    expect(g.sy).toBeGreaterThan(short.y);
    expect(g.sy).toBeLessThan(short.y + short.h);
    expect(g.ty).toBeLessThanOrEqual(tall.y + tall.h);
  });

  it("aims at a bare point — the preview while an arrow is being drawn", () => {
    const g = linkGeometry(rect(0, 0, 200, 200), rect(600, 100, 0, 0));
    expect([g.tx, g.ty]).toEqual([600, 100]);
  });
});

describe("the drawn arrow", () => {
  const a = rect(0, 0, 200, 200);
  const b = rect(400, 0, 200, 200);

  it("is one cubic with the handle at the midpoint when unbent", () => {
    const g = linkGeometry(a, b);
    expect(g.path.startsWith("M 200 100 C ")).toBe(true);
    expect(g.path.match(/C/g)).toHaveLength(1);
    expect([g.mx, g.my]).toEqual([300, 100]);
  });

  it("routes through the handle once bent, and the handle tracks the offset", () => {
    const g = linkGeometry(a, b, { dx: 20, dy: -60 });
    expect([g.mx, g.my]).toEqual([320, 40]);
    expect(g.path.match(/C/g)).toHaveLength(2);
    // The curve passes through the handle: it is the end of the first segment.
    expect(g.path).toContain(" 320 40 C ");
    // Endpoints are unchanged by the bend.
    expect([g.sx, g.sy, g.tx, g.ty]).toEqual([200, 100, 400, 100]);
  });

  it("points the arrowhead along the incoming tangent, apex on the target", () => {
    // Left-to-right: the head sits at the target with its back to the left.
    const g = linkGeometry(a, b);
    const [hx, hy, p1x, , p2x] = nums(g.head);
    expect([hx, hy]).toEqual([400, 100]);
    expect(p1x).toBeLessThan(400);
    expect(p2x).toBeLessThan(400);

    // Stacked frames: the head arrives from above, so its back is above it.
    const down = linkGeometry(rect(0, 0, 200, 200), rect(0, 500, 200, 200));
    const [dx, dy, , b1y] = nums(down.head);
    expect([dx, dy]).toEqual([100, 500]);
    expect(b1y).toBeLessThan(500);
  });
});

describe("creating and editing arrows", () => {
  it("draws one arrow per pair, in the direction it was drawn", () => {
    const first = createGroupLink([], g("g1"), g("g2"));
    expect(first?.link).toMatchObject({ from: "g1", to: "g2" });
    // A group-to-group arrow carries no kinds — the shape it has always been
    // saved as.
    expect(first?.link.fromKind).toBeUndefined();
    expect(first?.link.toKind).toBeUndefined();
    const links = first?.links ?? [];
    // Nothing points at itself, and a joined pair cannot be joined twice — in
    // either direction (the second arrow would hide under the first).
    expect(createGroupLink(links, g("g1"), g("g1"))).toBeNull();
    expect(createGroupLink(links, g("g1"), g("g2"))).toBeNull();
    expect(createGroupLink(links, g("g2"), g("g1"))).toBeNull();
    expect(findGroupLink(links, g("g2"), g("g1"))?.id).toBe(first?.link.id);
    expect(findGroupLink(links, g("g2"), g("g3"))).toBeNull();
  });

  it("fans any number of arrows out of one group", () => {
    let links: GroupLink[] = [];
    for (const to of [g("g2"), g("g3"), t("orders"), t("events")]) {
      const made = createGroupLink(links, g("g1"), to);
      expect(made).not.toBeNull();
      links = made?.links ?? links;
    }
    expect(links).toHaveLength(4);
    expect(links.every((l) => l.from === "g1")).toBe(true);
  });

  it("tags a table endpoint, and keeps it distinct from the frame around it", () => {
    const made = createGroupLink([], g("g1"), t("users"));
    expect(made?.link).toMatchObject({ from: "g1", to: "users", toKind: "table" });
    const links = made?.links ?? [];
    // "the table users" and "the group users" are different things, and the
    // card inside a frame is not the frame.
    expect(createGroupLink(links, g("g1"), g("users"))).not.toBeNull();
    expect(createGroupLink(links, g("g1"), t("users"))).toBeNull();
    // Table to table is an arrow like any other.
    expect(createGroupLink(links, t("users"), t("orders"))?.link).toMatchObject({
      fromKind: "table",
      toKind: "table",
    });
    expect(createGroupLink(links, t("users"), t("users"))).toBeNull();
  });

  it("flips direction, captions, bends, straightens and removes", () => {
    const made = createGroupLink([], g("g1"), g("g2"));
    const id = made?.link.id ?? "";
    let links = made?.links ?? [];

    links = flipGroupLink(links, id);
    expect(links[0]).toMatchObject({ from: "g2", to: "g1" });
    // A flip carries each end's kind with it.
    const mixed = flipGroupLink([{ id: "a1", from: "g1", to: "users", toKind: "table" }], "a1");
    expect(mixed[0]).toMatchObject({ from: "users", fromKind: "table", to: "g1" });
    expect(mixed[0]?.toKind).toBeUndefined();

    links = labelGroupLink(links, id, "  writes to  ");
    expect(links[0]?.label).toBe("writes to");
    // A blank caption clears the field rather than drawing an empty pill.
    expect(labelGroupLink(links, id, "   ")[0]?.label).toBeUndefined();

    expect(hasBentGroupLinks(links)).toBe(false);
    links = bendGroupLink(links, id, 12, -30);
    expect(hasBentGroupLinks(links)).toBe(true);
    expect(straightenGroupLink(links, id)[0]).toMatchObject({ dx: undefined, dy: undefined });
    expect(hasBentGroupLinks(straightenGroupLinks(links))).toBe(false);
    // The caption survives a straighten.
    expect(straightenGroupLinks(links)[0]?.label).toBe("writes to");

    expect(removeGroupLink(links, id)).toEqual([]);
    expect(removeGroupLink(links, "nope")).toHaveLength(1);
  });

  it("drops arrows whose group is gone, but keeps table ends alone", () => {
    const links: GroupLink[] = [
      { id: "a1", from: "g1", to: "g2" },
      { id: "a2", from: "g2", to: "g3" },
      // A table end is never pruned: a table can be missing for a moment while
      // the schema reloads, and deleting the annotation over that is data loss.
      { id: "a3", from: "g1", to: "gone_table", toKind: "table" },
      { id: "a4", from: "orders", to: "events", fromKind: "table", toKind: "table" },
    ];
    expect(pruneGroupLinks(links, ["g1", "g2"]).map((l) => l.id)).toEqual(["a1", "a3", "a4"]);
    expect(pruneGroupLinks(links, []).map((l) => l.id)).toEqual(["a4"]);
  });
});

describe("resolving arrows against the live frames and cards", () => {
  const boxes = [
    box("g1", rect(0, 0, 200, 200), "Billing", "#4f9dff", ["invoices"]),
    box("g2", rect(400, 0, 200, 200), "Auth"),
  ];
  const all = cards(card("invoices", 20, 40), card("events", 900, 500));
  const build = (links: GroupLink[]) => buildGroupLinks(links, boxes, all, "#2dd4a7");

  it("carries the endpoint names and the source frame's colour", () => {
    const models = build([{ id: "a1", from: "g1", to: "g2", label: "pays" }]);
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      fromName: "Billing",
      toName: "Auth",
      label: "pays",
      color: "#4f9dff",
      bent: false,
    });
    expect(models[0]?.path).toContain("M 200 100");
  });

  it("attaches a table end to that card's own box", () => {
    const models = build([{ id: "a1", from: "g1", to: "events", toKind: "table" }]);
    const m = models[0];
    expect(m?.toName).toBe("events");
    expect(m?.to).toEqual({ kind: "table", id: "events" });
    // Into the events card (x 900..1100, y 500..620), not the Auth frame.
    expect(m?.tx).toBe(900);
    expect(m?.ty).toBeGreaterThanOrEqual(500);
    expect(m?.ty).toBeLessThanOrEqual(620);
  });

  it("colours a table end from the frame it sits in, else the accent", () => {
    // invoices is inside Billing → the arrow leaves in Billing's colour.
    expect(build([{ id: "a1", from: "invoices", to: "g2", fromKind: "table" }])[0]?.color).toBe(
      "#4f9dff",
    );
    // events is in no frame → the app accent.
    expect(build([{ id: "a2", from: "events", to: "g2", fromKind: "table" }])[0]?.color).toBe(
      "#2dd4a7",
    );
  });

  it("re-routes from wherever the frames are now", () => {
    const moved = [boxes[0]!, box("g2", rect(0, 600, 200, 200), "Auth")];
    const link: GroupLink = { id: "a1", from: "g1", to: "g2" };
    expect(build([link])[0]?.sx).toBe(200); // side to side
    expect(buildGroupLinks([link], moved, all, "#2dd4a7")[0]?.sy).toBe(200); // top to bottom
  });

  it("skips an arrow whose end is not on the canvas, without deleting it", () => {
    const links: GroupLink[] = [
      { id: "a1", from: "g1", to: "gone" },
      { id: "a2", from: "g1", to: "gone_table", toKind: "table" },
    ];
    expect(build(links)).toEqual([]);
    expect(links).toHaveLength(2);
  });

  it("marks a bent arrow so its handle stays visible", () => {
    const models = build([{ id: "a1", from: "g1", to: "g2", dy: 80 }]);
    expect(models[0]).toMatchObject({ bent: true, my: 180 });
  });
});
