// Cassandra create flows (M19 §19.6, ported from cassandra-create.jsx):
// CassCreateKeyspaceModal (replication strategy + RF/DC, durable writes, CQL
// preview), CassCreateTableModal (columns + type + kind, partition/clustering
// selection with order, live CQL preview), and CassAddIndexModal (the sidebar's
// secondary-index / materialized-view add — reuses the §19.4 DDL backend).

import { useEffect, useState } from "react";

import { isAppErrorPayload } from "../../../../shared/api/error";
import { useT } from "../../../../shared/i18n/useT";
import { Btn } from "../../../../shared/ui/Btn";
import { CopyButton } from "../../../../shared/ui/CopyButton";
import { Icon } from "../../../../shared/ui/Icon";
import { IconBtn } from "../../../../shared/ui/IconBtn";
import { Select } from "../../../../shared/ui/Select";
import { useToast } from "../../../../shared/ui/toastContext";
import { highlightSql } from "../../shared/highlightSql";
import {
  cassClusterStatus,
  cassCreateIndex,
  cassCreateKeyspace,
  cassCreateMv,
  cassCreateTable,
  keyColumns,
  type ColumnKind,
  type NodeStatus,
  type TableDescriptor,
} from "../api";

const CASS_CQL_TYPES = [
  "text",
  "varchar",
  "ascii",
  "uuid",
  "timeuuid",
  "int",
  "bigint",
  "smallint",
  "tinyint",
  "varint",
  "decimal",
  "double",
  "float",
  "counter",
  "boolean",
  "timestamp",
  "date",
  "time",
  "inet",
  "blob",
  "set<text>",
  "list<text>",
  "map<text,text>",
];
const CASS_ROLES: {
  id: ColumnKind;
  labelKey:
    | "cass.role.partition"
    | "cass.role.clustering"
    | "cass.role.regular"
    | "cass.role.static";
}[] = [
  { id: "partition_key", labelKey: "cass.role.partition" },
  { id: "clustering", labelKey: "cass.role.clustering" },
  { id: "regular", labelKey: "cass.role.regular" },
  { id: "static", labelKey: "cass.role.static" },
];

const cassIdent = (s: string) => s.trim().replace(/\W+/g, "_").toLowerCase();
const pkString = (pk: string[], ck: string[]) =>
  "((" + pk.join(", ") + ")" + (ck.length ? ", " + ck.join(", ") : "") + ")";

// ============================ Create keyspace ============================
export function CassCreateKeyspaceModal({
  handleId,
  existing,
  onClose,
  onCreated,
}: {
  handleId: string;
  existing: string[];
  onClose: () => void;
  onCreated: (name: string) => void;
}) {
  const t = useT();
  const toast = useToast();
  const [name, setName] = useState("");
  const [strategy, setStrategy] = useState<"NetworkTopologyStrategy" | "SimpleStrategy">(
    "NetworkTopologyStrategy",
  );
  const [rf, setRf] = useState(3);
  const [durable, setDurable] = useState(true);
  const [busy, setBusy] = useState(false);

  // The live ring, for the replica advice below and for the DATACENTER name —
  // `dc1` was hardcoded, which silently produces a keyspace with no replicas
  // anywhere on a cluster whose DC is called something else (`datacenter1` is
  // Cassandra's own default). Unknown ring → fall back to the old constant and
  // say nothing.
  const [nodes, setNodes] = useState<NodeStatus[] | null>(null);
  useEffect(() => {
    let live = true;
    void cassClusterStatus(handleId)
      .then((s) => live && setNodes(s.nodes))
      .catch(() => live && setNodes([]));
    return () => {
      live = false;
    };
  }, [handleId]);

  const dc = nodes?.find((n) => n.dc)?.dc ?? "dc1";
  // NetworkTopologyStrategy counts replicas per datacenter; SimpleStrategy
  // spreads them over the whole ring.
  const available =
    nodes === null
      ? null
      : strategy === "SimpleStrategy"
        ? nodes.length
        : nodes.filter((n) => n.dc === dc).length;

  const clean = cassIdent(name);
  const dupe = !!clean && existing.includes(clean);
  const ok = !!clean && !dupe && rf >= 1;

  // The replication map is printed one entry per line rather than inline: on a
  // 540px modal the single-line form wrapped mid-map, breaking the quoted keys
  // across rows. Cassandra ignores the whitespace.
  const repEntries =
    strategy === "SimpleStrategy"
      ? [
          ["'class'", "'SimpleStrategy'"],
          ["'replication_factor'", String(rf)],
        ]
      : [
          ["'class'", "'NetworkTopologyStrategy'"],
          ["'" + dc + "'", String(rf)],
        ];
  const repObj = "{\n" + repEntries.map(([k, v]) => "    " + k + ": " + v).join(",\n") + "\n  }";

  // Replica advice. Cassandra happily creates a keyspace asking for more
  // replicas than the cluster has nodes — the failure only shows up later, on
  // the first QUORUM read, in another tab ("Not enough nodes are alive to
  // satisfy required consistency level"). A QUORUM needs floor(RF/2)+1 replicas
  // reachable, so RF 2 or 3 on a single node can never be read at the app's
  // default LOCAL_QUORUM. Advisory only: asking for RF 3 before adding the
  // other two nodes is legitimate.
  const quorum = Math.floor(rf / 2) + 1;
  const advice =
    available === null || available === 0
      ? null
      : quorum > available
        ? {
            tone: "err" as const,
            text: t("cass.create.adviceQuorum", {
              rf,
              nodes: t("cass.create.nodes", { count: available }),
              quorum,
            }),
          }
        : rf > available
          ? {
              tone: "warn" as const,
              text: t("cass.create.adviceTooMany", {
                rf,
                nodes: t("cass.create.nodes", { count: available }),
              }),
            }
          : null;
  const ddl =
    "CREATE KEYSPACE " +
    (clean || "keyspace_name") +
    "\n  WITH replication = " +
    repObj +
    "\n  AND durable_writes = " +
    durable +
    ";";

  const confirm = async () => {
    if (!ok) return;
    setBusy(true);
    try {
      const replication: Record<string, string | number> =
        strategy === "SimpleStrategy"
          ? { class: "SimpleStrategy", replication_factor: rf }
          : { class: "NetworkTopologyStrategy", [dc]: rf };
      await cassCreateKeyspace(handleId, clean, replication, durable);
      toast(t("cass.create.applied", { name: clean }), "ok");
      onCreated(clean);
    } catch (e) {
      toast(isAppErrorPayload(e) ? e.message : t("cass.create.failed"), "err");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal cass-create-modal">
        <div className="modal-title">
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <Icon name="hub" size={17} style={{ color: "var(--accent)" }} />{" "}
            {t("cass.create.title")}
          </span>
          <IconBtn icon="close" onClick={onClose} title={t("cass.row.close")} />
        </div>

        <div className="cass-row-field">
          <span className="form-section-label">{t("cass.create.nameLabel")}</span>
          <input
            className="cass-field"
            value={name}
            autoFocus
            spellCheck={false}
            placeholder={t("cass.create.namePh")}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div className="cass-field-grid">
          {/* Sizing lives in Cassandra.css: the strategy card fills the row
              with two equal chips, the replicas card is wide enough for its
              longer label ("Replication factor") to stay on one line. */}
          <div className="cass-field cass-field-strategy">
            <span className="form-section-label">{t("cass.create.replicationStrategy")}</span>
            <div className="seg">
              {(["NetworkTopologyStrategy", "SimpleStrategy"] as const).map((s) => (
                <button
                  key={s}
                  className={"seg-btn" + (strategy === s ? " active" : "")}
                  onClick={() => setStrategy(s)}
                >
                  {s.replace("Strategy", "")}
                </button>
              ))}
            </div>
          </div>
          <div className="cass-field cass-field-rf">
            <span className="form-section-label">
              {strategy === "SimpleStrategy"
                ? t("cass.create.replicationFactor")
                : t("cass.create.replicas", { dc })}
            </span>
            <div className="cass-stepper">
              <button onClick={() => setRf((n) => Math.max(1, n - 1))} disabled={rf <= 1}>
                <Icon name="remove" size={15} />
              </button>
              <span>{rf}</span>
              <button onClick={() => setRf((n) => Math.min(9, n + 1))} disabled={rf >= 9}>
                <Icon name="add" size={15} />
              </button>
            </div>
          </div>
        </div>

        <button className="cass-check-row" onClick={() => setDurable((d) => !d)}>
          <Icon
            name={durable ? "check_box" : "check_box_outline_blank"}
            size={18}
            style={{ color: durable ? "var(--accent)" : "var(--text-faint)" }}
          />
          <span>{t("cass.create.durableWrites")}</span>
        </button>

        {advice ? (
          <p className={"cass-create-note cass-note-" + advice.tone}>
            <Icon name={advice.tone === "err" ? "error" : "warning"} size={13} />
            {advice.text}
          </p>
        ) : null}

        <div className="cass-cql-wrap">
          <pre
            className="cass-cql-preview"
            dangerouslySetInnerHTML={{ __html: highlightSql(ddl) }}
          />
          <CopyButton
            className="cass-cql-copy"
            text={ddl}
            label={t("cass.create.copyCql")}
            size={13}
          />
        </div>
        {dupe ? (
          <p className="cass-create-note">{t("cass.create.ksExists", { name: clean })}</p>
        ) : null}

        <div className="modal-actions">
          <div style={{ flex: 1 }} />
          <Btn variant="text" onClick={onClose}>
            {t("cass.create.cancel")}
          </Btn>
          <Btn variant="filled" icon="add" disabled={!ok || busy} onClick={() => void confirm()}>
            {t("cass.create.createBtn")}
          </Btn>
        </div>
      </div>
    </div>
  );
}

// ============================ Create table ============================
interface ColDraft {
  id: string;
  name: string;
  type: string;
  role: ColumnKind;
  order: string;
}
let colSeq = 0;

export function CassCreateTableModal({
  handleId,
  ks,
  existing,
  onClose,
  onCreated,
}: {
  handleId: string;
  ks: string;
  existing: string[];
  onClose: () => void;
  onCreated: (name: string) => void;
}) {
  const t = useT();
  const toast = useToast();
  const [name, setName] = useState("");
  const [cols, setCols] = useState<ColDraft[]>([
    { id: "c1", name: "id", type: "uuid", role: "partition_key", order: "ASC" },
    { id: "c2", name: "", type: "text", role: "regular", order: "ASC" },
  ]);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);

  const clean = cassIdent(name);
  const dupe = !!clean && existing.includes(clean);
  const validCols = cols.filter((c) => c.name.trim());
  const partition = validCols.filter((c) => c.role === "partition_key");
  const clustering = validCols.filter((c) => c.role === "clustering");
  const ok = !!clean && !dupe && validCols.length > 0 && partition.length > 0;

  const addCol = () =>
    setCols((cs) => [
      ...cs,
      { id: "c" + ++colSeq, name: "", type: "text", role: "regular", order: "ASC" },
    ]);
  const patch = (id: string, p: Partial<ColDraft>) =>
    setCols((cs) => cs.map((c) => (c.id === id ? { ...c, ...p } : c)));
  const remove = (id: string) => setCols((cs) => cs.filter((c) => c.id !== id));

  const ddl = (() => {
    const lines = validCols.map(
      (c) => "  " + cassIdent(c.name) + " " + c.type + (c.role === "static" ? " static" : ""),
    );
    const pk = pkString(
      partition.length ? partition.map((c) => cassIdent(c.name)) : ["…"],
      clustering.map((c) => cassIdent(c.name)),
    );
    lines.push("  PRIMARY KEY " + pk);
    let s =
      "CREATE TABLE " + ks + "." + (clean || "table_name") + " (\n" + lines.join(",\n") + "\n)";
    const withs: string[] = [];
    if (clustering.length)
      withs.push(
        "CLUSTERING ORDER BY (" +
          clustering.map((c) => cassIdent(c.name) + " " + c.order).join(", ") +
          ")",
      );
    if (comment.trim()) withs.push("comment = '" + comment.trim() + "'");
    if (withs.length) s += "\n  WITH " + withs.join("\n  AND ");
    return s + ";";
  })();

  const confirm = async () => {
    if (!ok) return;
    setBusy(true);
    try {
      await cassCreateTable(
        handleId,
        ks,
        clean,
        validCols.map((c) => ({ name: cassIdent(c.name), type: c.type, kind: c.role })),
        partition.map((c) => cassIdent(c.name)),
        clustering.map((c) => ({ name: cassIdent(c.name), order: c.order })),
        comment.trim(),
      );
      toast(t("cass.createTable.applied", { name: clean }), "ok");
      onCreated(clean);
    } catch (e) {
      toast(isAppErrorPayload(e) ? e.message : t("cass.createTable.failed"), "err");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal cass-create-modal cass-create-table">
        <div className="modal-title">
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <Icon name="add" size={17} style={{ color: "var(--accent)" }} />{" "}
            {t("cass.createTable.title")}
            <span className="structure-sub">{t("cass.createTable.in", { ks })}</span>
          </span>
          <IconBtn icon="close" onClick={onClose} title={t("cass.row.close")} />
        </div>

        <div className="cass-row-field">
          <span className="form-section-label">{t("cass.createTable.nameLabel")}</span>
          <input
            className="cass-field"
            value={name}
            autoFocus
            spellCheck={false}
            placeholder={t("cass.createTable.namePh")}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span className="form-section-label">{t("cass.createTable.columns")}</span>
          <button className="rail-add" onClick={addCol} title={t("cass.createTable.addColumn")}>
            <Icon name="add" size={15} />
          </button>
        </div>
        <div>
          <div className="cass-ct-row cass-ct-head">
            <span>{t("cass.createTable.thName")}</span>
            <span>{t("cass.createTable.thType")}</span>
            <span>{t("cass.createTable.thRole")}</span>
            <span>{t("cass.createTable.thOrder")}</span>
            <span />
          </div>
          {cols.map((c) => (
            <div className="cass-ct-row" key={c.id}>
              <input
                className="cass-field"
                value={c.name}
                placeholder={t("cass.createTable.colPh")}
                spellCheck={false}
                onChange={(e) => patch(c.id, { name: e.target.value })}
              />
              <Select
                className="sel-block cass-ct-select"
                aria-label={t("cass.createTable.colType")}
                value={c.type}
                options={[...new Set([c.type, ...CASS_CQL_TYPES])].map((ty) => ({
                  value: ty,
                  label: ty,
                }))}
                onChange={(ty) => patch(c.id, { type: ty })}
              />
              <Select<ColumnKind>
                className={"sel-block cass-ct-select cass-role-" + c.role}
                aria-label={t("cass.createTable.colRole")}
                mono={false}
                value={c.role}
                options={CASS_ROLES.map((r) => ({ value: r.id, label: t(r.labelKey) }))}
                onChange={(role) => patch(c.id, { role })}
              />
              {c.role === "clustering" ? (
                <button
                  className="cass-qb-allow on"
                  onClick={() => patch(c.id, { order: c.order === "ASC" ? "DESC" : "ASC" })}
                  title={t("cass.createTable.toggleOrder")}
                >
                  {c.order === "DESC" ? "↓ DESC" : "↑ ASC"}
                </button>
              ) : (
                <span className="cass-ct-dash">—</span>
              )}
              <button
                className="card-drop"
                onClick={() => remove(c.id)}
                disabled={cols.length === 1}
                title={t("cass.createTable.removeColumn")}
              >
                <Icon name="delete" size={14} />
              </button>
            </div>
          ))}
        </div>

        <div className="cass-row-field">
          <span className="form-section-label">{t("cass.createTable.comment")}</span>
          <input
            className="cass-field"
            value={comment}
            spellCheck={false}
            placeholder={t("cass.createTable.commentPh")}
            onChange={(e) => setComment(e.target.value)}
          />
        </div>

        <div className="cass-cql-wrap">
          <pre
            className="cass-cql-preview"
            dangerouslySetInnerHTML={{ __html: highlightSql(ddl) }}
          />
          <CopyButton
            className="cass-cql-copy"
            text={ddl}
            label={t("cass.createTable.copyCql")}
            size={13}
          />
        </div>
        {dupe ? (
          <p className="cass-create-note">{t("cass.createTable.exists", { name: clean })}</p>
        ) : !partition.length && validCols.length ? (
          <p className="cass-create-note">{t("cass.createTable.needPartition")}</p>
        ) : null}

        <div className="modal-actions">
          <div style={{ flex: 1 }} />
          <Btn variant="text" onClick={onClose}>
            {t("cass.createTable.cancel")}
          </Btn>
          <Btn variant="filled" icon="add" disabled={!ok || busy} onClick={() => void confirm()}>
            {t("cass.createTable.createBtn")}
          </Btn>
        </div>
      </div>
    </div>
  );
}

// ====================== Add index / materialized view ======================
export function CassAddIndexModal({
  handleId,
  ks,
  table,
  onClose,
  onDone,
}: {
  handleId: string;
  ks: string;
  table: TableDescriptor;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const [kind, setKind] = useState<"index" | "mv">("index");
  const allCols = table.columns.map((c) => c.name);
  const baseKey = keyColumns(table);

  const [target, setTarget] = useState(
    table.columns.find((c) => !baseKey.includes(c.name))?.name ?? allCols[0] ?? "",
  );
  const idxName = table.name + "_" + target + "_idx";
  const idxDupe = table.indexes.some((i) => i.name === idxName);

  const firstOther = allCols.find((c) => c !== table.partitionKey[0]) ?? allCols[0] ?? "";
  const [mvName, setMvName] = useState(table.name + "_by_" + firstOther);
  const [mvPk, setMvPk] = useState(firstOther);
  const cleanMvName = cassIdent(mvName);
  const mvDupe = table.mvs.some((m) => m.name === cleanMvName);
  const mvClustering = baseKey.filter((c) => c !== mvPk);

  const [busy, setBusy] = useState(false);
  const ok = kind === "index" ? !idxDupe && !!target : !!cleanMvName && !mvDupe;

  const idxDDL =
    "CREATE INDEX " + idxName + "\n  ON " + ks + "." + table.name + " (" + target + ");";
  const mvDDL =
    "CREATE MATERIALIZED VIEW " +
    ks +
    "." +
    (cleanMvName || "view_name") +
    " AS\n  SELECT * FROM " +
    ks +
    "." +
    table.name +
    "\n  WHERE " +
    [mvPk, ...mvClustering].map((c) => c + " IS NOT NULL").join(" AND ") +
    "\n  PRIMARY KEY ((" +
    mvPk +
    ")" +
    (mvClustering.length ? ", " + mvClustering.join(", ") : "") +
    ");";

  const confirm = async () => {
    if (!ok) return;
    setBusy(true);
    try {
      if (kind === "index") {
        await cassCreateIndex(handleId, ks, table.name, idxName, target);
        toast(t("cass.addIndex.indexApplied", { name: idxName }), "ok");
      } else {
        await cassCreateMv(handleId, ks, table.name, cleanMvName, [mvPk], mvClustering);
        toast(t("cass.addIndex.mvApplied", { name: cleanMvName }), "ok");
      }
      onDone();
    } catch (e) {
      toast(isAppErrorPayload(e) ? e.message : t("cass.addIndex.failed"), "err");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal cass-create-modal">
        <div className="modal-title">
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <Icon name="bolt" size={17} style={{ color: "var(--accent)" }} />{" "}
            {t("cass.addIndex.title")}
            <span className="structure-sub">{table.name}</span>
          </span>
          <IconBtn icon="close" onClick={onClose} title={t("cass.row.close")} />
        </div>

        <div className="seg" style={{ width: "100%" }}>
          <button
            className={"seg-btn" + (kind === "index" ? " active" : "")}
            style={{ flex: 1, justifyContent: "center" }}
            onClick={() => setKind("index")}
          >
            <Icon name="bolt" size={14} /> {t("cass.addIndex.secondaryIndex")}
          </button>
          <button
            className={"seg-btn" + (kind === "mv" ? " active" : "")}
            style={{ flex: 1, justifyContent: "center" }}
            onClick={() => setKind("mv")}
          >
            <Icon name="dvr" size={14} /> {t("cass.addIndex.materializedView")}
          </button>
        </div>

        {kind === "index" ? (
          <>
            <div className="cass-field">
              <span className="form-section-label">{t("cass.addIndex.indexColumn")}</span>
              <Select
                className="sel-block cass-ct-select"
                aria-label={t("cass.addIndex.indexColumn")}
                value={target}
                options={table.columns.map((c) => ({
                  value: c.name,
                  label: c.name + " · " + c.type,
                }))}
                onChange={setTarget}
              />
            </div>
            <p className="cass-create-note">
              <Icon name="info" size={13} /> {t("cass.addIndex.hint", { target: target || "…" })}
            </p>
          </>
        ) : (
          <>
            <div className="cass-row-field">
              <span className="form-section-label">{t("cass.addIndex.viewName")}</span>
              <input
                className="cass-field"
                value={mvName}
                spellCheck={false}
                onChange={(e) => setMvName(e.target.value)}
              />
            </div>
            <div className="cass-field">
              <span className="form-section-label">{t("cass.addIndex.newPartitionKey")}</span>
              <Select
                className="sel-block cass-ct-select"
                aria-label={t("cass.addIndex.newPartitionKey")}
                value={mvPk}
                options={allCols.map((c) => ({ value: c, label: c }))}
                onChange={setMvPk}
              />
            </div>
            <p className="cass-create-note">
              <Icon name="info" size={13} />{" "}
              {t("cass.addIndex.repartitions", { table: table.name, keys: mvPk })}
              {mvClustering.length
                ? ", carrying (" + mvClustering.join(", ") + ") as clustering"
                : ""}
              .
            </p>
          </>
        )}

        <div className="cass-cql-wrap">
          <pre
            className="cass-cql-preview"
            dangerouslySetInnerHTML={{ __html: highlightSql(kind === "index" ? idxDDL : mvDDL) }}
          />
          <CopyButton
            className="cass-cql-copy"
            text={kind === "index" ? idxDDL : mvDDL}
            label={t("cass.addIndex.copyCql")}
            size={13}
          />
        </div>

        <div className="modal-actions">
          <div style={{ flex: 1 }} />
          <Btn variant="text" onClick={onClose}>
            {t("cass.addIndex.cancel")}
          </Btn>
          <Btn variant="filled" icon="add" disabled={!ok || busy} onClick={() => void confirm()}>
            {kind === "index" ? t("cass.addIndex.createIndex") : t("cass.addIndex.createView")}
          </Btn>
        </div>
      </div>
    </div>
  );
}
