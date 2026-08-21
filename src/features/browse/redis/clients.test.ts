// The connected-clients model (M36 §A1/§A4).
//
// What matters here is that the numbers mean what the labels say: the risk
// rules fire on the four real conditions and never on your own connection, the
// stats strip and the dashboard derive from one `breakdown`, and the kill
// filters match locally the same way the server will — the "N clients match"
// count is a promise about what `CLIENT KILL` is about to do.

import { describe, expect, it } from "vitest";

import {
  INFO_FIELDS,
  KILL_FILTERS,
  breakdown,
  clientField,
  clientRisk,
  flagSummary,
  humanAge,
  humanClientMem,
  humanNet,
  infoLine,
  isBlocked,
  isStale,
} from "./clients";
import type { KvClient } from "./api";

/** A parsed client, with `fields`/`raw` kept consistent with the typed values. */
function client(over: Partial<KvClient> = {}): KvClient {
  const base: KvClient = {
    id: 6,
    addr: "10.0.4.18:52310",
    laddr: "10.0.1.5:6379",
    name: "web-1",
    age: 42,
    idle: 0,
    flags: "N",
    db: 0,
    sub: 0,
    psub: 0,
    multi: -1,
    watch: 0,
    qbuf: 26,
    oll: 0,
    omem: 0,
    totMem: 20512,
    cmd: "get",
    user: "default",
    clientType: "normal",
    isSelf: false,
    fields: [],
    raw: "",
    ...over,
  };
  const pairs: [string, string][] = [
    ["id", String(base.id)],
    ["addr", base.addr],
    ["laddr", base.laddr],
    ["name", base.name],
    ["age", String(base.age)],
    ["idle", String(base.idle)],
    ["flags", base.flags],
    ["db", String(base.db)],
    ["multi", String(base.multi)],
    ["tot-mem", String(base.totMem)],
    ["cmd", base.cmd],
    ["user", base.user],
  ];
  return {
    ...base,
    fields: pairs.map(([field, value]) => ({ field, value })),
    raw: pairs.map(([f, v]) => f + "=" + v).join(" "),
  };
}

describe("infoLine", () => {
  it("returns the server's own line verbatim — that is what CLIENT INFO printed", () => {
    const c = client();
    expect(infoLine(c)).toBe(c.raw);
  });

  it("reconstructs in Redis field order when a row somehow has no raw line", () => {
    const c = { ...client(), raw: "" };
    const line = infoLine(c);
    const order = line.split(" ").map((token) => token.split("=")[0]);
    expect(order).toEqual([...INFO_FIELDS]);
    expect(line).toContain("id=6");
    expect(line).toContain("addr=10.0.4.18:52310");
    // A field the server never reported is present but empty, not dropped.
    expect(line).toContain("lib-name=");
  });

  it("reads one reported field by name", () => {
    expect(clientField(client(), "user")).toBe("default");
    expect(clientField(client(), "resp")).toBeUndefined();
  });
});

describe("clientRisk", () => {
  it("flags a normal client idle past five minutes as a leaked pool connection", () => {
    const risk = clientRisk(client({ idle: 900 }));
    expect(risk?.sev).toBe("warn");
    expect(risk?.text).toContain("leaked pool connection");
    expect(risk?.text).toContain("15m");
  });

  it("does not flag a pub/sub or blocked client for idling — they never accrue it", () => {
    expect(clientRisk(client({ idle: 900, clientType: "pubsub", flags: "P" }))).toBeNull();
    expect(clientRisk(client({ idle: 900, clientType: "replica", flags: "S" }))).toBeNull();
  });

  it("flags a filling output buffer as a slow consumer", () => {
    const risk = clientRisk(client({ oll: 9 }));
    expect(risk?.sev).toBe("warn");
    expect(risk?.text).toContain("slow consumer");
  });

  it("flags an open MULTI left idle, because it holds WATCHed keys", () => {
    expect(clientRisk(client({ multi: 4, idle: 45 }))?.text).toContain("WATCHed keys");
    // Still inside the window — an active transaction is not a problem.
    expect(clientRisk(client({ multi: 4, idle: 5 }))).toBeNull();
  });

  it("notes an expensive connection without calling it a fault", () => {
    const risk = clientRisk(client({ totMem: 60000 }));
    expect(risk?.sev).toBe("note");
    expect(risk?.text).toContain("58.6 KB");
  });

  it("never flags your own connection", () => {
    expect(clientRisk(client({ isSelf: true, idle: 9000, oll: 40, totMem: 900000 }))).toBeNull();
  });

  it("leaves a healthy connection unmarked", () => {
    expect(clientRisk(client())).toBeNull();
  });
});

describe("breakdown", () => {
  const list = [
    client({ id: 1, isSelf: true }),
    client({ id: 2, idle: 600 }),
    client({ id: 3, idle: 900 }),
    client({ id: 4, clientType: "pubsub", flags: "P" }),
    client({ id: 5, clientType: "replica", flags: "S" }),
    client({ id: 6, flags: "b", cmd: "blpop" }),
    // A `master` connection (this node replicating from another) counts with
    // the replica-link group rather than as a normal application client.
    client({ id: 7, clientType: "master", flags: "M" }),
  ];

  it("splits by type, counts blocked and stale, and sums client memory", () => {
    const b = breakdown(list);
    expect(b.total).toBe(7);
    // Blocked clients are still `normal` — `b` is a state, not a class.
    expect(b.normal).toBe(4);
    expect(b.pubsub).toBe(1);
    expect(b.replica).toBe(2);
    expect(b.blocked).toBe(1);
    expect(b.stale).toBe(2);
    expect(b.mem).toBe(7 * 20512);
  });

  it("has an empty shape for an empty list, not NaN", () => {
    expect(breakdown([])).toEqual({
      total: 0,
      normal: 0,
      pubsub: 0,
      replica: 0,
      blocked: 0,
      stale: 0,
      mem: 0,
    });
  });

  it("agrees with the per-row predicates the table filters by", () => {
    expect(list.filter(isStale)).toHaveLength(breakdown(list).stale);
    expect(list.filter(isBlocked)).toHaveLength(breakdown(list).blocked);
  });
});

describe("KILL_FILTERS", () => {
  const list = [
    client({ id: 11, addr: "10.0.4.18:52310", user: "app_rw", age: 30 }),
    client({ id: 12, addr: "10.0.4.22:52311", user: "app_ro", age: 4000, clientType: "pubsub" }),
    client({ id: 13, addr: "10.0.4.31:52312", user: "app_rw", age: 90000 }),
  ];
  const filter = (id: string) => KILL_FILTERS.find((f) => f.id === id)!;
  const matched = (id: string, value: string) => list.filter((c) => filter(id).match(c, value));

  it("renders the exact command it will run", () => {
    expect(filter("id").cmd("11")).toBe("CLIENT KILL ID 11");
    expect(filter("type").cmd("pubsub")).toBe("CLIENT KILL TYPE pubsub");
    expect(filter("maxage").cmd("3600")).toBe("CLIENT KILL MAXAGE 3600");
  });

  it("matches by id, address, local address, type and ACL user", () => {
    expect(matched("id", "11").map((c) => c.id)).toEqual([11]);
    expect(matched("addr", "10.0.4.22:52311").map((c) => c.id)).toEqual([12]);
    expect(matched("laddr", "10.0.1.5:6379")).toHaveLength(3);
    expect(matched("type", "pubsub").map((c) => c.id)).toEqual([12]);
    expect(matched("user", "app_rw").map((c) => c.id)).toEqual([11, 13]);
  });

  it("matches MAXAGE inclusively, the way Redis does", () => {
    expect(matched("maxage", "3600").map((c) => c.id)).toEqual([12, 13]);
    expect(matched("maxage", "30").map((c) => c.id)).toEqual([11, 12, 13]);
    expect(matched("maxage", "100000")).toEqual([]);
  });

  it("matches nothing for a blank or non-numeric value rather than everything", () => {
    expect(matched("maxage", "")).toEqual([]);
    expect(matched("maxage", "soon")).toEqual([]);
    expect(matched("user", "")).toEqual([]);
    expect(matched("id", "")).toEqual([]);
  });

  it("tolerates a pasted value with surrounding whitespace", () => {
    expect(matched("id", " 11 ").map((c) => c.id)).toEqual([11]);
    expect(matched("user", " app_ro ").map((c) => c.id)).toEqual([12]);
  });
});

describe("humanizers", () => {
  it("scales ages the way the age/idle columns read", () => {
    expect(humanAge(0)).toBe("0s");
    expect(humanAge(59)).toBe("59s");
    expect(humanAge(60)).toBe("1m");
    expect(humanAge(3599)).toBe("59m");
    expect(humanAge(3600)).toBe("1h 0m");
    expect(humanAge(9000)).toBe("2h 30m");
    expect(humanAge(90000)).toBe("1d 1h");
  });

  it("scales client memory and network totals", () => {
    expect(humanClientMem(812)).toBe("812 B");
    expect(humanClientMem(20512)).toBe("20.0 KB");
    expect(humanClientMem(1572864)).toBe("1.50 MB");
    expect(humanNet(2048)).toBe("2 KB");
    expect(humanNet(4200000)).toBe("4.0 MB");
  });

  it("spells out flag letters so the state column is readable", () => {
    expect(flagSummary("N")).toBe("N · normal");
    expect(flagSummary("bx")).toBe("bx · blocked, in MULTI");
    expect(flagSummary("")).toBe("—");
  });
});
