// Import parsing/preview helpers — pure functions ported from the prototype's
// `bytetable/import.jsx` (`parseCSV`, `parseInserts`, `toObjects`, `preview`,
// `parseInsertsByTable`, `previewSchema`), plus the SQL-INSERT generation that
// turns parsed rows into a script the backend's `execute_script_text` runs.
//
// All functions here are pure (no I/O, no React, no Tauri): the modals read a
// file via `readTextFile`, then parse/preview/generate entirely client-side.
// Value escaping mirrors the export side's `sql_value` (src-tauri export
// domain): numbers/bools unquoted, strings single-quoted with `'` doubled,
// null → NULL — so a CSV cell never breaks the generated INSERT on a quote.

import type { ColumnInfo } from "../../shared/api/engine";

/** A parsed value: the cell types the prototype's parsers produce. */
export type ParsedValue = string | number | boolean | null;

/** A parsed tabular payload: the header columns + the data rows. */
export interface Parsed {
  columns: string[];
  rows: ParsedValue[][];
}

// ---------------------------------------------------------------------------
// CSV parsing (RFC-4180-ish: quotes, "" escapes, embedded commas/newlines)
// ---------------------------------------------------------------------------

/**
 * Parse CSV text into `{ columns, rows }`. The first non-empty row is the
 * header (trimmed). Quoted fields may contain commas, newlines, and doubled
 * quotes (`""` → `"`). Ported verbatim from the prototype's `parseCSV`.
 */
export function parseCSV(text: string): Parsed {
  const t = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inq = false;
  let i = 0;
  while (i < t.length) {
    const c = t[i];
    if (inq) {
      if (c === '"') {
        if (t[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inq = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inq = true;
      i++;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  const out = rows.filter((r) => !(r.length === 1 && r[0] === ""));
  const header = out[0];
  if (!header) return { columns: [], rows: [] };
  return {
    columns: header.map((s) => s.trim()),
    rows: out.slice(1),
  };
}

/** Coerce a raw CSV string into the JS type implied by the target column. */
function coerce(value: string | undefined, type: string | undefined): ParsedValue {
  if (value === undefined || value === "") return null;
  const t = (type ?? "").toUpperCase();
  if (/INT|NUMERIC|DECIMAL|REAL|DOUBLE|FLOAT|SERIAL/.test(t)) {
    const n = Number(value);
    return Number.isNaN(n) ? value : n;
  }
  if (/BOOL/.test(t)) return /^(true|1|t)$/i.test(value);
  return value;
}

// ---------------------------------------------------------------------------
// SQL INSERT parsing (round-trips our own export)
// ---------------------------------------------------------------------------

/** Parse one VALUES-token into a typed value (the prototype's `parseVal`). */
function parseVal(v: string): ParsedValue {
  const s = v.trim();
  if (/^null$/i.test(s)) return null;
  if (/^true$/i.test(s)) return true;
  if (/^false$/i.test(s)) return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s.replace(/^'([\s\S]*)'$/, "$1").replace(/''/g, "'");
}

/** Split one tuple body on top-level commas, honouring `'…''…'` literals. */
function splitValues(s: string): ParsedValue[] {
  const out: string[] = [];
  let cur = "";
  let inq = false;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (inq) {
      if (c === "'") {
        if (s[i + 1] === "'") {
          cur += "''";
          i += 2;
          continue;
        }
        inq = false;
        cur += c;
        i++;
        continue;
      }
      cur += c;
      i++;
      continue;
    }
    if (c === "'") {
      inq = true;
      cur += c;
      i++;
      continue;
    }
    if (c === ",") {
      out.push(cur);
      cur = "";
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  out.push(cur);
  return out.map(parseVal);
}

/** Tuple matcher shared by the single-table and per-table INSERT parsers. */
const TUPLE_RE = /\(((?:[^()']|'(?:[^']|'')*')*)\)/g;

/**
 * Parse `INSERT INTO … (cols) VALUES (…), (…);` statements into the last
 * statement's column list + every tuple's row (the prototype's `parseInserts`,
 * used by the single-table SQL import where every INSERT targets one table).
 */
export function parseInserts(sql: string): Parsed {
  const re = /insert\s+into\s+[\w".`]+\s*\(([^)]*)\)\s*values\s*([\s\S]*?);/gi;
  let m: RegExpExecArray | null;
  let columns: string[] | null = null;
  const rows: ParsedValue[][] = [];
  while ((m = re.exec(sql))) {
    const colList = m[1] ?? "";
    const tuples = m[2] ?? "";
    columns = colList.split(",").map((s) => s.trim().replace(/["`]/g, ""));
    const tupleRe = new RegExp(TUPLE_RE.source, "g");
    let tm: RegExpExecArray | null;
    while ((tm = tupleRe.exec(tuples))) rows.push(splitValues(tm[1] ?? ""));
  }
  return { columns: columns ?? [], rows };
}

/** One table's grouped INSERT data from a multi-table dump. */
export interface TableGroup {
  table: string;
  columns: string[];
  rows: ParsedValue[][];
}

/**
 * Group every `INSERT INTO <table> …` in a dump by its table (the prototype's
 * `parseInsertsByTable`): each entry carries the table's column list + all its
 * parsed rows. The table name is the unqualified tail (`schema.table` → `table`).
 */
export function parseInsertsByTable(sql: string): TableGroup[] {
  const groups: Record<string, TableGroup> = {};
  const re = /insert\s+into\s+([\w".`]+)\s*\(([^)]*)\)\s*values\s*([\s\S]*?);/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) {
    const rawName = m[1] ?? "";
    const colList = m[2] ?? "";
    const tuples = m[3] ?? "";
    const table = rawName.replace(/["`]/g, "").split(".").pop() ?? rawName;
    const columns = colList.split(",").map((s) => s.trim().replace(/["`]/g, ""));
    const existing = (groups[table] ??= { table, columns, rows: [] });
    const tupleRe = new RegExp(TUPLE_RE.source, "g");
    let tm: RegExpExecArray | null;
    while ((tm = tupleRe.exec(tuples))) existing.rows.push(splitValues(tm[1] ?? ""));
  }
  return Object.values(groups);
}

// ---------------------------------------------------------------------------
// Row-object mapping + table preview
// ---------------------------------------------------------------------------

/** A row mapped to `{ columnName: value }`, aligned to the parsed columns. */
export type RowObject = Record<string, ParsedValue>;

/**
 * Map parsed rows to row objects keyed by the parsed column names. For CSV
 * (`coerceTypes`) every cell is coerced to the JS type the matching target
 * column implies (numeric/bool); SQL values are already typed by the parser so
 * they pass through. The prototype's `toObjects`.
 */
export function toObjects(
  columns: string[],
  rows: ParsedValue[][],
  targetColumns: ColumnInfo[],
  coerceTypes: boolean,
): RowObject[] {
  const typeOf: Record<string, string> = {};
  for (const c of targetColumns) typeOf[c.name] = c.dataType;
  return rows.map((arr) => {
    const o: RowObject = {};
    columns.forEach((name, idx) => {
      const raw = arr[idx];
      o[name] = coerceTypes
        ? coerce(raw === null || raw === undefined ? undefined : String(raw), typeOf[name])
        : (raw ?? null);
    });
    return o;
  });
}

/** The import format chosen for a table import. */
export type ImportFormat = "csv" | "sql";

/** The result of {@link previewTable}: an error, or the preview payload. */
export interface TablePreview {
  /** Parsed source column names (header / INSERT column list). */
  parsedColumns: string[];
  /** Parsed columns that exist on the target table (will be imported). */
  matched: string[];
  /** Parsed columns NOT on the target table (will be ignored). */
  unknown: string[];
  /** Each row mapped to a `{ column: value }` object (aligned to parsedColumns). */
  objects: RowObject[];
  /** Number of importable rows. */
  count: number;
}

/** Either the preview, or a human error message (no rows / parse failure). */
export type TablePreviewResult = TablePreview | { error: string };

/** Type guard: did {@link previewTable} fail? */
export function isPreviewError(r: TablePreviewResult): r is { error: string } {
  return "error" in r;
}

/**
 * Preview a table import: parse the text per `format`, map rows to objects
 * aligned to the target `columns`, and split the parsed columns into matched
 * (on the table) vs unknown (ignored). Mirrors the prototype's `preview`.
 */
export function previewTable(
  format: ImportFormat,
  text: string,
  columns: ColumnInfo[],
): TablePreviewResult {
  let parsed: Parsed;
  try {
    parsed = format === "sql" ? parseInserts(text) : parseCSV(text);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  if (!parsed.columns.length || !parsed.rows.length) {
    return {
      error:
        "No rows found. Provide " +
        (format === "sql" ? "INSERT statements" : "CSV with a header row") +
        ".",
    };
  }
  const known = new Set(columns.map((c) => c.name));
  const objects = toObjects(parsed.columns, parsed.rows, columns, format === "csv");
  const matched = parsed.columns.filter((c) => known.has(c));
  const unknown = parsed.columns.filter((c) => !known.has(c));
  return { parsedColumns: parsed.columns, matched, unknown, objects, count: objects.length };
}

// ---------------------------------------------------------------------------
// Schema-dump preview
// ---------------------------------------------------------------------------

/** One row of {@link SchemaPreview}'s summary: a table + its row count. */
export interface SchemaGroupSummary {
  table: string;
  rowCount: number;
}

/** The result of {@link previewSchema}: the grouped tables + a total. */
export interface SchemaPreview {
  groups: SchemaGroupSummary[];
  totalStatements: number;
}

/** Either the schema preview, or a human error message. */
export type SchemaPreviewResult = SchemaPreview | { error: string };

/** Type guard: did {@link previewSchema} fail? */
export function isSchemaPreviewError(r: SchemaPreviewResult): r is { error: string } {
  return "error" in r;
}

/**
 * Preview a multi-table `.sql` dump: group its INSERTs by table and report each
 * table's row count + the total INSERT statement count. The actual import runs
 * the whole dump server-side (`import_sql`), so this is informational only —
 * unlike a table import, it does NOT filter against an existing schema (the
 * dump may legitimately create new tables).
 */
export function previewSchema(text: string): SchemaPreviewResult {
  let groups: TableGroup[];
  try {
    groups = parseInsertsByTable(text);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  if (!groups.length) {
    return {
      error: "No INSERT statements found. Provide a .sql dump containing INSERT INTO … VALUES …;",
    };
  }
  let total = 0;
  const summary = groups.map((g) => {
    total += g.rows.length;
    return { table: g.table, rowCount: g.rows.length };
  });
  return { groups: summary, totalStatements: total };
}

// ---------------------------------------------------------------------------
// SQL-INSERT generation (parsed CSV/objects → script for execute_script_text)
// ---------------------------------------------------------------------------

/**
 * Format one parsed value as a SQL literal, mirroring the export side's
 * `sql_value` (src-tauri export domain): null → `NULL`, bool → `true`/`false`,
 * finite number → its raw form (unquoted), everything else single-quoted with
 * every `'` doubled. A numeric string from a non-coerced source still quotes,
 * which is harmless. There is no injection surface beyond the user's own DB
 * (same trust as the SQL editor) — the doubling just keeps the statement valid.
 */
export function sqlLiteral(value: ParsedValue): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  return "'" + String(value).replace(/'/g, "''") + "'";
}

/** Quote a SQL identifier with double quotes, doubling any embedded `"`. */
function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

/**
 * Build an `INSERT INTO "schema"."table" (cols) VALUES (...);` script from
 * previewed row objects, using only the columns the target table has
 * (`matched`, in the target's column order). Unknown columns are dropped (they
 * are flagged in the preview). One statement per row, joined by newlines; the
 * resulting text is handed to `execute_script_text`. Returns `""` for no rows.
 */
export function buildInsertScript(
  schema: string,
  table: string,
  matchedColumns: string[],
  objects: RowObject[],
): string {
  if (!matchedColumns.length || !objects.length) return "";
  const qualified = quoteIdent(schema) + "." + quoteIdent(table);
  const cols = matchedColumns.map(quoteIdent).join(", ");
  const lines = objects.map((o) => {
    const values = matchedColumns.map((name) => sqlLiteral(o[name] ?? null)).join(", ");
    return "INSERT INTO " + qualified + " (" + cols + ") VALUES (" + values + ");";
  });
  return lines.join("\n") + "\n";
}
