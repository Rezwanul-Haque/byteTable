// The schema map is built from a bounded scan sample. A scan returns items in
// no guaranteed order, so anything the map derives from that order has to be
// normalised — otherwise the cards visibly reshuffle every time the workspace's
// auto-sync re-samples the tables.

import { describe, expect, it } from "vitest";

import type { TableDescriptor } from "./api";
import { buildDynamoModel } from "./helpers";

const TABLE: TableDescriptor = {
  name: "ShopApp",
  keySchema: { pk: "PK", sk: "SK" },
  attrTypes: {},
  gsis: [{ name: "GSI1", pk: "GSI1PK", sk: "GSI1SK", projection: "ALL" }],
  lsis: [],
  billing: "PAY_PER_REQUEST",
  itemCount: 3,
  sizeBytes: 100,
  status: "ACTIVE",
};

const item = (over: Record<string, unknown>) => ({
  PK: "USER#1",
  SK: "PROFILE",
  entity: "USER",
  GSI1PK: "USER",
  ...over,
});

describe("buildDynamoModel attribute order", () => {
  it("is the same whatever order the sample arrives in", () => {
    const a = buildDynamoModel([
      {
        descriptor: TABLE,
        items: [item({ country: "BD", email: "a@b.c", name: "A", userId: "1" })],
      },
    ]);
    // The same item, keys enumerated the other way round — which is exactly
    // what a second scan can hand back.
    const b = buildDynamoModel([
      {
        descriptor: TABLE,
        items: [item({ userId: "1", name: "A", email: "a@b.c", country: "BD" })],
      },
    ]);
    expect(a.entities[0]?.attrs).toEqual(b.entities[0]?.attrs);
  });

  it("lists non-key attributes alphabetically, keys and index keys excluded", () => {
    const model = buildDynamoModel([
      {
        descriptor: TABLE,
        items: [item({ name: "A", country: "BD", email: "a@b.c", isActive: true })],
      },
    ]);
    // PK/SK get their own rows, `entity` is the discriminator, GSI1PK is an
    // index key — none of them belong in the attribute list.
    expect(model.entities[0]?.attrs).toEqual(["country", "email", "isActive", "name"]);
  });

  it("keeps the attributes a wide card shows stable across re-samples", () => {
    const wide = (names: string[]) =>
      buildDynamoModel([
        {
          descriptor: TABLE,
          items: [item(Object.fromEntries(names.map((n) => [n, "x"])))],
        },
      ]).entities[0]?.attrs.slice(0, 7);
    const names = ["attr_str_43", "attr_num_07", "attr_str_28", "attr_num_15", "attr_str_59"];
    expect(wide(names)).toEqual(wide([...names].reverse()));
  });
});
