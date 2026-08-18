// Data-file core (M35 Tasks 1–3) — delimiter sniffing, RFC-4180 parsing, type
// inference, column profiling, data-quality issue detection, and the ad-hoc
// one-table schema the SQL tab loads into an in-memory SQLite database.
//
// Ported from the prototype's `bytetable/csv-core.js`. Deliberately pure: no
// React, no DOM, no Tauri — so it is unit-testable (core.test.ts) and reusable
// by the existing importer. Everything the viewer renders is derived here;
// detection NEVER lives in a view.

/**
 * Tokens that mean "no value". A CSV has no NULL, so these are the strings
 * exporters conventionally write for one; they become real nulls on parse.
 */
export const NULLS = [
  "",
  "null",
  "NULL",
  "Null",
  "NA",
  "N/A",
  "n/a",
  "nil",
  "None",
  "none",
  "-",
  "--",
];

/** Candidate delimiters {@link sniff} scores, with their display names. */
export const DELIMS = [
  { ch: ",", label: "Comma" },
  { ch: ";", label: "Semicolon" },
  { ch: "\t", label: "Tab" },
  { ch: "|", label: "Pipe" },
  { ch: ":", label: "Colon" },
] as const;

/** Human name for a delimiter character ("Custom" for anything unlisted). */
export function delimLabel(ch: string): string {
  return DELIMS.find((d) => d.ch === ch)?.label ?? "Custom";
}

/** The ten inferable column types. */
export type ColumnType =
  | "boolean"
  | "integer"
  | "decimal"
  | "datetime"
  | "date"
  | "uuid"
  | "email"
  | "url"
  | "json"
  | "text";

interface TypeMeta {
  /** Material Symbols glyph shown next to the type everywhere. */
  icon: string;
  /** Type tint (literal hexes, mirroring the prototype's palette). */
  color: string;
  /** SQL type used for the ad-hoc table, so the grid behaves as with a real one. */
  sql: string;
  /** True for the two numeric types (drives stats + the histogram). */
  num?: boolean;
  test: (v: string) => boolean;
}

export const TYPES: Record<ColumnType, TypeMeta> = {
  integer: {
    icon: "numbers",
    color: "#e2b340",
    sql: "INTEGER",
    num: true,
    test: (v) => /^[+-]?\d{1,15}$/.test(v),
  },
  decimal: {
    icon: "functions",
    color: "#e2b340",
    sql: "REAL",
    num: true,
    test: (v) => /^[+-]?(\d+\.\d+|\.\d+|\d+)$/.test(v),
  },
  boolean: {
    icon: "toggle_on",
    color: "#c792ea",
    sql: "BOOLEAN",
    test: (v) => /^(true|false|yes|no|t|f|y|n)$/i.test(v),
  },
  datetime: {
    icon: "schedule",
    color: "#2dd4a7",
    sql: "TIMESTAMP",
    test: (v) => /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.test(v),
  },
  date: {
    icon: "calendar_month",
    color: "#2dd4a7",
    sql: "DATE",
    test: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v),
  },
  uuid: {
    icon: "fingerprint",
    color: "#56b6c2",
    sql: "TEXT",
    test: (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
  },
  email: {
    icon: "alternate_email",
    color: "#56b6c2",
    sql: "TEXT",
    test: (v) => /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v),
  },
  url: { icon: "link", color: "#56b6c2", sql: "TEXT", test: (v) => /^https?:\/\/\S+$/i.test(v) },
  json: {
    icon: "data_object",
    color: "#56b6c2",
    sql: "JSON",
    test: (v) => {
      if (!/^[{[]/.test(v)) return false;
      try {
        JSON.parse(v);
        return true;
      } catch {
        return false;
      }
    },
  },
  text: { icon: "text_fields", color: "#8b94a7", sql: "TEXT", test: () => true },
};

/**
 * Tested MOST-SPECIFIC FIRST — the winner is the first type at or above the
 * match threshold, so an all-integer column never settles for `decimal`.
 */
export const ORDER: ColumnType[] = [
  "boolean",
  "integer",
  "decimal",
  "datetime",
  "date",
  "uuid",
  "email",
  "url",
  "json",
  "text",
];

/**
 * Share of a column's present values that must match a type for it to win.
 * The 10% slack is what makes real exports usable: one `"1,299.00"` in an
 * otherwise numeric column should not demote the whole column to text — it
 * should be reported as an off-type value instead.
 */
const TYPE_THRESHOLD = 0.9;

/**
 * Minimum present values before a type is inferred at all (unless the column is
 * fully populated). Without this, a 47/48-empty column takes its type from one
 * value and then reports "1 value is not integer" — noise, not signal.
 */
const MIN_TYPED_SAMPLE = 3;

const stripBom = (t: string): string => (t.charCodeAt(0) === 0xfeff ? t.slice(1) : t);

/** True when `v` is one of the null tokens (trimmed). */
export function isNull(v: unknown, tokens: string[] = NULLS): boolean {
  return tokens.indexOf(v === null || v === undefined ? "" : String(v).trim()) >= 0;
}

// ---------------------------------------------------------------------------
// Sniffing
// ---------------------------------------------------------------------------

/** What {@link sniff} learned about a file before it is parsed. */
export interface Sniffed {
  delimiter: string;
  quote: string;
  header: boolean;
  bom: boolean;
  crlf: boolean;
  encoding: string;
  /** Field count implied by the winning delimiter. */
  fields: number;
  lines: number;
  trailingNewline: boolean;
}

/**
 * Guess delimiter, header row and encoding from the first lines of `text`.
 *
 * Each candidate is scored by the CONSISTENCY of its field count across the
 * first 12 non-empty lines — `avg × 2 − meanAbsoluteDeviation × 6`. Consistency
 * beats frequency on purpose: a prose column full of commas loses to the real
 * delimiter because its counts are erratic, while the real delimiter's are not.
 */
export function sniff(text: string): Sniffed {
  const bom = text.charCodeAt(0) === 0xfeff;
  const crlf = /\r\n/.test(text.slice(0, 4000));
  const s = stripBom(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = s
    .split("\n")
    .filter((l) => l.trim() !== "")
    .slice(0, 12);

  let best = { ch: ",", score: -1, fields: 1 };
  for (const d of DELIMS) {
    const counts = lines.map((l) => countOutside(l, d.ch));
    const avg = counts.reduce((a, b) => a + b, 0) / (counts.length || 1);
    if (avg < 1) continue;
    const spread = counts.reduce((a, b) => a + Math.abs(b - avg), 0) / (counts.length || 1);
    const score = avg * 2 - spread * 6;
    if (score > best.score) best = { ch: d.ch, score, fields: Math.round(avg) + 1 };
  }

  const first = lines[0] ? splitLine(lines[0], best.ch) : [];
  const second = lines[1] ? splitLine(lines[1], best.ch) : [];
  // A header row is all-text; OR the row under it carries a typed value, which
  // makes row 1 a header even when its own labels look numeric-ish. Never
  // assume a header just because row 1 exists.
  const headerLike =
    first.length > 0 &&
    first.every((f) => {
      const v = f.trim();
      return v !== "" && !TYPES.integer.test(v) && !TYPES.decimal.test(v) && !TYPES.date.test(v);
    });
  const typedBelow = second.some((f) => {
    const v = f.trim();
    return (
      v !== "" &&
      (TYPES.integer.test(v) ||
        TYPES.decimal.test(v) ||
        TYPES.date.test(v) ||
        TYPES.datetime.test(v))
    );
  });

  return {
    delimiter: best.ch,
    quote: '"',
    header: headerLike || typedBelow,
    bom,
    crlf,
    encoding: bom ? "UTF-8 with BOM" : "UTF-8",
    fields: best.fields,
    lines: s.split("\n").length,
    trailingNewline: /\n$/.test(s),
  };
}

/** Count `ch` occurrences outside quoted runs (so a quoted comma doesn't vote). */
function countOutside(line: string, ch: string): number {
  let n = 0;
  let inq = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inq && line[i + 1] === '"') {
        i++;
        continue;
      }
      inq = !inq;
      continue;
    }
    if (c === ch && !inq) n++;
  }
  return n;
}

/** Split one already-newline-free line on `ch`, honouring quotes. */
function splitLine(line: string, ch: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inq = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === '"') {
      if (inq && line[i + 1] === '"') {
        cur += '"';
        i++;
        continue;
      }
      inq = !inq;
      continue;
    }
    if (c === ch && !inq) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Parse options; every field has a sensible default (see {@link parse}). */
export interface ParseOptions {
  delimiter?: string;
  quote?: string;
  header?: boolean;
  /** Trim UNQUOTED fields only — a quoted `"  x  "` is intentional. */
  trim?: boolean;
  nullTokens?: string[];
  skipBlank?: boolean;
}

/** The resolved option set a {@link Parsed} was produced with. */
export interface ResolvedParseOptions {
  delimiter: string;
  quote: string;
  header: boolean;
  trim: boolean;
  nullTokens: string[];
  skipBlank: boolean;
}

/** One row whose field count did not match the header's. */
export interface RaggedRow {
  /** Index into `rows`. */
  row: number;
  /** 1-based line in the source file — so an error can name a findable line. */
  line: number;
  got: number;
  want: number;
}

/**
 * A record's contiguous extent in the NORMALIZED text (see {@link normalize}),
 * from its first character through its terminating newline — so consecutive
 * spans tile the body with no gaps, and slicing one back out reproduces the
 * source exactly, quoting and all.
 */
export interface RecordSpan {
  /**
   * Where this record's slice begins. Blank lines skipped before it are folded
   * in here (so the spans tile with no gaps), which is why it can precede
   * {@link RecordSpan.textStart}.
   */
  start: number;
  /**
   * Where the record's OWN text begins — past any folded-in blank lines. A
   * rewrite must split the two: the blanks are copied through, only the text
   * after them is a record with fields.
   */
  textStart: number;
  /** Exclusive, and INCLUDES the trailing newline when the record has one. */
  end: number;
}

/** The outcome of {@link parse}. */
export interface Parsed {
  columns: string[];
  /** Row-major cells; `null` for a null token, a missing field, or a blank. */
  rows: (string | null)[][];
  /** EVERY field-count mismatch, with its source line. */
  ragged: RaggedRow[];
  /** Row index → source line number. */
  lineOf: number[];
  /**
   * Row index → its span in the normalized text. The data-file editor writes a
   * file back by splicing edited records into the original and slicing every
   * untouched one straight through, so nothing the user did not touch is
   * re-serialized (see `serializeFile`).
   */
  spans: RecordSpan[];
  /** Where the body begins: everything before it (BOM aside) is the header
   *  line plus any leading blank lines, preserved verbatim on write. */
  bodyStart: number;
  ms: number;
  /** Records read (header included). */
  records: number;
  opts: ResolvedParseOptions;
}

/**
 * The text every offset in {@link Parsed} refers to: BOM stripped and line
 * endings collapsed to `\n`. Exported because the writer must normalize
 * identically or every span would be off by the CR count.
 */
export function normalize(text: string): string {
  return stripBom(String(text)).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Character-scanning RFC-4180 parser: `""` escapes, embedded newlines and
 * delimiters inside quotes, CRLF normalised, BOM stripped, blank lines skipped.
 *
 * Reshaping data silently is the one unforgivable bug in a CSV tool, so short
 * rows are padded with `null`, long rows truncated, and **every** mismatch is
 * recorded in `ragged` with its source line.
 */
export function parse(text: string, options?: ParseOptions): Parsed {
  const o: ResolvedParseOptions = {
    delimiter: ",",
    quote: '"',
    header: true,
    trim: false,
    nullTokens: NULLS,
    skipBlank: true,
    ...options,
  };
  const t0 = performance.now();
  const s = normalize(text);
  const D = o.delimiter;
  const Q = o.quote;

  const recs: { f: string[]; line: number; span: RecordSpan }[] = [];
  let rec: string[] = [];
  let field = "";
  let inq = false;
  let quoted = false;
  let i = 0;
  let line = 1;
  let start = 1;
  // Where the record being scanned began in `s`. Spans tile the body, so the
  // next record starts exactly where this one ended (newline included).
  let spanStart = 0;
  const push = () => {
    rec.push(o.trim && !quoted ? field.trim() : field);
    field = "";
    quoted = false;
  };

  while (i < s.length) {
    const ch = s[i]!;
    if (inq) {
      if (ch === Q) {
        if (s[i + 1] === Q) {
          field += Q;
          i += 2;
          continue;
        }
        inq = false;
        i++;
        continue;
      }
      // A newline inside quotes belongs to the value, but still advances the
      // line counter so later rows report their true source line.
      if (ch === "\n") line++;
      field += ch;
      i++;
      continue;
    }
    if (ch === Q && field === "") {
      inq = true;
      quoted = true;
      i++;
      continue;
    }
    if (ch === D) {
      push();
      i++;
      continue;
    }
    if (ch === "\n") {
      push();
      // The span runs through the newline, so the next record starts at i + 1.
      recs.push({
        f: rec,
        line: start,
        span: { start: spanStart, textStart: spanStart, end: i + 1 },
      });
      rec = [];
      i++;
      spanStart = i;
      line++;
      start = line;
      continue;
    }
    field += ch;
    i++;
  }
  if (field !== "" || rec.length) {
    push();
    // A final record with no trailing newline ends at EOF.
    recs.push({
      f: rec,
      line: start,
      span: { start: spanStart, textStart: spanStart, end: s.length },
    });
  }

  // Drop blank lines, but hand their bytes to the NEXT surviving record so the
  // spans still tile the text end to end — otherwise a blank line between two
  // rows would silently disappear the first time the file is written back.
  const body: typeof recs = [];
  let carried: number | null = null;
  for (const r of recs) {
    if (o.skipBlank && r.f.length === 1 && (r.f[0] ?? "").trim() === "") {
      if (carried === null) carried = r.span.start;
      continue;
    }
    body.push(
      carried === null
        ? r
        : { ...r, span: { start: carried, textStart: r.span.textStart, end: r.span.end } },
    );
    carried = null;
  }
  // Trailing blank lines are left for the writer's suffix (everything past the
  // last record's span), so they survive too.

  let columns: string[];
  let dataRecs: typeof recs;
  if (o.header && body.length) {
    columns = dedupe(body[0]!.f.map((h, idx) => h.trim() || "column_" + (idx + 1)));
    dataRecs = body.slice(1);
  } else {
    const width = body.reduce((m, r) => Math.max(m, r.f.length), 0);
    columns = Array.from({ length: width }, (_, idx) => "column_" + (idx + 1));
    dataRecs = body;
  }

  const w = columns.length;
  const ragged: RaggedRow[] = [];
  const rows = dataRecs.map((r, ri) => {
    if (r.f.length !== w) ragged.push({ row: ri, line: r.line, got: r.f.length, want: w });
    const out: (string | null)[] = new Array(w).fill(null) as (string | null)[];
    for (let k = 0; k < w; k++) {
      const v = r.f[k];
      out[k] = v === undefined ? null : isNull(v, o.nullTokens) ? null : v;
    }
    return out;
  });

  // With a header the body starts where the header record ended (which is also
  // the first data record's start); without one it starts at the first record.
  const bodyStart =
    o.header && body.length ? body[0]!.span.end : (dataRecs[0]?.span.start ?? s.length);

  return {
    columns,
    rows,
    ragged,
    lineOf: dataRecs.map((r) => r.line),
    spans: dataRecs.map((r) => r.span),
    bodyStart,
    ms: +(performance.now() - t0).toFixed(1),
    records: body.length,
    opts: o,
  };
}

/** `total, total` → `total, total_2`; a name is never silently lost. */
function dedupe(names: string[]): string[] {
  const seen: Record<string, number> = {};
  return names.map((n) => {
    const hit = seen[n];
    if (hit) {
      seen[n] = hit + 1;
      return n + "_" + (hit + 1);
    }
    seen[n] = 1;
    return n;
  });
}

// ---------------------------------------------------------------------------
// Type inference + profiling
// ---------------------------------------------------------------------------

/** One histogram bin (14 per numeric column). */
export interface HistBin {
  x0: number;
  x1: number;
  n: number;
}

/** The profile of one column: its type plus everything the cards render. */
export interface ColumnProfile {
  name: string;
  index: number;
  type: ColumnType;
  /** Share of present values matching `type` (1 when it is a clean fit). */
  conf: number;
  nulls: number;
  blanks: number;
  /** Values with stray leading/trailing whitespace. */
  padded: number;
  /** Row indexes whose value does NOT match the chosen type. */
  bad: number[];
  count: number;
  present: number;
  distinct: number;
  unique: boolean;
  top: { v: string; n: number }[];
  fill: number;
  len?: { min: number; max: number; avg: number };
  stats?: {
    min: number;
    max: number;
    sum: number;
    mean: number;
    median: number;
    p95: number;
    negatives: number;
    zeros: number;
  };
  hist?: HistBin[];
  range?: { min: string; max: string };
  bools?: { t: number; f: number };
}

/** A row that exactly repeats an earlier one. */
export interface DuplicateRow {
  row: number;
  first: number;
}

/** The outcome of {@link analyze}. */
export interface Analysis {
  cols: ColumnProfile[];
  dups: DuplicateRow[];
  issues: Issue[];
}

/** Profile every column, find duplicate rows, and run the quality checks. */
export function analyze(parsed: Parsed): Analysis {
  const { columns, rows } = parsed;

  const cols = columns.map<ColumnProfile>((name, ci) => {
    const vals = rows.map((r) => r[ci] ?? null);
    const present: string[] = [];
    let nulls = 0;
    let blanks = 0;
    let padded = 0;
    for (const v of vals) {
      if (v === null) {
        nulls++;
        continue;
      }
      if (String(v).trim() === "") {
        blanks++;
        nulls++;
        continue;
      }
      if (v !== String(v).trim()) padded++;
      present.push(String(v).trim());
    }

    const tally: Record<string, number> = {};
    for (const t of ORDER) tally[t] = 0;
    for (const v of present) {
      for (const t of ORDER) if (TYPES[t].test(v)) tally[t] = (tally[t] ?? 0) + 1;
    }

    const n = present.length || 1;
    let type: ColumnType = "text";
    const enough =
      present.length >= MIN_TYPED_SAMPLE || (present.length > 0 && present.length === vals.length);
    if (enough) {
      for (const t of ORDER) {
        if (t !== "text" && (tally[t] ?? 0) / n >= TYPE_THRESHOLD) {
          type = t;
          break;
        }
      }
    }
    const conf = present.length ? (tally[type] ?? 0) / n : 0;

    const bad: number[] = [];
    if (type !== "text") {
      vals.forEach((v, ri) => {
        if (v !== null && String(v).trim() !== "" && !TYPES[type].test(String(v).trim())) {
          bad.push(ri);
        }
      });
    }

    const counts = new Map<string, number>();
    for (const v of present) counts.set(v, (counts.get(v) ?? 0) + 1);
    const top = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([v, c]) => ({ v, n: c }));

    const col: ColumnProfile = {
      name,
      index: ci,
      type,
      conf,
      nulls,
      blanks,
      padded,
      bad,
      count: vals.length,
      present: present.length,
      distinct: counts.size,
      // Same floor as type inference, for the same reason: in a column with one
      // value across 216 rows, "every present value is distinct" is arithmetic,
      // not a property of the data. Without this a 215/216-empty column reads as
      // a unique key — which is exactly how one won an ad-hoc primary key and
      // got locked read-only in the row inspector.
      unique: enough ? counts.size === present.length : false,
      top,
      fill: vals.length ? (vals.length - nulls) / vals.length : 0,
    };

    const lens = present.map((v) => v.length);
    if (lens.length) {
      col.len = {
        min: Math.min(...lens),
        max: Math.max(...lens),
        avg: lens.reduce((a, b) => a + b, 0) / lens.length,
      };
    }

    if (TYPES[type].num) {
      const nums = present
        .filter((v) => TYPES[type].test(v))
        .map(Number)
        .filter((x) => !Number.isNaN(x));
      if (nums.length) {
        const sorted = [...nums].sort((a, b) => a - b);
        const sum = nums.reduce((a, b) => a + b, 0);
        col.stats = {
          min: sorted[0]!,
          max: sorted[sorted.length - 1]!,
          sum,
          mean: sum / nums.length,
          median: sorted[Math.floor(sorted.length / 2)]!,
          p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!,
          negatives: nums.filter((x) => x < 0).length,
          zeros: nums.filter((x) => x === 0).length,
        };
        col.hist = histogram(sorted, 14);
      }
    }

    if (type === "date" || type === "datetime") {
      // ISO dates sort lexicographically, so a plain sort is the range.
      const ds = present.filter((v) => TYPES[type].test(v)).sort();
      if (ds.length) col.range = { min: ds[0]!, max: ds[ds.length - 1]! };
    }

    if (type === "boolean") {
      col.bools = {
        t: present.filter((v) => /^(true|yes|t|y)$/i.test(v)).length,
        f: present.filter((v) => /^(false|no|f|n)$/i.test(v)).length,
      };
    }

    return col;
  });

  // Exact duplicate rows. U+0001 cannot appear in text data, so joining the
  // fields on it makes the whole row one comparable key without a false match.
  const seen = new Map<string, number>();
  const dups: DuplicateRow[] = [];
  rows.forEach((r, ri) => {
    const k = r.join("\u0001");
    const first = seen.get(k);
    if (first !== undefined) dups.push({ row: ri, first });
    else seen.set(k, ri);
  });

  return { cols, dups, issues: findIssues(parsed, cols, dups) };
}

/** Equal-width bins over an already-ascending array. */
export function histogram(sorted: number[], bins: number): HistBin[] {
  const min = sorted[0]!;
  const max = sorted[sorted.length - 1]!;
  if (min === max) return [{ x0: min, x1: max, n: sorted.length }];
  const step = (max - min) / bins;
  const out: HistBin[] = [];
  for (let b = 0; b < bins; b++) out.push({ x0: min + b * step, x1: min + (b + 1) * step, n: 0 });
  for (const v of sorted) out[Math.min(bins - 1, Math.floor((v - min) / step))]!.n++;
  return out;
}

// ---------------------------------------------------------------------------
// Data-quality issues
// ---------------------------------------------------------------------------

/** Issue severity, in the order the list is sorted. */
export type IssueSeverity = "error" | "warn" | "note";

/** One data-quality finding. */
export interface Issue {
  id: string;
  sev: IssueSeverity;
  icon: string;
  title: string;
  /** What it MEANS for the user — never a bare count. */
  detail: string;
  /** Row indexes the Data tab can filter to ("Show rows"). */
  rows?: number[];
  /** Column the profile card jumps to ("Column"). */
  col?: string;
  /** One actionable sentence. */
  fix: string;
}

const SEVERITY_RANK: Record<IssueSeverity, number> = { error: 0, warn: 1, note: 2 };

/** `1 row has` / `2 rows have` — one helper, never an inline `+ "s"`. */
function plural(n: number, one: string, many: string): string {
  return n + " " + (n === 1 ? one : many);
}

/**
 * Every check the Data quality tab renders, sorted error → warning → note.
 * Lives here, in the core, so the view only ever displays what was found.
 */
export function findIssues(parsed: Parsed, cols: ColumnProfile[], dups: DuplicateRow[]): Issue[] {
  const out: Issue[] = [];
  const total = parsed.rows.length;

  if (parsed.ragged.length) {
    const r = parsed.ragged;
    out.push({
      id: "ragged",
      sev: "error",
      icon: "report",
      title: plural(r.length, "row has", "rows have") + " the wrong number of fields",
      detail:
        "Expected " +
        parsed.columns.length +
        " fields. " +
        r
          .slice(0, 4)
          .map((x) => "line " + x.line + " → " + x.got)
          .join(", ") +
        (r.length > 4 ? ", …" : "") +
        ". Short rows are padded with nulls; extra fields are dropped.",
      rows: r.map((x) => x.row),
      fix: "Usually an unquoted delimiter inside a value.",
    });
  }

  for (const c of cols) {
    if (c.bad.length) {
      const samples = c.bad.slice(0, 3).map((ri) => parsed.rows[ri]?.[c.index]);
      out.push({
        id: "type-" + c.name,
        sev: "error",
        icon: "rule",
        title:
          plural(c.bad.length, "value", "values") +
          " in " +
          c.name +
          (c.bad.length === 1 ? " is not " : " are not ") +
          c.type,
        detail:
          "Samples: " +
          samples.map((s) => "“" + String(s) + "”").join(", ") +
          ". These stay text and will break arithmetic or sorting.",
        rows: c.bad,
        col: c.name,
        fix: "Clean the source, or treat the column as text.",
      });
    }

    if (c.present === 0) {
      out.push({
        id: "empty-" + c.name,
        sev: "warn",
        icon: "block",
        title: c.name + " is completely empty",
        detail: "All " + total + " rows are null or blank — the column carries no information.",
        col: c.name,
        fix: "Safe to drop.",
      });
    } else if (c.distinct === 1) {
      out.push({
        id: "const-" + c.name,
        sev: "note",
        icon: "remove",
        title: c.name + " has a single value",
        detail: "Every non-null row is “" + (c.top[0]?.v ?? "") + "”.",
        col: c.name,
        fix: "Constant column — useful as metadata, not as a dimension.",
      });
    }

    if (c.present && c.nulls / c.count > 0.4) {
      out.push({
        id: "sparse-" + c.name,
        sev: "warn",
        icon: "water_drop",
        title: c.name + " is " + Math.min(99, Math.round((c.nulls / c.count) * 100)) + "% empty",
        detail:
          c.nulls.toLocaleString() + " of " + c.count.toLocaleString() + " rows have no value.",
        col: c.name,
        fix: "Check whether blank means zero, unknown, or not-applicable.",
      });
    }

    if (c.padded) {
      out.push({
        id: "pad-" + c.name,
        sev: "warn",
        icon: "space_bar",
        title:
          plural(c.padded, "value", "values") +
          " in " +
          c.name +
          (c.padded === 1 ? " has" : " have") +
          " stray whitespace",
        detail:
          "Leading or trailing spaces make values compare unequal even when they look identical.",
        col: c.name,
        fix: "Re-open with “Trim whitespace” on.",
      });
    }

    const repeats = c.present - c.distinct;
    // `repeats > 0` because a column can now be non-unique with nothing
    // repeated (too few values to judge) — "0 duplicate values" is not a finding.
    if (/^(id|.*_id|key|code|sku|email)$/i.test(c.name) && c.present && !c.unique && repeats > 0) {
      out.push({
        id: "dupkey-" + c.name,
        sev: "warn",
        icon: "content_copy",
        title: c.name + " looks like a key but repeats",
        detail:
          repeats.toLocaleString() +
          " duplicate value" +
          (repeats === 1 ? "" : "s") +
          " across " +
          c.present.toLocaleString() +
          " rows.",
        col: c.name,
        fix: "Fine for a fact table; a problem for an upsert target.",
      });
    }
  }

  if (dups.length) {
    out.push({
      id: "duprows",
      sev: "warn",
      icon: "file_copy",
      title: plural(dups.length, "exact duplicate row", "exact duplicate rows"),
      detail: "Every field matches an earlier row (first at row " + (dups[0]!.first + 1) + ").",
      rows: dups.map((d) => d.row),
      fix: "De-duplicate before loading.",
    });
  }

  return out.sort((a, b) => SEVERITY_RANK[a.sev] - SEVERITY_RANK[b.sev]);
}

// ---------------------------------------------------------------------------
// Coercion + the ad-hoc schema the SQL tab loads
// ---------------------------------------------------------------------------

/** A coerced cell: numbers stay numbers, booleans booleans, the rest text. */
export type DataFileValue = string | number | boolean | null;

/**
 * Coerce one raw cell for SQL. An unparseable value stays TEXT rather than
 * becoming `NaN` — losing the original is worse than a mixed column.
 */
export function coerce(v: string | null | undefined, type: ColumnType): DataFileValue {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === "") return null;
  if (TYPES[type].num) {
    const n = Number(s);
    return Number.isNaN(n) ? s : n;
  }
  if (type === "boolean") return /^(true|yes|t|y)$/i.test(s);
  return String(v);
}

/** Every row as a `{column: value}` object, coerced per the column's type. */
export function toObjects(
  cols: ColumnProfile[],
  rows: (string | null)[][],
): Record<string, DataFileValue>[] {
  return rows.map((r) => {
    const o: Record<string, DataFileValue> = {};
    for (const c of cols) o[c.name] = coerce(r[c.index] ?? null, c.type);
    return o;
  });
}

/**
 * Slugify a file name into a SQL table name:
 * `orders_export_2026-08.csv` → `orders_export_2026_08`.
 */
export function tableName(fileName: string): string {
  return (
    String(fileName || "file")
      .replace(/\.[a-z0-9]+$/i, "")
      .replace(/[^a-z0-9]+/gi, "_")
      .replace(/^_+|_+$/g, "")
      .toLowerCase() || "data"
  );
}

/** One column of the ad-hoc table, in the shape the DDL builder wants. */
export interface AdhocColumn {
  name: string;
  /** A SQL type from `TYPES[t].sql`, so the grid behaves as with a real table. */
  type: string;
  nullable: boolean;
}

/** The one-table schema the file is queried through. */
export interface AdhocSchema {
  /** Table (and schema display) name — the slugified file name. */
  name: string;
  columns: AdhocColumn[];
  rows: number;
}

/**
 * Build the one-table schema the SQL tab creates in its in-memory database.
 *
 * There is deliberately NO primary key here, unlike the milestone's sketch. A
 * delimited file has no key: nothing declares one, nothing enforces uniqueness,
 * and nothing references it. The scratch table does not declare one either (its
 * rowid has to stay the file's row ordinal — see `buildLoadScript`), so a `pk`
 * field would have no consumer except UI presenting a guess as a fact. It did
 * exactly that once: a 215/216-empty column was "unique" by arithmetic, became
 * the key, and the row inspector locked it read-only.
 */
export function adhocSchema(name: string, cols: ColumnProfile[], rows: number): AdhocSchema {
  return {
    name,
    columns: cols.map((c) => ({ name: c.name, type: TYPES[c.type].sql, nullable: c.nulls > 0 })),
    rows,
  };
}

/** `1.2 KB` / `3.40 MB` — the one size formatter the whole feature uses. */
export function fmtBytes(n: number): string {
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  return (n / 1048576).toFixed(2) + " MB";
}
