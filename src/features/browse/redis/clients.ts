// The connected-clients model (M36 §A1) — ported from the prototype's
// `redis-clients.js`, with the mock generator dropped: the rows come from a
// real `CLIENT LIST` via `kvClientList`, so there is nothing to synthesise or
// churn. What stays is everything that gives those rows meaning:
//
// - `INFO_FIELDS` — the field order Redis itself uses, so `infoLine()` rebuilds
//   the exact `CLIENT INFO` line even for a client whose row predates a field.
// - `FIELD_DOC` — one plain sentence per field. A wall of unexplained numbers
//   is what the generic processes tab already was; this is the difference.
// - `KILL_FILTERS` — the six `CLIENT KILL` filters, each rendering the command
//   it will run and matching locally so the tab can show "N clients match"
//   *before* anything is killed.
// - `breakdown()` / `clientRisk()` — the counts the stats strip shows and the
//   four conditions that earn a row attention.
//
// Pure: no React, no invoke. The tab owns the fetching.

import { t, type StringKey, type Vars } from "../../../shared/i18n";
import type { KvClient, KvKillFilter } from "./api";

/** The `CLIENT INFO` / `CLIENT LIST` field order, exactly as Redis emits it. */
export const INFO_FIELDS = [
  "id",
  "addr",
  "laddr",
  "fd",
  "name",
  "age",
  "idle",
  "flags",
  "db",
  "sub",
  "psub",
  "ssub",
  "multi",
  "watch",
  "qbuf",
  "qbuf-free",
  "argv-mem",
  "multi-mem",
  "tot-net-in",
  "tot-net-out",
  "rbs",
  "rbp",
  "obl",
  "oll",
  "omem",
  "tot-mem",
  "events",
  "cmd",
  "user",
  "redir",
  "resp",
  "lib-name",
  "lib-ver",
] as const;

/**
 * The client's `CLIENT INFO` line. The server already sent us one (`raw`), so
 * that is what we return — it is authoritative and includes any field this
 * build does not know about. The `INFO_FIELDS` reconstruction is the fallback
 * for a row that somehow arrived without it.
 */
export function infoLine(client: KvClient): string {
  if (client.raw) return client.raw;
  const byField = new Map(client.fields.map((f) => [f.field, f.value]));
  return INFO_FIELDS.map((f) => f + "=" + (byField.get(f) ?? "")).join(" ");
}

/** Read one reported field by name (the inspector renders from these). */
export function clientField(client: KvClient, field: string): string | undefined {
  return client.fields.find((f) => f.field === field)?.value;
}

/**
 * What each `CLIENT LIST` field means, in one sentence. Shown as the hover
 * title of every row in the inspector — the sentence lives in the i18n tables
 * under `redis.doc.<field>`, and `fieldDoc()` resolves it at call time so a
 * locale switch repaints the inspector.
 */
const FIELD_DOC_FIELDS = new Set<string>([
  "id",
  "addr",
  "laddr",
  "fd",
  "name",
  "age",
  "idle",
  "flags",
  "db",
  "sub",
  "psub",
  "ssub",
  "multi",
  "watch",
  "qbuf",
  "qbuf-free",
  "argv-mem",
  "multi-mem",
  "tot-mem",
  "tot-net-in",
  "tot-net-out",
  "rbs",
  "rbp",
  "obl",
  "oll",
  "omem",
  "events",
  "cmd",
  "user",
  "redir",
  "resp",
  "lib-name",
  "lib-ver",
]);

/** The plain sentence for a `CLIENT LIST` field, or undefined when unknown. */
export function fieldDoc(field: string): string | undefined {
  if (!FIELD_DOC_FIELDS.has(field)) return undefined;
  return t(("redis.doc." + field) as StringKey);
}

/** One `CLIENT KILL` filter: how it renders, and how it matches locally. */
export interface KillFilterSpec {
  id: KvKillFilter;
  /** The exact command that will run, for the preview. */
  cmd: (value: string) => string;
  /** The same predicate the server applies — powers the live match count. */
  match: (client: KvClient, value: string) => boolean;
}

/** The filter's display label, resolved at call time from the i18n tables. */
export function killFilterLabel(spec: KillFilterSpec): string {
  return t(("redis.kf." + spec.id) as StringKey);
}

/** The value placeholder describing what the filter's value is. */
export function killFilterHint(spec: KillFilterSpec): string {
  return t(("redis.kf." + spec.id + "Hint") as StringKey);
}

/**
 * The six filters `CLIENT KILL` supports. Per-row killing does not scale to
 * twenty leaked connections; this is the surface that does.
 */
export const KILL_FILTERS: KillFilterSpec[] = [
  {
    id: "id",
    cmd: (v) => "CLIENT KILL ID " + v,
    match: (c, v) => String(c.id) === v.trim(),
  },
  {
    id: "addr",
    cmd: (v) => "CLIENT KILL ADDR " + v,
    match: (c, v) => c.addr === v.trim(),
  },
  {
    id: "laddr",
    cmd: (v) => "CLIENT KILL LADDR " + v,
    match: (c, v) => c.laddr === v.trim(),
  },
  {
    id: "type",
    cmd: (v) => "CLIENT KILL TYPE " + v,
    match: (c, v) => c.clientType === v.trim(),
  },
  {
    id: "user",
    cmd: (v) => "CLIENT KILL USER " + v,
    match: (c, v) => c.user === v.trim(),
  },
  {
    id: "maxage",
    cmd: (v) => "CLIENT KILL MAXAGE " + v,
    match: (c, v) => {
      // A blank box must match NOTHING, not everything: `Number("")` is 0, and
      // `age >= 0` would have the popover promise to kill every connection
      // before anything had been typed.
      const raw = v.trim();
      const seconds = Number(raw);
      return raw !== "" && Number.isFinite(seconds) && c.age >= seconds;
    },
  },
];

/** The type colors the segmented control, the stats strip and the row tag share. */
export const CLIENT_TYPE_COLOR: Record<string, string> = {
  normal: "var(--accent)",
  pubsub: "#c792ea",
  replica: "#e2b340",
  master: "#e2b340",
};

/** Seconds a normal client may idle before it looks like a leaked connection. */
export const STALE_IDLE_SECONDS = 300;

/** The counts the stats strip shows, derived from one list — one source of truth. */
export interface ClientBreakdown {
  total: number;
  normal: number;
  pubsub: number;
  replica: number;
  blocked: number;
  /** Normal clients idle over 5 minutes — usually leaked pool connections. */
  stale: number;
  /** Total `tot-mem` across every connection. */
  mem: number;
}

export function breakdown(list: KvClient[]): ClientBreakdown {
  return {
    total: list.length,
    normal: list.filter((c) => c.clientType === "normal").length,
    pubsub: list.filter((c) => c.clientType === "pubsub").length,
    replica: list.filter((c) => c.clientType === "replica" || c.clientType === "master").length,
    blocked: list.filter((c) => c.flags.includes("b")).length,
    stale: list.filter(isStale).length,
    mem: list.reduce((sum, c) => sum + c.totMem, 0),
  };
}

/** A normal client idle past the leak threshold. */
export function isStale(client: KvClient): boolean {
  return client.clientType === "normal" && client.idle > STALE_IDLE_SECONDS;
}

/** Whether the client is parked in a blocking command (`BLPOP`, `XREAD`…). */
export function isBlocked(client: KvClient): boolean {
  return client.flags.includes("b");
}

/** A row that has earned attention, and why. `text` is the English sentence
 *  (kept for the unit test); `key` + `vars` are the i18n form components
 *  resolve at render time, so a locale switch repaints the note. */
export interface ClientRisk {
  sev: "warn" | "note";
  text: string;
  key: StringKey;
  vars?: Vars;
}

/**
 * The four things worth flagging on a connection. Your own connection is never
 * flagged — it is doing exactly what you asked it to.
 */
export function clientRisk(client: KvClient): ClientRisk | null {
  if (client.isSelf) return null;
  if (isStale(client)) {
    return {
      sev: "warn",
      key: "redis.risk.stale",
      vars: { idle: humanAge(client.idle) },
      text: "Idle " + humanAge(client.idle) + " — likely a leaked pool connection",
    };
  }
  if (client.oll > 6) {
    return {
      sev: "warn",
      key: "redis.risk.oll",
      vars: { count: client.oll },
      text: client.oll + " replies queued — slow consumer, output buffer is filling",
    };
  }
  if (client.multi >= 0 && client.idle > 30) {
    return {
      sev: "warn",
      key: "redis.risk.multi",
      vars: { idle: humanAge(client.idle) },
      text: "Transaction open and idle " + humanAge(client.idle) + " — holds WATCHed keys",
    };
  }
  if (client.totMem > 48000) {
    return {
      sev: "note",
      key: "redis.risk.mem",
      vars: { mem: humanClientMem(client.totMem) },
      text: "Costs " + humanClientMem(client.totMem) + " of server memory",
    };
  }
  return null;
}

/** A flag letter spelled out (`b` → `blocked`). */
export function flagLabel(flag: string): string {
  const labels: Record<string, string> = {
    N: "normal",
    S: "replica",
    M: "master",
    b: "blocked",
    x: "in MULTI",
    O: "monitor",
    P: "pubsub",
    t: "tracking",
    T: "no-touch",
    e: "no-evict",
  };
  return labels[flag] ?? flag;
}

/** Every flag letter on a client, spelled out (`N` → `N · normal`). */
export function flagSummary(flags: string): string {
  if (!flags) return "—";
  const parts = [...flags].map(flagLabel).filter((label) => label !== "");
  return flags + " · " + parts.join(", ");
}

/** Seconds → `12s` / `4m` / `2h 30m` / `3d 4h`. */
export function humanAge(seconds: number): string {
  if (seconds < 60) return seconds + "s";
  if (seconds < 3600) return Math.floor(seconds / 60) + "m";
  if (seconds < 86400) {
    return Math.floor(seconds / 3600) + "h " + Math.floor((seconds % 3600) / 60) + "m";
  }
  return Math.floor(seconds / 86400) + "d " + Math.floor((seconds % 86400) / 3600) + "h";
}

/** Client memory bytes → `812 B` / `20.5 KB` / `1.20 MB`. */
export function humanClientMem(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1048576).toFixed(2) + " MB";
}

/** Network totals → `812 B` / `20 KB` / `1.2 MB` (coarser than memory). */
export function humanNet(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1048576) return (bytes / 1024).toFixed(0) + " KB";
  return (bytes / 1048576).toFixed(1) + " MB";
}
