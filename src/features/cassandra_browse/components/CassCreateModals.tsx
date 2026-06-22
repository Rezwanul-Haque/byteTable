// Cassandra create flows (M19 §19.6, ported from cassandra-create.jsx):
// CassCreateKeyspaceModal (replication strategy + RF/DC, durable writes, CQL
// preview), CassCreateTableModal (columns + type + kind, partition/clustering
// selection with order, live CQL preview), and CassAddIndexModal (the sidebar's
// secondary-index / materialized-view add — reuses the §19.4 DDL backend).

import { useState } from "react";

import { isAppErrorPayload } from "../../../shared/api/error";
import { Btn } from "../../../shared/ui/Btn";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { useToast } from "../../../shared/ui/toastContext";
import {
  cassCreateIndex,
  cassCreateKeyspace,
  cassCreateMv,
  cassCreateTable,
  keyColumns,
  type ColumnKind,
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
const CASS_ROLES: { id: ColumnKind; label: string }[] = [
  { id: "partition_key", label: "Partition" },
  { id: "clustering", label: "Clustering" },
  { id: "regular", label: "Regular" },
  { id: "static", label: "Static" },
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
  const toast = useToast();
  const [name, setName] = useState("");
  const [strategy, setStrategy] = useState<"NetworkTopologyStrategy" | "SimpleStrategy">(
    "NetworkTopologyStrategy",
  );
  const [rf, setRf] = useState(3);
  const [durable, setDurable] = useState(true);
  const [busy, setBusy] = useState(false);

  const clean = cassIdent(name);
  const dupe = !!clean && existing.includes(clean);
  const ok = !!clean && !dupe && rf >= 1;

  const repObj =
    strategy === "SimpleStrategy"
      ? "{'class': 'SimpleStrategy', 'replication_factor': " + rf + "}"
      : "{'class': 'NetworkTopologyStrategy', 'dc1': " + rf + "}";
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
          : { class: "NetworkTopologyStrategy", dc1: rf };
      await cassCreateKeyspace(handleId, clean, replication, durable);
      toast("CREATE KEYSPACE " + clean + " — applied", "ok");
      onCreated(clean);
    } catch (e) {
      toast(isAppErrorPayload(e) ? e.message : "Create keyspace failed", "err");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal cass-create-modal">
        <div className="modal-title">
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <Icon name="hub" size={17} style={{ color: "var(--accent)" }} /> Create keyspace
          </span>
          <IconBtn icon="close" onClick={onClose} title="Close" />
        </div>

        <div className="cass-row-field">
          <span className="form-section-label">Keyspace name</span>
          <input
            className="cass-field"
            value={name}
            autoFocus
            spellCheck={false}
            placeholder="byteshop"
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div className="cass-field-grid">
          <div className="cass-field">
            <span className="form-section-label">Replication strategy</span>
            <div className="seg" style={{ width: "100%" }}>
              {(["NetworkTopologyStrategy", "SimpleStrategy"] as const).map((s) => (
                <button
                  key={s}
                  className={"seg-btn" + (strategy === s ? " active" : "")}
                  style={{ flex: 1, justifyContent: "center" }}
                  onClick={() => setStrategy(s)}
                >
                  {s.replace("Strategy", "")}
                </button>
              ))}
            </div>
          </div>
          <div className="cass-field" style={{ maxWidth: 140 }}>
            <span className="form-section-label">
              {strategy === "SimpleStrategy" ? "Replication factor" : "dc1 replicas"}
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
          <span>
            <b>durable_writes</b> — log writes to the commit log (recommended)
          </span>
        </button>

        <pre className="cass-cql-preview">{ddl}</pre>
        {dupe ? <p className="cass-create-note">Keyspace “{clean}” already exists</p> : null}

        <div className="modal-actions">
          <div style={{ flex: 1 }} />
          <Btn variant="text" onClick={onClose}>
            Cancel
          </Btn>
          <Btn variant="filled" icon="add" disabled={!ok || busy} onClick={() => void confirm()}>
            Create keyspace
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
      toast("CREATE TABLE " + clean + " — applied", "ok");
      onCreated(clean);
    } catch (e) {
      toast(isAppErrorPayload(e) ? e.message : "Create table failed", "err");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal cass-create-modal cass-create-table">
        <div className="modal-title">
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <Icon name="add" size={17} style={{ color: "var(--accent)" }} /> Create table
            <span className="structure-sub">in {ks}</span>
          </span>
          <IconBtn icon="close" onClick={onClose} title="Close" />
        </div>

        <div className="cass-row-field">
          <span className="form-section-label">Table name</span>
          <input
            className="cass-field"
            value={name}
            autoFocus
            spellCheck={false}
            placeholder="orders_by_user"
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span className="form-section-label">Columns</span>
          <button className="rail-add" onClick={addCol} title="Add column">
            <Icon name="add" size={15} />
          </button>
        </div>
        <div>
          <div className="cass-ct-row cass-ct-head">
            <span>Name</span>
            <span>Type</span>
            <span>Role</span>
            <span>Order</span>
            <span />
          </div>
          {cols.map((c) => (
            <div className="cass-ct-row" key={c.id}>
              <input
                className="cass-field"
                value={c.name}
                placeholder="column"
                spellCheck={false}
                onChange={(e) => patch(c.id, { name: e.target.value })}
              />
              <select
                className="filter-select"
                value={c.type}
                onChange={(e) => patch(c.id, { type: e.target.value })}
              >
                {[...new Set([c.type, ...CASS_CQL_TYPES])].map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <select
                className={"filter-select cass-role-" + c.role}
                value={c.role}
                onChange={(e) => patch(c.id, { role: e.target.value as ColumnKind })}
              >
                {CASS_ROLES.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </select>
              {c.role === "clustering" ? (
                <button
                  className="cass-qb-allow on"
                  onClick={() => patch(c.id, { order: c.order === "ASC" ? "DESC" : "ASC" })}
                  title="Toggle clustering order"
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
                title="Remove column"
              >
                <Icon name="delete" size={14} />
              </button>
            </div>
          ))}
        </div>

        <div className="cass-row-field">
          <span className="form-section-label">Comment</span>
          <input
            className="cass-field"
            value={comment}
            spellCheck={false}
            placeholder="A user's orders, newest first"
            onChange={(e) => setComment(e.target.value)}
          />
        </div>

        <pre className="cass-cql-preview">{ddl}</pre>
        {dupe ? (
          <p className="cass-create-note">Table “{clean}” already exists</p>
        ) : !partition.length && validCols.length ? (
          <p className="cass-create-note">Mark at least one column as the partition key</p>
        ) : null}

        <div className="modal-actions">
          <div style={{ flex: 1 }} />
          <Btn variant="text" onClick={onClose}>
            Cancel
          </Btn>
          <Btn variant="filled" icon="add" disabled={!ok || busy} onClick={() => void confirm()}>
            Create table
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
        toast("CREATE INDEX " + idxName + " — applied", "ok");
      } else {
        await cassCreateMv(handleId, ks, table.name, cleanMvName, [mvPk], mvClustering);
        toast("CREATE MATERIALIZED VIEW " + cleanMvName + " — applied", "ok");
      }
      onDone();
    } catch (e) {
      toast(isAppErrorPayload(e) ? e.message : "Create failed", "err");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal cass-create-modal">
        <div className="modal-title">
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <Icon name="bolt" size={17} style={{ color: "var(--accent)" }} /> Add to
            <span className="structure-sub">{table.name}</span>
          </span>
          <IconBtn icon="close" onClick={onClose} title="Close" />
        </div>

        <div className="seg" style={{ width: "100%" }}>
          <button
            className={"seg-btn" + (kind === "index" ? " active" : "")}
            style={{ flex: 1, justifyContent: "center" }}
            onClick={() => setKind("index")}
          >
            <Icon name="bolt" size={14} /> Secondary index
          </button>
          <button
            className={"seg-btn" + (kind === "mv" ? " active" : "")}
            style={{ flex: 1, justifyContent: "center" }}
            onClick={() => setKind("mv")}
          >
            <Icon name="dvr" size={14} /> Materialized view
          </button>
        </div>

        {kind === "index" ? (
          <>
            <div className="cass-field">
              <span className="form-section-label">Index column</span>
              <select
                className="filter-select"
                style={{ width: "100%" }}
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              >
                {table.columns.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name} · {c.type}
                  </option>
                ))}
              </select>
            </div>
            <p className="cass-create-note">
              <Icon name="info" size={13} /> A 2i lets you filter by <code>{target}</code> without{" "}
              <code>ALLOW FILTERING</code>. Best for low-cardinality columns.
            </p>
          </>
        ) : (
          <>
            <div className="cass-row-field">
              <span className="form-section-label">View name</span>
              <input
                className="cass-field"
                value={mvName}
                spellCheck={false}
                onChange={(e) => setMvName(e.target.value)}
              />
            </div>
            <div className="cass-field">
              <span className="form-section-label">New partition key</span>
              <select
                className="filter-select"
                style={{ width: "100%" }}
                value={mvPk}
                onChange={(e) => setMvPk(e.target.value)}
              >
                {allCols.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <p className="cass-create-note">
              <Icon name="info" size={13} /> Re-partitions <code>{table.name}</code> by{" "}
              <code>{mvPk}</code>
              {mvClustering.length
                ? ", carrying (" + mvClustering.join(", ") + ") as clustering"
                : ""}
              .
            </p>
          </>
        )}

        <pre className="cass-cql-preview">{kind === "index" ? idxDDL : mvDDL}</pre>

        <div className="modal-actions">
          <div style={{ flex: 1 }} />
          <Btn variant="text" onClick={onClose}>
            Cancel
          </Btn>
          <Btn variant="filled" icon="add" disabled={!ok || busy} onClick={() => void confirm()}>
            {kind === "index" ? "Create index" : "Create view"}
          </Btn>
        </div>
      </div>
    </div>
  );
}
