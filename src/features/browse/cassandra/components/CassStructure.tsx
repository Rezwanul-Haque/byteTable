// Cassandra structure view (M19 §19.4, ported from cassandra-table.jsx
// CassStructure): a filterable columns table with Kind badges + PRIMARY KEY
// summary, and a right-rail accordion (Secondary indexes / Materialized views /
// CQL) with add/drop affordances. Index/MV edits STAGE into a pending-CQL bar
// (Review CQL / Discard / Apply) — nothing mutates until applied, emitting real
// CREATE/DROP INDEX and CREATE/DROP MATERIALIZED VIEW. Columns are read-only
// (fixed at CREATE TABLE time).

import { useEffect, useState } from "react";

import { highlightSql } from "../../shared/highlightSql";
import { isAppErrorPayload } from "../../../../shared/api/error";
import { useT } from "../../../../shared/i18n/useT";
import { Btn } from "../../../../shared/ui/Btn";
import { Icon } from "../../../../shared/ui/Icon";
import { IconBtn } from "../../../../shared/ui/IconBtn";
import { useReadOnly } from "../../../../shared/ui/readOnlyContext";
import { useToast } from "../../../../shared/ui/toastContext";
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
import { StructureRailResizer } from "../../shared/components/StructureRailResizer";

type PendingOp =
  | { kind: "createIndex"; name: string; target: string; cql: string }
  | { kind: "dropIndex"; name: string; cql: string }
  | { kind: "createMv"; name: string; partitionKey: string[]; clustering: string[]; cql: string }
  | { kind: "dropMv"; name: string; cql: string };

function kindCell(t: ReturnType<typeof useT>, c: CassColumn) {
  if (c.kind === "partition_key")
    return <span className="cass-kbadge pk">{t("cass.kind.partitionKey")}</span>;
  if (c.kind === "clustering")
    return <span className="cass-kbadge ck">{t("cass.kind.clustering")}</span>;
  if (c.kind === "static") return <span className="cass-kbadge st">{t("cass.kind.static")}</span>;
  return <span className="cass-kind-reg">{t("cass.kind.regular")}</span>;
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
  const t = useT();
  const candidates = table.columns.filter(
    (c) => c.kind === "regular" || c.kind === "static" || c.kind === "clustering",
  );
  const [col, setCol] = useState(candidates[0]?.name ?? "");
  return (
    <div className="st-addform">
      <div className="st-addform-field">
        <label className="st-addform-lbl">{t("cass.struct.colToIndex")}</label>
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
          {t("cass.struct.cancel")}
        </Btn>
        <Btn variant="filled" small icon="add" disabled={!col} onClick={() => onAdd(col)}>
          {t("cass.struct.addIndex")}
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
  const t = useT();
  const [name, setName] = useState("");
  const [pk, setPk] = useState<string[]>([]);
  const [ck, setCk] = useState<string[]>([]);
  const toggle = (arr: string[], set: (v: string[]) => void, n: string) =>
    set(arr.includes(n) ? arr.filter((x) => x !== n) : [...arr, n]);
  const valid = name.trim() && pk.length;
  return (
    <div className="st-addform">
      <div className="st-addform-field">
        <label className="st-addform-lbl">{t("cass.struct.viewName")}</label>
        <input
          className="where-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("cass.struct.mvNamePh", { name: table.name })}
          spellCheck={false}
        />
      </div>
      <div className="st-addform-field">
        <label className="st-addform-lbl">{t("cass.struct.partitionKeyLabel")}</label>
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
          {t("cass.struct.clustering")}{" "}
          <span className="st-addform-opt">{t("cass.struct.optional")}</span>
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
          {t("cass.struct.cancel")}
        </Btn>
        <Btn
          variant="filled"
          small
          icon="add"
          disabled={!valid}
          onClick={() => onAdd(name.trim(), pk, ck)}
        >
          {t("cass.struct.addView")}
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
  const t = useT();
  // Read-only workspace: columns, indexes, MVs and DDL stay readable; the
  // create/drop affordances that stage CQL go.
  const readOnly = useReadOnly();
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
      toast(t("cass.struct.indexExists", { name }), "info");
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
      toast(t("cass.struct.viewExists", { name }), "info");
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
        t("cass.struct.confirmApply", {
          count: pending.length,
          target: ks + "." + table.name,
        }),
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
      toast(t("cass.struct.applied", { count: n, target: ks + "." + table.name }), "ok");
    } catch (e) {
      toast(isAppErrorPayload(e) ? e.message : t("cass.struct.applyFailed"), "err");
    } finally {
      setBusy(false);
    }
  };

  const q = colQuery.trim().toLowerCase();
  const filteredCols = table.columns.filter(
    (c) => !q || c.name.toLowerCase().includes(q) || c.type.toLowerCase().includes(q),
  );
  const copyDdl = () => {
    void navigator.clipboard?.writeText(ddl).then(() => toast(t("cass.struct.cqlCopied"), "ok"));
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
            <b>{table.columns.length}</b> {t("cass.struct.chipColumns")}
          </span>
          <span className="structure-chip">
            <b>{table.partitionKey.length}</b> {t("cass.struct.chipPartition")}
          </span>
          <span className="structure-chip">
            <b>{table.clustering.length}</b> {t("cass.struct.chipClustering")}
          </span>
          <span className="structure-chip">
            <b>{idxCount}</b> {t("cass.struct.chipIndexes")}
          </span>
          <span className="structure-chip">
            <b>{mvCount}</b> {t("cass.struct.chipViews")}
          </span>
        </div>
      </div>

      <div className="structure-body">
        <StructureRailResizer />
        <section className="columns-pane">
          <div className="columns-pane-head">
            <h3>
              <Icon name="view_column" size={15} /> {t("cass.struct.columns")}
            </h3>
            <div className="columns-search">
              <Icon name="search" size={14} style={{ color: "var(--text-faint)" }} />
              <input
                placeholder={t("cass.struct.filterColumns")}
                value={colQuery}
                onChange={(e) => setColQuery(e.target.value)}
                spellCheck={false}
              />
              {colQuery ? (
                <IconBtn
                  icon="close"
                  size={12}
                  title={t("cass.struct.clear")}
                  onClick={() => setColQuery("")}
                />
              ) : null}
            </div>
            <span className="columns-count">
              {q
                ? t("cass.struct.colCount", {
                    shown: filteredCols.length,
                    total: table.columns.length,
                  })
                : table.columns.length}
            </span>
          </div>
          <div className="cass-pk-summary">
            <span>
              <b>{t("cass.struct.primaryKey")}</b>{" "}
              <span className="mg-mono">{table.primaryKey}</span>
            </span>
            {table.clustering.length ? (
              <span className="cass-pk-clustering">
                {t("cass.struct.clusteringOrder")}{" "}
                {table.clustering.map((c) => c.name + " " + c.order).join(", ")}
              </span>
            ) : null}
          </div>
          <div className="columns-scroll">
            <table className="structure-table st-editable-table">
              <thead>
                <tr>
                  <th className="st-num-h">#</th>
                  <th />
                  <th>{t("cass.struct.thName")}</th>
                  <th>{t("cass.struct.thType")}</th>
                  <th>{t("cass.struct.thKind")}</th>
                </tr>
              </thead>
              <tbody>
                {filteredCols.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="grid-empty-cell">
                      {t("cass.struct.noColumnsMatch", { q: colQuery })}
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
                      <td>{kindCell(t, c)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            <div className="st-edit-hint">
              <code>CREATE TABLE</code> {t("cass.struct.columnsHint")}
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
              <Icon name="bolt" size={15} /> {t("cass.struct.secondaryIndexes")}{" "}
              <span className="rail-count">{idxCount}</span>
              <span style={{ flex: 1 }} />
              {readOnly ? (
                <span className="rail-add-slot" aria-hidden="true" />
              ) : (
                <span
                  className="rail-add"
                  role="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpenSection("indexes");
                    setAddingIndex(!addingIndex);
                    setAddingMv(false);
                  }}
                  title={t("cass.struct.addIndex")}
                >
                  <Icon
                    name={addingIndex && openSection === "indexes" ? "close" : "add"}
                    size={15}
                  />
                </span>
              )}
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
                    <div className="structure-none">{t("cass.struct.noSecondaryIndexes")}</div>
                  ) : (
                    shownIndexes.map((idx) => (
                      <div key={idx.name} className="structure-card">
                        <div className="structure-card-name">
                          {idx.name} <span className="tag">2i</span>
                          <span style={{ flex: 1 }} />
                          {readOnly ? (
                            <span className="card-drop-slot" aria-hidden="true" />
                          ) : (
                            <button
                              className="card-drop"
                              title={t("cass.struct.dropIndex", { name: idx.name })}
                              onClick={() => dropIndex(idx.name)}
                            >
                              <Icon name="delete" size={13} />
                            </button>
                          )}
                        </div>
                        <div className="structure-card-detail mg-mono">
                          {t("cass.struct.on")} {table.name} ({idx.target})
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
              <Icon name="dvr" size={15} /> {t("cass.struct.materializedViews")}{" "}
              <span className="rail-count">{mvCount}</span>
              <span style={{ flex: 1 }} />
              {readOnly ? (
                <span className="rail-add-slot" aria-hidden="true" />
              ) : (
                <span
                  className="rail-add"
                  role="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpenSection("mvs");
                    setAddingMv(!addingMv);
                    setAddingIndex(false);
                  }}
                  title={t("cass.struct.addMv")}
                >
                  <Icon name={addingMv && openSection === "mvs" ? "close" : "add"} size={15} />
                </span>
              )}
            </button>
            {openSection === "mvs" ? (
              <div className="acc-body">
                {addingMv ? (
                  <CassAddMvForm table={table} onCancel={() => setAddingMv(false)} onAdd={addMv} />
                ) : null}
                <div className="acc-scroll">
                  {mvCount === 0 && !addingMv ? (
                    <div className="structure-none">{t("cass.struct.noMvs")}</div>
                  ) : (
                    shownMvs.map((mv) => (
                      <div key={mv.name} className="structure-card">
                        <div className="structure-card-name">
                          {mv.name} <span className="tag">{t("cass.struct.view")}</span>
                          <span style={{ flex: 1 }} />
                          {readOnly ? (
                            <span className="card-drop-slot" aria-hidden="true" />
                          ) : (
                            <button
                              className="card-drop"
                              title={t("cass.struct.dropMv", { name: mv.name })}
                              onClick={() => dropMv(mv.name)}
                            >
                              <Icon name="delete" size={13} />
                            </button>
                          )}
                        </div>
                        <div className="structure-card-detail mg-mono">
                          {t("cass.struct.primaryKey")} (({mv.partitionKey.join(", ")})
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
              <Icon name="code" size={15} /> {t("cass.struct.cql")}
              <span style={{ flex: 1 }} />
              <span
                className="ddl-copy"
                role="button"
                onClick={(e) => {
                  e.stopPropagation();
                  copyDdl();
                }}
                title={t("cass.struct.copyCql")}
              >
                <Icon name="content_copy" size={13} /> {t("cass.struct.copy")}
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
              <div className="pending-list-title">{t("cass.struct.pendingStatements")}</div>
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
              {t("cass.struct.pendingCount", { count: pending.length })}
            </span>
            <button className="pending-review" onClick={() => setReviewOpen(!reviewOpen)}>
              <Icon name={reviewOpen ? "expand_more" : "expand_less"} size={14} />
              {reviewOpen ? t("cass.struct.hideCql") : t("cass.struct.reviewCql")}
            </button>
            <div style={{ flex: 1 }} />
            <Btn variant="text" small onClick={discardPending} disabled={busy}>
              {t("cass.struct.discard")}
            </Btn>
            <Btn
              variant="filled"
              icon="check"
              small
              onClick={() => void applyPending()}
              disabled={busy}
            >
              {t("cass.struct.applyChanges")}
            </Btn>
          </div>
        </div>
      ) : null}
    </div>
  );
}
