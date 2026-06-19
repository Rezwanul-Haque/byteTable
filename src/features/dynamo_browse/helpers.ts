// Pure helpers for the DynamoDB slice (M17), ported from the prototype's
// `dynamo.jsx`, `dynamo-export.js`, `dynamo-import.js`, and `dynamo-map.jsx`.
// No React, no IPC — value formatting, type inference, DynamoDB-typed JSON
// marshalling, CSV, the `CreateTable` structure definition, and the
// single-table-design map model.

import type { DynamoItem, SecondaryIndex, TableDescriptor } from "./api";

/** Compact cell display for the grid: objects collapse to `[n]` / `{…}`. */
export function dynamoFmt(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "object") return Array.isArray(v) ? "[" + v.length + "]" : "{…}";
  return String(v);
}

/** Infer the DynamoDB attribute type token (S/N/BOOL/L/M/NULL) of a value. */
export function ddbType(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return "N";
  if (typeof v === "boolean") return "BOOL";
  if (Array.isArray(v)) return "L";
  if (typeof v === "object") return "M";
  return "S";
}

/** First-seen-order attribute union across items (the schemaless grid columns). */
export function attributeUnion(items: DynamoItem[]): string[] {
  const seen = new Set<string>();
  const cols: string[] = [];
  for (const it of items) {
    for (const k of Object.keys(it)) {
      if (!seen.has(k)) {
        seen.add(k);
        cols.push(k);
      }
    }
  }
  return cols;
}

// -- Item editor coercion (dynamo.jsx) --------------------------------------

export const DDB_TYPES = ["S", "N", "BOOL", "M", "L", "NULL"] as const;

/** A value's raw editable string representation. */
export function ddbRawOf(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v, null, 2);
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

/** Coerce an edited (type, raw) pair back to a typed value; throws on bad M/L JSON. */
export function ddbCoerce(type: string, raw: string): unknown {
  switch (type) {
    case "N": {
      const n = Number(raw);
      return Number.isNaN(n) ? raw : n;
    }
    case "BOOL":
      return raw === "true";
    case "NULL":
      return null;
    case "M":
    case "L":
      return JSON.parse(raw);
    default:
      return raw;
  }
}

// -- DynamoDB-typed JSON marshalling (dynamo-export.js / dynamo-import.js) ---

type TypedValue = Record<string, unknown>;

/** Marshal a plain value into DynamoDB-typed JSON (`{"S":"…"}`, `{"N":"1"}`). */
export function marshal(v: unknown): TypedValue {
  switch (ddbType(v)) {
    case "NULL":
      return { NULL: true };
    case "N":
      return { N: String(v) };
    case "BOOL":
      return { BOOL: v };
    case "L":
      return { L: (v as unknown[]).map(marshal) };
    case "M": {
      const m: TypedValue = {};
      for (const k of Object.keys(v as object)) m[k] = marshal((v as Record<string, unknown>)[k]);
      return { M: m };
    }
    default:
      return { S: String(v) };
  }
}

export function marshalItem(it: DynamoItem): TypedValue {
  const m: TypedValue = {};
  for (const k of Object.keys(it)) m[k] = marshal(it[k]);
  return m;
}

const DDB_TAGS = ["S", "N", "BOOL", "NULL", "L", "M", "SS", "NS", "BS", "B"];

/** Unmarshal one DynamoDB-typed value into a plain value. */
export function unmarshal(v: unknown): unknown {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
  const o = v as Record<string, unknown>;
  if ("S" in o) return o.S;
  if ("N" in o) return Number(o.N);
  if ("BOOL" in o) return !!o.BOOL;
  if ("NULL" in o) return null;
  if ("L" in o) return (o.L as unknown[]).map(unmarshal);
  if ("M" in o) {
    const r: DynamoItem = {};
    const m = o.M as Record<string, unknown>;
    for (const k of Object.keys(m)) r[k] = unmarshal(m[k]);
    return r;
  }
  if ("SS" in o) return o.SS;
  if ("NS" in o) return (o.NS as string[]).map(Number);
  return v;
}

function isTypedVal(v: unknown): boolean {
  return (
    !!v &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    Object.keys(v).length === 1 &&
    DDB_TAGS.includes(Object.keys(v)[0] ?? "")
  );
}

export function isTypedItem(it: unknown): boolean {
  return (
    !!it &&
    typeof it === "object" &&
    !Array.isArray(it) &&
    Object.keys(it).length > 0 &&
    Object.values(it as object).every(isTypedVal)
  );
}

export function unmarshalItem(it: DynamoItem): DynamoItem {
  const o: DynamoItem = {};
  for (const k of Object.keys(it)) o[k] = unmarshal(it[k]);
  return o;
}

// -- CreateTable structure definition (dynamo-export.js) --------------------

function indexDef(g: SecondaryIndex) {
  return {
    IndexName: g.name,
    KeySchema: [{ AttributeName: g.pk, KeyType: "HASH" }].concat(
      g.sk ? [{ AttributeName: g.sk, KeyType: "RANGE" }] : [],
    ),
    Projection: { ProjectionType: g.projection },
  };
}

/** A `CreateTable`-style definition for a table (the "structure" export). */
export function tableDefinition(t: TableDescriptor): Record<string, unknown> {
  const attrs: Record<string, string> = {};
  [t.keySchema.pk, t.keySchema.sk].filter(Boolean).forEach((a) => {
    attrs[a as string] = t.attrTypes[a as string] || "S";
  });
  t.gsis.forEach((g) => {
    [g.pk, g.sk].filter(Boolean).forEach((a) => {
      if (!attrs[a as string]) attrs[a as string] = "S";
    });
  });
  const def: Record<string, unknown> = {
    TableName: t.name,
    AttributeDefinitions: Object.keys(attrs).map((a) => ({
      AttributeName: a,
      AttributeType: attrs[a] === "N" ? "N" : "S",
    })),
    KeySchema: [{ AttributeName: t.keySchema.pk, KeyType: "HASH" }].concat(
      t.keySchema.sk ? [{ AttributeName: t.keySchema.sk, KeyType: "RANGE" }] : [],
    ),
    BillingMode: t.billing,
  };
  if (t.gsis.length) def.GlobalSecondaryIndexes = t.gsis.map(indexDef);
  if (t.billing === "PROVISIONED") {
    def.ProvisionedThroughput = {
      ReadCapacityUnits: t.rcu ?? 5,
      WriteCapacityUnits: t.wcu ?? 5,
    };
  }
  if (t.ttlAttribute) {
    def.TimeToLiveSpecification = { Enabled: true, AttributeName: t.ttlAttribute };
  }
  return def;
}

// -- CSV (dynamo-export.js / dynamo-import.js) ------------------------------

/** Attribute-union CSV; nested maps/lists are serialized as JSON strings. */
export function toCSV(items: DynamoItem[]): string {
  const cols = attributeUnion(items);
  const esc = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [cols.join(",")];
  items.forEach((it) => lines.push(cols.map((c) => esc(it[c])).join(",")));
  return lines.join("\n");
}

/** Parse CSV (quotes, "" escapes, embedded commas/newlines). */
export function parseCSV(text: string): { columns: string[]; rows: string[][] } {
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
  return { columns: header.map((s) => s.trim()), rows: out.slice(1) };
}

function coerceCsv(v: string | undefined): unknown {
  if (v === undefined || v === "") return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (/^(true|false)$/i.test(v)) return /^true$/i.test(v);
  if (/^\s*[[{]/.test(v)) {
    try {
      return JSON.parse(v);
    } catch {
      /* keep string */
    }
  }
  return v;
}

/** Parse a paste/file into plain items (CSV coercion, or JSON auto-detecting
 *  DynamoDB-typed). Throws a human message on malformed JSON. */
export function parseItems(format: "json" | "csv", text: string): DynamoItem[] {
  if (format === "csv") {
    const { columns, rows } = parseCSV(text);
    if (!columns.length || !rows.length) return [];
    return rows.map((arr) => {
      const o: DynamoItem = {};
      columns.forEach((c, i) => {
        o[c] = coerceCsv(arr[i]);
      });
      return o;
    });
  }
  let data = JSON.parse(text);
  if (data && !Array.isArray(data) && Array.isArray(data.Items)) data = data.Items;
  else if (data && !Array.isArray(data) && Array.isArray(data.tables)) {
    data = data.tables.reduce(
      (acc: DynamoItem[], t: { Items?: DynamoItem[] }) => acc.concat(t.Items || []),
      [],
    );
  }
  if (!Array.isArray(data)) {
    throw new Error('Expected a JSON array of items, or an object with an "Items" array.');
  }
  return data.map((it: DynamoItem) => (isTypedItem(it) ? unmarshalItem(it) : it));
}

// -- Single-table-design map model (dynamo-map.jsx) -------------------------

export interface DynamoEntity {
  id: string;
  table: string;
  name: string;
  single: boolean;
  pkN: string;
  skN: string | null;
  pkPattern: string;
  skPattern: string | null;
  pkPrefix: string;
  skConst: boolean;
  count: number;
  attrs: string[];
  refKeys: string[];
  attrTypes: Record<string, string>;
  gsis: { name: string; pkPattern: string; skPattern: string | null; projection: string }[];
}

export interface DynamoModel {
  entities: DynamoEntity[];
  rels: { from: string; to: string; kind: "collection" }[];
  refs: { from: string; to: string; attr: string; kind: "ref" }[];
}

function ddbKeyPattern(val: unknown): string {
  if (val === undefined || val === null) return "∅";
  const s = String(val);
  const h = s.indexOf("#");
  if (h > 0) return s.slice(0, h) + "#⟨…⟩";
  if (/^[A-Z][A-Z0-9_]*$/.test(s)) return s;
  return "⟨…⟩";
}
function ddbKeyPrefix(val: unknown): string {
  const s = String(val == null ? "" : val);
  const h = s.indexOf("#");
  return h > 0 ? s.slice(0, h) : s;
}
function ddbIsConstSk(val: unknown): boolean {
  const s = String(val == null ? "" : val);
  return s.indexOf("#") < 0 && /^[A-Z][A-Z0-9_]*$/.test(s);
}

/** Derive entity types + item-collection / reference edges from sampled items
 *  per table (mirrors the prototype's `buildDynamoModel`). */
export function buildDynamoModel(
  tables: { descriptor: TableDescriptor; items: DynamoItem[] }[],
): DynamoModel {
  const entities: DynamoEntity[] = [];
  tables.forEach(({ descriptor: t, items }) => {
    const pkN = t.keySchema.pk;
    const skN = t.keySchema.sk ?? null;
    const gsiKeys = new Set<string>();
    t.gsis.forEach((g) => {
      gsiKeys.add(g.pk);
      if (g.sk) gsiKeys.add(g.sk);
    });

    const groups: Record<string, DynamoItem[]> = {};
    items.forEach((it) => {
      const k = (it.entity as string) || t.name;
      (groups[k] = groups[k] || []).push(it);
    });

    Object.entries(groups).forEach(([ename, gi]) => {
      const sample = gi[0];
      if (!sample) return;
      const seen = new Set<string>();
      const order: string[] = [];
      gi.slice(0, 30).forEach((it) =>
        Object.keys(it).forEach((k) => {
          if (!seen.has(k)) {
            seen.add(k);
            order.push(k);
          }
        }),
      );
      const attrs = order.filter(
        (k) => k !== pkN && k !== skN && k !== "entity" && !gsiKeys.has(k),
      );
      const refKeys = order.filter((k) => k !== pkN && k !== skN && k !== "entity");
      entities.push({
        id: t.name + "::" + ename,
        table: t.name,
        name: ename,
        single: !sample.entity,
        pkN,
        skN,
        pkPattern: ddbKeyPattern(sample[pkN]),
        skPattern: skN ? ddbKeyPattern(sample[skN]) : null,
        pkPrefix: ddbKeyPrefix(sample[pkN]),
        skConst: skN ? ddbIsConstSk(sample[skN]) : true,
        count: gi.length,
        attrs,
        refKeys,
        attrTypes: attrs.reduce<Record<string, string>>((m, k) => {
          m[k] = ddbType(sample[k]);
          return m;
        }, {}),
        gsis: t.gsis.map((g) => ({
          name: g.name,
          pkPattern: ddbKeyPattern(sample[g.pk]),
          skPattern: g.sk ? ddbKeyPattern(sample[g.sk]) : null,
          projection: g.projection,
        })),
      });
    });
  });

  // item-collection edges: same table + same partition-key prefix ⇒ 1:N.
  const rels: DynamoModel["rels"] = [];
  const groups: Record<string, DynamoEntity[]> = {};
  entities.forEach((e) => {
    const k = e.table + "::" + e.pkPrefix;
    (groups[k] = groups[k] || []).push(e);
  });
  Object.values(groups).forEach((grp) => {
    if (grp.length < 2) return;
    const parent = grp.find((e) => e.skConst) || grp[0];
    if (!parent) return;
    grp.forEach((e) => {
      if (e !== parent) rels.push({ from: parent.id, to: e.id, kind: "collection" });
    });
  });

  // reference edges: a "<x>Id" attribute pointing at an entity named <x>.
  const byName: Record<string, DynamoEntity> = {};
  entities.forEach((e) => {
    byName[e.name.toLowerCase()] = e;
  });
  const refs: DynamoModel["refs"] = [];
  entities.forEach((e) => {
    e.refKeys.forEach((a) => {
      const m = a.match(/^(.+)Id$/);
      if (!m || !m[1]) return;
      const target = byName[m[1].toLowerCase()];
      if (!target || target.id === e.id) return;
      const linked = rels.some(
        (r) => (r.from === e.id && r.to === target.id) || (r.from === target.id && r.to === e.id),
      );
      if (linked || refs.some((r) => r.from === e.id && r.to === target.id)) return;
      refs.push({ from: e.id, to: target.id, attr: a, kind: "ref" });
    });
  });

  return { entities, rels, refs };
}

/** Trigger a browser download of generated text content (export). */
export function downloadText(name: string, content: string, mime: string) {
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
