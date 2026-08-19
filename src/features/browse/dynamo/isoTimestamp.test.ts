// ISO-8601 timestamp handling for the DynamoDB item drawer's calendar editor.
//
// DynamoDB has no date type, so a timestamp is an ISO string in an `S`
// attribute. Two things must hold, and neither is true of the SQL row
// inspector's `parseTs`/`fmtTs` (which is why this exists rather than reusing
// them): offsets are honoured, and writing a value back preserves the exact
// spelling it was read in.

import { describe, expect, it } from "vitest";

import { formatIsoTs, isIsoTimestamp, isoShapeOf, parseIsoTs } from "./helpers";

describe("detection", () => {
  it("accepts the shapes DynamoDB items actually carry", () => {
    expect(isIsoTimestamp("2026-04-07T16:30:00Z")).toBe(true);
    expect(isIsoTimestamp("2026-04-07T16:30:00+06:00")).toBe(true);
    expect(isIsoTimestamp("2026-04-07T16:30:00.500Z")).toBe(true);
    expect(isIsoTimestamp("2026-04-07T16:30")).toBe(true);
    expect(isIsoTimestamp("2026-04-07 16:30:00")).toBe(true);
  });

  it("is anchored, so an id that merely starts with a date is not a timestamp", () => {
    expect(isIsoTimestamp("2026-04-07-order-12")).toBe(false);
    expect(isIsoTimestamp("USER#2026-04-07T16:30:00Z")).toBe(false);
    expect(isIsoTimestamp("2026-04-07")).toBe(false); // date only — no clock to edit
  });

  it("ignores non-strings, including epoch numbers", () => {
    // Deliberate: a bare 1775577600 is indistinguishable from a price or a
    // counter, so numbers never get a date picker.
    expect(isIsoTimestamp(1775577600)).toBe(false);
    expect(isIsoTimestamp(null)).toBe(false);
    expect(isIsoTimestamp({ $ss: ["a"] })).toBe(false);
  });
});

describe("parsing honours the offset", () => {
  it("reads a +06:00 timestamp as its real UTC instant", () => {
    // The SQL parseTs stops at the seconds and would call this 16:30 UTC.
    expect(parseIsoTs("2026-04-07T16:30:00+06:00")?.toISOString()).toBe("2026-04-07T10:30:00.000Z");
  });

  it("reads a -05:00 timestamp as its real UTC instant", () => {
    expect(parseIsoTs("2026-04-07T16:30:00-05:00")?.toISOString()).toBe("2026-04-07T21:30:00.000Z");
  });

  it("treats Z and a missing zone as UTC", () => {
    expect(parseIsoTs("2026-04-07T16:30:00Z")?.toISOString()).toBe("2026-04-07T16:30:00.000Z");
    expect(parseIsoTs("2026-04-07T16:30:00")?.toISOString()).toBe("2026-04-07T16:30:00.000Z");
  });

  it("keeps fractional seconds", () => {
    expect(parseIsoTs("2026-04-07T16:30:00.500Z")?.toISOString()).toBe("2026-04-07T16:30:00.500Z");
  });

  it("returns null for anything it cannot read", () => {
    expect(parseIsoTs("not a date")).toBeNull();
    expect(parseIsoTs(42)).toBeNull();
  });
});

describe("formatting preserves the stored spelling", () => {
  const round = (v: string) => formatIsoTs(parseIsoTs(v) as Date, isoShapeOf(v)!);

  it("round-trips every accepted shape byte for byte", () => {
    for (const v of [
      "2026-04-07T16:30:00Z",
      "2026-04-07T16:30:00+06:00",
      "2026-04-07T16:30:00-05:00",
      "2026-04-07T16:30:00.500Z",
      "2026-04-07T16:30",
      "2026-04-07 16:30:00",
    ]) {
      expect(round(v)).toBe(v);
    }
  });

  it("keeps the offset when the time is edited, rather than converting to Z", () => {
    // Editing the minute of a +06:00 timestamp must not rewrite it as UTC.
    const shape = isoShapeOf("2026-04-07T16:30:00+06:00")!;
    const later = new Date("2026-04-07T11:45:00.000Z"); // 17:45 at +06:00
    expect(formatIsoTs(later, shape)).toBe("2026-04-07T17:45:00+06:00");
  });

  it("does not add seconds or millis the stored value did not have", () => {
    const shape = isoShapeOf("2026-04-07T16:30")!;
    expect(formatIsoTs(new Date("2026-04-07T18:05:09.123Z"), shape)).toBe("2026-04-07T18:05");
  });

  it("keeps the fractional precision it was given", () => {
    const shape = isoShapeOf("2026-04-07T16:30:00.50Z")!;
    expect(formatIsoTs(new Date("2026-04-07T16:30:00.125Z"), shape)).toBe(
      "2026-04-07T16:30:00.12Z",
    );
  });
});

describe("an emptied timestamp keeps a usable shape", () => {
  // The trap this guards: clearing the field (or the calendar's own "null"
  // button) makes the value stop parsing, so anything deriving the editor from
  // the value alone loses the calendar with no way back. The drawer keeps that
  // decision sticky per attribute; this pins the formatting half — an empty
  // field still has a shape to write "now" into.
  const DEFAULT_ISO_SHAPE = { sep: "T", frac: "", zone: "Z", hasSeconds: true };

  it("has no shape to read from an empty value", () => {
    expect(isoShapeOf("")).toBeNull();
    expect(isIsoTimestamp("")).toBe(false);
  });

  it("writes plain UTC ISO when falling back to the default shape", () => {
    expect(formatIsoTs(new Date("2026-04-07T16:30:00.000Z"), DEFAULT_ISO_SHAPE)).toBe(
      "2026-04-07T16:30:00Z",
    );
  });

  it("round-trips that default output, so the field settles instead of drifting", () => {
    const written = formatIsoTs(new Date("2026-04-07T16:30:00.000Z"), DEFAULT_ISO_SHAPE);
    expect(isIsoTimestamp(written)).toBe(true);
    expect(formatIsoTs(parseIsoTs(written) as Date, isoShapeOf(written)!)).toBe(written);
  });
});
