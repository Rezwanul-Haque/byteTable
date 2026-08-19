// The single attribute order shared by the item grid and the item drawer.
//
// They used to disagree: the drawer floated every KEY attribute to the top —
// secondary-index keys included — and sorted that group by name, so a table with
// a GSI on `eventType` listed `aggregateId, eventType, timestamp` in the drawer
// while the grid showed `aggregateId, timestamp, eventType`.

import { describe, expect, it } from "vitest";

import { orderAttributes } from "./helpers";

const EVENT_LOG = { pk: "aggregateId", sk: "timestamp" };

describe("orderAttributes", () => {
  it("puts the partition key first and the sort key second", () => {
    expect(orderAttributes(["source", "timestamp", "aggregateId"], EVENT_LOG)).toEqual([
      "aggregateId",
      "timestamp",
      "source",
    ]);
  });

  it("does not promote a secondary-index key — the regression this fixes", () => {
    // `eventType` is a GSI partition key on this table. It is still just an
    // attribute of the item, so it sorts with the rest.
    expect(
      orderAttributes(["payload", "eventType", "timestamp", "source", "aggregateId"], EVENT_LOG),
    ).toEqual(["aggregateId", "timestamp", "eventType", "payload", "source"]);
  });

  it("sorts the non-key attributes alphabetically, whatever order they arrive in", () => {
    const names = ["source", "payload", "eventType"];
    expect(orderAttributes(names, EVENT_LOG)).toEqual(["eventType", "payload", "source"]);
    expect(orderAttributes([...names].reverse(), EVENT_LOG)).toEqual([
      "eventType",
      "payload",
      "source",
    ]);
  });

  it("handles a partition-only table", () => {
    expect(orderAttributes(["b", "PK", "a"], { pk: "PK" })).toEqual(["PK", "a", "b"]);
  });

  it("omits a key the item does not carry — a projection can leave it out", () => {
    expect(orderAttributes(["source", "eventType"], EVENT_LOG)).toEqual(["eventType", "source"]);
  });

  it("gives the grid and the drawer the same answer for the same item", () => {
    const item = {
      source: "web",
      aggregateId: "U-1001",
      payload: {},
      timestamp: "t",
      eventType: "x",
    };
    const fromDrawer = orderAttributes(Object.keys(item), EVENT_LOG);
    const fromGrid = orderAttributes(
      ["aggregateId", "timestamp", "eventType", "payload", "source"],
      EVENT_LOG,
    );
    expect(fromDrawer).toEqual(fromGrid);
  });
});
