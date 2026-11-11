import { describe, expect, it } from "vitest";

import { containsPoint, minimapFrame, toMinimap, toWorld, unionRects } from "./minimapGeometry";

describe("unionRects", () => {
  it("returns null for nothing and skips missing entries", () => {
    expect(unionRects([])).toBeNull();
    expect(unionRects([null, undefined])).toBeNull();
  });

  it("spans every rect, negative coordinates included", () => {
    expect(
      unionRects([{ x: 10, y: 10, w: 20, h: 20 }, null, { x: -5, y: 40, w: 10, h: 10 }]),
    ).toEqual({ x: -5, y: 10, w: 35, h: 40 });
  });
});

describe("minimapFrame", () => {
  it("fits the wider axis and centres the other", () => {
    // 400×100 world into a 200×130 box with 5px pad → width-bound, scale 0.475.
    const frame = minimapFrame({ x: 0, y: 0, w: 400, h: 100 }, 200, 130, 5);
    expect(frame.scale).toBeCloseTo(0.475);
    const r = toMinimap(frame, { x: 0, y: 0, w: 400, h: 100 });
    expect(r.x).toBeCloseTo(5);
    expect(r.w).toBeCloseTo(190);
    // Vertical slack split evenly above and below.
    expect(r.y).toBeCloseTo((130 - r.h) / 2);
  });

  it("keeps a finite scale for a single point", () => {
    const frame = minimapFrame({ x: 50, y: 50, w: 0, h: 0 }, 200, 130, 5);
    expect(Number.isFinite(frame.scale)).toBe(true);
  });

  it("round-trips world → minimap → world", () => {
    const frame = minimapFrame({ x: -120, y: 30, w: 900, h: 600 }, 200, 130, 6);
    const m = toMinimap(frame, { x: 333, y: 222, w: 0, h: 0 });
    const back = toWorld(frame, m.x, m.y);
    expect(back.x).toBeCloseTo(333);
    expect(back.y).toBeCloseTo(222);
  });
});

describe("containsPoint", () => {
  it("includes the edges", () => {
    const r = { x: 0, y: 0, w: 10, h: 10 };
    expect(containsPoint(r, 0, 10)).toBe(true);
    expect(containsPoint(r, 11, 5)).toBe(false);
  });
});
