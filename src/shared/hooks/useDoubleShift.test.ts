// Guard tests for the double-tap-Shift machine. The gesture's whole difficulty
// is telling a deliberate pair of taps from the Shift in ⇧A, ⌘⇧P, or a held
// key's auto-repeat — so those are the cases worth pinning down.

import { describe, expect, it } from "vitest";
import type { ShiftTapEvent, ShiftTaps } from "./useDoubleShift";
import { NO_SHIFT_TAPS, trackShiftTaps } from "./useDoubleShift";

/** Feed a sequence and count how many times the gesture fired. */
function fires(events: ShiftTapEvent[]): number {
  let state: ShiftTaps = NO_SHIFT_TAPS;
  let count = 0;
  for (const event of events) {
    const next = trackShiftTaps(state, event);
    state = next.state;
    if (next.fired) count++;
  }
  return count;
}

const down = (
  key: string,
  timeStamp: number,
  extra: Partial<ShiftTapEvent> = {},
): ShiftTapEvent => ({
  type: "keydown",
  key,
  timeStamp,
  ...extra,
});
const up = (key: string, timeStamp: number): ShiftTapEvent => ({ type: "keyup", key, timeStamp });

/** One bare Shift tap: down then up, `at` → `at + 20`. */
function tap(at: number): ShiftTapEvent[] {
  return [down("Shift", at), up("Shift", at + 20)];
}

describe("trackShiftTaps", () => {
  it("fires on two bare taps inside the window", () => {
    expect(fires([...tap(1000), ...tap(1100)])).toBe(1);
  });

  it("does not fire on one tap", () => {
    expect(fires(tap(1000))).toBe(0);
  });

  it("does not fire when the second tap is too late", () => {
    expect(fires([...tap(1000), ...tap(1600)])).toBe(0);
  });

  it("treats a late second tap as a fresh first tap", () => {
    // 1000 … 1600 is too wide, but 1600 … 1700 is a pair.
    expect(fires([...tap(1000), ...tap(1600), ...tap(1700)])).toBe(1);
  });

  it("ignores the Shift in ⇧A", () => {
    // Shift↓ A↓ A↑ Shift↑ — the letter's keydown makes the release a modifier
    // release, not a tap. Twice over is still no gesture.
    const shiftA = (at: number): ShiftTapEvent[] => [
      down("Shift", at),
      down("a", at + 10),
      up("a", at + 20),
      up("Shift", at + 30),
    ];
    expect(fires([...shiftA(1000), ...shiftA(1100)])).toBe(0);
  });

  it("ignores Shift held as part of ⌘⇧P", () => {
    const comboShift = (at: number): ShiftTapEvent[] => [
      down("Meta", at),
      down("Shift", at + 10, { metaKey: true }),
      down("p", at + 20, { metaKey: true }),
      up("Shift", at + 30),
      up("Meta", at + 40),
    ];
    expect(fires([...comboShift(1000), ...comboShift(1100)])).toBe(0);
  });

  it("ignores auto-repeat from a held Shift", () => {
    // Holding Shift down is one tap however many keydowns it emits.
    expect(
      fires([
        down("Shift", 1000),
        down("Shift", 1050, { repeat: true }),
        down("Shift", 1100, { repeat: true }),
        up("Shift", 1150),
      ]),
    ).toBe(0);
  });

  it("does not let a keystroke between taps complete the gesture", () => {
    // tap, "a", tap — fast enough to be inside the window, but not the gesture.
    expect(fires([...tap(1000), down("a", 1040), up("a", 1050), ...tap(1060)])).toBe(0);
  });

  it("starts over on a third tap rather than firing again", () => {
    expect(fires([...tap(1000), ...tap(1100), ...tap(1200)])).toBe(1);
    expect(fires([...tap(1000), ...tap(1100), ...tap(1200), ...tap(1300)])).toBe(2);
  });

  it("does not fire on the first tap right after load", () => {
    // A timestamp inside the window of the 0 sentinel must not read as a pair.
    expect(fires(tap(5))).toBe(0);
  });

  it("ignores a stray release with no press", () => {
    expect(fires([up("Shift", 1000), up("Shift", 1100)])).toBe(0);
  });
});
