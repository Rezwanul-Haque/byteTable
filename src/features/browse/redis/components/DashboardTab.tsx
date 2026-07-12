// Keyspace dashboard (REDIS_SPEC §8) — the default, non-closable Redis tab.
// Ported from the prototype `RedisDashboard` in `redis.jsx`. A stat grid (from
// `kvServerStats` — the INFO counters) plus two panels: keys-by-type (a colored
// horizontal bar per type) and keys-per-database (db0–db15 mini-cells from
// `kvKeyspace`, current highlighted, empty dimmed, clicking switches db).
//
// Stats source: `kvServerStats(handleId)` parses INFO once per fetch. Refetched
// on mount, on the workspace `version` nonce (a write / sidebar refresh), and
// via a manual refresh button.
//
// Per-type counts: there is no direct "count by type" command. We derive the
// distribution by a **bounded SCAN sample** of the current db (the `keyType`
// rides on every `KeyEntry`), tallying types over up to SAMPLE_MAX keys. This
// is a sample of the *current* db, not an exact whole-keyspace census — the
// limitation is surfaced as a caption on the panel. (A real census would need
// an OBJECT-ENCODING sweep / a server-side aggregate the port does not expose.)

import { useCallback, useEffect, useState } from "react";

import { appErrorMessage } from "../../../../shared/api/error";
import { EngineBadge } from "../../../../shared/ui/EngineBadge";
import { Icon } from "../../../../shared/ui/Icon";
import { IconBtn } from "../../../../shared/ui/IconBtn";
import type { KvDbInfo, KvServerInfo } from "../../../connections/api";
import { kvScan, kvServerStats, type KeyType, type KvServerStats } from "../api";
import { humanBytes, humanNum, REDIS_TYPES, REDIS_TYPE_ORDER } from "../helpers";
import { RedisTypeBadge } from "./RedisTypeBadge";
import "../../shared/dashboard.css";

/** Total keys to sample (bounded) when deriving the per-type distribution. */
const SAMPLE_MAX = 500;
const SAMPLE_COUNT = 200;
const DB_COUNT = 16;

interface DashboardTabProps {
  handleId: string;
  /** The selected db (sample source + the highlighted cell). */
  dbIndex: number;
  /** Per-db key counts from the open-result overview. */
  databases: KvDbInfo[];
  /** Server identity for the header. */
  serverInfo: KvServerInfo | undefined;
  /** Invalidation nonce — refetch stats + resample when it bumps. */
  version: number;
  /** Switch the workspace db (clicking a per-db cell). */
  onSelectDb: (db: number) => void;
}

type TypeCounts = Partial<Record<KeyType, number>>;

export function DashboardTab({
  handleId,
  dbIndex,
  databases,
  serverInfo,
  version,
  onSelectDb,
}: DashboardTabProps) {
  const [stats, setStats] = useState<KvServerStats | null>(null);
  const [typeCounts, setTypeCounts] = useState<TypeCounts>({});
  const [sampled, setSampled] = useState(0);
  const [sampleTruncated, setSampleTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Per-db counts (db0–db15) from the overview.
  const dbCounts = new Array<number>(DB_COUNT).fill(0);
  for (const d of databases) {
    if (d.index >= 0 && d.index < DB_COUNT) dbCounts[d.index] = d.keyCount;
  }
  const totalKeys = dbCounts.reduce((a, b) => a + b, 0);

  const load = useCallback(
    async (signal: { live: boolean }) => {
      setLoading(true);
      try {
        const s = await kvServerStats(handleId);
        if (!signal.live) return;
        setStats(s);

        // Bounded SCAN sample of the current db → per-type tally.
        const counts: TypeCounts = {};
        let scanned = 0;
        let cursor = "0";
        let truncated = false;
        do {
          const page = await kvScan(handleId, dbIndex, {
            pattern: "*",
            cursor,
            count: SAMPLE_COUNT,
          });
          if (!signal.live) return;
          for (const k of page.keys) {
            counts[k.keyType] = (counts[k.keyType] ?? 0) + 1;
          }
          scanned += page.keys.length;
          cursor = page.cursor;
          if (scanned >= SAMPLE_MAX && cursor !== "0") {
            truncated = true;
            break;
          }
        } while (cursor !== "0");

        if (!signal.live) return;
        setTypeCounts(counts);
        setSampled(scanned);
        setSampleTruncated(truncated);
        setError(null);
      } catch (err) {
        if (!signal.live) return;
        setError(appErrorMessage(err, "Could not load dashboard stats."));
      } finally {
        if (signal.live) setLoading(false);
      }
    },
    [handleId, dbIndex],
  );

  // Manual refresh (the header `sync` button) — a local nonce folded into the
  // fetch effect alongside the workspace `version`.
  const [refreshNonce, setRefreshNonce] = useState(0);
  const refresh = () => setRefreshNonce((n) => n + 1);

  useEffect(() => {
    const signal = { live: true };
    void load(signal);
    return () => {
      signal.live = false;
    };
    // `version` = write / sidebar-refresh nonce; `refreshNonce` = manual refresh.
  }, [load, version, refreshNonce]);

  const hits = stats?.keyspaceHits ?? 0;
  const misses = stats?.keyspaceMisses ?? 0;
  const hitRate = hits + misses > 0 ? Math.round((hits / (hits + misses)) * 100) : 0;
  const maxTypeCount = Math.max(1, ...Object.values(typeCounts).map((n) => n ?? 0));
  const typesWithKeys = REDIS_TYPE_ORDER.filter((t) => (typeCounts[t] ?? 0) > 0);

  const stat = (label: string, value: React.ReactNode, sub?: string) => (
    <div className="rdash-stat">
      <div className="rdash-stat-label">{label}</div>
      <div className="rdash-stat-value">{value}</div>
      {sub ? <div className="rdash-stat-sub">{sub}</div> : null}
    </div>
  );

  return (
    <div className="rdash" data-screen-label="Redis keyspace dashboard">
      <div className="rdash-head">
        <EngineBadge engine="redis" size={22} />
        <h2>Keyspace dashboard</h2>
        {serverInfo ? (
          <span className="rdash-sub">
            {serverInfo.mode} · {serverInfo.role} · Redis {serverInfo.serverVersion}
          </span>
        ) : null}
        <div className="rdash-head-spacer" />
        <IconBtn icon="sync" title="Refresh stats" onClick={refresh} disabled={loading} />
      </div>

      {error ? <div className="rdash-error">{error}</div> : null}

      <div className="rdash-grid">
        {stat("Total keys", humanNum(totalKeys), "across 16 databases")}
        {stat(
          "Memory used",
          stats ? humanBytes(stats.usedMemory) : "—",
          stats && stats.maxmemory > 0 ? "of " + humanBytes(stats.maxmemory) : "no limit set",
        )}
        {stat(
          "Hit rate",
          stats ? hitRate + "%" : "—",
          humanNum(hits) + " hits · " + humanNum(misses) + " misses",
        )}
        {stat("Ops/sec", stats ? humanNum(stats.instantaneousOpsPerSec) : "—", "instantaneous")}
        {stat("Clients", stats ? stats.connectedClients : "—", "connected")}
        {stat("Uptime", stats ? stats.uptimeInDays + "d" : "—", "since last restart")}
        {stat("Expired", stats ? humanNum(stats.expiredKeys) : "—", "keys total")}
        {stat("Evicted", stats ? humanNum(stats.evictedKeys) : "—", "keys total")}
      </div>

      <div className="rdash-cols">
        <div className="rdash-panel">
          <h3>
            <Icon name="data_usage" size={15} /> Keys by type
          </h3>
          {typesWithKeys.length === 0 ? (
            <div className="rdash-panel-empty">
              {loading ? "Sampling…" : "No keys sampled in db" + dbIndex + "."}
            </div>
          ) : (
            typesWithKeys.map((t) => {
              const n = typeCounts[t] ?? 0;
              const meta = REDIS_TYPES[t];
              return (
                <div className="rdash-bar-row" key={t}>
                  <RedisTypeBadge type={t} size={16} />
                  <span className="rdash-bar-label">{meta.label}</span>
                  <span className="rdash-bar-track">
                    <span
                      className="rdash-bar-fill"
                      style={{ width: (n / maxTypeCount) * 100 + "%", background: meta.color }}
                    />
                  </span>
                  <span className="rdash-bar-n">{n}</span>
                </div>
              );
            })
          )}
          <div className="rdash-panel-caption">
            {sampleTruncated
              ? "Sampled " + sampled + "+ keys in db" + dbIndex + " (distribution is an estimate)."
              : sampled > 0
                ? "From " + sampled + " keys in db" + dbIndex + "."
                : null}
          </div>
        </div>

        <div className="rdash-panel">
          <h3>
            <Icon name="storage" size={15} /> Keys per database
          </h3>
          <div className="rdash-dbgrid">
            {dbCounts.map((c, i) => (
              <button
                key={i}
                type="button"
                className={
                  "rdash-db" + (c === 0 ? " empty" : "") + (i === dbIndex ? " active" : "")
                }
                onClick={() => onSelectDb(i)}
                title={"Switch to db" + i + " · " + c + " keys"}
              >
                <span className="rdash-db-name">db{i}</span>
                <span className="rdash-db-count">{c}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
