// Redis Cluster dashboard (M36 §B2) — ported from the prototype's
// `redis-cluster.jsx`, reading the real topology from `kvClusterTopology`
// instead of a generated one. Reuses the `.rdash-*` vocabulary of the
// standalone dashboard so the two read as the same product.
//
// The signature visual is the slot map: one proportional band across all 16384
// slots, a segment per shard, a hatched overlay for anything migrating, and
// mouse-move slot resolution. Clicking a segment focuses that shard.
//
// Two things this view is careful about, because getting them wrong teaches the
// wrong thing:
//
// - `cluster_state` and node health are **separate pills**. In Redis the state
//   stays `ok` while every slot is covered, so a warning icon next to `ok`
//   would be self-contradictory — the node issues get their own pill.
// - **Clients is per node.** `CLIENT LIST` never spans a cluster, so the stat
//   says so rather than summing something Redis would never report.

import { useEffect, useMemo, useState } from "react";

import { appErrorMessage } from "../../../../shared/api/error";
import { EngineBadge } from "../../../../shared/ui/EngineBadge";
import { Icon } from "../../../../shared/ui/Icon";
import { IconBtn } from "../../../../shared/ui/IconBtn";
import {
  kvClientList,
  kvClusterTopology,
  type ClusterNode,
  type ClusterShard,
  type ClusterTopology,
} from "../api";
import {
  SAMPLE_KEYS,
  SLOTS,
  allNodes,
  clusterInfoField,
  clusterInfoNum,
  hashTag,
  isUnhealthy,
  keySlot,
  masterMemory,
  migrationWindows,
  ownerOf,
  resolveKey,
  shardColor,
  shardName,
  shardSlots,
  totalKeys,
  totalOps,
  warnings,
  type MigrationWindow,
} from "../cluster";
import { humanBytes, humanNum } from "../helpers";
import "../../shared/dashboard.css";
import "./ClusterDashboard.css";

/** Health flag → how it is drawn and what it is called. */
const HEALTH: Record<string, { color: string; icon: string; label: string }> = {
  online: { color: "var(--accent)", icon: "check_circle", label: "online" },
  "fail?": { color: "var(--warn)", icon: "error", label: "PFAIL" },
  fail: { color: "var(--danger)", icon: "heart_broken", label: "FAIL" },
  handshake: { color: "var(--warn)", icon: "sync", label: "handshake" },
  noaddr: { color: "var(--danger)", icon: "link_off", label: "noaddr" },
};

/** An unmeasured counter reads as an em dash, never as zero. */
function measured(value: number | null, format: (n: number) => string): string {
  return value === null ? "—" : format(value);
}

// ---------------------------------------------------------------------------
// The 16384-slot band
// ---------------------------------------------------------------------------

/** One drawn segment: a shard's slot range, or an unassigned gap. */
interface BandSegment {
  from: number;
  to: number;
  shard: ClusterShard | null;
}

/** Walk the slot space once, emitting every owned range and every hole. */
function bandSegments(shards: ClusterShard[]): BandSegment[] {
  const owned = shards
    .flatMap((shard) => shard.slots.map((range) => ({ ...range, shard })))
    .sort((a, b) => a.from - b.from);
  const out: BandSegment[] = [];
  let cursor = 0;
  for (const range of owned) {
    if (range.from > cursor) out.push({ from: cursor, to: range.from - 1, shard: null });
    out.push({ from: range.from, to: range.to, shard: range.shard });
    cursor = range.to + 1;
  }
  if (cursor < SLOTS) out.push({ from: cursor, to: SLOTS - 1, shard: null });
  return out;
}

function ClusterSlotMap({
  shards,
  windows,
  active,
  onPickShard,
}: {
  shards: ClusterShard[];
  windows: MigrationWindow[];
  active: number | null;
  onPickShard: (index: number | null) => void;
}) {
  const [hover, setHover] = useState<{ slot: number; shard: ClusterShard | null } | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const segments = useMemo(() => bandSegments(shards), [shards]);

  return (
    <div className="cl-map">
      <div className="cl-map-head">
        <span className="cl-map-title">Hash slot coverage</span>
        <span className="cl-map-sub">
          {SLOTS.toLocaleString()} slots · every key hashes into exactly one
        </span>
        <button
          type="button"
          className="cl-help-btn"
          aria-expanded={helpOpen}
          onClick={() => setHelpOpen((open) => !open)}
        >
          <Icon name="help" size={12} />
          What is a slot?
        </button>
        <div style={{ flex: 1 }} />
        {hover ? (
          <span className="cl-map-hover">
            {"slot " +
              hover.slot.toLocaleString() +
              " → " +
              (hover.shard
                ? shardName(hover.shard) + " · " + hover.shard.master.host
                : "unassigned")}
          </span>
        ) : (
          <span className="cl-map-hover dim">hover the band to resolve a slot</span>
        )}
      </div>
      {/* Collapsed by default: the band is self-explanatory once you know what
          a slot is, and a permanent paragraph would nag everyone who does. */}
      {helpOpen ? (
        <div className="cl-help">
          <p>
            A <b>hash slot</b> is one of {SLOTS.toLocaleString()} numbered buckets that every key
            belongs to. Redis takes <code>CRC16(key) % {SLOTS}</code> and that number is the
            key&apos;s slot — fixed, computed the same way by every client and every node, and never
            stored anywhere.
          </p>
          <p>
            Each master then <b>owns a range of slots</b>, which is what the band above shows. A key
            lives on whichever node owns its slot, so any client can work out where a key belongs
            without asking anyone. Ask the wrong node and it replies{" "}
            <code>MOVED &lt;slot&gt; &lt;node&gt;</code>.
          </p>
          <p>
            The indirection is the point: keys are not hashed to <em>nodes</em>. Adding a node means
            handing it some slots — the keys in them move, everything else stays put. If keys hashed
            straight to nodes, changing the node count would relocate nearly the whole keyspace.
          </p>
          <p>
            All {SLOTS.toLocaleString()} must be owned by someone for the cluster to serve traffic —
            that is what <b>slots covered</b> means. A gap in the band is slots nobody serves, and
            with <code>cluster-require-full-coverage</code> on (the default) the whole cluster stops
            until it is filled.
          </p>
          <p className="cl-help-try">
            <Icon name="my_location" size={12} />
            Try it: type a key into <b>Which node owns a key</b> below, or hover the band to see
            which shard a slot belongs to.
          </p>
        </div>
      ) : null}
      <div
        className="cl-band"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const slot = Math.min(
            SLOTS - 1,
            Math.max(0, Math.round(((e.clientX - rect.left) / rect.width) * SLOTS)),
          );
          setHover({ slot, shard: ownerOf(shards, slot) });
        }}
      >
        {segments.map((seg) => {
          const width = ((seg.to - seg.from + 1) / SLOTS) * 100 + "%";
          if (!seg.shard) {
            return (
              <span
                key={"gap-" + seg.from}
                className="cl-seg cl-gap"
                style={{ width }}
                title={
                  "Slots " +
                  seg.from.toLocaleString() +
                  "–" +
                  seg.to.toLocaleString() +
                  " are unassigned — no node serves them"
                }
              />
            );
          }
          const shard = seg.shard;
          return (
            <button
              key={"seg-" + seg.from}
              type="button"
              className={"cl-seg" + (active === shard.index ? " on" : "")}
              style={{ width, background: shardColor(shard.index) }}
              onClick={() => onPickShard(active === shard.index ? null : shard.index)}
              title={
                shardName(shard) +
                " · slots " +
                seg.from.toLocaleString() +
                "–" +
                seg.to.toLocaleString()
              }
            >
              <span className="cl-seg-label">{shardName(shard)}</span>
              <span className="cl-seg-range">
                {seg.from.toLocaleString()}–{seg.to.toLocaleString()}
              </span>
            </button>
          );
        })}
        {windows.map((w) => (
          <span
            key={"mig-" + w.from}
            className="cl-mig"
            style={{
              left: (w.from / SLOTS) * 100 + "%",
              width: ((w.to - w.from + 1) / SLOTS) * 100 + "%",
            }}
            title={"Slots " + w.from + "–" + w.to + " are " + w.direction}
          />
        ))}
        {hover ? (
          <span className="cl-cursor" style={{ left: (hover.slot / SLOTS) * 100 + "%" }} />
        ) : null}
      </div>
      <div className="cl-map-legend">
        {shards.map((s) => (
          <span className="cl-lg" key={s.index}>
            <i style={{ background: shardColor(s.index) }} />
            {shardName(s) + " · " + ((shardSlots(s) / SLOTS) * 100).toFixed(1) + "%"}
          </span>
        ))}
        {windows.length ? (
          <span className="cl-lg">
            <i className="cl-lg-mig" />
            {"migrating " +
              windows.reduce((n, w) => n + (w.to - w.from + 1), 0).toLocaleString() +
              " slots"}
          </span>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shard cards
// ---------------------------------------------------------------------------

function ClusterNodeRow({ node, color }: { node: ClusterNode; color: string }) {
  const health = HEALTH[node.health] ?? HEALTH.online!;
  const lagging = node.role === "replica" && (node.lagSeconds ?? 0) > 10;
  return (
    <div className={"cl-node" + (isUnhealthy(node) ? " bad" : "")}>
      <Icon
        name={node.role === "master" ? "stars" : "content_copy"}
        size={13}
        style={{ color: node.role === "master" ? color : "var(--text-faint)" }}
      />
      <div className="cl-node-main">
        <div className="cl-node-line">
          <span className="cl-node-addr">
            {node.host}:{node.port}
          </span>
          <span className={"cl-role " + node.role}>{node.role}</span>
          {node.myself ? (
            <span className="cl-me" title="The node this workspace is attached to">
              me
            </span>
          ) : null}
          {lagging ? <span className="cl-lag">{node.lagSeconds}s behind</span> : null}
        </div>
        <div className="cl-node-meta">
          <span title={"Node id " + node.id}>{node.id.slice(0, 12)}…</span>
          {node.hostname ? <span>{node.hostname}</span> : null}
          <span>{measured(node.keys, (n) => humanNum(n) + " keys")}</span>
          <span>{measured(node.memory, humanBytes)}</span>
          <span>{measured(node.ops, (n) => humanNum(n) + " ops/s")}</span>
        </div>
      </div>
      <span className="cl-health" style={{ color: health.color }} title={"link " + node.link}>
        <Icon name={health.icon} size={12} />
        {health.label}
      </span>
    </div>
  );
}

function ClusterShardCard({
  shard,
  dimmed,
  onFocus,
}: {
  shard: ClusterShard;
  dimmed: boolean;
  onFocus: () => void;
}) {
  const healthy = shard.replicas.filter((r) => r.health === "online").length;
  const color = shardColor(shard.index);
  const first = shard.slots[0];
  const last = shard.slots[shard.slots.length - 1];
  return (
    <button type="button" className={"cl-shard" + (dimmed ? " dim" : "")} onClick={onFocus}>
      <div className="cl-shard-head">
        <span className="cl-shard-dot" style={{ background: color }} />
        <b>{shardName(shard)}</b>
        <span className="cl-shard-slots">
          {first && last
            ? "slots " + first.from.toLocaleString() + "–" + last.to.toLocaleString()
            : "no slots"}
        </span>
        <div style={{ flex: 1 }} />
        <span className={"cl-shard-rep" + (healthy === 0 ? " bad" : "")}>
          {healthy +
            "/" +
            shard.replicas.length +
            (shard.replicas.length === 1 ? " replica healthy" : " replicas healthy")}
        </span>
      </div>
      <ClusterNodeRow node={shard.master} color={color} />
      {shard.replicas.map((r) => (
        <ClusterNodeRow key={r.id} node={r} color={color} />
      ))}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Key → slot resolver
// ---------------------------------------------------------------------------

function ClusterKeyResolver({
  topology,
  windows,
}: {
  topology: ClusterTopology;
  windows: MigrationWindow[];
}) {
  const [key, setKey] = useState(SAMPLE_KEYS[0] ?? "");
  const resolved = useMemo(
    () => (key ? resolveKey(topology, key, windows) : null),
    [topology, key, windows],
  );
  // The contrast key: for a tagged key, the same tag under a different prefix
  // (which MUST collide); otherwise a fixed unrelated key — never the key
  // itself, which would trivially "match".
  const pair = useMemo(() => {
    if (!key) return null;
    const tag = hashTag(key);
    const other =
      tag !== null
        ? key.startsWith("orders")
          ? "cart:{" + tag + "}"
          : "orders:{" + tag + "}"
        : key === "metrics:cpu"
          ? "session:88f3c1"
          : "metrics:cpu";
    return { other, same: keySlot(key) === keySlot(other) };
  }, [key]);

  return (
    <div className="rdash-panel">
      <h3>
        <Icon name="my_location" size={15} /> Which node owns a key
      </h3>
      <div className="cl-res-in">
        <Icon name="vpn_key" size={14} style={{ color: "var(--text-faint)" }} />
        <input
          value={key}
          spellCheck="false"
          placeholder="key name"
          aria-label="Key to resolve"
          onChange={(e) => setKey(e.target.value)}
        />
      </div>
      <div className="cl-res-sugg">
        {SAMPLE_KEYS.map((k) => (
          <button type="button" key={k} className={k === key ? "on" : ""} onClick={() => setKey(k)}>
            {k}
          </button>
        ))}
      </div>
      {resolved ? (
        <>
          <div className="cl-res-out">
            <div className="cl-res-row">
              <span>Hashed input</span>
              <b>{resolved.tag === null ? resolved.key : "{" + resolved.tag + "}"}</b>
            </div>
            <div className="cl-res-row">
              <span>CRC16 mod 16384</span>
              <b>slot {resolved.slot.toLocaleString()}</b>
            </div>
            <div className="cl-res-row">
              <span>Owned by</span>
              <b style={{ color: resolved.shard ? shardColor(resolved.shard.index) : undefined }}>
                {resolved.shard
                  ? shardName(resolved.shard) + " · " + resolved.shard.master.host
                  : "nobody — the slot is unassigned"}
              </b>
            </div>
            {resolved.migrating ? (
              <div className="cl-res-row">
                <span>State</span>
                <b style={{ color: "var(--warn)" }}>slot is migrating — expect ASK</b>
              </div>
            ) : null}
          </div>
          {resolved.tag !== null ? (
            <div className="cl-res-note ok">
              <Icon name="link" size={12} />
              <span>
                The hash tag <code>{"{" + resolved.tag + "}"}</code> pins this key to the same slot
                as every other key sharing that tag — which is what makes multi-key commands legal.
              </span>
            </div>
          ) : (
            <div className="cl-res-note">
              <Icon name="info" size={12} />
              <span>
                No hash tag, so the whole key name hashes. Two such keys almost never share a slot,
                so <code>MGET</code> across them fails with <code>CROSSSLOT</code>.
              </span>
            </div>
          )}
          {pair ? (
            <div className={"cl-res-note " + (pair.same ? "ok" : "warn")}>
              <Icon name={pair.same ? "check" : "block"} size={12} />
              <span>
                <code>
                  MGET {resolved.key} {pair.other}
                </code>{" "}
                — {pair.same ? "same slot, allowed" : "different slots, CROSSSLOT error"}
              </span>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The dashboard
// ---------------------------------------------------------------------------

export function ClusterDashboard({
  handleId,
  topology,
  serverVersion,
  version,
  onOpenClients,
}: {
  handleId: string;
  topology: ClusterTopology;
  /** `INFO server`'s redis_version, for the subtitle. */
  serverVersion: string;
  /** Invalidation nonce — re-read the topology when it bumps. */
  version: number;
  onOpenClients: () => void;
}) {
  // Seeded with the topology the workspace already fetched, then kept fresh.
  const [live, setLive] = useState(topology);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [focus, setFocus] = useState<number | null>(null);
  const [rawOpen, setRawOpen] = useState(false);
  const [nodeClients, setNodeClients] = useState<number | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);

  useEffect(() => {
    setLive(topology);
  }, [topology]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void (async () => {
      try {
        const next = await kvClusterTopology(handleId);
        if (!alive || !next) return;
        setLive(next);
        setError(null);
      } catch (err) {
        if (alive) setError(appErrorMessage(err, "Could not read the cluster topology."));
      } finally {
        if (alive) setLoading(false);
      }
      // CLIENT LIST is per node — this is the node we are attached to, never a
      // cluster-wide sum, so it is fetched separately from the topology.
      const clients = await kvClientList(handleId).catch(() => null);
      if (alive && clients) setNodeClients(clients.length);
    })();
    return () => {
      alive = false;
    };
  }, [handleId, version, refreshNonce]);

  const shards = live.shards;
  const nodes = allNodes(shards);
  const windows = useMemo(() => migrationWindows(live), [live]);
  const warns = useMemo(() => warnings(live), [live]);

  const state = clusterInfoField(live, "cluster_state") ?? "unknown";
  const slotsOk = clusterInfoNum(live, "cluster_slots_ok");
  const slotsAssigned = clusterInfoNum(live, "cluster_slots_assigned");
  const knownNodes = clusterInfoNum(live, "cluster_known_nodes", nodes.length);
  const currentEpoch = clusterInfoNum(live, "cluster_current_epoch");
  const gossipSent = clusterInfoNum(live, "cluster_stats_messages_sent");

  const masters = nodes.filter((n) => n.role === "master").length;
  const replicas = nodes.filter((n) => n.role === "replica").length;
  const bad = nodes.filter(isUnhealthy).length;
  const errs = warns.filter((w) => w.sev === "error").length;

  return (
    <div className="rdash cl-dash" data-screen-label="Redis cluster dashboard">
      <div className="rdash-head">
        <EngineBadge engine="redis" size={22} />
        <h2>Cluster dashboard</h2>
        <span className="rdash-sub">
          {"cluster · " +
            shards.length +
            (shards.length === 1 ? " shard · Redis " : " shards · Redis ") +
            serverVersion}
        </span>
        <div className="rdash-head-spacer" />
        {/* Two pills, deliberately: cluster_state stays `ok` while every slot is
            covered, so node health is a separate statement. */}
        <span className={"cl-state " + (state === "ok" ? "ok" : "bad")}>
          <Icon name={state === "ok" ? "check_circle" : "error"} size={13} />
          {"cluster_state: " + state}
        </span>
        {errs ? (
          <span
            className="cl-state warn"
            title="All slots are served, but a node or replica needs attention"
          >
            <Icon name="warning" size={13} />
            <span>{errs + (errs === 1 ? " node issue" : " node issues")}</span>
          </span>
        ) : null}
        <IconBtn
          icon="sync"
          title="Re-read CLUSTER NODES"
          disabled={loading}
          onClick={() => setRefreshNonce((n) => n + 1)}
        />
      </div>

      {error ? <div className="rdash-error">{error}</div> : null}

      <div className="rdash-grid cl-grid">
        <div className="rdash-stat">
          <div className="rdash-stat-label">Slots covered</div>
          <div className="rdash-stat-value">
            {((slotsOk / SLOTS) * 100).toFixed(0)}
            {"%"}
          </div>
          <div className="rdash-stat-sub">
            {slotsAssigned.toLocaleString() + " of " + SLOTS.toLocaleString() + " assigned"}
          </div>
        </div>
        <div className="rdash-stat">
          <div className="rdash-stat-label">Shards</div>
          <div className="rdash-stat-value">{shards.length}</div>
          <div className="rdash-stat-sub">{masters + " masters · " + replicas + " replicas"}</div>
        </div>
        <div className="rdash-stat">
          <div className="rdash-stat-label">Keys</div>
          <div className="rdash-stat-value">{measured(totalKeys(shards), humanNum)}</div>
          <div className="rdash-stat-sub">
            {live.nodeStatsMeasured ? "across all shards · db0 only" : "nodes not reachable"}
          </div>
        </div>
        <div className="rdash-stat">
          <div className="rdash-stat-label">Memory</div>
          <div className="rdash-stat-value">{measured(masterMemory(shards), humanBytes)}</div>
          <div className="rdash-stat-sub">masters, replicas excluded</div>
        </div>
        <div className="rdash-stat">
          <div className="rdash-stat-label">Ops/sec</div>
          <div className="rdash-stat-value">{measured(totalOps(shards), humanNum)}</div>
          <div className="rdash-stat-sub">summed across nodes</div>
        </div>
        <div className={"rdash-stat" + (bad ? " cl-stat-bad" : "")}>
          <div className="rdash-stat-label">Nodes</div>
          <div className="rdash-stat-value">
            {knownNodes}
            {bad ? <em className="cl-bad-n"> {bad} PFAIL</em> : null}
          </div>
          <div className="rdash-stat-sub">epoch {currentEpoch}</div>
        </div>
        <button
          type="button"
          className="rdash-stat rdash-stat-btn"
          onClick={onOpenClients}
          title="Review connected clients on this node"
        >
          <div className="rdash-stat-label">Clients</div>
          <div className="rdash-stat-value">{nodeClients ?? "—"}</div>
          <div className="rdash-stat-go">
            <Icon name="monitor_heart" size={12} />
            On this node
          </div>
        </button>
        <div className="rdash-stat">
          <div className="rdash-stat-label">Gossip</div>
          <div className="rdash-stat-value">{humanNum(gossipSent)}</div>
          <div className="rdash-stat-sub">bus messages sent</div>
        </div>
      </div>

      <ClusterSlotMap shards={shards} windows={windows} active={focus} onPickShard={setFocus} />

      <div className="cl-shards">
        {shards.map((s) => (
          <ClusterShardCard
            key={s.master.id}
            shard={s}
            dimmed={focus !== null && focus !== s.index}
            onFocus={() => setFocus(focus === s.index ? null : s.index)}
          />
        ))}
      </div>

      <div className="rdash-cols cl-cols">
        <div className="rdash-panel">
          <h3>
            <Icon name="rule" size={15} /> Cluster health
          </h3>
          {warns.length === 0 ? (
            <div className="cl-clean">
              <Icon name="verified" size={18} style={{ color: "var(--accent)" }} />
              <span>Every slot is covered, every node is online, and no replica is lagging.</span>
            </div>
          ) : (
            warns.map((w, i) => (
              <div className={"cl-warn " + w.sev} key={w.title + i}>
                <Icon name={w.icon} size={14} />
                <div>
                  <div className="cl-warn-t">{w.title}</div>
                  <div className="cl-warn-d">{w.detail}</div>
                  <div className="cl-warn-f">
                    <Icon name="lightbulb" size={11} />
                    {w.fix}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
        <ClusterKeyResolver topology={live} windows={windows} />
      </div>

      <div className="cl-raw">
        <button type="button" className="cl-raw-btn" onClick={() => setRawOpen((v) => !v)}>
          <Icon name={rawOpen ? "expand_less" : "expand_more"} size={14} />
          CLUSTER NODES · CLUSTER INFO
        </button>
        {rawOpen ? (
          <div className="cl-raw-body">
            <pre className="cl-raw-pre">{live.nodesText}</pre>
            <pre className="cl-raw-pre">
              {live.info.map((f) => f.field + ":" + f.value).join("\n")}
            </pre>
          </div>
        ) : null}
      </div>
    </div>
  );
}
