// Pure helpers for reading and editing a schedule's recurrence (M41).
//
// The authority on what a recurrence MEANS is the Rust domain
// (`features/schedules/domain`), which computes the actual next run. Nothing
// here recomputes that — `nextRunAt` always comes back from the backend. These
// functions only describe a recurrence in words and keep the editor's form
// fields coherent while the user edits them.

import type { StringKey } from "../../shared/i18n/strings";
import { MIN_EVERY_MINUTES, type Recurrence, type RecurrenceKind } from "./api";

/** The translate function shape these helpers need. Matches `i18n`'s `t`. */
export type Translate = (key: StringKey, vars?: Record<string, string | number>) => string;

/** The kinds the editor offers, in order. */
export const RECURRENCE_KINDS: RecurrenceKind[] = ["every", "daily", "weekly", "monthly"];

/**
 * Weekday label keys, indexed by the `weekday` field's own 0 = Sunday
 * convention (which matches `Date.getDay()`, so a date maps straight through).
 *
 * A literal array rather than a `sched.dow.${n}` template because `StringKey`
 * is a union of the literal keys in `en.ts` — building one by concatenation
 * would not typecheck, and that is the type doing its job.
 */
const WEEKDAY_KEYS: StringKey[] = [
  "sched.dow.sun",
  "sched.dow.mon",
  "sched.dow.tue",
  "sched.dow.wed",
  "sched.dow.thu",
  "sched.dow.fri",
  "sched.dow.sat",
];

/** The localized name of a weekday, by the 0 = Sunday index. */
export function weekdayLabel(weekday: number, t: Translate): string {
  return t(WEEKDAY_KEYS[clamp(weekday, 0, 6)]!);
}

/**
 * A wall-clock time as `HH:MM`, zero-padded.
 *
 * Deliberately NOT locale-formatted (no 12-hour AM/PM): this is the same
 * string the editor's two number inputs hold, and a description that reads
 * "3:00 PM" next to inputs showing `15` and `00` makes the user check whether
 * they mean the same thing.
 */
export function formatTime(hour: number, minute: number): string {
  return `${pad(clamp(hour, 0, 23))}:${pad(clamp(minute, 0, 59))}`;
}

/** A recurrence in one line of prose, for the list row. */
export function describeRecurrence(recurrence: Recurrence, t: Translate): string {
  switch (recurrence.kind) {
    case "every":
      return t("sched.desc.every", { minutes: Math.max(recurrence.minutes, MIN_EVERY_MINUTES) });
    case "daily":
      return t("sched.desc.daily", { time: formatTime(recurrence.hour, recurrence.minute) });
    case "weekly":
      return t("sched.desc.weekly", {
        day: weekdayLabel(recurrence.weekday, t),
        time: formatTime(recurrence.hour, recurrence.minute),
      });
    case "monthly":
      return t("sched.desc.monthly", {
        day: clamp(recurrence.day, 1, 31),
        time: formatTime(recurrence.hour, recurrence.minute),
      });
  }
}

/**
 * Switch a recurrence to another kind, carrying the time of day across.
 *
 * Carrying it over is the point: someone who set 03:00 and then realises they
 * want it weekly rather than nightly means 03:00 on that weekday, not 00:00.
 * `every` has no time of day, so coming back out of it starts from the
 * default hour rather than inventing one from the interval.
 */
export function withKind(
  recurrence: Recurrence,
  kind: RecurrenceKind,
  defaultHour = 3,
): Recurrence {
  if (recurrence.kind === kind) return recurrence;
  const hour = recurrence.kind === "every" ? defaultHour : recurrence.hour;
  const minute = recurrence.kind === "every" ? 0 : recurrence.minute;
  switch (kind) {
    case "every":
      return { kind: "every", minutes: 60 };
    case "daily":
      return { kind: "daily", hour, minute };
    case "weekly":
      return { kind: "weekly", weekday: 1, hour, minute };
    case "monthly":
      return { kind: "monthly", day: 1, hour, minute };
  }
}

/**
 * A recurrence with one numeric field replaced, clamped to its valid range.
 *
 * Clamping rather than rejecting, because the source is a number input the
 * user is mid-edit in: refusing `7` on the way to `70` would make the field
 * unusable. The backend validates independently, so a clamp here is a
 * convenience, not the guarantee.
 */
export function withField(
  recurrence: Recurrence,
  field: "minutes" | "hour" | "minute" | "weekday" | "day",
  value: number,
): Recurrence {
  const n = Number.isFinite(value) ? Math.trunc(value) : 0;
  switch (recurrence.kind) {
    case "every":
      return field === "minutes"
        ? { ...recurrence, minutes: clamp(n, MIN_EVERY_MINUTES, 60 * 24 * 7) }
        : recurrence;
    case "daily":
      if (field === "hour") return { ...recurrence, hour: clamp(n, 0, 23) };
      if (field === "minute") return { ...recurrence, minute: clamp(n, 0, 59) };
      return recurrence;
    case "weekly":
      if (field === "weekday") return { ...recurrence, weekday: clamp(n, 0, 6) };
      if (field === "hour") return { ...recurrence, hour: clamp(n, 0, 23) };
      if (field === "minute") return { ...recurrence, minute: clamp(n, 0, 59) };
      return recurrence;
    case "monthly":
      if (field === "day") return { ...recurrence, day: clamp(n, 1, 31) };
      if (field === "hour") return { ...recurrence, hour: clamp(n, 0, 23) };
      if (field === "minute") return { ...recurrence, minute: clamp(n, 0, 59) };
      return recurrence;
  }
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
