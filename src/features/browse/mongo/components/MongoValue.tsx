// MongoDB value rendering (M18): the typed inline cell (MongoValue), the
// attribute-union grid (MongoDocGrid), and the expandable tree (MongoDocTree /
// MongoTreeNode). Ported from the prototype's `mongo.jsx`. ObjectId/ISODate/
// number/bool/null all render with their distinct tints (MONGO_TYPE_COLOR).

import { useState } from "react";

import { Icon } from "../../../../shared/ui/Icon";
import type { MongoDoc, OidTag, DateTag } from "../api";
import { fieldUnion, MONGO_TYPE_COLOR, mType, scalar, shortDate } from "../helpers";

/** One typed value cell. */
export function MongoValue({ v }: { v: unknown }) {
  const t = mType(v);
  if (t === "null") return <span className="cell-null">null</span>;
  if (t === "objectId")
    return (
      <span className="mg-oid">
        <Icon name="tag" size={9} />
        {(v as OidTag).$oid.slice(-8)}
      </span>
    );
  if (t === "date")
    return (
      <span className="mg-date">
        <Icon name="schedule" size={9} />
        {shortDate((v as DateTag).$date)}
      </span>
    );
  if (t === "array") return <span className="mg-arr">[{(v as unknown[]).length}]</span>;
  if (t === "object")
    return (
      <span className="mg-obj">
        <Icon name="data_object" size={9} />
        {Object.keys(v as object).length} fields
      </span>
    );
  if (t === "bool") return <span className={v ? "cell-true" : "cell-false"}>{String(v)}</span>;
  if (t === "int" || t === "double") return <span className="cell-num">{String(v)}</span>;
  return <span className="cell-text">{String(v)}</span>;
}

/** Attribute-union document grid (the "Table" view). Clicking a row opens it. */
export function MongoDocGrid({
  docs,
  onOpenDoc,
  selected,
  onToggleRow,
  onToggleAll,
}: {
  docs: MongoDoc[];
  onOpenDoc: (d: MongoDoc) => void;
  /** Multi-select (by row index). When omitted, the checkbox column is hidden. */
  selected?: Set<number>;
  onToggleRow?: (i: number) => void;
  onToggleAll?: () => void;
}) {
  if (!docs.length) return <div className="ddb-grid-empty">No documents</div>;
  const cols = fieldUnion(docs);
  const ordered = ["_id"].concat(cols.filter((c) => c !== "_id"));
  const selectable = !!onToggleRow;
  const sel = selected ?? new Set<number>();
  const allOn = selectable && docs.length > 0 && sel.size === docs.length;
  const someOn = selectable && sel.size > 0 && !allOn;
  return (
    <div className="ddb-datagrid-wrap">
      <table className="ddb-datagrid">
        <thead>
          <tr>
            {selectable ? (
              <th className="ddb-dg-check-c">
                <input
                  type="checkbox"
                  className="ddb-dg-check"
                  checked={allOn}
                  ref={(el) => {
                    if (el) el.indeterminate = someOn;
                  }}
                  onChange={() => onToggleAll?.()}
                  aria-label="Select all rows"
                />
              </th>
            ) : null}
            <th className="ddb-dg-rownum-h">#</th>
            {ordered.map((c) => (
              <th key={c}>
                <span className="ddb-dg-head">
                  <span className="ddb-dg-colname">{c}</span>
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {docs.map((d, ri) => (
            <tr
              key={ri}
              className={"ddb-row" + (sel.has(ri) ? " selected" : "")}
              onClick={() => onOpenDoc(d)}
            >
              {selectable ? (
                <td className="ddb-dg-check-c" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    className="ddb-dg-check"
                    checked={sel.has(ri)}
                    onChange={() => onToggleRow?.(ri)}
                    aria-label={"Select row " + (ri + 1)}
                  />
                </td>
              ) : null}
              <td className="ddb-dg-rownum">{ri + 1}</td>
              {ordered.map((c) => (
                <td key={c} title={c in d ? "" : "missing"}>
                  {c in d ? <MongoValue v={d[c]} /> : <span className="cell-absent">·</span>}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One expandable tree node (a field row; expandable for objects/arrays). */
export function MongoTreeNode({
  k,
  v,
  depth,
  defaultOpen,
}: {
  k: string;
  v: unknown;
  depth: number;
  defaultOpen?: boolean;
}) {
  const t = mType(v);
  const size = Array.isArray(v) ? v.length : v && typeof v === "object" ? Object.keys(v).length : 0;
  const expandable = (t === "object" || t === "array") && size > 0;
  const [open, setOpen] = useState(!!defaultOpen);
  const pad = { paddingLeft: depth * 14 + 8 };
  if (!expandable) {
    return (
      <div className="mg-tree-row" style={pad}>
        <span className="mg-tree-key">
          {k}
          <span className="mg-tree-colon">:</span>
        </span>
        <MongoValue v={v} />
        <span className="mg-tree-type" style={{ color: MONGO_TYPE_COLOR[t] }}>
          {t}
        </span>
      </div>
    );
  }
  const entries: [string, unknown][] = Array.isArray(v)
    ? v.map((e, i) => [String(i), e])
    : Object.entries(v as object);
  const keys = Array.isArray(v) ? [] : Object.keys(v as object);
  const preview = Array.isArray(v)
    ? "Array(" + v.length + ")"
    : "{ " + keys.slice(0, 4).join(", ") + (keys.length > 4 ? ", …" : "") + " }";
  return (
    <div className="mg-tree-branch">
      <div className="mg-tree-row mg-tree-parent" style={pad} onClick={() => setOpen((o) => !o)}>
        <Icon name="chevron_right" size={13} className={"mg-tree-caret" + (open ? " open" : "")} />
        <span className="mg-tree-key">
          {k}
          <span className="mg-tree-colon">:</span>
        </span>
        <span className="mg-tree-preview">{preview}</span>
        <span className="mg-tree-type" style={{ color: MONGO_TYPE_COLOR[t] }}>
          {t}
        </span>
      </div>
      {open
        ? entries.map(([ck, cv]) => <MongoTreeNode key={ck} k={ck} v={cv} depth={depth + 1} />)
        : null}
    </div>
  );
}

/** Tree view: one card per doc, with per-doc edit (✎) and two-click-arm
 *  delete (🗑). Delete is only wired on find results (onDeleteDoc undefined for
 *  aggregation output). */
export function MongoDocTree({
  docs,
  onOpenDoc,
  onDeleteDoc,
}: {
  docs: MongoDoc[];
  onOpenDoc: (d: MongoDoc) => void;
  onDeleteDoc?: (d: MongoDoc) => void;
}) {
  const [armed, setArmed] = useState<string | null>(null);
  if (!docs.length) return <div className="grid-empty">No documents</div>;
  return (
    <div className="mg-tree-wrap">
      {docs.map((d, i) => {
        const id = String(scalar(d._id));
        return (
          <div key={i} className="mg-tree-doc">
            <div className="mg-tree-doc-head">
              <span className="mg-tree-idx">{i + 1}</span>
              <MongoValue v={d._id} />
              <span className="mg-tree-doc-fields">{Object.keys(d).length} fields</span>
              <button className="mg-tree-edit" onClick={() => onOpenDoc(d)} title="Edit document">
                <Icon name="edit" size={13} />
              </button>
              {onDeleteDoc ? (
                <button
                  className={"mg-tree-del" + (armed === id ? " armed" : "")}
                  onClick={() => {
                    if (armed === id) {
                      onDeleteDoc(d);
                      setArmed(null);
                    } else setArmed(id);
                  }}
                  onMouseLeave={() => {
                    if (armed === id) setArmed(null);
                  }}
                  title={armed === id ? "Click again to delete" : "Delete document"}
                >
                  <Icon name={armed === id ? "delete_forever" : "delete"} size={13} />
                </button>
              ) : null}
            </div>
            <div className="mg-tree-doc-body">
              {Object.entries(d).map(([k, v]) => (
                <MongoTreeNode key={k} k={k} v={v} depth={0} defaultOpen={false} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
