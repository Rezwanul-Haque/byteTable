import { describe, expect, it } from "vitest";

import { shellCalls, shellJson } from "./helpers";

describe("shellJson", () => {
  it("passes strict JSON through", () => {
    expect(shellJson('{"status":"shipped","n":[1,2]}')).toEqual({ status: "shipped", n: [1, 2] });
  });

  it("reads mongosh-style keys, quotes and trailing commas", () => {
    expect(shellJson("{ status: 'shipped', total: { $gt: 10, }, ok: true, }")).toEqual({
      status: "shipped",
      total: { $gt: 10 },
      ok: true,
    });
    expect(shellJson("{ note: 'it\\'s \"here\"' }")).toEqual({ note: 'it\'s "here"' });
  });

  it("tags ObjectId and dates", () => {
    expect(shellJson('{ _id: ObjectId("65f0a1b2c3d4e5f6a7b8c9d0") }')).toEqual({
      _id: { $oid: "65f0a1b2c3d4e5f6a7b8c9d0" },
    });
    expect(
      shellJson("{ at: { $gte: ISODate('2024-01-01T00:00:00Z'), $lt: new Date('2025-01-01') } }"),
    ).toEqual({ at: { $gte: { $date: "2024-01-01T00:00:00Z" }, $lt: { $date: "2025-01-01" } } });
  });

  it("leaves words inside strings alone", () => {
    expect(shellJson('{ "q": "ObjectId(x), a: b" }')).toEqual({ q: "ObjectId(x), a: b" });
  });

  it("says what is wrong", () => {
    expect(() => shellJson('{ userId: ObjectId("318f615f") }')).toThrow(/24 hex/);
    expect(() => shellJson("{ a: 'open }")).toThrow(/closing quote/);
    expect(() => shellJson("{ a: }")).toThrow(/Couldn't read/);
  });
});

describe("shellCalls", () => {
  it("splits a cursor chain", () => {
    expect(shellCalls("db.events.find().sort({ ts: -1 }).limit(20)")).toEqual({
      coll: "events",
      calls: [
        { name: "find", args: [] },
        { name: "sort", args: ["{ ts: -1 }"] },
        { name: "limit", args: ["20"] },
      ],
    });
  });

  it("splits top-level arguments only, and skips brackets inside strings", () => {
    expect(shellCalls("db.users.find({ a: [1, 2], b: ')(,' }, { name: 1 });")?.calls).toEqual([
      { name: "find", args: ["{ a: [1, 2], b: ')(,' }", "{ name: 1 }"] },
    ]);
    expect(shellCalls('db.getCollection("my-logs").countDocuments()')).toEqual({
      coll: "my-logs",
      calls: [{ name: "countDocuments", args: [] }],
    });
  });

  it("is null for other text and throws on an open bracket", () => {
    expect(shellCalls("show dbs")).toBeNull();
    expect(shellCalls("db.events")).toBeNull();
    expect(() => shellCalls("db.events.find({ a: 1 }")).toThrow(/closing bracket/);
  });
});
