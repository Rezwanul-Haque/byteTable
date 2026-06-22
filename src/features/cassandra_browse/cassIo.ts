// Cassandra export / import engines (M19 §19.8, ported from cassandra-export.js +
// cassandra-import.js). Client-side, driving the existing backend commands:
// export pages rows via `cassQuery` + schema via `cassDescribeTable`; import
// parses CQL/CSV/JSON and writes rows via `cassInsertRow` in chunks with a
// progress callback. CQL types are serialized/coerced faithfully.

import {
  cassDescribeTable,
  cassInsertRow,
  cassQuery,
  keyColumns,
  type CassColumn,
  type KeyspaceInfo,
  type TableDescriptor,
} from "./api";
import { baseType } from "./cqlTypes";

export type ExportFormat = "cql" | "json" | "csv";
export type ExportMode = "both" | "schema" | "data";
export type ImportFormat = "cql" | "json" | "csv";

type Row = Record<string, unknown>;
export interface ExportResult {
  content: string;
  mime: string;
  ext: string;
}
export type ProgressFn = (pct: number, done: number, total: number, table?: string) => void;

const NUMERIC = [
  "int",
  "bigint",
  "smallint",
  "tinyint",
  "varint",
  "double",
  "float",
  "decimal",
  "counter",
];

// -- CQL value serialization (export) ---------------------------------------
function cqlVal(type: string, v: unknown): string {
  if (v === null || v === undefined || v === "") return "null";
  const bt = baseType(type);
  if (NUMERIC.includes(bt) || bt === "boolean") return String(v);
  if (bt === "set" || bt === "list") {
    const arr = Array.isArray(v) ? v : [];
    const inner = arr.map((x) => "'" + String(x).replace(/'/g, "''") + "'").join(", ");
    return (bt === "set" ? "{" : "[") + inner + (bt === "set" ? "}" : "]");
  }
  if (bt === "map") {
    const ent = v && typeof v === "object" ? Object.entries(v as Record<string, unknown>) : [];
    return (
      "{" +
      ent.map(([k, val]) => "'" + k + "': '" + String(val).replace(/'/g, "''") + "'").join(", ") +
      "}"
    );
  }
  return "'" + String(v).replace(/'/g, "''") + "'";
}

export function csvOf(columns: CassColumn[], rows: Row[]): string {
  const cols = columns.map((c) => c.name);
  const esc = (v: unknown) => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [cols.join(",")].concat(rows.map((r) => cols.map((c) => esc(r[c])).join(","))).join("\n");
}

/** Build the `CREATE KEYSPACE` statement from a keyspace's replication map. */
function buildCreateKeyspace(info: KeyspaceInfo): string {
  const entries = Object.entries(info.replication).map(([k, v]) => "'" + k + "': '" + v + "'");
  return (
    "CREATE KEYSPACE " +
    info.name +
    "\n  WITH replication = {" +
    entries.join(", ") +
    "}" +
    "\n  AND durable_writes = " +
    info.durableWrites +
    ";"
  );
}

async function fetchAllRows(handleId: string, ks: string, table: string): Promise<Row[]> {
  const r = await cassQuery(handleId, {
    keyspace: ks,
    table,
    predicates: [],
    limit: 0, // "All" — backend bounds it with a row cap + paged read.
    allowFiltering: false,
  });
  return r.rows;
}

function emitInserts(ks: string, t: TableDescriptor, rows: Row[]): string[] {
  const cols = t.columns.map((c) => c.name);
  return rows.map(
    (r) =>
      "INSERT INTO " +
      ks +
      "." +
      t.name +
      " (" +
      cols.join(", ") +
      ") VALUES (" +
      t.columns.map((c) => cqlVal(c.type, r[c.name])).join(", ") +
      ");",
  );
}

export async function buildTableExport(
  handleId: string,
  ks: string,
  t: TableDescriptor,
  format: ExportFormat,
  mode: ExportMode,
  onProg: ProgressFn,
): Promise<ExportResult> {
  const needData = mode !== "schema";
  const rows = needData ? await fetchAllRows(handleId, ks, t.name) : [];
  onProg(format === "cql" ? 0.5 : 1, rows.length, rows.length, t.name);

  if (format === "csv") {
    return { content: csvOf(t.columns, rows), mime: "text/csv", ext: "csv" };
  }
  if (format === "json") {
    const payload =
      mode === "schema"
        ? { keyspace: ks, table: t.name, primaryKey: t.primaryKey, columns: t.columns }
        : mode === "data"
          ? rows
          : { keyspace: ks, table: t.name, primaryKey: t.primaryKey, columns: t.columns, rows };
    return { content: JSON.stringify(payload, null, 2), mime: "application/json", ext: "json" };
  }
  // CQL
  const lines = ["-- ByteTable export · " + ks + "." + t.name, "USE " + ks + ";", ""];
  if (mode !== "data") {
    lines.push(await cassDescribeTable(handleId, ks, t.name), "");
  }
  if (needData) lines.push(...emitInserts(ks, t, rows));
  onProg(1, rows.length, rows.length, t.name);
  return { content: lines.join("\n"), mime: "text/plain", ext: "cql" };
}

export async function buildKeyspaceExport(
  handleId: string,
  info: KeyspaceInfo,
  tables: TableDescriptor[],
  format: ExportFormat,
  mode: ExportMode,
  onProg: ProgressFn,
): Promise<ExportResult> {
  const ks = info.name;
  if (format === "json") {
    const out = [];
    for (const t of tables) {
      const rows = mode === "schema" ? undefined : await fetchAllRows(handleId, ks, t.name);
      out.push({ table: t.name, primaryKey: t.primaryKey, columns: t.columns, rows });
      onProg(out.length / tables.length, out.length, tables.length, t.name);
    }
    return {
      content: JSON.stringify({ keyspace: ks, tables: out }, null, 2),
      mime: "application/json",
      ext: "json",
    };
  }
  // CQL
  const lines = [
    "-- ByteTable keyspace dump · " + ks,
    buildCreateKeyspace(info),
    "USE " + ks + ";",
    "",
  ];
  let done = 0;
  for (const t of tables) {
    if (mode !== "data") lines.push(await cassDescribeTable(handleId, ks, t.name), "");
    if (mode !== "schema") {
      const rows = await fetchAllRows(handleId, ks, t.name);
      lines.push(...emitInserts(ks, t, rows), "");
    }
    done++;
    onProg(done / tables.length, done, tables.length, t.name);
  }
  return { content: lines.join("\n"), mime: "text/plain", ext: "cql" };
}

/** Trigger a browser download of `content` (works in the Tauri webview). */
export function download(name: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 100);
}

// -- import -----------------------------------------------------------------
function coerce(type: string, raw: unknown): unknown {
  if (raw === undefined || raw === null || raw === "") return null;
  const bt = baseType(type);
  if (NUMERIC.includes(bt)) return Number(raw);
  if (bt === "boolean") return String(raw).toLowerCase() === "true";
  if (bt === "set" || bt === "list") {
    if (Array.isArray(raw)) return raw;
    try {
      return JSON.parse(String(raw));
    } catch {
      return String(raw)
        .replace(/^[{[]|[}\]]$/g, "")
        .split(",")
        .map((s) => s.trim().replace(/^'|'$/g, ""))
        .filter(Boolean);
    }
  }
  if (bt === "map") {
    if (raw && typeof raw === "object") return raw;
    try {
      return JSON.parse(String(raw));
    } catch {
      return {};
    }
  }
  return String(raw);
}

export function parseCsv(text: string): Row[] {
  const lines = text.trim().split(/\r?\n/);
  const header = (lines[0] ?? "").split(",").map((s) => s.trim());
  return lines
    .slice(1)
    .filter((l) => l.trim())
    .map((l) => {
      const cells: string[] = [];
      let cur = "";
      let q = false;
      for (let i = 0; i < l.length; i++) {
        const ch = l[i];
        if (ch === '"') {
          if (q && l[i + 1] === '"') {
            cur += '"';
            i++;
          } else q = !q;
        } else if (ch === "," && !q) {
          cells.push(cur);
          cur = "";
        } else cur += ch;
      }
      cells.push(cur);
      const o: Row = {};
      header.forEach((h, i) => (o[h] = cells[i]));
      return o;
    });
}

function splitArgs(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let depth = 0;
  let q = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'") q = !q;
    if (!q && (ch === "{" || ch === "[" || ch === "(")) depth++;
    if (!q && (ch === "}" || ch === "]" || ch === ")")) depth--;
    if (ch === "," && depth === 0 && !q) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
function unliteral(v: string): unknown {
  v = v.trim();
  if (v === "null") return null;
  if (/^'.*'$/.test(v)) return v.slice(1, -1).replace(/''/g, "'");
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v === "true" || v === "false") return v === "true";
  return v;
}
export function parseCqlInserts(text: string): Row[] {
  const re = /insert\s+into\s+[\w.]+\s*\(([^)]+)\)\s*values\s*\(([\s\S]*?)\)\s*;/gi;
  const rows: Row[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const cols = (m[1] ?? "").split(",").map((s) => s.trim());
    const vals = splitArgs(m[2] ?? "");
    const o: Row = {};
    cols.forEach((c, i) => (o[c] = unliteral(vals[i] ?? "")));
    rows.push(o);
  }
  return rows;
}

export interface ImportPreview {
  error?: string;
  count: number;
  columns: CassColumn[];
  rows: Row[];
  missingKey: number;
}

export function previewImport(
  format: ImportFormat,
  text: string,
  t: TableDescriptor,
): ImportPreview {
  if (!text || !text.trim()) return { count: 0, columns: [], rows: [], missingKey: 0 };
  let raw: Row[];
  try {
    if (format === "csv") raw = parseCsv(text);
    else if (format === "cql") raw = parseCqlInserts(text);
    else {
      const j = JSON.parse(text);
      raw = Array.isArray(j) ? j : (j.rows ?? []);
    }
  } catch (e) {
    return {
      error: "Parse error: " + (e as Error).message,
      count: 0,
      columns: [],
      rows: [],
      missingKey: 0,
    };
  }
  if (!Array.isArray(raw) || !raw.length)
    return { error: "No rows found to import.", count: 0, columns: [], rows: [], missingKey: 0 };
  const rows = raw.map((r) => {
    const o: Row = {};
    t.columns.forEach((c) => (o[c.name] = coerce(c.type, r[c.name])));
    return o;
  });
  const keys = keyColumns(t);
  const missingKey = rows.filter((r) =>
    keys.some((k) => r[k] === null || r[k] === undefined),
  ).length;
  return { count: rows.length, columns: t.columns, rows, missingKey };
}

/** Write rows by primary key (insert = upsert in Cassandra) in chunks. */
export async function applyImport(
  handleId: string,
  ks: string,
  table: string,
  rows: Row[],
  onProg: ProgressFn,
): Promise<number> {
  let done = 0;
  for (const row of rows) {
    await cassInsertRow(handleId, ks, table, row);
    done++;
    if (done % 10 === 0 || done === rows.length)
      onProg(done / rows.length, done, rows.length, table);
  }
  return rows.length;
}
