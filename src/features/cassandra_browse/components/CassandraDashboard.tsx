// Cassandra keyspace dashboard (M19 §19.1, ported from cassandra-shell.jsx
// CassandraDashboard): stat tiles (Tables / Indexes / Materialized views /
// replication), a per-table panel, and a Cluster ring panel. Numeric cells are
// left-aligned and the two panels are spaced apart. No row counts (no cheap
// COUNT(*)). Reuses the shared .rdash-* dashboard chrome + .structure-table.

import { EngineBadge } from "../../../shared/ui/EngineBadge";
import { Icon } from "../../../shared/ui/Icon";
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
        <h2>{ks} · keyspace</h2>
        {keyspace ? (
          <span className="structure-sub">
            {rep} · durable_writes {String(keyspace.durableWrites)}
          </span>
        ) : null}
      </div>
      <div className="rdash-grid">
        <Stat label="Tables" val={tables.length} />
        <Stat label="Indexes" val={totalIdx} />
        <Stat label="Mat. views" val={totalMv} />
        <Stat label="Replication" val={keyspace?.replication.class ?? "—"} />
      </div>

      <div className="cass-dash-panels">
        <div className="rdash-panel">
          <h3>
            <Icon name="table_chart" size={15} /> Tables
          </h3>
          <table className="structure-table" style={{ width: "100%" }}>
            <thead>
              <tr>
                <th>Name</th>
                <th>Partition key</th>
                <th>Clustering</th>
                <th>Columns</th>
                <th>Indexes</th>
                <th>Views</th>
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
                    No tables in this keyspace.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <div className="rdash-panel">
          <h3>
            <Icon name="lan" size={15} /> Cluster{cluster ? " · " + cluster.cluster : ""}
          </h3>
          {cluster ? (
            <>
              <div className="cass-cluster-meta">
                <span>
                  Partitioner: <b>{cluster.partitioner.replace("org.apache.cassandra.dht.", "")}</b>
                </span>
                <span>
                  Snitch: <b>{cluster.snitch ?? "—"}</b>
                </span>
              </div>
              <table className="structure-table cass-nodetool" style={{ width: "100%" }}>
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Address</th>
                    <th>Load</th>
                    <th>Owns</th>
                    <th>DC</th>
                    <th>Rack</th>
                    <th>Tokens</th>
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
              {loading ? "Loading cluster…" : "Cluster status unavailable."}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
