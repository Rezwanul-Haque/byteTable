// Typesense cluster dashboard (M30 Task 6, ported from typesense-shell.jsx
// TypesenseDashboard): head + stat cards, the Collections table with per-row
// search/schema actions, the Nodes table, and the Analytics panel.
//
// Deviation from the prototype, deliberate: analytics is optional server
// configuration (rules must be created and popular queries land in a destination
// collection the operator sets up), so on a default install there is nothing to
// show. The prototype's mock data always has analytics; here the panel renders
// an explicit "not configured" state rather than an empty chart.

import { useT } from "../../../../shared/i18n/useT";
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
  const t = useT();
  if (loading && !stats) return <TsLoading what="tsx.whatCluster" />;

  const healthy = stats?.healthy ?? nodes.every((n) => n.healthy);
  const topCount = analytics?.popularQueries[0]?.count ?? 0;

  return (
    <div className="rdash" data-screen-label="Typesense dashboard">
      <div className="rdash-head">
        <EngineBadge engine="typesense" size={22} />
        <h2>{t("tsx.dash.head")}</h2>
        <span className="structure-sub">
          {version ? t("tsx.dash.version", { version }) : ""}
          {t("tsx.dash.nodeCount", { count: nodes.length })} ·{" "}
          {healthy ? t("tsx.dash.healthy") : t("tsx.dash.degraded")}
        </span>
      </div>

      <div className="rdash-grid">
        <Stat
          label={t("tsx.dash.statCollections")}
          value={stats ? tsCount(stats.collections) : "—"}
        />
        <Stat label={t("tsx.dash.statDocuments")} value={stats ? tsCount(stats.documents) : "—"} />
        <Stat label={t("tsx.dash.statFields")} value={stats ? tsCount(stats.fields) : "—"} />
        <Stat label={t("tsx.dash.statNodes")} value={String(nodes.length)} />
        <Stat label={t("tsx.dash.statMemory")} value={tsBytes(stats?.memoryBytes)} />
      </div>

      <div className="rdash-panel" style={{ marginBottom: 16 }}>
        <h3>
          <Icon name="database" size={15} /> {t("tsx.dash.statCollections")}
        </h3>
        {!adminKey ? (
          <TsAdminRequired what="tsx.whatCollections" />
        ) : collections.length === 0 ? (
          <div className="ts-facet-none">{t("tsx.dash.noCollections")}</div>
        ) : (
          <div className="ts-tablewrap">
            <table className="structure-table" style={{ width: "100%" }}>
              <thead>
                <tr>
                  <th>{t("tsx.dash.thName")}</th>
                  <th>{t("tsx.dash.thDocuments")}</th>
                  <th>{t("tsx.dash.thFields")}</th>
                  <th>{t("tsx.dash.thFacets")}</th>
                  <th>{t("tsx.dash.thDefaultSort")}</th>
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
                        title={t("tsx.dash.searchTitle")}
                        onClick={() => onOpenSearch(c.name)}
                      >
                        <Icon name="search" size={13} />
                      </button>
                      <button
                        type="button"
                        className="ts-row-act"
                        title={t("tsx.dash.schemaTitle")}
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
          <Icon name="lan" size={15} /> {t("tsx.dash.statNodes")}
          <InfoHint text={t("tsx.dash.nodesHint")} />
        </h3>
        <div className="ts-tablewrap">
          <table className="structure-table" style={{ width: "100%" }}>
            <thead>
              <tr>
                <th>{t("tsx.dash.thHealth")}</th>
                <th>{t("tsx.dash.thHost")}</th>
                <th>{t("tsx.dash.thRaftState")}</th>
                <th>{t("tsx.dash.thLogIndex")}</th>
                {/* "Host CPU", not "CPU": Typesense reports no per-process CPU,
                    so this is the whole machine's — nodes sharing a host all
                    show the same number and a busy neighbour dominates it. */}
                {/* Per-NODE workload, from /stats.json — this is what
                    Typesense itself is doing, as opposed to Host CPU below. */}
                <th title={t("tsx.dash.thReqPerSecTitle")}>{t("tsx.dash.thReqPerSec")}</th>
                <th title={t("tsx.dash.thHostCpuTitle")}>{t("tsx.dash.thHostCpu")}</th>
                <th title={t("tsx.dash.thMemoryTitle")}>{t("tsx.dash.thMemory")}</th>
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
                      aria-label={n.healthy ? t("tsx.dash.healthy") : t("tsx.dash.unhealthy")}
                      title={n.healthy ? t("tsx.dash.healthy") : t("tsx.dash.unhealthy")}
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
                        ? t("tsx.dash.queuedWrites", { count: n.queuedWrites })
                        : t("tsx.dash.committedIndexTitle")
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
                        : t("tsx.dash.meanLatency", { ms: n.searchLatencyMs.toFixed(1) })
                    }
                  >
                    {n.requestsPerSecond === undefined ? "—" : n.requestsPerSecond.toFixed(1)}
                  </td>
                  <td className="cass-dash-num" title={t("tsx.dash.hostCpuTitle")}>
                    {n.cpuPercent === undefined ? "—" : n.cpuPercent.toFixed(0) + "%"}
                  </td>
                  <td
                    className="cass-dash-num"
                    title={
                      n.memoryBytes === undefined
                        ? undefined
                        : n.memoryTotalBytes
                          ? t("tsx.dash.residentMemoryTotal")
                          : t("tsx.dash.residentMemory")
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
          <Icon name="trending_up" size={15} /> {t("tsx.dash.analyticsHead")}
        </h3>
        {!analytics?.configured ? (
          <div className="ts-empty">
            <Icon name="trending_up" size={24} style={{ color: "var(--text-faint)" }} />
            <p>{t("tsx.dash.analyticsOff")}</p>
            <span className="ts-empty-hint">{t("tsx.dash.analyticsOffHint")}</span>
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
                  title={t("tsx.dash.runInPlayground", { query: p.query })}
                >
                  <span className="ts-an-bar">
                    <span
                      style={{
                        width: topCount > 0 ? Math.round((p.count / topCount) * 100) + "%" : "0%",
                      }}
                    />
                  </span>
                  <span className="ts-an-q">{p.query}</span>
                  <span className="ts-an-hits">{p.noHits ? t("tsx.dash.noHits") : ""}</span>
                  <span className="ts-an-cnt">{tsCount(p.count)}</span>
                </button>
              ))}
              {analytics.popularQueries.length === 0 ? (
                <div className="ts-facet-none">{t("tsx.dash.noQueriesYet")}</div>
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
