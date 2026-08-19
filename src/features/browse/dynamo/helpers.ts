// Pure helpers for the DynamoDB slice (M17), ported from the prototype's
// `dynamo.jsx`, `dynamo-export.js`, `dynamo-import.js`, and `dynamo-map.jsx`.
// No React, no IPC — value formatting, type inference, DynamoDB-typed JSON
// marshalling, CSV, the `CreateTable` structure definition, and the
// single-table-design map model.

import type { DynamoItem, SecondaryIndex, TableDescriptor } from "./api";

/** Compact cell display for the grid: objects collapse to `[n]` / `{…}`. */
export function dynamoFmt(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  // A set is a tagged object on the wire, so without this it would read as the
  // generic "{…}" a map gets — and the whole point of the tag is that a set is
  // not a map. Shown as its own type + size, e.g. `SS[3]`.
  const set = setTypeOf(v);
  if (set) return set + "[" + setMembers(v).length + "]";
  if (typeof v === "object") return Array.isArray(v) ? "[" + v.length + "]" : "{…}";
  return String(v);
}

/**
 * The wire tags the Rust adapter wraps DynamoDB's set types in
 * (`engines/dynamo/value.rs`). Sets have no JSON counterpart, so without a tag
 * they arrive as bare arrays — indistinguishable from an `L`, which is how
 * reading and re-saving an item used to turn every set into a list.
 */
export const SET_TAG: Record<string, string> = { SS: "$ss", NS: "$ns", BS: "$bs" };
const TAG_TYPE: Record<string, string> = { $ss: "SS", $ns: "NS", $bs: "BS" };

/** The set type of a tagged value (`SS`/`NS`/`BS`), or null if it is not one. */
export function setTypeOf(v: unknown): string | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const keys = Object.keys(v as object);
  if (keys.length !== 1) return null;
  const type = TAG_TYPE[keys[0] as string];
  if (!type) return null;
  return Array.isArray((v as Record<string, unknown>)[keys[0] as string]) ? type : null;
}

/** The members of a tagged set. */
export function setMembers(v: unknown): unknown[] {
  const type = setTypeOf(v);
  if (!type) return [];
  return ((v as Record<string, unknown>)[SET_TAG[type] as string] as unknown[]) ?? [];
}

/** Infer the DynamoDB attribute type token (S/N/BOOL/L/M/SS/NS/BS/NULL). */
export function ddbType(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return "N";
  if (typeof v === "boolean") return "BOOL";
  if (Array.isArray(v)) return "L";
  if (typeof v === "object") return setTypeOf(v) ?? "M";
  return "S";
}

/**
 * The one attribute order used by BOTH the item grid and the item drawer:
 * partition key, sort key, then everything else alphabetically.
 *
 * Shared because they disagreed. The drawer used to float every KEY attribute to
 * the top — including secondary-index keys — and sort that whole group by name,
 * so a table with a GSI on `eventType` listed `aggregateId, eventType,
 * timestamp` while the grid showed `aggregateId, timestamp, eventType`. Index
 * keys are ordinary attributes of the item; only the table's own key identifies
 * it, and that is what earns the top of the list.
 */
export function orderAttributes(names: string[], keySchema: { pk: string; sk?: string }): string[] {
  const lead = [keySchema.pk, keySchema.sk].filter((c): c is string => !!c && names.includes(c));
  return lead.concat(names.filter((c) => c !== keySchema.pk && c !== keySchema.sk).sort());
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

export const DDB_TYPES = ["S", "N", "BOOL", "M", "L", "SS", "NS", "BS", "NULL"] as const;

/** True for the three set types, which share one editor and one validation. */
export function isSetType(type: string): boolean {
  return type === "SS" || type === "NS" || type === "BS";
}

/** A value's raw editable string representation. */
export function ddbRawOf(v: unknown): string {
  if (v === null || v === undefined) return "";
  // A set edits as its members, not as the tag wrapper — the type selector
  // already says which set it is, so showing `{"$ss": [...]}` would be noise the
  // user could break by editing.
  if (setTypeOf(v)) return JSON.stringify(setMembers(v), null, 2);
  if (typeof v === "object") return JSON.stringify(v, null, 2);
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

/**
 * Why a set's members are unusable, or null when they are fine. DynamoDB is
 * strict here in ways JSON is not, and a rejected write is a worse way to find
 * out than a message beside the field.
 */
export function setError(type: string, members: unknown[]): string | null {
  if (members.length === 0) return "A DynamoDB set cannot be empty.";
  const seen = new Set<string>();
  for (const m of members) {
    if (type === "NS") {
      if (typeof m !== "number" && !(typeof m === "string" && m.trim() !== "" && !isNaN(Number(m))))
        return "Every member of a number set must be a number.";
    } else if (typeof m !== "string") {
      return type === "BS"
        ? "Every member of a binary set must be a base64 string."
        : "Every member of a string set must be a string.";
    }
    const key = String(m);
    if (seen.has(key)) return "A set cannot contain the same value twice — “" + key + "” repeats.";
    seen.add(key);
  }
  return null;
}

/** Coerce an edited (type, raw) pair back to a typed value; throws on bad JSON. */
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
    case "SS":
    case "NS":
    case "BS": {
      // Edited as a bare array of members; re-wrapped in the tag the adapter
      // needs to rebuild an actual set rather than a list.
      const members: unknown = JSON.parse(raw);
      if (!Array.isArray(members)) throw new SyntaxError("a set must be a JSON array");
      const problem = setError(type, members);
      if (problem) throw new SyntaxError(problem);
      return { [SET_TAG[type] as string]: members };
    }
    default:
      return raw;
  }
}

/**
 * A stable identity string for an item, built from its primary key — the key by
 * which staged edits are held and folded back over a fetched page.
 *
 * JSON-encodes each part rather than concatenating: DynamoDB key values are
 * user data and may contain any separator you could pick, so `"a#b" + "c"` and
 * `"a" + "#bc"` must not collide.
 */
export function itemKeyOf(item: DynamoItem, keySchema: { pk: string; sk?: string }): string {
  const parts = [JSON.stringify(item[keySchema.pk] ?? null)];
  if (keySchema.sk) parts.push(JSON.stringify(item[keySchema.sk] ?? null));
  return parts.join("|");
}

// -- ISO-8601 timestamps ----------------------------------------------------
//
// DynamoDB has no date type. The convention AWS itself documents is an ISO-8601
// string in an `S` attribute, so that is what the item drawer offers a calendar
// for. Epoch NUMBERS are the other common convention, and are deliberately NOT
// detected: a bare 1775577600 is indistinguishable from a price or a counter,
// and silently turning someone's integer into a date picker would be worse than
// not offering one.

/**
 * `2026-04-07T16:30:00Z`, `…+06:00`, `…T16:30`, millis optional, and the space
 * separator some writers use. Anchored, so a string that merely STARTS with a
 * date (an id like `2026-04-07-order-12`) is not mistaken for a timestamp.
 */
const ISO_TS =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(\.\d{1,9})?(Z|[+-]\d{2}:?\d{2})?$/;

/** The parts of an ISO string worth preserving when it is written back. */
export interface IsoShape {
  /** `T` or a space — whichever the stored value used. */
  sep: string;
  /** The fractional-seconds text (`.500`), or "" when there was none. */
  frac: string;
  /** `Z`, `+06:00`, or "" for a bare local-looking timestamp. */
  zone: string;
  /** Whether the stored value spelled out seconds. */
  hasSeconds: boolean;
}

/** The ISO shape of a value, or null when it is not an ISO timestamp. */
export function isoShapeOf(v: unknown): IsoShape | null {
  if (typeof v !== "string") return null;
  const m = ISO_TS.exec(v.trim());
  if (!m) return null;
  return {
    sep: v.includes("T") ? "T" : " ",
    frac: m[7] ?? "",
    zone: m[8] ?? "",
    hasSeconds: m[6] !== undefined,
  };
}

/** True when a value is an ISO-8601 timestamp the calendar editor can drive. */
export function isIsoTimestamp(v: unknown): boolean {
  return isoShapeOf(v) !== null && parseIsoTs(v) !== null;
}

/**
 * Parse an ISO-8601 timestamp, HONOURING its offset — `…T16:30:00+06:00` is
 * 10:30 UTC, not 16:30. (The SQL `parseTs` stops at the seconds and would read
 * it as 16:30 UTC.) A value with no zone is read as UTC.
 */
export function parseIsoTs(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const m = ISO_TS.exec(v.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, sec, frac, zone] = m;
  let ms = Date.UTC(
    +y!,
    +mo! - 1,
    +d!,
    +h!,
    +mi!,
    sec ? +sec : 0,
    frac ? Math.round(parseFloat(frac) * 1000) : 0,
  );
  if (zone && zone !== "Z") {
    const sign = zone.startsWith("-") ? -1 : 1;
    const [zh, zm] = zone.slice(1).replace(":", "").match(/\d{2}/g) ?? ["0", "0"];
    ms -= sign * (+zh! * 60 + +zm!) * 60_000;
  }
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Render a Date back to ISO-8601 in the SAME shape it was read in — same
 * separator, same fractional digits, same zone spelling. Editing the minute of
 * a `…T16:30:00Z` must not also rewrite it as `… 16:30:00.000+00:00`.
 *
 * The instant is always correct: a value stored with an offset keeps that
 * offset, with the wall-clock time recomputed for it.
 */
export function formatIsoTs(date: Date, shape: IsoShape): string {
  const offsetMin = (() => {
    if (!shape.zone || shape.zone === "Z") return 0;
    const sign = shape.zone.startsWith("-") ? -1 : 1;
    const [zh, zm] = shape.zone.slice(1).replace(":", "").match(/\d{2}/g) ?? ["0", "0"];
    return sign * (+zh! * 60 + +zm!);
  })();
  const local = new Date(date.getTime() + offsetMin * 60_000);
  const p = (n: number) => String(n).padStart(2, "0");
  const base =
    local.getUTCFullYear() +
    "-" +
    p(local.getUTCMonth() + 1) +
    "-" +
    p(local.getUTCDate()) +
    shape.sep +
    p(local.getUTCHours()) +
    ":" +
    p(local.getUTCMinutes()) +
    (shape.hasSeconds ? ":" + p(local.getUTCSeconds()) : "");
  const frac = shape.frac
    ? "." +
      String(local.getUTCMilliseconds())
        .padStart(3, "0")
        .slice(0, shape.frac.length - 1)
    : "";
  return base + frac + shape.zone;
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
    // A set's members are carried as strings on the wire, numbers included —
    // DynamoDB's `NS` is a list of numeric STRINGS, exactly like a lone `N`.
    case "SS":
      return { SS: setMembers(v).map(String) };
    case "NS":
      return { NS: setMembers(v).map(String) };
    case "BS":
      return { BS: setMembers(v).map(String) };
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
  // Tagged, not bare: a bare array here would be re-marshalled as an `L`, which
  // is the round-trip loss the tags exist to prevent.
  if ("SS" in o) return { [SET_TAG.SS as string]: o.SS };
  if ("NS" in o) return { [SET_TAG.NS as string]: (o.NS as string[]).map(Number) };
  if ("BS" in o) return { [SET_TAG.BS as string]: o.BS };
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
