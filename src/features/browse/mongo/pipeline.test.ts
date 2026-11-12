import { describe, expect, it } from "vitest";

import { compilePipeline, stagesFromCommand } from "./pipeline";

describe("stagesFromCommand", () => {
  it("turns an aggregate call into one stage per entry", () => {
    const built = stagesFromCommand(
      "db.orders.aggregate([{ $match: { status: 'shipped' } }, { $group: { _id: '$userId', n: { $sum: 1 } } }, { $sort: { n: -1 } }])",
    );
    expect(built?.coll).toBe("orders");
    expect(built?.stages.map((s) => s.op)).toEqual(["$match", "$group", "$sort"]);
    expect(JSON.parse(built!.stages[0]!.body)).toEqual({ status: "shipped" });
  });

  it("round-trips through the rail, ObjectId and dates included", () => {
    const built = stagesFromCommand(
      'db.events.aggregate([{ $match: { userId: ObjectId("65f0a1b2c3d4e5f6a7b8c9d0"), at: { $gte: ISODate("2024-01-01T00:00:00Z") } } }, { $limit: 5 }])',
    );
    expect(built?.stages[0]?.body).toContain('ObjectId("65f0a1b2c3d4e5f6a7b8c9d0")');
    expect(compilePipeline(built!.stages)).toEqual([
      {
        $match: {
          userId: { $oid: "65f0a1b2c3d4e5f6a7b8c9d0" },
          at: { $gte: { $date: "2024-01-01T00:00:00Z" } },
        },
      },
      { $limit: 5 },
    ]);
  });

  it("is null for anything that isn't a stage list", () => {
    expect(stagesFromCommand("db.orders.find({})")).toBeNull();
    expect(stagesFromCommand("db.orders.aggregate([])")).toBeNull();
    expect(stagesFromCommand("db.orders.aggregate([{ $match: {}, $sort: { a: 1 } }])")).toBeNull();
    expect(stagesFromCommand("db.orders.aggregate([{ status: 1 }])")).toBeNull();
    expect(stagesFromCommand("db.orders.aggregate([{ $match: ")).toBeNull();
  });
});

describe("compilePipeline", () => {
  it("reads mongosh-style bodies", () => {
    expect(compilePipeline([{ op: "$match", body: "{ status: 'shipped', }" }])).toEqual([
      { $match: { status: "shipped" } },
    ]);
  });
});
