// Tests for the ICU-lite formatter (`format`). The string TABLES are covered
// by strings.test.ts; this covers the engine that renders them.
//
// The case that motivated the file: a message with more than one plural, using
// ICU `=0` exact-value arms, rendered its own source into the UI. No throw, no
// warning — the regex simply failed to match and the template passed through.
// Every assertion below therefore also checks that no `{` survives, because
// "looks roughly right" is exactly how that bug shipped.

import { describe, expect, it } from "vitest";

import { format } from "./index";

/** Nothing ICU-shaped may survive formatting — the silent failure mode. */
function expectFullyRendered(out: string) {
  expect(out).not.toContain("{");
  expect(out).not.toContain("}");
  expect(out).not.toContain("plural,");
}

describe("format", () => {
  it("interpolates plain placeholders", () => {
    expect(format("Hello {name}, you have {n}", { name: "Ada", n: 3 })).toBe(
      "Hello Ada, you have 3",
    );
  });

  it("leaves a placeholder alone when no value is supplied", () => {
    // Better a visible `{missing}` than an empty gap that reads as finished copy.
    expect(format("a {missing} b", { other: 1 })).toBe("a {missing} b");
  });

  it("selects a plural category and renders # as the localized count", () => {
    const msg = "{count, plural, one {# row} other {# rows}}";
    expect(format(msg, { count: 1 })).toBe("1 row");
    expect(format(msg, { count: 2 })).toBe("2 rows");
    expect(format(msg, { count: 1234 })).toBe("1,234 rows");
  });

  it("prefers an exact =N arm over the plural category", () => {
    const msg = "{count, plural, =0 {nothing here} one {# item} other {# items}}";
    expect(format(msg, { count: 0 })).toBe("nothing here");
    expect(format(msg, { count: 1 })).toBe("1 item");
    expect(format(msg, { count: 7 })).toBe("7 items");
  });

  it("falls back to the other arm when a category is absent", () => {
    // zh-Hans writes `other`-only plurals; an `en` count of 1 must still render.
    const msg = "{count, plural, other {# 个连接}}";
    expectFullyRendered(format(msg, { count: 1 }));
  });

  // The reported bug, end to end: three plurals in one message, two of them
  // using `=0`. Before the fix only the first rendered and the other two
  // appeared as raw ICU source in the import preview.
  it("renders every plural in a message with several, =N arms included", () => {
    const msg =
      "{count, plural, one {# connection} other {# connections}} · " +
      "{conflicts, plural, =0 {none already here} one {# already here} other {# already here}} · " +
      "{warned, plural, =0 {no warnings} one {# needs attention} other {# need attention}}";

    const none = format(msg, { count: 18, conflicts: 0, warned: 0 });
    expect(none).toBe("18 connections · none already here · no warnings");
    expectFullyRendered(none);

    const some = format(msg, { count: 18, conflicts: 18, warned: 1 });
    expect(some).toBe("18 connections · 18 already here · 1 needs attention");
    expectFullyRendered(some);
  });

  it("mixes plurals and plain placeholders in one message", () => {
    const out = format("{n, plural, one {# file} other {# files}} in {dir}", {
      n: 2,
      dir: "/tmp",
    });
    expect(out).toBe("2 files in /tmp");
    expectFullyRendered(out);
  });

  it("returns the template untouched when there are no vars at all", () => {
    expect(format("plain text")).toBe("plain text");
  });
});
