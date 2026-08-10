// Value / type formatting for the Typesense workspace, ported from the
// prototype's typesense.jsx helpers (`tsFmt`, `tsDate`, `TS_TYPE_COLOR`).
//
// Typesense collections are schema'd but documents are plain JSON, so the
// renderer formats generically off the declared field type rather than a
// per-engine value union.

/** Per-type tint for the schema/field type tag (prototype `TS_TYPE_COLOR`). */
const TYPE_COLOR: Record<string, string> = {
  string: "var(--accent)",
  "string[]": "var(--accent)",
  int32: "#e2b340",
  "int32[]": "#e2b340",
  int64: "#e2b340",
  "int64[]": "#e2b340",
  float: "#e2b340",
  "float[]": "#e2b340",
  bool: "#c792ea",
  "bool[]": "#c792ea",
  geopoint: "#2dd4a7",
  object: "#c792ea",
  "object[]": "#c792ea",
};

export function typeColor(type: string): string {
  return TYPE_COLOR[type] ?? "var(--text-dim)";
}

/**
 * Render a document value for a table cell. Arrays join with commas, booleans
 * spell out, and absent/null becomes an em dash — Typesense fields are often
 * `optional`, so absence is common and must read as absence, not as `undefined`.
 */
export function tsFmt(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (Array.isArray(value)) return value.map((v) => tsFmt(v)).join(", ");
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Render a Unix-seconds timestamp as an ISO date. Typesense has no date type —
 * timestamps are `int64` by convention (`created_at`, `updated_at`), so the
 * Documents tab renders `*_at` int columns through this rather than showing a
 * raw epoch.
 */
export function tsDate(seconds: number): string {
  const ms = seconds * 1000;
  if (!Number.isFinite(ms)) return "—";
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toISOString().slice(0, 10);
}

/** True when a column should render through {@link tsDate}. */
export function isTimestampColumn(name: string, value: unknown): boolean {
  return name.endsWith("_at") && typeof value === "number";
}

/** Human byte size (`1.4 MB`). `undefined` in → em dash, never "NaN". */
export function tsBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return bytes + " B";
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return (value < 10 ? value.toFixed(1) : Math.round(value).toString()) + " " + units[unit];
}

/** Thousands-separated count. */
export function tsCount(n: number): string {
  return n.toLocaleString();
}
