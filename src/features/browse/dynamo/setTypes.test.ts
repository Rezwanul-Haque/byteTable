// DynamoDB's three set types (SS / NS / BS) across the renderer's helpers.
//
// The invariant under test is that a set stays a set. Sets have no JSON
// counterpart, so the Rust adapter wraps them in a `{$ss|$ns|$bs: [...]}` tag
// (engines/dynamo/value.rs) — before that tag existed, a set unmarshalled to a
// bare array, which is indistinguishable from an `L`, so reading an item and
// saving it back silently turned every set into a list. These tests pin the
// renderer half of that contract.

import { describe, expect, it } from "vitest";

import {
  DDB_TYPES,
  ddbCoerce,
  ddbRawOf,
  ddbType,
  dynamoFmt,
  isSetType,
  marshal,
  setError,
  setMembers,
  setTypeOf,
  unmarshal,
} from "./helpers";

describe("set type detection", () => {
  it("recognises each tagged set", () => {
    expect(ddbType({ $ss: ["a", "b"] })).toBe("SS");
    expect(ddbType({ $ns: [1, 2] })).toBe("NS");
    expect(ddbType({ $bs: ["AQID"] })).toBe("BS");
  });

  it("leaves ordinary values alone", () => {
    expect(ddbType({ city: "Dhaka" })).toBe("M");
    expect(ddbType(["a", "b"])).toBe("L");
    expect(ddbType("x")).toBe("S");
    expect(ddbType(3)).toBe("N");
    expect(ddbType(null)).toBe("NULL");
  });

  it("does not mistake an object that merely contains a tag key for a set", () => {
    // Only the exact single-key shape is a set; user data shaped like a tag
    // alongside other keys is still a map.
    expect(setTypeOf({ $ss: ["a"], other: 1 })).toBeNull();
    expect(ddbType({ $ss: ["a"], other: 1 })).toBe("M");
    // A tag whose value is not an array is not a set either.
    expect(setTypeOf({ $ss: "a" })).toBeNull();
  });

  it("offers all three in the type selector", () => {
    expect(DDB_TYPES).toContain("SS");
    expect(DDB_TYPES).toContain("NS");
    expect(DDB_TYPES).toContain("BS");
    expect(isSetType("SS")).toBe(true);
    expect(isSetType("L")).toBe(false);
  });
});

describe("editing a set", () => {
  it("edits as a bare array of members, not as the tag wrapper", () => {
    expect(ddbRawOf({ $ss: ["a", "b"] })).toBe(JSON.stringify(["a", "b"], null, 2));
    expect(setMembers({ $ns: [1, 2] })).toEqual([1, 2]);
  });

  it("re-wraps the edited members in the tag", () => {
    expect(ddbCoerce("SS", '["a","b"]')).toEqual({ $ss: ["a", "b"] });
    expect(ddbCoerce("NS", "[1,2]")).toEqual({ $ns: [1, 2] });
  });

  it("round-trips through the editor unchanged", () => {
    const original = { $ss: ["a", "b"] };
    expect(ddbCoerce(ddbType(original), ddbRawOf(original))).toEqual(original);
  });
});

describe("set validation", () => {
  it("rejects an empty set, which DynamoDB has no representation for", () => {
    expect(setError("SS", [])).toMatch(/cannot be empty/);
    expect(() => ddbCoerce("SS", "[]")).toThrow();
  });

  it("rejects duplicates — it is a set, not a list", () => {
    expect(setError("SS", ["a", "a"])).toMatch(/same value twice/);
  });

  it("rejects a mistyped member", () => {
    expect(setError("NS", [1, "x"])).toMatch(/must be a number/);
    expect(setError("SS", [1])).toMatch(/must be a string/);
    // A numeric string is fine in an NS: DynamoDB carries N as a string anyway.
    expect(setError("NS", ["1", 2])).toBeNull();
  });

  it("rejects a non-array", () => {
    expect(() => ddbCoerce("SS", '{"a":1}')).toThrow();
  });
});

describe("DynamoDB-JSON marshalling", () => {
  it("emits the wire form, with members as strings", () => {
    // `NS` is a list of numeric STRINGS on the wire, exactly like a lone `N`.
    expect(marshal({ $ns: [1, 2] })).toEqual({ NS: ["1", "2"] });
    expect(marshal({ $ss: ["a"] })).toEqual({ SS: ["a"] });
    expect(marshal({ $bs: ["AQID"] })).toEqual({ BS: ["AQID"] });
  });

  it("unmarshals a pasted wire set back to the tagged form, not a bare array", () => {
    // A bare array here would be re-marshalled as an `L` — the exact round-trip
    // loss the tag exists to prevent.
    expect(unmarshal({ SS: ["a", "b"] })).toEqual({ $ss: ["a", "b"] });
    expect(unmarshal({ NS: ["1", "2"] })).toEqual({ $ns: [1, 2] });
  });
});

describe("grid display", () => {
  it("shows a set as its own type and size, not as a generic map", () => {
    expect(dynamoFmt({ $ss: ["a", "b", "c"] })).toBe("SS[3]");
    expect(dynamoFmt({ $ns: [1] })).toBe("NS[1]");
    // Contrast: a map and a list keep their existing renderings.
    expect(dynamoFmt({ city: "Dhaka" })).toBe("{…}");
    expect(dynamoFmt(["a", "b"])).toBe("[2]");
  });
});
