// Filename-pattern preview for the schedule editor (M41).
//
// ⚠️ NOT AUTHORITATIVE. The filename a run actually writes is produced by
// `Schedule::output_filename` in Rust; this is a live preview so the editor
// can show what a pattern will produce before the first run. The two are kept
// deliberately in step (same tokens, same sanitizing rules), but if they ever
// drift, Rust is right and this is a cosmetic bug.
//
// That tradeoff is the opposite of the one this feature makes for SQL
// parameters, and for a reason: a wrong preview is a wrong label, where a
// second placeholder lexer would be wrong SQL. A label can afford a mirror.

import type { OutputFormat } from "./api";

/** Longest stem the backend will produce, in characters. */
const MAX_STEM = 120;

/** Every token the filename pattern understands, for the editor's hint row. */
export const FILENAME_TOKENS = [
  "{{name}}",
  "{{env}}",
  "{{date}}",
  "{{time}}",
  "{{today}}",
  "{{yesterday}}",
  "{{month_start}}",
] as const;

/** Every token the SQL snapshot understands, for the editor's hint row. */
export const SQL_TOKENS = [
  "{{today}}",
  "{{yesterday}}",
  "{{now}}",
  "{{month_start}}",
  "{{days_ago:7}}",
] as const;

/**
 * The filename a run would write right now: tokens resolved, sanitized to one
 * path component, extension from the format.
 */
export function previewFilename(
  pattern: string,
  format: OutputFormat,
  name: string,
  env: string,
  now: Date = new Date(),
): string {
  return `${sanitizeComponent(resolveTokens(pattern, name, env, now))}.${format}`;
}

/** Expand `{{token}}`; an unrecognised token is left exactly as written. */
function resolveTokens(pattern: string, name: string, env: string, now: Date): string {
  let out = "";
  let rest = pattern;
  for (;;) {
    const start = rest.indexOf("{{");
    if (start === -1) return out + rest;
    out += rest.slice(0, start);
    const after = rest.slice(start + 2);
    const end = after.indexOf("}}");
    if (end === -1) return out + rest.slice(start);
    const value = tokenValue(after.slice(0, end).trim(), name, env, now);
    out += value ?? rest.slice(start, start + 2 + end + 2);
    rest = after.slice(end + 2);
  }
}

function tokenValue(token: string, name: string, env: string, now: Date): string | null {
  switch (token) {
    case "name":
      return name;
    case "env":
      return env;
    case "date":
      return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
    case "time":
      return `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    case "today":
      return isoDate(now);
    case "yesterday":
      return isoDate(addDays(now, -1));
    case "now":
      return `${isoDate(now)} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    case "month_start":
      return isoDate(new Date(now.getFullYear(), now.getMonth(), 1));
    default: {
      const ago = /^days_ago:\s*(\d+)$/.exec(token);
      return ago ? isoDate(addDays(now, -Number(ago[1]))) : null;
    }
  }
}

/** Mirror of the Rust `sanitize_component`. */
function sanitizeComponent(raw: string): string {
  // Control characters, path separators, and the Windows-illegal set.
  // The control range is spelled out with escapes rather than written as a
  // `-` range beside the literals, where it would silently swallow every
  // punctuation character in between.
  // eslint-disable-next-line no-control-regex
  let out = raw.replace(/[\u0000-\u001f\u007f/\\<>:"|?*]/g, "_");
  out = out.trim().replace(/^\.+/, "");
  out = out.replace(/[. ]+$/, "");
  if (out.length > MAX_STEM) out = out.slice(0, MAX_STEM).trimEnd();
  if (out === "") return "export";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(out)) return `_${out}`;
  return out;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function isoDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
