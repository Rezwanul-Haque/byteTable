// Redis Cluster slot math + health analysis (M36 §B1) — ported from the
// prototype's `redis-cluster.js`. The topology itself is no longer generated:
// it arrives from the server via `kvClusterTopology`. What lives here is the
// part that is pure computation and must be exactly right:
//
// - `crc16` is the real **CRC16-CCITT/XMODEM** (poly 0x1021, init 0) and
//   `keySlot(key) = crc16(hashTagOrKey) % 16384`. An approximation would make
//   every slot answer in the UI a lie, so it is verified against the values
//   real Redis produces: foo → 12182, bar → 5061, hello → 866,
//   123456789 → 12739.
// - `hashTag` implements the rule that makes multi-key commands legal in
//   cluster mode: only a **non-empty** `{…}` body hashes; otherwise the whole
//   key does.
// - `warnings()` turns the topology into the ordered, explained problem list
//   the health panel shows.

import type { ClusterNode, ClusterShard, ClusterTopology, SlotRange } from "./api";

/** Redis Cluster's fixed hash-slot space. */
export const SLOTS = 16384;

/** The shard band's colors, cycled when a cluster has more than three shards. */
export const SHARD_COLORS = ["#2dd4a7", "#56b6c2", "#c792ea", "#e2b340", "#e8845a", "#61afef"];

/** The color a shard is drawn in, everywhere it appears. */
export function shardColor(index: number): string {
  return SHARD_COLORS[index % SHARD_COLORS.length] ?? SHARD_COLORS[0]!;
}

/** CRC16-CCITT (XMODEM) lookup table — poly 0x1021, init 0. */
const CRC_TABLE = (() => {
  const table = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 8;
    for (let j = 0; j < 8; j++) {
      c = (c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff) as number;
    }
    table[i] = c;
  }
  return table;
})();

/** The exact CRC16 Redis uses for slot assignment. */
export function crc16(input: string): number {
  let crc = 0;
  for (let i = 0; i < input.length; i++) {
    crc = ((crc << 8) ^ (CRC_TABLE[((crc >> 8) ^ input.charCodeAt(i)) & 0xff] ?? 0)) & 0xffff;
  }
  return crc;
}

/**
 * The hash tag of a key: the substring between the first `{` and the next `}`,
 * **only when it is non-empty**. `{}` and a `{` with no `}` both fall back to
 * hashing the whole key. Returns `null` when no tag applies.
 */
export function hashTag(key: string): string | null {
  const start = key.indexOf("{");
  if (start < 0) return null;
  const end = key.indexOf("}", start + 1);
  if (end < 0 || end === start + 1) return null;
  return key.slice(start + 1, end);
}

/** The slot a key hashes into — the tag when there is one, else the whole key. */
export function keySlot(key: string): number {
  const tag = hashTag(key);
  return crc16(tag === null ? key : tag) % SLOTS;
}

/** How many slots a range covers. */
export function rangeSize(range: SlotRange): number {
  return range.to - range.from + 1;
}

/** Total slots a shard owns. */
export function shardSlots(shard: ClusterShard): number {
  return shard.slots.reduce((sum, r) => sum + rangeSize(r), 0);
}

/** The shard that owns a slot, or null when the slot is unassigned. */
export function ownerOf(shards: ClusterShard[], slot: number): ClusterShard | null {
  return shards.find((s) => s.slots.some((r) => slot >= r.from && slot <= r.to)) ?? null;
}

/** Every node in the cluster, masters first within each shard. */
export function allNodes(shards: ClusterShard[]): ClusterNode[] {
  return shards.flatMap((s) => [s.master, ...s.replicas]);
}

/** One contiguous window of slots currently moving between shards. */
export interface MigrationWindow {
  from: number;
  to: number;
  direction: string;
  peerId: string;
}

/**
 * Group Redis's per-slot migration markers into contiguous windows — one
 * reshard shows up as hundreds of adjacent slots, and the band draws a window,
 * not hundreds of hairlines.
 */
export function migrationWindows(topology: ClusterTopology): MigrationWindow[] {
  const windows: MigrationWindow[] = [];
  for (const m of [...topology.migrating].sort((a, b) => a.slot - b.slot)) {
    const last = windows[windows.length - 1];
    if (
      last &&
      last.direction === m.direction &&
      last.peerId === m.peerId &&
      m.slot === last.to + 1
    ) {
      last.to = m.slot;
    } else {
      windows.push({ from: m.slot, to: m.slot, direction: m.direction, peerId: m.peerId });
    }
  }
  return windows;
}

/** Is this slot inside a migration window? */
export function isMigrating(windows: MigrationWindow[], slot: number): boolean {
  return windows.some((w) => slot >= w.from && slot <= w.to);
}

/** Read one `CLUSTER INFO` field. */
export function clusterInfoField(topology: ClusterTopology, key: string): string | undefined {
  return topology.info.find((f) => f.field === key)?.value;
}

/** Read one numeric `CLUSTER INFO` field, defaulting when absent. */
export function clusterInfoNum(topology: ClusterTopology, key: string, fallback = 0): number {
  const raw = clusterInfoField(topology, key);
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** The keys the whole cluster holds, when the per-node probes measured them. */
export function totalKeys(shards: ClusterShard[]): number | null {
  const masters = shards.map((s) => s.master);
  if (masters.some((m) => m.keys === null)) return null;
  return masters.reduce((sum, m) => sum + (m.keys ?? 0), 0);
}

/** Total memory across masters (replicas hold the same data — never summed). */
export function masterMemory(shards: ClusterShard[]): number | null {
  const masters = shards.map((s) => s.master);
  if (masters.some((m) => m.memory === null)) return null;
  return masters.reduce((sum, m) => sum + (m.memory ?? 0), 0);
}

/** Ops/sec summed across every node that reported one. */
export function totalOps(shards: ClusterShard[]): number | null {
  const nodes = allNodes(shards);
  const measured = nodes.filter((n) => n.ops !== null);
  if (measured.length === 0) return null;
  return measured.reduce((sum, n) => sum + (n.ops ?? 0), 0);
}

/** A node that is not `online`. */
export function isUnhealthy(node: ClusterNode): boolean {
  return node.health !== "online";
}

/** One thing worth acting on, with what it means and what to do. */
export interface ClusterWarning {
  sev: "error" | "warn" | "note";
  icon: string;
  title: string;
  detail: string;
  fix: string;
}

/** Seconds of replica lag past which a promotion would lose meaningful writes. */
const LAG_WARN_SECONDS = 10;
/** Key-count spread across shards that suggests a hot hash tag. */
const SKEW_WARN = 0.3;

/**
 * The cluster's problems, in severity order: a node flagged PFAIL, a lagging
 * replica, a shard with no healthy replica, a migration in progress, and an
 * uneven key distribution. Each explains the mechanism, not just the symptom.
 */
export function warnings(topology: ClusterTopology): ClusterWarning[] {
  const out: ClusterWarning[] = [];
  const shards = topology.shards;
  const nodes = allNodes(shards);

  for (const n of nodes.filter(isUnhealthy)) {
    out.push({
      sev: "error",
      icon: "heart_broken",
      title: n.role + " " + n.host + " is flagged " + n.health,
      detail:
        "The node has missed enough gossip pings for other masters to mark it PFAIL. If a majority agrees it becomes FAIL and, for a master, a replica is promoted.",
      fix:
        "Check the node and its cluster bus port (" +
        n.busPort +
        ") before the failover threshold elapses.",
    });
  }

  for (const n of nodes) {
    if (n.role !== "replica" || (n.lagSeconds ?? 0) <= LAG_WARN_SECONDS) continue;
    out.push({
      sev: "warn",
      icon: "schedule",
      title: "Replica " + n.host + " is " + n.lagSeconds + "s behind",
      detail:
        "Promoting this replica now would lose up to " +
        n.lagSeconds +
        "s of writes. Reads served from it are stale by the same margin.",
      fix: "Check the replication link and network before relying on this replica for failover.",
    });
  }

  for (const s of shards) {
    if (s.replicas.length > 0 && s.replicas.some((r) => r.health === "online")) continue;
    const slots = shardSlots(s);
    out.push({
      sev: "error",
      icon: "warning",
      title: shardName(s) + " has no healthy replica",
      detail:
        "Losing its master takes " +
        slots.toLocaleString() +
        " slots offline. With cluster-require-full-coverage on, the whole cluster stops serving.",
      fix:
        s.replicas.length === 0
          ? "Attach a replica with CLUSTER REPLICATE."
          : "Recover the replica or attach a new one with CLUSTER REPLICATE.",
    });
  }

  for (const w of migrationWindows(topology)) {
    const count = w.to - w.from + 1;
    const peer = nodes.find((n) => n.id === w.peerId);
    const peerLabel = peer ? shardLabelForNode(shards, peer) : w.peerId.slice(0, 8) + "…";
    out.push({
      sev: "note",
      icon: "swap_horiz",
      title: count.toLocaleString() + (count === 1 ? " slot is migrating" : " slots are migrating"),
      detail:
        "Slots " +
        w.from +
        "–" +
        w.to +
        (w.direction === "migrating" ? " are moving to " : " are arriving from ") +
        peerLabel +
        ". Keys in flight answer with ASK redirects, which is normal.",
      fix: "Nothing to do — but avoid multi-key operations against these slots until it finishes.",
    });
  }

  // Key skew needs measured key counts; without them there is nothing to say.
  const counts = shards.map((s) => s.master.keys).filter((k): k is number => k !== null);
  if (counts.length === shards.length && counts.length > 1) {
    const max = Math.max(...counts);
    const min = Math.min(...counts);
    const spread = max > 0 ? (max - min) / max : 0;
    if (spread > SKEW_WARN) {
      out.push({
        sev: "warn",
        icon: "balance",
        title: "Key distribution is uneven",
        detail:
          shards
            .map((s) => shardName(s) + " " + (s.master.keys ?? 0).toLocaleString())
            .join(" · ") +
          " — a " +
          Math.round(spread * 100) +
          "% spread. Usually a hot hash tag pinning many keys to one slot.",
        fix: "Look for a hash tag used by too many keys before resharding.",
      });
    }
  }

  return out;
}

/** The shard's display name (`shard-1`, one-based like redis-cli output). */
export function shardName(shard: ClusterShard): string {
  return "shard-" + (shard.index + 1);
}

/** A node's shard name, for cross-referencing a migration peer. */
function shardLabelForNode(shards: ClusterShard[], node: ClusterNode): string {
  const shard = shards.find(
    (s) => s.master.id === node.id || s.replicas.some((r) => r.id === node.id),
  );
  return shard ? shardName(shard) : node.host;
}

/** The key→slot resolution the resolver panel shows. */
export interface KeyResolution {
  key: string;
  slot: number;
  /** The hash tag in play, or null when the whole key hashed. */
  tag: string | null;
  shard: ClusterShard | null;
  migrating: boolean;
}

export function resolveKey(
  topology: ClusterTopology,
  key: string,
  windows: MigrationWindow[],
): KeyResolution {
  const slot = keySlot(key);
  return {
    key,
    slot,
    tag: hashTag(key),
    shard: ownerOf(topology.shards, slot),
    migrating: isMigrating(windows, slot),
  };
}

/**
 * Sample keys for the resolver — deliberately including a tagged pair that
 * MUST collide and untagged keys that must not, so the CROSSSLOT rule can be
 * demonstrated rather than asserted. Their slots — 4403 · 4403 · 7870 · 13340 ·
 * 2479 — span all three shards of a standard even split, so a resolver whose
 * every example lands on shard-1 can't happen.
 */
export const SAMPLE_KEYS = [
  "cart:{user:5521}",
  "orders:{user:5521}",
  "metrics:cpu",
  "stream:events",
  "session:88f3c1",
];
