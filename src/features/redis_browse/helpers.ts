// Pure Redis-UI helpers — ported from the prototype's `redis.jsx` /
// `redis-tabs.jsx` (REDIS_SPEC §10). All side-effect-free: humanizers for the
// sidebar/status/dashboard, a glob→regex compiler for the MATCH client-side
// preview, and a namespace-tree builder for the tree view of the key list.
//
// Tasks 3 (key viewers) and 4 (CLI + dashboard + status) also consume
// `humanBytes` / `humanNum` here.

import type { KeyType } from "./api";

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
