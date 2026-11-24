// Pure helpers for a schedule's check (the "should return zero rows" rule):
// the form's single select ↔ the wire `CheckRule`, and what counts as failing
// for the list chips and the rail badge.
//
// The verdict itself is computed in Rust (`CheckRule::failure`); nothing here
// re-judges a row count.

import type { CheckRule, RunHistory, RunRecord, Schedule } from "./api";
import type { Translate } from "./recurrence";

/** The form's choices, "none" first: a plain report is still the default. */
export type CheckChoice = "none" | CheckRule["kind"];

export const CHECK_CHOICES: CheckChoice[] = ["none", "noRows", "atMost", "atLeast"];

/** The select value for a schedule's check. */
export function checkChoice(check: CheckRule | null | undefined): CheckChoice {
  return check?.kind ?? "none";
}

/** The rule's row count, or undefined for a rule that has none. */
export function checkRows(check: CheckRule | null | undefined): number | undefined {
  return check && check.kind !== "noRows" ? check.rows : undefined;
}

/** The check as a short list chip — "Expects no rows", "≤ 10 rows". */
export function describeCheck(check: CheckRule, t: Translate): string {
  switch (check.kind) {
    case "noRows":
      return t("sched.desc.noRows");
    case "atMost":
      return t("sched.desc.atMost", { rows: check.rows });
    case "atLeast":
      return t("sched.desc.atLeast", { rows: check.rows });
  }
}

/** A sampled cell as the history table shows it. */
export function sampleCell(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/**
 * The schedule with its check switched to `choice`.
 *
 * Switching between the two counted rules keeps the count. Turning a check ON
 * also turns `notify` on — an alert is what a check is for, so the form starts
 * there — and turning it OFF turns the file back on, because a schedule with
 * neither does nothing and the backend refuses it.
 */
export function withCheckChoice(schedule: Schedule, choice: CheckChoice): Schedule {
  if (choice === "none") return { ...schedule, check: null, writeFile: true };
  const rows = checkRows(schedule.check);
  const check: CheckRule =
    choice === "noRows"
      ? { kind: "noRows" }
      : choice === "atMost"
        ? { kind: "atMost", rows: rows ?? 0 }
        : { kind: "atLeast", rows: Math.max(1, rows ?? 1) };
  const turningOn = !schedule.check;
  return { ...schedule, check, notify: turningOn ? true : schedule.notify };
}

/** The schedule with its counted rule's row count set. No-op for "no rows". */
export function withCheckRows(schedule: Schedule, rows: number): Schedule {
  const check = schedule.check;
  if (!check || check.kind === "noRows") return schedule;
  const floor = check.kind === "atLeast" ? 1 : 0;
  return { ...schedule, check: { ...check, rows: Math.max(floor, Math.floor(rows) || floor) } };
}

/**
 * Whether a run is a problem: it errored, or its result failed the check.
 * Mirrors Rust's `RunRecord::failing`.
 */
export function isFailing(record: RunRecord | undefined): boolean {
  return !!record && (!!record.error || !!record.checkFailure);
}

/**
 * How many ACTIVE schedules are failing as of their latest run — the rail
 * badge. Derived from state rather than counted from alerts, so it needs no
 * "seen" bookkeeping and clears itself when the schedule passes again. A
 * paused schedule is left out: nobody is waiting on its next run.
 */
export function failingCount(schedules: Schedule[], runs: RunHistory): number {
  return schedules.filter((s) => {
    if (!s.enabled) return false;
    const history = runs[s.id];
    return isFailing(history?.[history.length - 1]);
  }).length;
}
