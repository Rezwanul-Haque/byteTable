import { describe, expect, it } from "vitest";

import { MIN_EVERY_MINUTES, type Recurrence } from "./api";
import {
  describeRecurrence,
  formatTime,
  weekdayLabel,
  withField,
  withKind,
  type Translate,
} from "./recurrence";

/**
 * A translator that renders `key(vars)` — so the assertions below check which
 * key was chosen and what was interpolated, without pinning English wording
 * that a copy edit is free to change.
 */
const t: Translate = (key, vars) =>
  vars ? `${key}(${Object.entries(vars).map(([k, v]) => `${k}=${v}`)})` : key;

describe("formatTime", () => {
  it("zero-pads both halves", () => {
    expect(formatTime(3, 0)).toBe("03:00");
    expect(formatTime(23, 59)).toBe("23:59");
    expect(formatTime(0, 5)).toBe("00:05");
  });

  it("clamps out-of-range input rather than rendering nonsense", () => {
    expect(formatTime(99, 99)).toBe("23:59");
    expect(formatTime(-1, -1)).toBe("00:00");
  });
});

describe("weekdayLabel", () => {
  it("indexes from Sunday, matching Date.getDay()", () => {
    expect(weekdayLabel(0, t)).toBe("sched.dow.sun");
    expect(weekdayLabel(1, t)).toBe("sched.dow.mon");
    expect(weekdayLabel(6, t)).toBe("sched.dow.sat");
  });

  it("clamps an out-of-range index instead of returning undefined", () => {
    expect(weekdayLabel(9, t)).toBe("sched.dow.sat");
    expect(weekdayLabel(-3, t)).toBe("sched.dow.sun");
  });
});

describe("describeRecurrence", () => {
  it("describes each kind with its own key and values", () => {
    expect(describeRecurrence({ kind: "every", minutes: 30 }, t)).toBe(
      "sched.desc.every(minutes=30)",
    );
    expect(describeRecurrence({ kind: "daily", hour: 3, minute: 0 }, t)).toBe(
      "sched.desc.daily(time=03:00)",
    );
    expect(describeRecurrence({ kind: "weekly", weekday: 1, hour: 7, minute: 30 }, t)).toBe(
      "sched.desc.weekly(day=sched.dow.mon,time=07:30)",
    );
    expect(describeRecurrence({ kind: "monthly", day: 1, hour: 6, minute: 0 }, t)).toBe(
      "sched.desc.monthly(day=1,time=06:00)",
    );
  });

  it("shows the enforced floor for an interval below it", () => {
    expect(describeRecurrence({ kind: "every", minutes: 1 }, t)).toBe(
      `sched.desc.every(minutes=${MIN_EVERY_MINUTES})`,
    );
  });
});

describe("withKind", () => {
  it("carries the time of day across a switch", () => {
    const daily: Recurrence = { kind: "daily", hour: 3, minute: 15 };
    expect(withKind(daily, "weekly")).toEqual({
      kind: "weekly",
      weekday: 1,
      hour: 3,
      minute: 15,
    });
    expect(withKind(daily, "monthly")).toEqual({ kind: "monthly", day: 1, hour: 3, minute: 15 });
  });

  it("starts from the default hour when coming out of an interval", () => {
    // `every` has no time of day, so there is nothing to carry.
    expect(withKind({ kind: "every", minutes: 30 }, "daily")).toEqual({
      kind: "daily",
      hour: 3,
      minute: 0,
    });
  });

  it("is identity for the kind it already is", () => {
    const weekly: Recurrence = { kind: "weekly", weekday: 4, hour: 9, minute: 0 };
    expect(withKind(weekly, "weekly")).toBe(weekly);
  });
});

describe("withField", () => {
  it("clamps each field to its own range", () => {
    expect(withField({ kind: "daily", hour: 3, minute: 0 }, "hour", 99)).toEqual({
      kind: "daily",
      hour: 23,
      minute: 0,
    });
    expect(withField({ kind: "daily", hour: 3, minute: 0 }, "minute", -5)).toEqual({
      kind: "daily",
      hour: 3,
      minute: 0,
    });
    expect(withField({ kind: "weekly", weekday: 1, hour: 3, minute: 0 }, "weekday", 12)).toEqual({
      kind: "weekly",
      weekday: 6,
      hour: 3,
      minute: 0,
    });
    expect(withField({ kind: "monthly", day: 1, hour: 3, minute: 0 }, "day", 0)).toEqual({
      kind: "monthly",
      day: 1,
      hour: 3,
      minute: 0,
    });
  });

  it("holds the interval at its floor", () => {
    expect(withField({ kind: "every", minutes: 60 }, "minutes", 1)).toEqual({
      kind: "every",
      minutes: MIN_EVERY_MINUTES,
    });
  });

  it("ignores a field the current kind does not have", () => {
    const every: Recurrence = { kind: "every", minutes: 60 };
    expect(withField(every, "weekday", 3)).toBe(every);
  });

  it("truncates a fractional input and survives a blank one", () => {
    expect(withField({ kind: "daily", hour: 0, minute: 0 }, "hour", 7.9)).toEqual({
      kind: "daily",
      hour: 7,
      minute: 0,
    });
    // Number("") is 0, but an empty input can also arrive as NaN.
    expect(withField({ kind: "daily", hour: 5, minute: 0 }, "hour", Number.NaN)).toEqual({
      kind: "daily",
      hour: 0,
      minute: 0,
    });
  });
});
