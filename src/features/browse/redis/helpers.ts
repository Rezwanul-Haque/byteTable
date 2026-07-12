// Pure Redis-UI helpers — ported from the prototype's `redis.jsx` /
// `redis-tabs.jsx` (REDIS_SPEC §10). All side-effect-free: humanizers for the
// sidebar/status/dashboard, a glob→regex compiler for the MATCH client-side
// preview, and a namespace-tree builder for the tree view of the key list.
//
// Tasks 3 (key viewers) and 4 (CLI + dashboard + status) also consume
// `humanBytes` / `humanNum` here.

import type { KeyType, RespReply } from "./api";
import type { CliLine } from "./state";

/**
 * The six Redis value types' display metadata — fixed accent colors + short
 * badge labels (REDIS_SPEC §2). Used by the type badge, the filter chips, the
 * tab bar's key tabs, and (Tasks 3–4) the key viewers + dashboard.
 */
export const REDIS_TYPES: Record<KeyType, { label: string; short: string; color: string }> = {
  string: { label: "string", short: "Str", color: "#61afef" },
  hash: { label: "hash", short: "Hsh", color: "#e2b340" },
  list: { label: "list", short: "Lst", color: "#c678dd" },
  set: { label: "set", short: "Set", color: "#34d39e" },
  zset: { label: "zset", short: "ZSt", color: "#e8845a" },
  stream: { label: "stream", short: "Xst", color: "#8b93a3" },
};

/** Ordered list of the value types — drives the filter-chip order. */
export const REDIS_TYPE_ORDER: KeyType[] = ["string", "hash", "list", "set", "zset", "stream"];

/**
 * Humanize a TTL in seconds (REDIS_SPEC §10): `∞` for no-expiry (`< 0`, i.e.
 * the `-1` / `-2` sentinels), else the largest sensible unit — `Ns`, `Nm`,
 * `Nh`, `Nd`.
 */
export function humanTTL(ttl: number): string {
  if (ttl < 0) return "∞"; // ∞
  if (ttl < 60) return ttl + "s";
  if (ttl < 3600) return Math.round(ttl / 60) + "m";
  if (ttl < 86400) return Math.round(ttl / 3600) + "h";
  return Math.round(ttl / 86400) + "d";
}

/** Humanize a byte count (REDIS_SPEC §10): `B / KB / MB / GB`. */
export function humanBytes(b: number): string {
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
  if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + " MB";
  return (b / 1024 / 1024 / 1024).toFixed(2) + " GB";
}

/** Humanize a plain count (REDIS_SPEC §10): `K / M` suffixes over 1e3 / 1e6. */
export function humanNum(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}

/**
 * Compile a Redis glob (`*`, `?`) into an anchored RegExp (REDIS_SPEC §10).
 * Used only for a client-side preview/sort guard; the server-side `MATCH`
 * remains the source of truth (the scan is cursor-paged with the raw glob).
 * Every non-glob char is regex-escaped, so the pattern is safe to compile.
 */
export function patternToRegExp(glob: string): RegExp {
  let re = "";
  for (const c of glob) {
    if (c === "*") re += "[\\s\\S]*";
    else if (c === "?") re += "[\\s\\S]";
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$");
}

/** Namespace separator the tree view splits keys on (REDIS_SPEC §4). */
export const KEY_SEPARATOR = ":";

/**
 * One node of the namespace tree: child folders by segment, plus the full key
 * names that terminate at this node (their last segment is the node's leaf).
 */
export interface NamespaceNode {
  children: Record<string, NamespaceNode>;
  keys: string[];
}

/** A fresh, empty tree node. */
function emptyNode(): NamespaceNode {
  return { children: {}, keys: [] };
}

/**
 * Build the namespace tree from a list of full key names (REDIS_SPEC §4 /
 * `redis.jsx`): split each key on `:`, nesting all-but-last segments as
 * folders and attaching the full key under the final folder. A key with no
 * separator lands directly on the root's `keys`.
 */
export function buildNamespaceTree(keys: string[]): NamespaceNode {
  const root = emptyNode();
  for (const key of keys) {
    const parts = key.split(KEY_SEPARATOR);
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i] ?? "";
      node.children[seg] ??= emptyNode();
      node = node.children[seg];
    }
    node.keys.push(key);
  }
  return root;
}

/** Total leaf-key count under a tree node (its own keys + all descendants'). */
export function countLeaves(node: NamespaceNode): number {
  let n = node.keys.length;
  for (const child of Object.values(node.children)) n += countLeaves(child);
  return n;
}

/** The last `:`-segment of a key — what the tree view shows for a leaf row. */
export function lastSegment(key: string): string {
  const parts = key.split(KEY_SEPARATOR);
  return parts[parts.length - 1] ?? key;
}

// ---------------------------------------------------------------------------
// CLI console helpers (REDIS_SPEC §7) — ported from the prototype's
// `redis-engine.js` tokenizer + `redis-tabs.jsx` formatReply. The tokenizer
// splits a command line into args (honoring "double" / 'single' quotes); the
// formatter renders a typed `RespReply` into colored log lines exactly like
// redis-cli. The renderer drives off the *typed* reply (never re-parsing).
// ---------------------------------------------------------------------------

/**
 * Split a command line into argument tokens, honoring `"double"` and `'single'`
 * quotes (ported verbatim from the prototype `redis-engine.js` tokenizer).
 * Backslash escapes are honored only inside double quotes. Empty quoted args
 * (`""`) are preserved as empty-string tokens.
 */
export function tokenizeCommand(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inq: '"' | "'" | null = null;
  let has = false;
  let i = 0;
  while (i < line.length) {
    const c = line[i] ?? "";
    if (inq) {
      if (c === inq) {
        inq = null;
        i++;
        continue;
      }
      if (c === "\\" && inq === '"' && i + 1 < line.length) {
        cur += line[i + 1];
        i += 2;
        continue;
      }
      cur += c;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      inq = c;
      has = true;
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      if (has || cur) {
        out.push(cur);
        cur = "";
        has = false;
      }
      i++;
      continue;
    }
    cur += c;
    has = true;
    i++;
  }
  if (has || cur) out.push(cur);
  return out;
}

/**
 * Redis write commands the CLI should treat as mutating (REDIS_SPEC §7): after
 * one returns, the workspace version is bumped so the sidebar + open key tabs
 * re-fetch. A reasonable superset of the coverage in §7; a non-mutating command
 * not in this set never forces a refresh.
 */
const MUTATING_COMMANDS = new Set<string>([
  "SET",
  "SETEX",
  "SETNX",
  "GETSET",
  "APPEND",
  "INCR",
  "DECR",
  "INCRBY",
  "DECRBY",
  "DEL",
  "UNLINK",
  "EXPIRE",
  "PEXPIRE",
  "EXPIREAT",
  "PERSIST",
  "RENAME",
  "RENAMENX",
  "FLUSHDB",
  "FLUSHALL",
  "MOVE",
  "COPY",
  "HSET",
  "HMSET",
  "HSETNX",
  "HDEL",
  "HINCRBY",
  "LPUSH",
  "RPUSH",
  "LPOP",
  "RPOP",
  "LSET",
  "LREM",
  "LTRIM",
  "LINSERT",
  "SADD",
  "SREM",
  "SPOP",
  "SMOVE",
  "ZADD",
  "ZREM",
  "ZINCRBY",
  "ZPOPMIN",
  "ZPOPMAX",
  "XADD",
  "XDEL",
  "XTRIM",
]);

/** Whether `command` (any case) mutates the keyspace → caller bumps version. */
export function isMutatingCommand(command: string): boolean {
  return MUTATING_COMMANDS.has(command.toUpperCase());
}

/** Destructive commands gated behind a confirm on a production connection. */
const DESTRUCTIVE_COMMANDS = new Set<string>(["FLUSHDB", "FLUSHALL"]);

/**
 * Whether a tokenized command is destructive enough to confirm on a production
 * connection (REDIS_SPEC §7 / M13 safety): a `FLUSHDB`/`FLUSHALL`, or a
 * **multi-key** `DEL`/`UNLINK` (`DEL k1 k2 …`). A single-key `DEL` is not
 * gated — that mirrors the key tab's own per-key delete confirm.
 */
export function isDestructiveCommand(tokens: string[]): boolean {
  const cmd = (tokens[0] ?? "").toUpperCase();
  if (DESTRUCTIVE_COMMANDS.has(cmd)) return true;
  if ((cmd === "DEL" || cmd === "UNLINK") && tokens.length > 2) return true;
  return false;
}

/**
 * Format a typed `RespReply` into colored log lines, mirroring redis-cli output
 * exactly (REDIS_SPEC §7 — ported from the prototype `formatReply`):
 * - status → plain accent (`cli-status`)
 * - error  → red `(error) …` (`cli-error`)
 * - int    → `(integer) N` (`cli-int`)
 * - bulk   → quoted `"…"` (`cli-bulk`); a multi-line bulk (e.g. INFO) prints
 *            line-per-line; a null bulk is `(nil)` (`cli-nil`)
 * - array  → numbered `1) … 2) …`; nested arrays indented one level; an empty
 *            array is `(empty array)` (`cli-nil`)
 */
export function formatReply(rep: RespReply, indent = 0, out: CliLine[] = []): CliLine[] {
  const pad = "  ".repeat(indent);
  if (rep.kind === "status") {
    out.push({ cls: "cli-status", text: pad + rep.value });
  } else if (rep.kind === "error") {
    out.push({ cls: "cli-error", text: pad + "(error) " + rep.value });
  } else if (rep.kind === "int") {
    out.push({ cls: "cli-int", text: pad + "(integer) " + rep.value });
  } else if (rep.kind === "bulk") {
    if (rep.value === null) {
      out.push({ cls: "cli-nil", text: pad + "(nil)" });
    } else {
      const lines = rep.value.split("\n");
      if (lines.length > 1) {
        for (const l of lines) out.push({ cls: "cli-bulk", text: pad + l });
      } else {
        out.push({ cls: "cli-bulk", text: pad + '"' + rep.value + '"' });
      }
    }
  } else {
    // array
    if (rep.items.length === 0) {
      out.push({ cls: "cli-nil", text: pad + "(empty array)" });
      return out;
    }
    rep.items.forEach((item, i) => {
      const prefix = pad + (i + 1) + ") ";
      if (item.kind === "array") {
        out.push({ cls: "cli-idx", text: prefix.trimEnd() });
        formatReply(item, indent + 1, out);
      } else {
        const sub: CliLine[] = [];
        formatReply(item, 0, sub);
        const first = sub[0];
        if (first) {
          out.push({ cls: first.cls, text: prefix + first.text.trimStart() });
          for (let j = 1; j < sub.length; j++) {
            const s = sub[j];
            if (s) out.push(s);
          }
        }
      }
    });
  }
  return out;
}
