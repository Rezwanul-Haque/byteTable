import { describe, expect, it } from "vitest";

import { baseName, shortenPath } from "./path";

describe("shortenPath", () => {
  it("keeps the tail, which is the part that identifies the folder", () => {
    expect(shortenPath("/Users/rezwanul-haque/me/workspaces/personal/ByteTable/reports")).toBe(
      "…/ByteTable/reports",
    );
  });

  it("honours a different segment count", () => {
    const path = "/a/b/c/d/e";
    expect(shortenPath(path, 1)).toBe("…/e");
    expect(shortenPath(path, 3)).toBe("…/c/d/e");
  });

  it("leaves a path that already fits alone, with no misleading ellipsis", () => {
    expect(shortenPath("/Reports")).toBe("/Reports");
    expect(shortenPath("/tmp/out")).toBe("/tmp/out");
    expect(shortenPath("reports")).toBe("reports");
  });

  it("uses the separator the path is written with", () => {
    expect(shortenPath("C:\\Users\\me\\Documents\\ByteTable\\reports")).toBe(
      "…\\ByteTable\\reports",
    );
  });

  it("ignores a trailing separator rather than counting it as a component", () => {
    expect(shortenPath("/a/b/c/d/")).toBe("…/c/d");
  });

  it("survives the degenerate inputs", () => {
    expect(shortenPath("")).toBe("");
    expect(shortenPath("   ")).toBe("");
    expect(shortenPath("/")).toBe("/");
  });
});

describe("baseName", () => {
  it("returns the final component", () => {
    expect(baseName("/tmp/reports/Nightly orders_20261026.csv")).toBe(
      "Nightly orders_20261026.csv",
    );
    expect(baseName("C:\\reports\\out.json")).toBe("out.json");
    expect(baseName("out.csv")).toBe("out.csv");
  });

  it("walks back past trailing separators", () => {
    expect(baseName("/tmp/reports/")).toBe("reports");
  });

  it("is empty for an empty path, not undefined", () => {
    expect(baseName("")).toBe("");
    expect(baseName("/")).toBe("");
  });
});
