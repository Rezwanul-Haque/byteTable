// Redis sidebar helpers.
//
// `mergeKeys` is the one that matters here: `SCAN` promises each key **at
// least** once, so a paged key list that concatenates pages will eventually
// draw a key twice and report more keys than the server holds.

import { describe, expect, it } from "vitest";

import { buildNamespaceTree, countLeaves, humanTTL, mergeKeys } from "./helpers";
import type { KeyEntry } from "./api";

const key = (name: string, ttl = -1): KeyEntry => ({ name, keyType: "string", ttl });

describe("mergeKeys", () => {
  it("appends a page of new keys in order", () => {
    const merged = mergeKeys([key("a"), key("b")], [key("c")]);
    expect(merged.map((k) => k.name)).toEqual(["a", "b", "c"]);
  });

  it("does not draw a key twice when SCAN returns it on two pages", () => {
    // The rehash case: page 2 re-reports "b".
    const merged = mergeKeys([key("a"), key("b")], [key("b"), key("c")]);
    expect(merged.map((k) => k.name)).toEqual(["a", "b", "c"]);
    expect(merged).toHaveLength(3);
  });

  it("keeps the fresher read of a re-seen key, in its original position", () => {
    const merged = mergeKeys([key("a"), key("b", 60)], [key("b", 5)]);
    expect(merged.map((k) => k.name)).toEqual(["a", "b"]);
    expect(merged[1]?.ttl).toBe(5);
  });

  it("is a no-op for an empty page and copies through for an empty list", () => {
    expect(mergeKeys([key("a")], [])).toEqual([key("a")]);
    expect(mergeKeys([], [key("a")])).toEqual([key("a")]);
    expect(mergeKeys([], [])).toEqual([]);
  });

  it("de-duplicates within a single page too", () => {
    expect(mergeKeys([], [key("a"), key("a")])).toHaveLength(1);
  });
});

describe("buildNamespaceTree", () => {
  it("groups by `:` segments and counts every leaf", () => {
    const tree = buildNamespaceTree([
      "audit:{tenant:acme}:1",
      "audit:{tenant:acme}:2",
      "product:1",
      "flat",
    ]);
    expect(countLeaves(tree)).toBe(4);
    expect(Object.keys(tree.children).sort()).toEqual(["audit", "product"]);
    expect(tree.keys).toEqual(["flat"]);
  });
});

describe("humanTTL", () => {
  it("shows no-expiry as ∞ and scales the rest", () => {
    expect(humanTTL(-1)).toBe("∞");
    expect(humanTTL(-2)).toBe("∞");
    expect(humanTTL(30)).toBe("30s");
    expect(humanTTL(120)).toBe("2m");
    expect(humanTTL(7200)).toBe("2h");
    expect(humanTTL(172800)).toBe("2d");
  });
});
