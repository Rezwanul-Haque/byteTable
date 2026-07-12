// Cassandra value rendering + key badges (ported from cassandra.jsx). CQL types
// drive both colour and shape: collections render as `{…}` / `[…]` / `k: v`,
// scalars are tinted by their type family. `cassIsComplex` classifies the types
// that must edit in the row modal rather than inline.

import type { ColumnKind } from "../api";
import { baseType, cqlColor } from "../cqlTypes";

function fmtTimestamp(v: unknown): string {
  try {
    const d = new Date(v as string);
    if (isNaN(d.getTime())) return String(v);
    return d
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d+Z$/, "+0000");
  } catch {
    return String(v);
  }
}

export function CassValue({ v, type }: { v: unknown; type: string }) {
  if (v === null || v === undefined) return <span className="cass-null">null</span>;
  const bt = baseType(type);
  if (bt === "set" || bt === "list") {
    const arr = Array.isArray(v) ? v : [];
    const open = bt === "set" ? "{" : "[";
    const close = bt === "set" ? "}" : "]";
    return (
      <span className="cass-coll">
        {open}{" "}
        {arr.map((x, i) => (
          <span key={i}>
            {i ? ", " : ""}
            <span className="cass-coll-item">{String(x)}</span>
          </span>
        ))}{" "}
        {close}
      </span>
    );
  }
  if (bt === "map") {
    const ent = v && typeof v === "object" ? Object.entries(v as Record<string, unknown>) : [];
    return (
      <span className="cass-coll">
        {"{"}{" "}
        {ent.map(([k, val], i) => (
          <span key={k}>
            {i ? ", " : ""}
            <span className="cass-map-k">{k}</span>:{" "}
            <span className="cass-map-v">{String(val)}</span>
          </span>
        ))}{" "}
        {"}"}
      </span>
    );
  }
  if (bt === "timestamp") return <span style={{ color: cqlColor(type) }}>{fmtTimestamp(v)}</span>;
  if (bt === "boolean") return <span style={{ color: cqlColor(type) }}>{String(v)}</span>;
  if (bt === "uuid" || bt === "timeuuid")
    return (
      <span className="cass-uuid" style={{ color: cqlColor(type) }} title={String(v)}>
        {String(v)}
      </span>
    );
  return <span style={{ color: cqlColor(type) }}>{String(v)}</span>;
}

export function KeyBadge({ kind }: { kind: ColumnKind }) {
  if (kind === "partition_key")
    return (
      <span className="cass-kbadge pk" title="Partition key">
        PK
      </span>
    );
  if (kind === "clustering")
    return (
      <span className="cass-kbadge ck" title="Clustering column">
        CK
      </span>
    );
  if (kind === "static")
    return (
      <span className="cass-kbadge st" title="Static column">
        ST
      </span>
    );
  return null;
}
