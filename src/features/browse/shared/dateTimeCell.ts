// Timestamp editor helpers — ported from the prototype's row-inspector.jsx
// (isTemporalType, RI_TZS, tzParts, tzOffsetMin, wallToDate, parseTs, fmtTs).
// Drive the Row Inspector's calendar + clock editor: existing values are parsed
// as UTC, displayed in the chosen timezone, and every edit converts the
// wall-clock parts back to a UTC string (`YYYY-MM-DD HH:MM:SS`) via a two-pass
// DST-safe `wallToDate`, so storage always stays UTC regardless of the display
// timezone.

import { isJsonType } from "./jsonCell";

/** True for temporal column types (timestamp / timestamptz / datetime / date /
 *  time), but not JSON (a `json` type must never be treated as temporal).
 *  Several tokens are listed explicitly because word boundaries don't fall where
 *  a bare stem would need them: `timestamptz` (no `\b` before `tz`), and the SQL
 *  Server family `datetime2` (trailing digit), `datetimeoffset`, and
 *  `smalldatetime` (no `\b` before/after the `datetime` stem). Longest tokens
 *  come first so alternation matches the full name. */
export function isTemporalType(type: string | undefined): boolean {
  return (
    /\b(timestamptz|timestamp|smalldatetime|datetimeoffset|datetime2|datetime|date|time)\b/i.test(
      type ?? "",
    ) && !isJsonType(type)
  );
}

/** True for a timezone-aware temporal type: Postgres `timestamptz` /
 *  `timestamp with time zone`, or SQL Server `datetimeoffset`. Such columns must
 *  be written with an explicit UTC offset, else the engine reads a bare literal
 *  in the session timezone and shifts the stored instant. */
export function isTzAwareType(type: string | undefined): boolean {
  return /timestamptz|datetimeoffset|with time zone/i.test(type ?? "");
}

/** True for a pure `date` column (no time component in the editor). */
export function isDateOnlyType(type: string | undefined): boolean {
  return /^date$/i.test((type ?? "").trim());
}

/** One selectable timezone in the datetime editor's dropdown. */
export interface TzOption {
  id: string;
  label: string;
}

/** UTC default + Local + a handful of common zones (prototype `RI_TZS`). */
export const RI_TZS: TzOption[] = [
  { id: "UTC", label: "UTC" },
  { id: Intl.DateTimeFormat().resolvedOptions().timeZone, label: "Local" },
  { id: "America/New_York", label: "New York" },
  { id: "Europe/London", label: "London" },
  { id: "Europe/Berlin", label: "Berlin" },
  { id: "Asia/Dhaka", label: "Dhaka" },
  { id: "Asia/Tokyo", label: "Tokyo" },
];

/** Wall-clock parts of `date` as seen in timezone `tz`. */
export interface WallParts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

export function tzParts(date: Date, tz: string): WallParts {
  const p: Record<string, string> = {};
  new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
    .formatToParts(date)
    .forEach((x) => {
      p[x.type] = x.value;
    });
  return {
    y: +(p.year ?? 0),
    mo: +(p.month ?? 1),
    d: +(p.day ?? 1),
    h: +(p.hour ?? 0) % 24,
    mi: +(p.minute ?? 0),
    s: +(p.second ?? 0),
  };
}

/** Minutes `tz` is offset from UTC at the instant `date`. */
export function tzOffsetMin(date: Date, tz: string): number {
  const p = tzParts(date, tz);
  return (Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - date.getTime()) / 60000;
}

/** Wall-clock parts in `tz` → the real Date (two-pass for DST edges). */
export function wallToDate(w: WallParts, tz: string): Date {
  let guess = new Date(Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s));
  for (let i = 0; i < 2; i++) {
    guess = new Date(Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - tzOffsetMin(guess, tz) * 60000);
  }
  return guess;
}

/** Parse a stored value as a UTC instant; null when it isn't a `YYYY-MM-DD…`
 *  timestamp (the editor then falls back to raw text mode). */
export function parseTs(v: unknown): Date | null {
  if (v == null || v === "") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(v).trim());
  if (!m) return null;
  return new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)));
}

/** Zero-pad to two digits. */
export const p2 = (n: number): string => String(n).padStart(2, "0");

/** Format a Date as a UTC storage string (`YYYY-MM-DD` or `… HH:MM:SS`). */
export function fmtTs(date: Date, dateOnly: boolean): string {
  const w = tzParts(date, "UTC");
  return (
    w.y +
    "-" +
    p2(w.mo) +
    "-" +
    p2(w.d) +
    (dateOnly ? "" : " " + p2(w.h) + ":" + p2(w.mi) + ":" + p2(w.s))
  );
}
