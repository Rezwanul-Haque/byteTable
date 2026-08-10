// Typesense cluster dashboard (M30 Task 6, ported from typesense-shell.jsx
// TypesenseDashboard): head + stat cards, the Collections table with per-row
// search/schema actions, the Nodes table, and the Analytics panel.
//
// Deviation from the prototype, deliberate: analytics is optional server
// configuration (rules must be created and popular queries land in a destination
// collection the operator sets up), so on a default install there is nothing to
// show. The prototype's mock data always has analytics; here the panel renders
// an explicit "not configured" state rather than an empty chart.

import { Icon } from "../../../../shared/ui/Icon";
import { EngineBadge } from "../../../../shared/ui/EngineBadge";
import { InfoHint } from "../../../../shared/ui/InfoHint";
import type { AnalyticsOverview, ClusterStats, CollectionDescriptor, NodeInfo } from "../api";
import { tsBytes, tsCount } from "../format";
import { TsAdminRequired, TsLoading } from "./TsBits";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rdash-stat">
      <div className="rdash-stat-label">{label}</div>
      <div className="rdash-stat-value">{value}</div>
    </div>
  );
}

interface TypesenseDashboardProps {
  version: string;
  stats: ClusterStats | null;
  nodes: NodeInfo[];
  collections: CollectionDescriptor[];
  analytics: AnalyticsOverview | null;
  adminKey: boolean;
  loading: boolean;
  onOpenSearch: (coll: string, seedQuery?: string) => void;
  onOpenSchema: (coll: string) => void;
}

export function TypesenseDashboard({
  version,
  stats,
  nodes,
  collections,
  analytics,
  adminKey,
  loading,
  onOpenSearch,
  onOpenSchema,
}: TypesenseDashboardProps) {
  if (loading && !stats) return <TsLoading what="the cluster" />;

  const healthy = stats?.healthy ?? nodes.every((n) => n.healthy);
  const topCount = analytics?.popularQueries[0]?.count ?? 0;

  return (
    <div className="rdash" data-screen-label="Typesense dashboard">
      <div className="rdash-head">
        <EngineBadge engine="typesense" size={22} />
        <h2>search cluster</h2>
        <span className="structure-sub">
          {version ? "Typesense " + version + " · " : ""}
          {nodes.length} {nodes.length === 1 ? "node" : "nodes"} ·{" "}
          {healthy ? "healthy" : "degraded"}
        </span>
      </div>

      <div className="rdash-grid">
        <Stat label="Collections" value={stats ? tsCount(stats.collections) : "—"} />
        <Stat label="Documents" value={stats ? tsCount(stats.documents) : "—"} />
        <Stat label="Fields" value={stats ? tsCount(stats.fields) : "—"} />
        <Stat label="Nodes" value={String(nodes.length)} />
        <Stat label="Memory (leader)" value={tsBytes(stats?.memoryBytes)} />
      </div>

      <div className="rdash-panel" style={{ marginBottom: 16 }}>
        <h3>
          <Icon name="database" size={15} /> Collections
        </h3>
        {!adminKey ? (
          <TsAdminRequired what="the full collection list" />
        ) : collections.length === 0 ? (
          <div className="ts-facet-none">this cluster has no collections yet</div>
        ) : (
          <div className="ts-tablewrap">
            <table className="structure-table" style={{ width: "100%" }}>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Documents</th>
                  <th>Fields</th>
                  <th>Facets</th>
                  <th>default_sorting_field</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {collections.map((c) => (
                  <tr key={c.name}>
                    <td className="st-name">{c.name}</td>
                    <td className="cass-dash-num">{tsCount(c.numDocuments)}</td>
                    <td className="cass-dash-num">{c.fields.length}</td>
                    <td className="mg-mono cass-dash-key">
                      {c.fields
                        .filter((f) => f.facet)
                        .map((f) => f.name)
                        .join(", ") || "—"}
                    </td>
                    <td className="mg-mono cass-dash-key">{c.defaultSortingField ?? "—"}</td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <button
                        type="button"
                        className="ts-row-act"
                        title="Search playground"
                        onClick={() => onOpenSearch(c.name)}
                      >
                        <Icon name="search" size={13} />
                      </button>
                      <button
                        type="button"
                        className="ts-row-act"
                        title="Schema"
                        onClick={() => onOpenSchema(c.name)}
                      >
                        <Icon name="schema" size={13} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="rdash-panel" style={{ marginBottom: 16 }}>
        <h3>
          <Icon name="lan" size={15} /> Nodes
          <InfoHint text="Seeing only one node? Add the others to this connection\u2019s \u201cOther nodes\u201d field. Typesense has no cluster-membership endpoint \u2014 not even on the leader \u2014 so a client can only display the peers it is configured with, exactly as its own clients require." />
        </h3>
        <div className="ts-tablewrap">
          <table className="structure-table" style={{ width: "100%" }}>
            <thead>
              <tr>
                <th>Health</th>
                <th>Host</th>
                <th>Raft state</th>
                <th>Log index</th>
                {/* "Host CPU", not "CPU": Typesense reports no per-process CPU,
                    so this is the whole machine's — nodes sharing a host all
                    show the same number and a busy neighbour dominates it. */}
                {/* Per-NODE workload, from /stats.json — this is what
                    Typesense itself is doing, as opposed to Host CPU below. */}
                <th title="Requests per second served by this node, with its mean search latency. Scoped to this Typesense process, unlike Host CPU.">
                  Req/s
                </th>
                <th title="CPU of the whole machine this node runs on. Typesense exposes no per-process CPU (no typesense_cpu_* metric exists in v29 or v30), so nodes sharing a host all report the same value and other workloads on that host count towards it.">
                  Host CPU
                </th>
                <th title="Typesense's own resident memory, against the total memory visible to the node.">
                  Memory
                </th>
              </tr>
            </thead>
            <tbody>
              {nodes.map((n) => (
                <tr key={n.host}>
                  <td>
                    {/* Colour is the only signal in this column, so the dot
                        carries the word too — for screen readers and for anyone
                        who cannot separate the green from the red. */}
                    <span
                      className={"ts-health" + (n.healthy ? "" : " bad")}
                      role="img"
                      aria-label={n.healthy ? "healthy" : "unhealthy"}
                      title={n.healthy ? "healthy" : "unhealthy"}
                    />
                  </td>
                  <td className="mg-mono">{n.host}</td>
                  <td>
                    <span className={"ts-raft" + (n.state === "LEADER" ? " leader" : "")}>
                      {n.state}
                    </span>
                  </td>
                  <td
                    className="cass-dash-num"
                    title={
                      n.queuedWrites
                        ? n.queuedWrites + " write(s) queued — this node is behind on its log"
                        : "Raft committed_index; every healthy node reports the same value"
                    }
                  >
                    {n.committedIndex === undefined ? "—" : tsCount(n.committedIndex)}
                    {n.queuedWrites ? " (+" + n.queuedWrites + ")" : ""}
                  </td>
                  <td
                    className="cass-dash-num"
                    title={
                      n.searchLatencyMs === undefined
                        ? undefined
                        : "mean search latency " + n.searchLatencyMs.toFixed(1) + " ms"
                    }
                  >
                    {n.requestsPerSecond === undefined ? "—" : n.requestsPerSecond.toFixed(1)}
                  </td>
                  <td
                    className="cass-dash-num"
                    title="Whole-machine CPU, not this process's — see the column header."
                  >
                    {n.cpuPercent === undefined ? "—" : n.cpuPercent.toFixed(0) + "%"}
                  </td>
                  <td
                    className="cass-dash-num"
                    title={
                      n.memoryBytes === undefined
                        ? undefined
                        : "Typesense resident memory" +
                          (n.memoryTotalBytes ? ", against the machine's total" : "")
                    }
                  >
                    {tsBytes(n.memoryBytes)}
                    {n.memoryTotalBytes ? " / " + tsBytes(n.memoryTotalBytes) : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rdash-panel">
        <h3>
          <Icon name="trending_up" size={15} /> Analytics · popular &amp; no-hit queries
        </h3>
        {!analytics?.configured ? (
          <div className="ts-empty">
            <Icon name="trending_up" size={24} style={{ color: "var(--text-faint)" }} />
            <p>Analytics is not configured on this cluster.</p>
            <span className="ts-empty-hint">
              Typesense records popular and no-hit queries only once you create an analytics rule
              pointing at a destination collection. Until then there is nothing to chart.
            </span>
          </div>
        ) : (
          <>
            <div className="ts-analytics">
              {analytics.popularQueries.map((p) => (
                <button
                  key={p.query}
                  type="button"
                  className={"ts-an-row" + (p.noHits ? " zero" : "")}
                  onClick={() => onOpenSearch(collections[0]?.name ?? "", p.query)}
                  title={"Run “" + p.query + "” in the playground"}
                >
                  <span className="ts-an-bar">
                    <span
                      style={{
                        width: topCount > 0 ? Math.round((p.count / topCount) * 100) + "%" : "0%",
                      }}
                    />
                  </span>
                  <span className="ts-an-q">{p.query}</span>
                  <span className="ts-an-hits">{p.noHits ? "no hits" : ""}</span>
                  <span className="ts-an-cnt">{tsCount(p.count)}</span>
                </button>
              ))}
              {analytics.popularQueries.length === 0 ? (
                <div className="ts-facet-none">
                  rules are configured, but no queries have been recorded yet
                </div>
              ) : null}
            </div>
            <div className="ts-an-rules">
              {analytics.rules.map((r) => (
                <span key={r.name} className="ts-an-rule">
                  <b>{r.name}</b> {r.type}
                </span>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
