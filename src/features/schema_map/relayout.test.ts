// Reset view re-runs the layout. Plain `autoLayout` starts at the origin and
// knows nothing about frames, so on a map with a frame near the origin it swept
// every table in the schema into that one group. Reset has to tidy the diagram
// without changing who belongs to what.

import { describe, expect, it } from "vitest";

import type { TableMeta } from "../../shared/api/engine";
import { cardHeight, CARD_W, type CardModel } from "./diagram";
import { rectHoldsCard, relayoutWithGroups, type GroupBox, type GroupRect } from "./groups";

const meta = (columns: number, fks: { columns: string[]; refTable: string }[] = []): TableMeta =>
  ({
    columns: Array.from({ length: columns }, (_, i) => ({
      name: i === 0 ? "id" : `c${i}`,
      dataType: "int",
      pk: i === 0,
      fk: false,
      nullable: false,
    })),
    foreignKeys: fks.map((f) => ({ ...f, refColumns: ["id"] })),
    indexes: [],
  }) as unknown as TableMeta;

const metas: Record<string, TableMeta> = {
  trees: meta(8),
  benefits: meta(6, [{ columns: ["tree_id"], refTable: "trees" }]),
  locations: meta(9, [{ columns: ["tree_id"], refTable: "trees" }]),
  cms_users: meta(12),
  cms_roles: meta(6),
  cms_audit_log: meta(20, [{ columns: ["actor_user_id"], refTable: "cms_users" }]),
  loose_one: meta(4),
  loose_two: meta(5),
};

const box = (id: string, tables: string[], rect: GroupRect): GroupBox => ({
  ...rect,
  id,
  name: id,
  color: "#4f9dff",
  tables,
});

const card = (table: string, p: { x: number; y: number }): CardModel =>
  ({
    table,
    x: p.x,
    y: p.y,
    w: CARD_W,
    h: cardHeight(metas[table] as TableMeta),
  }) as CardModel;

const overlaps = (a: GroupRect, b: GroupRect): boolean =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

describe("relayoutWithGroups", () => {
  const forest = box("forest", ["trees", "benefits", "locations"], {
    x: 0,
    y: 6,
    w: 1900,
    h: 1080,
  });
  const auth = box("auth", ["cms_users", "cms_roles", "cms_audit_log"], {
    x: 0,
    y: 1200,
    w: 900,
    h: 700,
  });
  const tables = Object.keys(metas);

  it("keeps every table in the group it was already in", () => {
    const { positions, rects } = relayoutWithGroups(tables, metas, [forest, auth]);
    for (const [id, members] of [
      ["forest", forest.tables],
      ["auth", auth.tables],
    ] as const) {
      const rect = rects[id] as GroupRect;
      for (const t of members) {
        expect(rectHoldsCard(rect, card(t, positions[t] as { x: number; y: number })), t).toBe(
          true,
        );
      }
    }
  });

  it("does not sweep the rest of the schema into a frame", () => {
    const { positions, rects } = relayoutWithGroups(tables, metas, [forest, auth]);
    for (const t of ["loose_one", "loose_two"]) {
      for (const rect of Object.values(rects)) {
        expect(rectHoldsCard(rect, card(t, positions[t] as { x: number; y: number })), t).toBe(
          false,
        );
      }
    }
  });

  it("gives every table a position", () => {
    const { positions } = relayoutWithGroups(tables, metas, [forest, auth]);
    expect(Object.keys(positions).sort()).toEqual([...tables].sort());
  });

  it("resizes each frame to hold its tidied contents, without overlapping the next", () => {
    const { rects } = relayoutWithGroups(tables, metas, [forest, auth]);
    const list = Object.values(rects);
    expect(list).toHaveLength(2);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        expect(overlaps(list[i] as GroupRect, list[j] as GroupRect)).toBe(false);
      }
    }
    // The oversized Forest frame shrinks to its three tables.
    expect((rects.forest as GroupRect).w).toBeLessThan(forest.w);
  });

  it("leaves an empty frame alone rather than collapsing it", () => {
    const empty = box("empty", [], { x: 0, y: 0, w: 600, h: 400 });
    const { rects } = relayoutWithGroups(tables, metas, [empty]);
    expect(rects.empty).toMatchObject({ w: 600, h: 400 });
  });

  it("is deterministic", () => {
    const a = relayoutWithGroups(tables, metas, [forest, auth]);
    const b = relayoutWithGroups([...tables].reverse(), metas, [forest, auth]);
    expect(a).toEqual(b);
  });
});
