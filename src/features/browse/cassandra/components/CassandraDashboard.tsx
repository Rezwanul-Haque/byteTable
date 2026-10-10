// Cassandra keyspace dashboard (M19 §19.1, ported from cassandra-shell.jsx
// CassandraDashboard): stat tiles (Tables / Indexes / Materialized views /
// replication), a per-table panel, and a Cluster ring panel. Numeric cells are
// left-aligned and the two panels are spaced apart. No row counts (no cheap
// COUNT(*)). Reuses the shared .rdash-* dashboard chrome + .structure-table.

import { useT } from "../../../../shared/i18n/useT";
import { EngineBadge } from "../../../../shared/ui/EngineBadge";
import { Icon } from "../../../../shared/ui/Icon";
import {
  replicationLabel,
  type ClusterStatus,
  type KeyspaceInfo,
  type TableDescriptor,
} from "../api";

function Stat({ label, val }: { label: string; val: string | number }) {
  return (
    <div className="rdash-stat">
      <div className="rdash-stat-label">{label}</div>
      <div className="rdash-stat-value">{val}</div>
    </div>
  );
}

interface CassandraDashboardProps {
  ks: string;
  keyspace: KeyspaceInfo | null;
  tables: TableDescriptor[];
  cluster: ClusterStatus | null;
  loading: boolean;
  error: string | null;
}

export function CassandraDashboard({
  ks,
  keyspace,
  tables,
  cluster,
  loading,
  error,
}: CassandraDashboardProps) {
  const t = useT();
  const totalIdx = tables.reduce((a, t) => a + t.indexes.length, 0);
  const totalMv = tables.reduce((a, t) => a + t.mvs.length, 0);
  const rep = keyspace ? replicationLabel(keyspace.replication) : "—";

  if (error) {
    return (
      <div className="rdash">
        <div className="empty-state">
          <Icon name="error" size={28} />
          <p>{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="rdash">
      <div className="rdash-head">
        <EngineBadge engine="cassandra" size={22} />
        <h2>
          {ks} · {t("cass.dash.keyspaceSuffix")}
        </h2>
        {keyspace ? (
          <span className="structure-sub">
            {rep} · durable_writes {String(keyspace.durableWrites)}
          </span>
        ) : null}
      </div>
      <div className="rdash-grid">
        <Stat label={t("cass.dash.statTables")} val={tables.length} />
        <Stat label={t("cass.dash.statIndexes")} val={totalIdx} />
        <Stat label={t("cass.dash.statMvs")} val={totalMv} />
        <Stat label={t("cass.dash.statReplication")} val={keyspace?.replication.class ?? "—"} />
      </div>

      <div className="cass-dash-panels">
        <div className="rdash-panel">
          <h3>
            <Icon name="table_chart" size={15} /> {t("cass.dash.panelTables")}
          </h3>
          <table className="structure-table" style={{ width: "100%" }}>
            <thead>
              <tr>
                <th>{t("cass.dash.colName")}</th>
                <th>{t("cass.dash.colPartitionKey")}</th>
                <th>{t("cass.dash.colClustering")}</th>
                <th>{t("cass.dash.colColumns")}</th>
                <th>{t("cass.dash.colIndexes")}</th>
                <th>{t("cass.dash.colViews")}</th>
              </tr>
            </thead>
            <tbody>
              {tables.map((t) => (
                <tr key={t.name}>
                  <td className="st-name">{t.name}</td>
                  <td className="mg-mono cass-dash-key">{t.partitionKey.join(", ")}</td>
                  <td className="mg-mono cass-dash-key">
                    {t.clustering.length
                      ? t.clustering
                          .map((c) => c.name + " " + (c.order === "DESC" ? "↓" : "↑"))
                          .join(", ")
                      : "—"}
                  </td>
                  <td className="cass-dash-num">{t.columns.length}</td>
                  <td className="cass-dash-num">{t.indexes.length}</td>
                  <td className="cass-dash-num">{t.mvs.length}</td>
                </tr>
              ))}
              {!tables.length && !loading ? (
                <tr>
                  <td colSpan={6} style={{ color: "var(--text-faint)", padding: "12px" }}>
                    {t("cass.dash.noTables")}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <div className="rdash-panel">
          <h3>
            <Icon name="lan" size={15} /> {t("cass.dash.panelCluster")}
            {cluster ? " · " + cluster.cluster : ""}
          </h3>
          {cluster ? (
            <>
              <div className="cass-cluster-meta">
                <span>
                  {t("cass.dash.partitioner")}{" "}
                  <b>{cluster.partitioner.replace("org.apache.cassandra.dht.", "")}</b>
                </span>
                <span>
                  {t("cass.dash.snitch")} <b>{cluster.snitch ?? "—"}</b>
                </span>
              </div>
              <table className="structure-table cass-nodetool" style={{ width: "100%" }}>
                <thead>
                  <tr>
                    <th>{t("cass.dash.colStatus")}</th>
                    <th>{t("cass.dash.colAddress")}</th>
                    <th>{t("cass.dash.colLoad")}</th>
                    <th>{t("cass.dash.colOwns")}</th>
                    <th>{t("cass.dash.colDc")}</th>
                    <th>{t("cass.dash.colRack")}</th>
                    <th>{t("cass.dash.colTokens")}</th>
                  </tr>
                </thead>
                <tbody>
                  {cluster.nodes.map((n) => (
                    <tr key={n.address + (n.hostId ?? "")}>
                      <td>
                        <span className="cass-node-up">{n.status ?? "?"}</span>
                      </td>
                      <td className="mg-mono">{n.address}</td>
                      <td className="cass-dash-num">{n.load ?? "—"}</td>
                      <td className="cass-dash-num">{n.owns ?? "—"}</td>
                      <td>{n.dc}</td>
                      <td>{n.rack}</td>
                      <td className="cass-dash-num">{n.tokens ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <div style={{ color: "var(--text-faint)", padding: "8px 2px", fontSize: 12 }}>
              {loading ? t("cass.dash.loading") : t("cass.dash.unavailable")}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
