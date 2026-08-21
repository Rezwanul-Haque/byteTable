// Redis Cluster slot math (M36 §B1/§B4).
//
// The four `keySlot` values below are the ones a real Redis server produces.
// They are the whole point of this file: an approximate CRC16 would make every
// slot answer in the UI — the resolver, the band's hover readout, the
// CROSSSLOT verdict — quietly wrong rather than visibly broken.

import { describe, expect, it } from "vitest";

import {
  SAMPLE_KEYS,
  SLOTS,
  crc16,
  hashTag,
  isMigrating,
  keySlot,
  migrationWindows,
  ownerOf,
  shardSlots,
  warnings,
} from "./cluster";
import type { ClusterNode, ClusterShard, ClusterTopology, SlotMigration } from "./api";

// --- fixtures ---------------------------------------------------------------

function node(over: Partial<ClusterNode> = {}): ClusterNode {
  return {
    id: "0".repeat(40),
    host: "10.0.2.11",
    port: 6379,
    busPort: 16379,
    hostname: null,
    role: "master",
    masterId: null,
    myself: false,
    health: "online",
    link: "connected",
    epoch: 12,
    slots: [],
    offset: null,
    lagBytes: null,
    lagSeconds: null,
    keys: null,
    memory: null,
    ops: null,
    clients: null,
    ...over,
  };
}

/** An even three-shard split, the standard `--cluster-replicas 1` layout. */
function topology(over: Partial<ClusterTopology> = {}): ClusterTopology {
  const ranges = [
    { from: 0, to: 5460 },
    { from: 5461, to: 10922 },
    { from: 10923, to: 16383 },
  ];
  const shards: ClusterShard[] = ranges.map((range, index) => {
    const master = node({
      id: "m" + index + "0".repeat(38),
      host: "10.0.2.1" + index,
      slots: [range],
      keys: 20000,
    });
    return {
      index,
      master,
      replicas: [
        node({
          id: "r" + index + "0".repeat(38),
          host: "10.0.2.2" + index,
          role: "replica",
          masterId: master.id,
          keys: 20000,
        }),
      ],
      slots: [range],
    };
  });
  return {
    info: [
      { field: "cluster_state", value: "ok" },
      { field: "cluster_slots_assigned", value: "16384" },
    ],
    nodesText: "",
    shards,
    migrating: [],
    nodeStatsMeasured: true,
    ...over,
  };
}

// --- slot math --------------------------------------------------------------

describe("keySlot — verified against real Redis", () => {
  it.each([
    ["foo", 12182],
    ["bar", 5061],
    ["hello", 866],
    ["123456789", 12739],
  ])("%s hashes to slot %i", (key, slot) => {
    expect(keySlot(key)).toBe(slot);
  });

  it("crc16 is CRC16-CCITT/XMODEM (init 0)", () => {
    // The XMODEM check value: "123456789" → 0x31C3.
    expect(crc16("123456789")).toBe(0x31c3);
    expect(crc16("")).toBe(0);
  });

  it("never leaves the slot space", () => {
    for (const key of ["", "a", "{}", "x".repeat(400), "unicode:π:ключ"]) {
      const slot = keySlot(key);
      expect(slot).toBeGreaterThanOrEqual(0);
      expect(slot).toBeLessThan(SLOTS);
    }
  });
});

describe("hashTag — the rule that makes multi-key commands legal", () => {
  it("hashes only the tag when there is a non-empty one", () => {
    expect(hashTag("cart:{user:5521}")).toBe("user:5521");
    expect(keySlot("cart:{user:5521}")).toBe(keySlot("{user:5521}"));
    expect(keySlot("cart:{user:5521}")).toBe(keySlot("user:5521"));
  });

  it("collides two keys sharing a tag, and does not collide two untagged keys", () => {
    expect(keySlot("cart:{user:5521}")).toBe(keySlot("orders:{user:5521}"));
    expect(keySlot("metrics:cpu")).not.toBe(keySlot("session:88f3c1"));
  });

  it("falls back to the whole key for an empty tag or an unclosed brace", () => {
    expect(hashTag("a{}b")).toBeNull();
    expect(keySlot("a{}b")).toBe(crc16("a{}b") % SLOTS);
    expect(hashTag("a{bc")).toBeNull();
    expect(keySlot("a{bc")).toBe(crc16("a{bc") % SLOTS);
    expect(hashTag("plain")).toBeNull();
  });

  it("uses the first { and the NEXT }, not the last", () => {
    expect(hashTag("k:{a}{b}")).toBe("a");
    expect(hashTag("{a{b}")).toBe("a{b");
  });

  it("ships sample keys that span every shard and include a colliding pair", () => {
    const t = topology();
    const owners = SAMPLE_KEYS.map((k) => ownerOf(t.shards, keySlot(k))?.index);
    expect(owners).not.toContain(undefined);
    // Every shard is demonstrated — a resolver whose examples all land on
    // shard-1 would show nothing.
    expect(new Set(owners).size).toBe(t.shards.length);
    // …and the tagged pair collides.
    expect(keySlot(SAMPLE_KEYS[0]!)).toBe(keySlot(SAMPLE_KEYS[1]!));
  });
});

describe("ownerOf / shardSlots", () => {
  it("resolves both ends of every range and the boundary between two", () => {
    const t = topology();
    expect(ownerOf(t.shards, 0)?.index).toBe(0);
    expect(ownerOf(t.shards, 5460)?.index).toBe(0);
    expect(ownerOf(t.shards, 5461)?.index).toBe(1);
    expect(ownerOf(t.shards, 16383)?.index).toBe(2);
  });

  it("returns null for a slot nobody owns", () => {
    const t = topology();
    t.shards[1]!.slots = [];
    expect(ownerOf(t.shards, 6000)).toBeNull();
  });

  it("sums to the full slot space, so the band's widths sum to 100%", () => {
    const t = topology();
    expect(t.shards.reduce((sum, s) => sum + shardSlots(s), 0)).toBe(SLOTS);
  });
});

describe("migrationWindows", () => {
  const mig = (slot: number, peerId = "peer", direction = "migrating"): SlotMigration => ({
    slot,
    direction,
    peerId,
  });

  it("groups a contiguous run into one window", () => {
    const t = topology({ migrating: [mig(102), mig(100), mig(101)] });
    expect(migrationWindows(t)).toEqual([
      { from: 100, to: 102, direction: "migrating", peerId: "peer" },
    ]);
  });

  it("splits on a gap, a different peer, or a different direction", () => {
    const t = topology({
      migrating: [mig(100), mig(101), mig(103), mig(104, "other"), mig(105, "other", "importing")],
    });
    expect(migrationWindows(t).map((w) => [w.from, w.to])).toEqual([
      [100, 101],
      [103, 103],
      [104, 104],
      [105, 105],
    ]);
  });

  it("reports which slots are in flight", () => {
    const windows = migrationWindows(topology({ migrating: [mig(500), mig(501)] }));
    expect(isMigrating(windows, 500)).toBe(true);
    expect(isMigrating(windows, 501)).toBe(true);
    expect(isMigrating(windows, 502)).toBe(false);
  });
});

// --- health analysis --------------------------------------------------------

describe("warnings", () => {
  it("says nothing about a healthy, evenly-loaded cluster", () => {
    expect(warnings(topology())).toEqual([]);
  });

  it("explains a PFAIL node in terms of the gossip → FAIL → promotion path", () => {
    const t = topology();
    t.shards[2]!.replicas[0]!.health = "fail?";
    const w = warnings(t);
    const pfail = w.find((x) => x.title.includes("flagged fail?"));
    expect(pfail?.sev).toBe("error");
    expect(pfail?.detail).toContain("PFAIL");
    expect(pfail?.fix).toContain("16379");
  });

  it("states the write loss when a replica lags", () => {
    const t = topology();
    t.shards[0]!.replicas[0]!.lagSeconds = 37;
    const lag = warnings(t).find((x) => x.title.includes("behind"));
    expect(lag?.sev).toBe("warn");
    expect(lag?.detail).toContain("37s of writes");
  });

  it("ignores lag under the threshold", () => {
    const t = topology();
    t.shards[0]!.replicas[0]!.lagSeconds = 3;
    expect(warnings(t)).toEqual([]);
  });

  it("calls out a shard left with no healthy replica, with the slots at risk", () => {
    const t = topology();
    t.shards[1]!.replicas[0]!.health = "fail?";
    const bare = warnings(t).find((x) => x.title.includes("no healthy replica"));
    expect(bare?.sev).toBe("error");
    expect(bare?.title).toContain("shard-2");
    expect(bare?.detail).toContain("5,462 slots");
    expect(bare?.detail).toContain("cluster-require-full-coverage");
  });

  it("treats a shard with zero replicas as replica-less too", () => {
    const t = topology();
    t.shards[0]!.replicas = [];
    const bare = warnings(t).find((x) => x.title.includes("no healthy replica"));
    expect(bare?.fix).toContain("CLUSTER REPLICATE");
  });

  it("notes a migration as normal, not as a fault", () => {
    const t = topology({
      migrating: Array.from({ length: 500 }, (_, i) => ({
        slot: 10923 + i,
        direction: "migrating",
        peerId: "m0" + "0".repeat(38),
      })),
    });
    const note = warnings(t).find((x) => x.title.includes("migrating"));
    expect(note?.sev).toBe("note");
    expect(note?.title).toContain("500 slots");
    expect(note?.detail).toContain("ASK redirects");
    expect(note?.detail).toContain("shard-1");
  });

  it("flags a >30% key spread as a probable hot hash tag", () => {
    const t = topology();
    t.shards[0]!.master.keys = 100000;
    t.shards[1]!.master.keys = 20000;
    const skew = warnings(t).find((x) => x.title.includes("uneven"));
    expect(skew?.sev).toBe("warn");
    expect(skew?.detail).toContain("80% spread");
    expect(skew?.fix).toContain("hash tag");
  });

  it("says nothing about skew when the key counts were never measured", () => {
    const t = topology({ nodeStatsMeasured: false });
    for (const s of t.shards) s.master.keys = null;
    expect(warnings(t).filter((w) => w.title.includes("uneven"))).toEqual([]);
  });

  it("orders errors before warnings before notes", () => {
    const t = topology({
      migrating: [{ slot: 1, direction: "migrating", peerId: "m0" + "0".repeat(38) }],
    });
    t.shards[2]!.replicas[0]!.health = "fail?";
    t.shards[0]!.replicas[0]!.lagSeconds = 30;
    const severities = warnings(t).map((w) => w.sev);
    expect(severities.indexOf("error")).toBeLessThan(severities.indexOf("warn"));
    expect(severities.indexOf("warn")).toBeLessThan(severities.indexOf("note"));
  });
});
