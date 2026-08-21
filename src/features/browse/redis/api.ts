// Typed invoke() wrappers + wire types for the Redis (key-value) slice's Tauri
// commands (M13). The TS mirrors of the Rust types in
// `src-tauri/src/shared/keyvalue.rs` — field names camelCase, enum values
// lowercase per the serde attributes. Keep the two files in sync.
//
// Backend Task 1 lays the types + wrappers; the renderer slice (Tasks 2–4 —
// the keyspace sidebar, key tabs, CLI console, dashboard) is built on top of
// these and the design prototypes `redis.jsx` / `redis-tabs.jsx` in
// `design_handoff_bytetable_latest/bytetable/`.
//
// Routing: `connectionOpen` (connections/api.ts) returns `kind: "kv"` plus an
// initial `keyspace` overview for Redis; the workspace host routes `kv` here.

import { invoke } from "@tauri-apps/api/core";

import type { KvDbInfo, KvServerInfo } from "../../connections/api";

// Re-export the open-result overview types that live in the connections slice
// (the open-result is one shape across both engine families).
export type {
  ConnectionKind,
  KeyspaceOverview,
  KvDbInfo,
  KvServerInfo,
} from "../../connections/api";

/**
 * The Redis value type of a key, exactly as `TYPE` reports it. Lowercase on the
 * wire — mirrors Rust's `KeyType`.
 */
export type KeyType = "string" | "hash" | "list" | "set" | "zset" | "stream";

/** One `{field, value}` pair of a hash (and of a stream entry's fields). */
export interface KvField {
  field: string;
  value: string;
}

/** One `{member, score}` entry of a sorted set. */
export interface KvScored {
  member: string;
  score: number;
}

/** One entry of a stream: its id plus the flattened `{field,value}` pairs. */
export interface KvStreamEntry {
  id: string;
  fields: KvField[];
}

/**
 * A typed Redis value, a discriminated union by `type` — mirrors Rust's
 * `KvValue`. `missing` models a key that does not exist (TTL `-2`).
 */
export type KvValue =
  | { type: "str"; value: string }
  | { type: "list"; items: string[] }
  | { type: "set"; members: string[] }
  | { type: "hash"; fields: KvField[] }
  | { type: "zset"; entries: KvScored[] }
  | { type: "stream"; entries: KvStreamEntry[] }
  | { type: "missing" };

/** One key in a scan page — mirrors Rust's `KeyEntry`. */
export interface KeyEntry {
  name: string;
  keyType: KeyType;
  /** TTL seconds; `-1` = no expiry, `-2` = vanished mid-scan. */
  ttl: number;
}

/**
 * A cursor-based scan request — mirrors Rust's `ScanRequest`. Never a blocking
 * `KEYS *`. `cursor` is Redis's opaque cursor as a string (`"0"` starts fresh).
 */
export interface ScanRequest {
  /** Glob pattern for `MATCH` (default `*`). */
  pattern?: string;
  /** Optional server-side `TYPE` filter. */
  typeFilter?: KeyType;
  /** Opaque SCAN cursor (`"0"` to start). */
  cursor?: string;
  /** `COUNT` hint (work per round trip, not a result-size cap). */
  count?: number;
}

/** One page of `kvScan`: the next cursor (`"0"` = done) + enriched keys. */
export interface ScanPage {
  cursor: string;
  keys: KeyEntry[];
}

/**
 * Everything the key tab's Info mode shows — mirrors Rust's `KeyView`:
 * type, TTL, `OBJECT ENCODING`, `MEMORY USAGE` bytes, `OBJECT IDLETIME` secs,
 * and the typed value.
 */
export interface KeyView {
  keyType: KeyType;
  /** TTL seconds; `-1` = no expiry, `-2` = missing. */
  ttl: number;
  encoding: string | null;
  memory: number | null;
  idle: number | null;
  value: KvValue;
}

/**
 * The dashboard stat-grid fields parsed from `INFO` — mirrors Rust's
 * `KvServerStats`. `maxmemory: 0` means no configured limit.
 */
export interface KvServerStats {
  keyspaceHits: number;
  keyspaceMisses: number;
  instantaneousOpsPerSec: number;
  connectedClients: number;
  usedMemory: number;
  maxmemory: number;
  uptimeInDays: number;
  expiredKeys: number;
  evictedKeys: number;
}

/**
 * A typed RESP reply for the CLI console — a discriminated union by `kind`,
 * mirroring Rust's `RespReply`. The renderer formats each shape exactly like
 * `redis-cli` (status → plain text, error → `(error) …`, int → `(integer) N`,
 * bulk → quoted string or `(nil)` when `value` is null, array → numbered list
 * with nested arrays indented). The backend never formats — server errors
 * (`WRONGTYPE`, `ERR unknown command`) arrive as `{ kind: "error" }`.
 */
export type RespReply =
  | { kind: "status"; value: string }
  | { kind: "error"; value: string }
  | { kind: "int"; value: number }
  | { kind: "bulk"; value: string | null }
  | { kind: "array"; items: RespReply[] };

// ---------------------------------------------------------------------------
// Command wrappers (one per `kv_*` Tauri command)
// ---------------------------------------------------------------------------

/** Server identity for the dashboard header. */
export function kvServerInfo(handleId: string): Promise<KvServerInfo> {
  return invoke<KvServerInfo>("kv_server_info", { handleId });
}

/** Dashboard stat-grid counters. */
export function kvServerStats(handleId: string): Promise<KvServerStats> {
  return invoke<KvServerStats>("kv_server_stats", { handleId });
}

/** Per-database key counts (`INFO keyspace`). */
export function kvKeyspace(handleId: string): Promise<KvDbInfo[]> {
  return invoke<KvDbInfo[]>("kv_keyspace", { handleId });
}

/** One cursor page of keys in a db, enriched with type + TTL. */
export function kvScan(handleId: string, db: number, request: ScanRequest): Promise<ScanPage> {
  return invoke<ScanPage>("kv_scan", { handleId, db, request });
}

/** The full typed view of one key. */
export function kvGetKey(handleId: string, db: number, key: string): Promise<KeyView> {
  return invoke<KeyView>("kv_get_key", { handleId, db, key });
}

/** `SET key value`. */
export function kvSetString(
  handleId: string,
  db: number,
  key: string,
  value: string,
): Promise<void> {
  return invoke("kv_set_string", { handleId, db, key, value });
}

/** `HSET key field value`. */
export function kvHashSet(
  handleId: string,
  db: number,
  key: string,
  field: string,
  value: string,
): Promise<void> {
  return invoke("kv_hash_set", { handleId, db, key, field, value });
}

/** `HDEL key field` — resolves to whether a field was removed. */
export function kvHashDel(
  handleId: string,
  db: number,
  key: string,
  field: string,
): Promise<boolean> {
  return invoke<boolean>("kv_hash_del", { handleId, db, key, field });
}

/** `LSET key index value`. */
export function kvListSet(
  handleId: string,
  db: number,
  key: string,
  index: number,
  value: string,
): Promise<void> {
  return invoke("kv_list_set", { handleId, db, key, index, value });
}

/** `SADD key member` — resolves to whether the member was newly added. */
export function kvSetAdd(
  handleId: string,
  db: number,
  key: string,
  member: string,
): Promise<boolean> {
  return invoke<boolean>("kv_set_add", { handleId, db, key, member });
}

/** `SREM key member` — resolves to whether the member was removed. */
export function kvSetRemove(
  handleId: string,
  db: number,
  key: string,
  member: string,
): Promise<boolean> {
  return invoke<boolean>("kv_set_remove", { handleId, db, key, member });
}

/** `ZADD key score member`. */
export function kvZsetAdd(
  handleId: string,
  db: number,
  key: string,
  member: string,
  score: number,
): Promise<void> {
  return invoke("kv_zset_add", { handleId, db, key, member, score });
}

/** `ZREM key member` — resolves to whether the member was removed. */
export function kvZsetRemove(
  handleId: string,
  db: number,
  key: string,
  member: string,
): Promise<boolean> {
  return invoke<boolean>("kv_zset_remove", { handleId, db, key, member });
}

/** `DEL key` — resolves to whether the key existed. */
export function kvDeleteKey(handleId: string, db: number, key: string): Promise<boolean> {
  return invoke<boolean>("kv_delete_key", { handleId, db, key });
}

/** `RENAME key newKey`. A missing source key is a not-found error. */
export function kvRenameKey(
  handleId: string,
  db: number,
  key: string,
  newKey: string,
): Promise<void> {
  return invoke("kv_rename_key", { handleId, db, key, newKey });
}

/** `EXPIRE key seconds` — resolves to whether the timeout was set. */
export function kvExpire(
  handleId: string,
  db: number,
  key: string,
  seconds: number,
): Promise<boolean> {
  return invoke<boolean>("kv_expire", { handleId, db, key, seconds });
}

/** `PERSIST key` — resolves to whether a timeout was removed. */
export function kvPersist(handleId: string, db: number, key: string): Promise<boolean> {
  return invoke<boolean>("kv_persist", { handleId, db, key });
}

/** Create a fresh key of `keyType` with an optional initial seed value. */
export function kvCreateKey(
  handleId: string,
  db: number,
  key: string,
  keyType: KeyType,
  initial?: string,
): Promise<void> {
  return invoke("kv_create_key", { handleId, db, key, keyType, initial });
}

/**
 * Run a raw, already-tokenized command in a db and get the typed reply (the
 * CLI console). Server error replies (`WRONGTYPE`, `ERR …`) come back as
 * `{ kind: "error" }`, not thrown — only a connection failure rejects.
 */
export function kvCommand(handleId: string, db: number, args: string[]): Promise<RespReply> {
  return invoke<RespReply>("kv_command", { handleId, db, args });
}

// ---------------------------------------------------------------------------
// Connected clients (M36 §A) — CLIENT LIST / CLIENT KILL
// ---------------------------------------------------------------------------

/**
 * One connection from `CLIENT LIST` — mirrors Rust's `KvClient`. The typed
 * fields are the ones the table sorts, filters and colors by; `fields` carries
 * **every** `key=value` the server reported in its own order, and `raw` is the
 * verbatim line (a `CLIENT LIST` line IS `CLIENT INFO` output, which is what
 * people paste into a bug report).
 */
export interface KvClient {
  id: number;
  addr: string;
  laddr: string;
  name: string;
  /** Seconds since the connection opened. */
  age: number;
  /** Seconds since its last command. */
  idle: number;
  /** Raw flag letters: `N` normal · `S` replica · `b` blocked · `x` in MULTI. */
  flags: string;
  db: number;
  sub: number;
  psub: number;
  /** Commands queued in an open `MULTI`; `-1` = no transaction. */
  multi: number;
  watch: number;
  qbuf: number;
  /** Output list length — replies queued but not yet flushed. */
  oll: number;
  omem: number;
  /** Total memory the connection costs the server, buffers included. */
  totMem: number;
  cmd: string;
  user: string;
  /** Derived class: `normal` / `pubsub` / `replica` / `master`. */
  clientType: string;
  /** True for the connection ByteTable itself is using — never killable. */
  isSelf: boolean;
  fields: KvField[];
  raw: string;
}

/** The `CLIENT KILL` filter to apply — mirrors Rust's `KvKillFilter`. */
export type KvKillFilter = "id" | "addr" | "laddr" | "type" | "user" | "maxage";

/** `CLIENT LIST` — every connection on this node, ours flagged `isSelf`. */
export function kvClientList(handleId: string): Promise<KvClient[]> {
  return invoke<KvClient[]>("kv_client_list", { handleId });
}

/** `CLIENT KILL <filter> <value>` — resolves to the number of connections closed. */
export function kvClientKill(
  handleId: string,
  filter: KvKillFilter,
  value: string,
): Promise<number> {
  return invoke<number>("kv_client_kill", { handleId, filter, value });
}

/** One `CLIENT KILL ID <id>` per id — resolves to the number closed. */
export function kvClientKillIds(handleId: string, ids: number[]): Promise<number> {
  return invoke<number>("kv_client_kill_ids", { handleId, ids });
}

/**
 * `CLIENT NO-EVICT on|off`. Redis applies this to the **calling** connection
 * only — it cannot be aimed at another client, which is why the inspector
 * enables it only on your own connection.
 */
export function kvClientNoEvict(handleId: string, on: boolean): Promise<void> {
  return invoke("kv_client_no_evict", { handleId, on });
}

/** `CLIENT UNPAUSE` — resume every client the server had paused. */
export function kvClientUnpause(handleId: string): Promise<void> {
  return invoke("kv_client_unpause", { handleId });
}

// ---------------------------------------------------------------------------
// Cluster topology (M36 §B)
// ---------------------------------------------------------------------------

/** An inclusive `[from, to]` hash-slot range owned by a node. */
export interface SlotRange {
  from: number;
  to: number;
}

/**
 * One slot moving between shards, from the local node's `CLUSTER NODES` view.
 * Redis reports these one slot at a time; the UI groups contiguous runs.
 */
export interface SlotMigration {
  slot: number;
  /** `migrating` (leaving this node) or `importing` (arriving here). */
  direction: string;
  peerId: string;
}

/**
 * One cluster node — mirrors Rust's `ClusterNode`. Identity/health are facts
 * from `CLUSTER NODES`; the traffic counters need an `INFO` on that node and
 * are `null` when it was not directly reachable (see `nodeStatsMeasured`).
 */
export interface ClusterNode {
  id: string;
  host: string;
  port: number;
  busPort: number;
  hostname: string | null;
  /** `master` or `replica`. */
  role: string;
  masterId: string | null;
  /** True for the node this connection is attached to. */
  myself: boolean;
  /** `online` · `fail?` (PFAIL) · `fail` · `handshake` · `noaddr`. */
  health: string;
  /** Cluster-bus link state: `connected` / `disconnected`. */
  link: string;
  epoch: number;
  slots: SlotRange[];
  offset: number | null;
  lagBytes: number | null;
  lagSeconds: number | null;
  keys: number | null;
  memory: number | null;
  ops: number | null;
  clients: number | null;
}

/** One shard: the master owning a slot range plus its replicas. */
export interface ClusterShard {
  index: number;
  master: ClusterNode;
  replicas: ClusterNode[];
  slots: SlotRange[];
}

/** The whole cluster as one snapshot — mirrors Rust's `ClusterTopology`. */
export interface ClusterTopology {
  /** Raw `CLUSTER INFO` pairs in server order. */
  info: KvField[];
  /** Raw `CLUSTER NODES` reply. */
  nodesText: string;
  shards: ClusterShard[];
  migrating: SlotMigration[];
  /** False when the per-node probes were skipped — counters are unknown, not zero. */
  nodeStatsMeasured: boolean;
}

/**
 * The cluster snapshot, or `null` when the server runs standalone. The
 * connection decides — there is no UI toggle (M36 §B3).
 */
export function kvClusterTopology(handleId: string): Promise<ClusterTopology | null> {
  return invoke<ClusterTopology | null>("kv_cluster_topology", { handleId });
}

/**
 * Sub-workspace scope id for a Redis db (M33).
 *
 * The workspaces store keys a sub-workspace by an opaque scope STRING (a schema
 * name for SQL, a keyspace for Cassandra), and uses it verbatim as the rail
 * tile's name. Redis scopes are numeric, so they round-trip as `db3` rather
 * than `3`: the tile then reads the way the rest of the Redis UI writes it, and
 * the persisted session (which stores scope strings) needs no engine-specific
 * handling.
 */
export function dbScopeId(index: number): string {
  return "db" + index;
}

/** The db index behind a {@link dbScopeId}, or null if it isn't one. */
export function dbScopeIndex(scope: string | null | undefined): number | null {
  if (!scope) return null;
  const match = /^db(\d+)$/.exec(scope);
  if (!match?.[1]) return null;
  const index = Number(match[1]);
  return Number.isInteger(index) && index >= 0 ? index : null;
}
