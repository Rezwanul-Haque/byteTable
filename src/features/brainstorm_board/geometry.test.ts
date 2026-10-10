import { describe, expect, it } from "vitest";

import { boxOf, edgePath, inkPath, unionBox, volumeWidth } from "./geometry";
import type { BoardObject, BoardSizes } from "./model";

const sizes: BoardSizes = { st1: { w: 150, h: 90 } };

const sticky: BoardObject = {
  id: "st1",
  type: "sticky",
  layer: "domain",
  x: 10,
  y: 20,
  color: "y",
  tag: "note",
  text: "",
};

describe("boxOf", () => {
  it("uses the measured size for a content-sized object", () => {
    expect(boxOf(sticky, sizes)).toEqual({ x1: 10, y1: 20, x2: 160, y2: 110 });
  });

  it("falls back before the first measurement pass", () => {
    expect(boxOf(sticky, {})).toEqual({ x1: 10, y1: 20, x2: 160, y2: 80 });
  });

  it("uses a frame's own size rather than a measurement", () => {
    const frame: BoardObject = {
      id: "fr1",
      type: "frame",
      layer: "domain",
      x: 0,
      y: 0,
      w: 300,
      h: 200,
      label: "Zone",
    };
    expect(boxOf(frame, { fr1: { w: 1, h: 1 } })).toEqual({ x1: 0, y1: 0, x2: 300, y2: 200 });
  });

  it("bounds an ink stroke by its points", () => {
    const ink: BoardObject = {
      id: "ink1",
      type: "ink",
      layer: "domain",
      color: "#fff",
      points: [
        [5, 50],
        [30, 10],
        [60, 40],
      ],
    };
    expect(boxOf(ink, {})).toEqual({ x1: 5, y1: 10, x2: 60, y2: 50 });
  });

  it("is null for a missing object or an empty stroke", () => {
    expect(boxOf(undefined, {})).toBeNull();
    expect(
      boxOf({ id: "i", type: "ink", layer: "domain", color: "#fff", points: [] }, {}),
    ).toBeNull();
  });
});

describe("unionBox", () => {
  it("spans every box", () => {
    expect(
      unionBox([
        { x1: 10, y1: 10, x2: 20, y2: 20 },
        { x1: -5, y1: 15, x2: 15, y2: 40 },
      ]),
    ).toEqual({ x1: -5, y1: 10, x2: 20, y2: 40 });
  });

  it("is null with nothing to span", () => {
    expect(unionBox([])).toBeNull();
  });
});

describe("edgePath", () => {
  const a = { x1: 0, y1: 0, x2: 100, y2: 50 };

  it("anchors on facing side edges for a mostly-horizontal pair", () => {
    const path = edgePath(a, { x1: 300, y1: 0, x2: 400, y2: 50 });
    expect(path.d).toMatch(/^M100 25 C/);
    expect(path.d).toMatch(/300 25$/);
    // The label sits on the curve, between the two cards.
    expect(path.mx).toBeCloseTo(200);
    expect(path.my).toBeCloseTo(25);
  });

  it("anchors on top and bottom for a mostly-vertical pair", () => {
    const path = edgePath(a, { x1: 0, y1: 300, x2: 100, y2: 350 });
    expect(path.d).toMatch(/^M50 50 C/);
    expect(path.d).toMatch(/50 300$/);
  });

  it("leaves from the left edge when the target is behind", () => {
    expect(edgePath(a, { x1: -400, y1: 0, x2: -300, y2: 50 }).d).toMatch(/^M0 25 C/);
  });

  it("keeps a minimum control handle for touching boxes, so the curve shows", () => {
    const path = edgePath(a, { x1: 101, y1: 0, x2: 200, y2: 50 });
    expect(path.d).toContain("C128 25 73 25");
  });
});

describe("inkPath", () => {
  it("smooths through midpoints and finishes on the last sample", () => {
    expect(
      inkPath([
        [0, 0],
        [10, 10],
        [20, 0],
      ]),
    ).toBe("M0 0 Q10 10 15 5 L20 0");
  });

  it("handles degenerate strokes", () => {
    expect(inkPath([])).toBe("");
    expect(inkPath([[3, 4]])).toBe("M3 4 L3 4");
  });
});

describe("volumeWidth", () => {
  it("scales a bigger number to a heavier stroke", () => {
    const light = volumeWidth("2 /min");
    const heavy = volumeWidth("3000 rps");
    expect(heavy).toBeGreaterThan(light);
    expect(light).toBeGreaterThanOrEqual(1.3);
    expect(heavy).toBeLessThanOrEqual(5);
  });

  it("reads thousands written with a k or a comma", () => {
    expect(volumeWidth("12k rows/s")).toBeCloseTo(volumeWidth("12000 rows/s"), 5);
    expect(volumeWidth("12,000 rows/s")).toBeCloseTo(volumeWidth("12000 rows/s"), 5);
  });

  it("caps at 5px however large the number", () => {
    expect(volumeWidth("999999999 rps")).toBe(5);
  });

  it("keeps the default weight for a label with no number", () => {
    expect(volumeWidth("write-through")).toBe(1.5);
    expect(volumeWidth(undefined)).toBe(1.5);
  });
});
