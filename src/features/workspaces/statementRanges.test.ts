// Offsets of a buffer's statements — what "Go to statement" on a result tab
// uses to select the SQL behind that tab. The ranges must line up exactly with
// `splitStatements`, since the runs were produced by that split: a range that
// slices to anything but the run's own SQL would jump to the wrong statement.

import { describe, expect, it } from "vitest";

import { splitStatements, statementRanges } from "./sqlStatement";

const slice = (doc: string) => statementRanges(doc).map((r) => doc.slice(r.from, r.to));

describe("statementRanges", () => {
  it("slices to exactly what splitStatements returns", () => {
    const doc = "SELECT 1;\n\n  SELECT 2 ;\nSELECT bad FROM nope";
    expect(slice(doc)).toEqual(splitStatements(doc));
  });

  it("excludes the trailing semicolon and surrounding whitespace", () => {
    const doc = "  SELECT 1 ;  ";
    expect(statementRanges(doc)).toEqual([{ from: 2, to: 10 }]);
    expect(doc.slice(2, 10)).toBe("SELECT 1");
  });

  it("does not split on a semicolon inside a string or a comment", () => {
    const doc = "SELECT ';' AS a; -- one; two\nSELECT 2";
    expect(slice(doc)).toEqual(["SELECT ';' AS a", "-- one; two\nSELECT 2"]);
  });

  it("gives each duplicate statement its own range", () => {
    const doc = "SELECT 1;\nSELECT 1;";
    const ranges = statementRanges(doc);
    expect(ranges.map((r) => r.from)).toEqual([0, 10]);
    expect(slice(doc)).toEqual(["SELECT 1", "SELECT 1"]);
  });

  it("drops blank segments so range N is statement N", () => {
    const doc = ";;\nSELECT 1;;\n\n;SELECT 2;";
    expect(slice(doc)).toEqual(["SELECT 1", "SELECT 2"]);
  });
});
