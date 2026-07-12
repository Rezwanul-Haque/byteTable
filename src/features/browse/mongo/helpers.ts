// MongoDB renderer helpers (M18): value typing/rendering, the ObjectId/ISODate
// tagged-value contract, $jsonSchema validation, and the export/import
// serializers. Ported from the prototype's `mongo.jsx` value helpers,
// `mongo-export.js`, and `mongo-import.js`. The heavy lifting (find/aggregate/
// explain/CRUD) lives in the Rust backend; these are the pure client-side
// transforms the editor, grid, tree, terminal, and IO modals share.

import type { MongoDoc, OidTag, DateTag } from "./api";

export type MongoType =
  | "null"
  | "objectId"
  | "date"
  | "array"
  | "object"
  | "bool"
  | "int"
  | "double"
  | "string";

export function isOid(v: unknown): v is OidTag {
  return typeof v === "object" && v !== null && typeof (v as OidTag).$oid === "string";
}
export function isDate(v: unknown): v is DateTag {
  return typeof v === "object" && v !== null && typeof (v as DateTag).$date === "string";
}
/** A "plain" object — not an array and not a tagged ObjectId/ISODate. */
export function isPlainObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !isOid(v) && !isDate(v);
}

/** The prototype's `mType` — the value's BSON-ish type name. */
export function mType(v: unknown): MongoType {
  if (v === null || v === undefined) return "null";
  if (isOid(v)) return "objectId";
  if (isDate(v)) return "date";
  if (Array.isArray(v)) return "array";
  if (typeof v === "object") return "object";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "double";
  return "string";
}

/** A scalar key for equality/sort — the hex/ISO string for tagged values. */
export function scalar(v: unknown): unknown {
  if (isOid(v)) return v.$oid;
  if (isDate(v)) return v.$date;
  return v;
}

export function shortDate(iso: string): string {
  return iso
    .replace("T", " ")
    .replace(/:\d\d\.\d+Z$/, "Z")
    .replace("Z", "");
}

/** Type colors — mirrors the prototype's `MONGO_TYPE_COLOR`. */
export const MONGO_TYPE_COLOR: Record<MongoType, string> = {
  objectId: "#b08cff",
  date: "#e2b340",
  array: "#56b6c2",
  object: "#61afef",
  bool: "#e06c75",
  int: "#2dd4a7",
  double: "#2dd4a7",
  string: "#98c379",
  null: "#6b7280",
};

/** First-seen-order field union across docs (the schemaless grid columns). */
export function fieldUnion(docs: MongoDoc[]): string[] {
  const seen = new Set<string>();
  const cols: string[] = [];
  for (const d of docs) {
    for (const k of Object.keys(d)) {
      if (!seen.has(k)) {
        seen.add(k);
        cols.push(k);
      }
    }
  }
  return cols;
}

/** A fresh 24-hex ObjectId-ish id (for Insert + auto-assigned _id on import). */
export function freshOid(): string {
  let hex = "";
  for (let i = 0; i < 24; i++) hex += Math.floor(Math.random() * 16).toString(16);
  return hex;
}

// -- JSON editor round-trip (ObjectId/ISODate preserved) --------------------

/** Stringify a doc with tagged ObjectId/ISODate rendered as `ObjectId("…")` /
 *  `ISODate("…")` (the prototype's `mongoStringify`). */
export function mongoStringify(doc: unknown): string {
  return JSON.stringify(doc, null, 2)
    .replace(/\{\s*"\$oid":\s*"([0-9a-fA-F]+)"\s*\}/g, 'ObjectId("$1")')
    .replace(/\{\s*"\$date":\s*"([^"]+)"\s*\}/g, 'ISODate("$1")');
}

/** Parse editor text back to a doc, restoring the `{$oid}`/`{$date}` tags
 *  (the prototype's `mongoParse`). Throws on invalid JSON. */
export function mongoParse(text: string): MongoDoc {
  const json = text
    .replace(/ObjectId\(\s*"([0-9a-fA-F]+)"\s*\)/g, '{"$oid":"$1"}')
    .replace(/ISODate\(\s*"([^"]+)"\s*\)/g, '{"$date":"$1"}');
  return JSON.parse(json) as MongoDoc;
}

// -- $jsonSchema validation (client-side, mirrors the prototype) -------------

interface JsonSchemaRule {
  bsonType?: string | string[];
  minimum?: number;
}
interface JsonSchema {
  required?: string[];
  properties?: Record<string, JsonSchemaRule>;
}

/** Validate a parsed doc against a `$jsonSchema` validator object, returning the
 *  first failure message or null. Mirrors the prototype's MongoDocModal check. */
export function validateAgainstSchema(parsed: MongoDoc, validator: unknown): string | null {
  const sc = (validator as { $jsonSchema?: JsonSchema } | null)?.$jsonSchema;
  if (!sc) return null;
  for (const req of sc.required ?? []) {
    if (!(req in parsed)) return `missing required field "${req}"`;
  }
  for (const [f, rule] of Object.entries(sc.properties ?? {})) {
    const val = parsed[f];
    if (val === undefined) continue;
    const bt = mType(val);
    if (rule.bsonType) {
      const allowed = Array.isArray(rule.bsonType) ? rule.bsonType : [rule.bsonType];
      if (!allowed.includes(bt)) {
        return `field "${f}" must be ${allowed.join("|")} (got ${bt})`;
      }
    }
    if (rule.minimum != null && typeof val === "number" && val < rule.minimum) {
      return `field "${f}" must be ≥ ${rule.minimum}`;
    }
  }
  return null;
}

// -- Export serializers (mirrors mongo-export.js) ---------------------------

/** mongosh-style document literal — `ObjectId("…")` / `ISODate("…")`. */
export function toShell(doc: MongoDoc): string {
  return JSON.stringify(doc)
    .replace(/\{"\$oid":"([0-9a-fA-F]+)"\}/g, 'ObjectId("$1")')
    .replace(/\{"\$date":"([^"]+)"\}/g, 'ISODate("$1")');
}

function flatten(doc: Record<string, unknown>, prefix: string, out: Record<string, unknown>) {
  for (const k of Object.keys(doc)) {
    const key = prefix ? prefix + "." + k : k;
    const v = doc[k];
    if (isOid(v)) out[key] = v.$oid;
    else if (isDate(v)) out[key] = v.$date;
    else if (Array.isArray(v)) out[key] = JSON.stringify(v);
    else if (isPlainObj(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

export function toCSV(docs: MongoDoc[]): string {
  const flat = docs.map((d) => flatten(d, "", {}));
  const cols: string[] = [];
  const seen = new Set<string>();
  for (const r of flat) {
    for (const k of Object.keys(r)) {
      if (!seen.has(k)) {
        seen.add(k);
        cols.push(k);
      }
    }
  }
  const esc = (v: unknown) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [cols.join(",")].concat(flat.map((r) => cols.map((c) => esc(r[c])).join(","))).join("\n");
}

// -- Import parsers (mirrors mongo-import.js) --------------------------------

function parseCSV(text: string): { columns: string[]; rows: string[][] } {
  const t = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inq = false;
  let i = 0;
  while (i < t.length) {
    const ch = t[i];
    if (inq) {
      if (ch === '"') {
        if (t[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inq = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inq = true;
      i++;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  const out = rows.filter((r) => !(r.length === 1 && r[0] === ""));
  const header = out[0];
  if (!header) return { columns: [], rows: [] };
  return { columns: header.map((s) => s.trim()), rows: out.slice(1) };
}

function coerce(v: string | undefined): unknown {
  if (v === undefined || v === "") return null;
  if (/^[0-9a-f]{24}$/i.test(v)) return { $oid: v };
  if (/^\d{4}-\d\d-\d\dT/.test(v)) return { $date: v };
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (/^(true|false)$/i.test(v)) return /^true$/i.test(v);
  if (/^\s*[[{]/.test(v)) {
    try {
      return JSON.parse(v);
    } catch {
      /* keep as string */
    }
  }
  return v;
}

function unflatten(row: string[], columns: string[]): MongoDoc {
  const doc: MongoDoc = {};
  columns.forEach((col, i) => {
    const val = coerce(row[i]);
    const parts = col.split(".");
    let cur = doc;
    parts.forEach((p, j) => {
      if (j === parts.length - 1) cur[p] = val;
      else cur = (cur[p] = (cur[p] as MongoDoc) || {}) as MongoDoc;
    });
  });
  return doc;
}

function normalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === "object") {
    if (isOid(v)) return { $oid: v.$oid };
    const dv = (v as DateTag).$date;
    if (dv !== undefined) {
      return { $date: typeof dv === "string" ? dv : new Date(dv).toISOString() };
    }
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v)) o[k] = normalize((v as Record<string, unknown>)[k]);
    return o;
  }
  return v;
}

/** Parse import text (JSON array / mongosh script / CSV) → documents. */
export function parseDocs(format: "json" | "csv", text: string): MongoDoc[] {
  if (format === "csv") {
    const { columns, rows } = parseCSV(text);
    if (!columns.length || !rows.length) return [];
    return rows.map((r) => unflatten(r, columns));
  }
  let json = text.trim();
  // Tolerate a runnable insertMany([...]) script — extract the array.
  const im = json.match(/insertMany\(\s*(\[[\s\S]*\])\s*\)/);
  if (im?.[1]) json = im[1];
  json = json
    .replace(/ObjectId\(\s*"([0-9a-fA-F]+)"\s*\)/g, '{"$oid":"$1"}')
    .replace(/ISODate\(\s*"([^"]+)"\s*\)/g, '{"$date":"$1"}');
  let data = JSON.parse(json);
  if (data && !Array.isArray(data) && Array.isArray(data.documents)) data = data.documents;
  if (data && !Array.isArray(data) && Array.isArray(data.collections)) {
    data = data.collections.reduce(
      (a: MongoDoc[], c: { documents?: MongoDoc[] }) => a.concat(c.documents || []),
      [],
    );
  }
  if (!Array.isArray(data)) {
    throw new Error('Expected a JSON array of documents (or an object with a "documents" array).');
  }
  return (data as unknown[]).map((d) => normalize(d) as MongoDoc);
}

export interface ImportPreview {
  docs?: MongoDoc[];
  count?: number;
  columns?: string[];
  noId?: number;
  error?: string;
}

/** Build the import preview (count + columns + auto-_id count) or an error. */
export function previewImport(format: "json" | "csv", text: string): ImportPreview {
  let docs: MongoDoc[];
  try {
    docs = parseDocs(format, text);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  if (!docs.length) {
    return {
      error:
        "No documents found. Paste " +
        (format === "csv" ? "CSV with a header row" : "a JSON array of documents") +
        ".",
    };
  }
  return {
    docs,
    count: docs.length,
    columns: fieldUnion(docs),
    noId: docs.filter((d) => !("_id" in d)).length,
  };
}

/** Ensure every doc has an `_id` (auto-assign on import, like the prototype). */
export function withIds(docs: MongoDoc[]): MongoDoc[] {
  return docs.map((d) => ("_id" in d ? d : { _id: { $oid: freshOid() }, ...d }));
}
