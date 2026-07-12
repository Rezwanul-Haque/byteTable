// Cassandra structure view (M19 §19.4, ported from cassandra-table.jsx
// CassStructure): a filterable columns table with Kind badges + PRIMARY KEY
// summary, and a right-rail accordion (Secondary indexes / Materialized views /
// CQL) with add/drop affordances. Index/MV edits STAGE into a pending-CQL bar
// (Review CQL / Discard / Apply) — nothing mutates until applied, emitting real
// CREATE/DROP INDEX and CREATE/DROP MATERIALIZED VIEW. Columns are read-only
// (fixed at CREATE TABLE time).

import { useEffect, useState } from "react";

import { highlightSql } from "../../browse/shared/highlightSql";
import { isAppErrorPayload } from "../../../shared/api/error";
import { Btn } from "../../../shared/ui/Btn";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { useToast } from "../../../shared/ui/toastContext";
import {
  cassCreateIndex,
  cassCreateMv,
  cassDescribeTable,
  cassDropIndex,
  cassDropMv,
  type CassColumn,
  type TableDescriptor,
} from "../api";
import { cqlColor } from "../cqlTypes";

type PendingOp =
  | { kind: "createIndex"; name: string; target: string; cql: string }
  | { kind: "dropIndex"; name: string; cql: string }
  | { kind: "createMv"; name: string; partitionKey: string[]; clustering: string[]; cql: string }
  | { kind: "dropMv"; name: string; cql: string };

function kindCell(c: CassColumn) {
  if (c.kind === "partition_key") return <span className="cass-kbadge pk">partition key</span>;
  if (c.kind === "clustering") return <span className="cass-kbadge ck">clustering</span>;
  if (c.kind === "static") return <span className="cass-kbadge st">static</span>;
  return <span className="cass-kind-reg">regular</span>;
}

function CassAddIndexForm({
  table,
  onAdd,
  onCancel,
}: {
  table: TableDescriptor;
  onAdd: (col: string) => void;
  onCancel: () => void;
}) {
  const candidates = table.columns.filter(
    (c) => c.kind === "regular" || c.kind === "static" || c.kind === "clustering",
  );
  const [col, setCol] = useState(candidates[0]?.name ?? "");
  return (
    <div className="st-addform">
      <div className="st-addform-field">
        <label className="st-addform-lbl">Column to index</label>
        <select className="filter-select" value={col} onChange={(e) => setCol(e.target.value)}>
          {candidates.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name} · {c.type}
            </option>
          ))}
        </select>
      </div>
      <div className="st-addform-actions">
        <Btn variant="text" small onClick={onCancel}>
          Cancel
        </Btn>
        <Btn variant="filled" small icon="add" disabled={!col} onClick={() => onAdd(col)}>
          Add index
        </Btn>
      </div>
    </div>
  );
}

function CassAddMvForm({
  table,
  onAdd,
  onCancel,
}: {
  table: TableDescriptor;
  onAdd: (name: string, pk: string[], ck: string[]) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [pk, setPk] = useState<string[]>([]);
  const [ck, setCk] = useState<string[]>([]);
  const toggle = (arr: string[], set: (v: string[]) => void, n: string) =>
    set(arr.includes(n) ? arr.filter((x) => x !== n) : [...arr, n]);
  const valid = name.trim() && pk.length;
  return (
    <div className="st-addform">
      <div className="st-addform-field">
        <label className="st-addform-lbl">View name</label>
        <input
          className="where-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={table.name + "_by_…"}
          spellCheck={false}
        />
      </div>
      <div className="st-addform-field">
        <label className="st-addform-lbl">Partition key</label>
        <div className="st-addform-cols">
          {table.columns.map((c) => (
            <button
              key={c.name}
              className={"st-chip" + (pk.includes(c.name) ? " on" : "")}
              onClick={() => toggle(pk, setPk, c.name)}
            >
              {c.name}
            </button>
          ))}
        </div>
      </div>
      <div className="st-addform-field">
        <label className="st-addform-lbl">
          Clustering <span className="st-addform-opt">optional</span>
        </label>
        <div className="st-addform-cols">
          {table.columns
            .filter((c) => !pk.includes(c.name))
            .map((c) => (
              <button
                key={c.name}
                className={"st-chip" + (ck.includes(c.name) ? " on" : "")}
                onClick={() => toggle(ck, setCk, c.name)}
              >
                {c.name}
              </button>
            ))}
        </div>
      </div>
      <div className="st-addform-actions">
        <Btn variant="text" small onClick={onCancel}>
          Cancel
        </Btn>
        <Btn
          variant="filled"
          small
          icon="add"
          disabled={!valid}
          onClick={() => onAdd(name.trim(), pk, ck)}
        >
          Add view
        </Btn>
      </div>
    </div>
  );
}

interface CassStructureProps {
  handleId: string;
  ks: string;
  table: TableDescriptor;
  isProduction: boolean;
  onChanged: () => void;
}

export function CassStructure({
  handleId,
  ks,
  table,
  isProduction,
  onChanged,
}: CassStructureProps) {
  const toast = useToast();
  const [colQuery, setColQuery] = useState("");
  const [openSection, setOpenSection] = useState<"indexes" | "mvs" | "ddl" | null>("indexes");
  const [addingIndex, setAddingIndex] = useState(false);
  const [addingMv, setAddingMv] = useState(false);
  const [pending, setPending] = useState<PendingOp[]>([]);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [ddl, setDdl] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void cassDescribeTable(handleId, ks, table.name)
      .then((d) => live && setDdl(d))
      .catch(() => live && setDdl(""));
    return () => {
      live = false;
    };
  }, [handleId, ks, table.name, pending.length]);

  // Indexes/MVs shown = real ones minus pending drops, plus pending adds.
  const droppedIdx = new Set(pending.filter((p) => p.kind === "dropIndex").map((p) => p.name));
  const droppedMv = new Set(pending.filter((p) => p.kind === "dropMv").map((p) => p.name));
  const shownIndexes = [
    ...table.indexes.filter((i) => !droppedIdx.has(i.name)),
    ...pending
      .filter((p): p is Extract<PendingOp, { kind: "createIndex" }> => p.kind === "createIndex")
      .map((p) => ({ name: p.name, target: p.target })),
  ];
  const shownMvs = [
    ...table.mvs.filter((m) => !droppedMv.has(m.name)),
    ...pending
      .filter((p): p is Extract<PendingOp, { kind: "createMv" }> => p.kind === "createMv")
      .map((p) => ({ name: p.name, partitionKey: p.partitionKey, clustering: p.clustering })),
  ];
  const idxCount = shownIndexes.length;
  const mvCount = shownMvs.length;

  const addIndex = (col: string) => {
    const name = table.name + "_" + col + "_idx";
    if (shownIndexes.some((i) => i.name === name)) {
      toast("Index " + name + " already exists", "info");
      return;
    }
    setPending((p) => [
      ...p,
      {
        kind: "createIndex",
        name,
        target: col,
        cql: "CREATE INDEX " + name + " ON " + ks + "." + table.name + " (" + col + ");",
      },
    ]);
    setAddingIndex(false);
  };
  const dropIndex = (name: string) =>
    setPending((p) => [
      ...p,
      { kind: "dropIndex", name, cql: "DROP INDEX " + ks + "." + name + ";" },
    ]);
  const addMv = (name: string, pk: string[], ck: string[]) => {
    if (shownMvs.some((m) => m.name === name)) {
      toast("View " + name + " already exists", "info");
      return;
    }
    const keyStr = "((" + pk.join(", ") + ")" + (ck.length ? ", " + ck.join(", ") : "") + ")";
    const notNull = [...pk, ...ck].map((c) => c + " IS NOT NULL").join(" AND ");
    setPending((p) => [
      ...p,
      {
        kind: "createMv",
        name,
        partitionKey: pk,
        clustering: ck,
        cql:
          "CREATE MATERIALIZED VIEW " +
          ks +
          "." +
          name +
          " AS\n  SELECT * FROM " +
          ks +
          "." +
          table.name +
          "\n  WHERE " +
          notNull +
          "\n  PRIMARY KEY " +
          keyStr +
          ";",
      },
    ]);
    setAddingMv(false);
  };
  const dropMv = (name: string) =>
    setPending((p) => [
      ...p,
      { kind: "dropMv", name, cql: "DROP MATERIALIZED VIEW " + ks + "." + name + ";" },
    ]);

  const discardPending = () => {
    setPending([]);
    setReviewOpen(false);
    setAddingIndex(false);
    setAddingMv(false);
  };
  const applyPending = async () => {
    if (
      isProduction &&
      !window.confirm(
        "Apply " + pending.length + " DDL change(s) to production " + ks + "." + table.name + "?",
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      for (const op of pending) {
        if (op.kind === "createIndex")
          await cassCreateIndex(handleId, ks, table.name, op.name, op.target);
        else if (op.kind === "dropIndex") await cassDropIndex(handleId, ks, op.name);
        else if (op.kind === "createMv")
          await cassCreateMv(handleId, ks, table.name, op.name, op.partitionKey, op.clustering);
        else await cassDropMv(handleId, ks, op.name);
      }
      const n = pending.length;
      setPending([]);
      setReviewOpen(false);
      onChanged();
      toast(
        "Applied " + n + " statement" + (n === 1 ? "" : "s") + " to " + ks + "." + table.name,
        "ok",
      );
    } catch (e) {
      toast(isAppErrorPayload(e) ? e.message : "Apply failed", "err");
    } finally {
      setBusy(false);
    }
  };

  const q = colQuery.trim().toLowerCase();
  const filteredCols = table.columns.filter(
    (c) => !q || c.name.toLowerCase().includes(q) || c.type.toLowerCase().includes(q),
  );
  const copyDdl = () => {
    void navigator.clipboard?.writeText(ddl).then(() => toast("CQL copied to clipboard", "ok"));
  };

  return (
    <div className="structure-view">
      <div className="structure-head">
        <Icon name="account_tree" size={20} style={{ color: "var(--accent)" }} />
        <h2>
          {ks}.{table.name}
        </h2>
        <span className="structure-sub">{table.comment ?? ""}</span>
        <div style={{ flex: 1 }} />
        <div className="structure-chips">
          <span className="structure-chip">
            <b>{table.columns.length}</b> columns
          </span>
          <span className="structure-chip">
            <b>{table.partitionKey.length}</b> partition
          </span>
          <span className="structure-chip">
            <b>{table.clustering.length}</b> clustering
          </span>
          <span className="structure-chip">
            <b>{idxCount}</b> indexes
          </span>
          <span className="structure-chip">
            <b>{mvCount}</b> views
          </span>
        </div>
      </div>

      <div className="structure-body">
        <section className="columns-pane">
          <div className="columns-pane-head">
            <h3>
              <Icon name="view_column" size={15} /> Columns
            </h3>
            <div className="columns-search">
              <Icon name="search" size={14} style={{ color: "var(--text-faint)" }} />
              <input
                placeholder={"Filter " + table.columns.length + " columns…"}
                value={colQuery}
                onChange={(e) => setColQuery(e.target.value)}
                spellCheck={false}
              />
              {colQuery ? (
                <IconBtn icon="close" size={12} title="Clear" onClick={() => setColQuery("")} />
              ) : null}
            </div>
            <span className="columns-count">
              {q ? filteredCols.length + " of " + table.columns.length : table.columns.length}
            </span>
          </div>
          <div className="cass-pk-summary">
            <span>
              <b>PRIMARY KEY</b> <span className="mg-mono">{table.primaryKey}</span>
            </span>
            {table.clustering.length ? (
              <span className="cass-pk-clustering">
                CLUSTERING ORDER {table.clustering.map((c) => c.name + " " + c.order).join(", ")}
              </span>
            ) : null}
          </div>
          <div className="columns-scroll">
            <table className="structure-table st-editable-table">
              <thead>
                <tr>
                  <th className="st-num-h">#</th>
                  <th />
                  <th>Name</th>
                  <th>Type</th>
                  <th>Kind</th>
                </tr>
              </thead>
              <tbody>
                {filteredCols.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="grid-empty-cell">
                      No columns match “{colQuery}”
                    </td>
                  </tr>
                ) : (
                  filteredCols.map((c, i) => (
                    <tr key={c.name}>
                      <td className="st-num">{i + 1}</td>
                      <td className="st-icon">
                        {c.kind === "partition_key" ? (
                          <Icon
                            name="key"
                            size={14}
                            style={{ color: "var(--accent)", transform: "rotate(45deg)" }}
                          />
                        ) : c.kind === "clustering" ? (
                          <Icon name="sort" size={14} style={{ color: "#e5a458" }} />
                        ) : c.kind === "static" ? (
                          <Icon name="push_pin" size={13} style={{ color: "#b08cff" }} />
                        ) : null}
                      </td>
                      <td className="st-name">{c.name}</td>
                      <td>
                        <span
                          className="mg-type-chip"
                          style={{ color: cqlColor(c.type), borderColor: cqlColor(c.type) + "55" }}
                        >
                          {c.type}
                        </span>
                      </td>
                      <td>{kindCell(c)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            <div className="st-edit-hint">
              Columns are defined at <code>CREATE TABLE</code> time · alter indexes and views in the
              panel at right
            </div>
          </div>
        </section>

        <aside className="structure-rail accordion">
          <div className={"acc-section" + (openSection === "indexes" ? " open" : "")}>
            <button
              className="acc-head"
              onClick={() => setOpenSection(openSection === "indexes" ? null : "indexes")}
            >
              <Icon
                name={openSection === "indexes" ? "expand_more" : "chevron_right"}
                size={16}
                style={{ color: "var(--text-faint)" }}
              />
              <Icon name="bolt" size={15} /> Secondary indexes{" "}
              <span className="rail-count">{idxCount}</span>
              <span style={{ flex: 1 }} />
              <span
                className="rail-add"
                role="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setOpenSection("indexes");
                  setAddingIndex(!addingIndex);
                  setAddingMv(false);
                }}
                title="Add index"
              >
                <Icon name={addingIndex && openSection === "indexes" ? "close" : "add"} size={15} />
              </span>
            </button>
            {openSection === "indexes" ? (
              <div className="acc-body">
                {addingIndex ? (
                  <CassAddIndexForm
                    table={table}
                    onCancel={() => setAddingIndex(false)}
                    onAdd={addIndex}
                  />
                ) : null}
                <div className="acc-scroll">
                  {idxCount === 0 && !addingIndex ? (
                    <div className="structure-none">No secondary indexes</div>
                  ) : (
                    shownIndexes.map((idx) => (
                      <div key={idx.name} className="structure-card">
                        <div className="structure-card-name">
                          {idx.name} <span className="tag">2i</span>
                          <span style={{ flex: 1 }} />
                          <button
                            className="card-drop"
                            title={"Drop " + idx.name}
                            onClick={() => dropIndex(idx.name)}
                          >
                            <Icon name="delete" size={13} />
                          </button>
                        </div>
                        <div className="structure-card-detail mg-mono">
                          ON {table.name} ({idx.target})
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            ) : null}
          </div>

          <div className={"acc-section" + (openSection === "mvs" ? " open" : "")}>
            <button
              className="acc-head"
              onClick={() => setOpenSection(openSection === "mvs" ? null : "mvs")}
            >
              <Icon
                name={openSection === "mvs" ? "expand_more" : "chevron_right"}
                size={16}
                style={{ color: "var(--text-faint)" }}
              />
              <Icon name="dvr" size={15} /> Materialized views{" "}
              <span className="rail-count">{mvCount}</span>
              <span style={{ flex: 1 }} />
              <span
                className="rail-add"
                role="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setOpenSection("mvs");
                  setAddingMv(!addingMv);
                  setAddingIndex(false);
                }}
                title="Add materialized view"
              >
                <Icon name={addingMv && openSection === "mvs" ? "close" : "add"} size={15} />
              </span>
            </button>
            {openSection === "mvs" ? (
              <div className="acc-body">
                {addingMv ? (
                  <CassAddMvForm table={table} onCancel={() => setAddingMv(false)} onAdd={addMv} />
                ) : null}
                <div className="acc-scroll">
                  {mvCount === 0 && !addingMv ? (
                    <div className="structure-none">No materialized views</div>
                  ) : (
                    shownMvs.map((mv) => (
                      <div key={mv.name} className="structure-card">
                        <div className="structure-card-name">
                          {mv.name} <span className="tag">view</span>
                          <span style={{ flex: 1 }} />
                          <button
                            className="card-drop"
                            title={"Drop " + mv.name}
                            onClick={() => dropMv(mv.name)}
                          >
                            <Icon name="delete" size={13} />
                          </button>
                        </div>
                        <div className="structure-card-detail mg-mono">
                          PRIMARY KEY (({mv.partitionKey.join(", ")})
                          {mv.clustering.length ? ", " + mv.clustering.join(", ") : ""})
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            ) : null}
          </div>

          <div className={"acc-section" + (openSection === "ddl" ? " open" : "")}>
            <button
              className="acc-head"
              onClick={() => setOpenSection(openSection === "ddl" ? null : "ddl")}
            >
              <Icon
                name={openSection === "ddl" ? "expand_more" : "chevron_right"}
                size={16}
                style={{ color: "var(--text-faint)" }}
              />
              <Icon name="code" size={15} /> CQL
              <span style={{ flex: 1 }} />
              <span
                className="ddl-copy"
                role="button"
                onClick={(e) => {
                  e.stopPropagation();
                  copyDdl();
                }}
                title="Copy CQL"
              >
                <Icon name="content_copy" size={13} /> copy
              </span>
            </button>
            {openSection === "ddl" ? (
              <div className="acc-body">
                <pre
                  className="ddl-block acc-ddl-block"
                  dangerouslySetInnerHTML={{ __html: highlightSql(ddl) }}
                />
              </div>
            ) : null}
          </div>
        </aside>
      </div>

      {pending.length > 0 ? (
        <div className="pending-bar">
          {reviewOpen ? (
            <div className="pending-list">
              <div className="pending-list-title">Pending statements</div>
              {pending.map((op, i) => (
                <pre key={i} className="pending-sql">
                  {op.cql}
                </pre>
              ))}
            </div>
          ) : null}
          <div className="pending-bar-row">
            <Icon name="pending_actions" size={16} style={{ color: "var(--accent)" }} />
            <span className="pending-count">
              {pending.length} pending change{pending.length === 1 ? "" : "s"}
            </span>
            <button className="pending-review" onClick={() => setReviewOpen(!reviewOpen)}>
              <Icon name={reviewOpen ? "expand_more" : "expand_less"} size={14} />
              {reviewOpen ? "Hide CQL" : "Review CQL"}
            </button>
            <div style={{ flex: 1 }} />
            <Btn variant="text" small onClick={discardPending} disabled={busy}>
              Discard
            </Btn>
            <Btn
              variant="filled"
              icon="check"
              small
              onClick={() => void applyPending()}
              disabled={busy}
            >
              Apply changes
            </Btn>
          </div>
        </div>
      ) : null}
    </div>
  );
}
