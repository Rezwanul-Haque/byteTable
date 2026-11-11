import { describe, expect, it } from "vitest";

import { centreOn, clampZoom, fitView, visibleWorld, zoomAt, zoomKeyStep } from "./canvasView";

const limits = { min: 0.25, max: 2.5 };

/** Where world point (wx, wy) lands on screen under `view`. */
const screen = (view: { x: number; y: number; k: number }, wx: number, wy: number) => ({
  x: view.x + wx * view.k,
  y: view.y + wy * view.k,
});

describe("zoomAt", () => {
  it("keeps the world point under the anchor fixed", () => {
    const view = { x: -120, y: 40, k: 0.8 };
    const mx = 300;
    const my = 200;
    const wx = (mx - view.x) / view.k;
    const wy = (my - view.y) / view.k;
    const next = zoomAt(view, 1.7, mx, my);
    expect(next.k).toBe(1.7);
    const p = screen(next, wx, wy);
    expect(p.x).toBeCloseTo(mx);
    expect(p.y).toBeCloseTo(my);
  });
});

describe("clampZoom", () => {
  it("bounds both ends and leaves the middle unrounded", () => {
    expect(clampZoom(0.1, limits)).toBe(0.25);
    expect(clampZoom(9, limits)).toBe(2.5);
    expect(clampZoom(0.8137, limits)).toBe(0.8137);
  });
});

describe("visibleWorld / centreOn", () => {
  it("round-trip: centring a point puts it in the middle of the visible rect", () => {
    const view = centreOn(500, 250, 2, 800, 600);
    const r = visibleWorld(view, 800, 600);
    expect(r.x + r.w / 2).toBeCloseTo(500);
    expect(r.y + r.h / 2).toBeCloseTo(250);
    expect(r.w).toBeCloseTo(400);
  });
});

describe("fitView", () => {
  it("fits the tighter axis and centres the box", () => {
    const box = { x: 100, y: 50, w: 1000, h: 200 };
    const view = fitView(box, 800, 600, 0, limits);
    expect(view.k).toBeCloseTo(0.8);
    const tl = screen(view, box.x, box.y);
    const br = screen(view, box.x + box.w, box.y + box.h);
    expect(tl.x).toBeCloseTo(0);
    expect(br.x).toBeCloseTo(800);
    expect(tl.y).toBeCloseTo(600 - br.y);
  });

  it("does not blow a small box up past the max", () => {
    const view = fitView({ x: 0, y: 0, w: 10, h: 10 }, 800, 600, 40, { min: 0.25, max: 1.4 });
    expect(view.k).toBe(1.4);
  });
});

describe("zoomKeyStep", () => {
  const key = (
    k: string,
    code: string,
    mods: Partial<Record<"meta" | "ctrl" | "alt", boolean>>,
  ) => ({
    key: k,
    code,
    metaKey: !!mods.meta,
    ctrlKey: !!mods.ctrl,
    altKey: !!mods.alt,
  });

  it("reads ⌘/Ctrl with = + − _ and the keypad", () => {
    expect(zoomKeyStep(key("=", "Equal", { meta: true }))).toBe(1);
    expect(zoomKeyStep(key("+", "Equal", { ctrl: true }))).toBe(1);
    expect(zoomKeyStep(key("+", "NumpadAdd", { meta: true }))).toBe(1);
    expect(zoomKeyStep(key("-", "Minus", { meta: true }))).toBe(-1);
    expect(zoomKeyStep(key("_", "Minus", { ctrl: true }))).toBe(-1);
    expect(zoomKeyStep(key("-", "NumpadSubtract", { meta: true }))).toBe(-1);
  });

  it("ignores the bare key, ⌥ chords and other ⌘ shortcuts", () => {
    expect(zoomKeyStep(key("=", "Equal", {}))).toBe(0);
    expect(zoomKeyStep(key("=", "Equal", { meta: true, alt: true }))).toBe(0);
    expect(zoomKeyStep(key("k", "KeyK", { meta: true }))).toBe(0);
  });
});
