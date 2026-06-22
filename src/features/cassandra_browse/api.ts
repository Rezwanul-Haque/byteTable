// Typed invoke() wrappers for the Cassandra slice's Tauri commands, plus the TS
// mirrors of the Rust wire types in `src-tauri/src/shared/widecolumn.rs`. Field
// names are camelCase and enum values snake_case per the serde attributes on the
// Rust side. Cross-feature consumption of this slice's api.ts is sanctioned;
// reaching into its components is not.

import { invoke } from "@tauri-apps/api/core";

/** The role a column plays — mirrors Rust's `ColumnKind` (snake_case wire). */
export type ColumnKind = "partition_key" | "clustering" | "static" | "regular";

/** One column — `{ name, type, kind }`. */
export interface CassColumn {
  name: string;
  type: string;
  kind: ColumnKind;
}

/** One clustering column with its order. */
export interface CassClustering {
  name: string;
  type: string;
  /** `ASC` or `DESC`. */
  order: string;
}

/** A secondary index — `{ name, target }`. */
export interface CassIndex {
  name: string;
  target: string;
}

/** A materialized view derived from a base table. */
export interface CassMv {
  name: string;
  partitionKey: string[];
  clustering: string[];
}

/** A full table descriptor (sidebar list, dashboard, structure, grid header). */
export interface TableDescriptor {
  name: string;
  columns: CassColumn[];
  partitionKey: string[];
  clustering: CassClustering[];
  primaryKey: string;
  indexes: CassIndex[];
  mvs: CassMv[];
  comment?: string;
  /** Always absent — Cassandra has no cheap COUNT(*). */
  estRows?: number;
}

/** One keyspace: name + replication (raw object) + durable-writes flag. */
export interface KeyspaceInfo {
  name: string;
  replication: Record<string, string>;
  durableWrites: boolean;
}

/** One ring node (`nodetool status` row). load/owns/status best-effort. */
export interface NodeStatus {
  status?: string;
  address: string;
  dc: string;
  rack: string;
  load?: string;
  owns?: string;
  tokens?: number;
  hostId?: string;
}

/** The cluster ring summary for the dashboard + `nodetool status`. */
export interface ClusterStatus {
  cluster: string;
  partitioner: string;
  snitch?: string;
  nodes: NodeStatus[];
}

export function cassListKeyspaces(handleId: string): Promise<KeyspaceInfo[]> {
  return invoke<KeyspaceInfo[]>("cassandra_list_keyspaces", { handleId });
}

export function cassListTables(handleId: string, keyspace: string): Promise<TableDescriptor[]> {
  return invoke<TableDescriptor[]>("cassandra_list_tables", { handleId, keyspace });
}

export function cassTableMeta(
  handleId: string,
  keyspace: string,
  table: string,
): Promise<TableDescriptor> {
  return invoke<TableDescriptor>("cassandra_table_meta", { handleId, keyspace, table });
}

export function cassClusterStatus(handleId: string): Promise<ClusterStatus> {
  return invoke<ClusterStatus>("cassandra_cluster_status", { handleId });
}

/** One query-builder predicate — `{ col, op, val }`. */
export interface CassPredicate {
  col: string;
  op: string;
  val: unknown;
}

/** A bounded query-builder request (M19 §19.2). */
export interface CassQueryRequest {
  keyspace: string;
  table: string;
  predicates: CassPredicate[];
  /** Row cap; 0 = "All" (still bounded server-side). */
  limit: number;
  allowFiltering: boolean;
  consistency?: string;
  /** Forward-paging cursor from a prior page's `nextPagingState` (absent = first
   *  page). Cassandra has no OFFSET, so paging is cursor-based. */
  pagingState?: string;
}

/** A bounded query result. No total — Cassandra has no cheap COUNT(*). */
export interface CassQueryResult {
  columns: CassColumn[];
  rows: Record<string, unknown>[];
  returned: number;
  /** True when more pages exist. */
  truncated: boolean;
  /** Cursor for the next page (pass back as `pagingState`), or absent on the last. */
  nextPagingState?: string;
  ms: number;
  allowFiltering: boolean;
  partitionRestricted: boolean;
  warnings: string[];
  consistency: string;
}

export function cassQuery(handleId: string, request: CassQueryRequest): Promise<CassQueryResult> {
  return invoke<CassQueryResult>("cassandra_query", { handleId, request });
}

type Row = Record<string, unknown>;

export function cassInsertRow(
  handleId: string,
  keyspace: string,
  table: string,
  row: Row,
): Promise<void> {
  return invoke("cassandra_insert_row", { handleId, request: { keyspace, table, row } });
}

export function cassUpdateRow(
  handleId: string,
  keyspace: string,
  table: string,
  key: Row,
  set: Row,
): Promise<void> {
  return invoke("cassandra_update_row", { handleId, request: { keyspace, table, key, set } });
}

export function cassDeleteRow(
  handleId: string,
  keyspace: string,
  table: string,
  key: Row,
): Promise<void> {
  return invoke("cassandra_delete_row", { handleId, request: { keyspace, table, key } });
}

/** Bulk delete selected rows by full primary key (grid multi-select). Returns
 *  the number deleted. */
export function cassDeleteRows(
  handleId: string,
  keyspace: string,
  table: string,
  keys: Row[],
): Promise<number> {
  return invoke<number>("cassandra_delete_rows", { handleId, request: { keyspace, table, keys } });
}

/** The tagged outcome of a raw CQL statement (M19 §19.5). */
export type CassCqlResult =
  | {
      kind: "rows";
      columns: CassColumn[];
      rows: Record<string, unknown>[];
      returned: number;
      ms: number;
      warnings: string[];
    }
  | { kind: "ddl"; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "use"; keyspace: string }
  | { kind: "ok"; message: string };

export function cassRunCql(
  handleId: string,
  keyspace: string,
  cql: string,
  consistency?: string,
): Promise<CassCqlResult> {
  return invoke<CassCqlResult>("cassandra_run_cql", { handleId, keyspace, cql, consistency });
}

export function cassDescribeTable(
  handleId: string,
  keyspace: string,
  table: string,
): Promise<string> {
  return invoke<string>("cassandra_describe_table", { handleId, keyspace, table });
}

export function cassCreateIndex(
  handleId: string,
  keyspace: string,
  table: string,
  name: string,
  target: string,
): Promise<void> {
  return invoke("cassandra_create_index", { handleId, request: { keyspace, table, name, target } });
}

export function cassDropIndex(handleId: string, keyspace: string, name: string): Promise<void> {
  return invoke("cassandra_drop_index", { handleId, keyspace, name });
}

export function cassCreateMv(
  handleId: string,
  keyspace: string,
  table: string,
  name: string,
  partitionKey: string[],
  clustering: string[],
): Promise<void> {
  return invoke("cassandra_create_mv", {
    handleId,
    request: { keyspace, table, name, partitionKey, clustering },
  });
}

export function cassDropMv(handleId: string, keyspace: string, name: string): Promise<void> {
  return invoke("cassandra_drop_mv", { handleId, keyspace, name });
}

export function cassCreateKeyspace(
  handleId: string,
  name: string,
  replication: Record<string, string | number>,
  durableWrites: boolean,
): Promise<void> {
  return invoke("cassandra_create_keyspace", {
    handleId,
    request: { name, replication, durableWrites },
  });
}

export interface CassCreateColumnDef {
  name: string;
  type: string;
  kind: ColumnKind;
}
export interface CassCreateClusteringDef {
  name: string;
  order: string;
}

export function cassCreateTable(
  handleId: string,
  keyspace: string,
  name: string,
  columns: CassCreateColumnDef[],
  partitionKey: string[],
  clustering: CassCreateClusteringDef[],
  comment: string,
): Promise<void> {
  return invoke("cassandra_create_table", {
    handleId,
    request: { keyspace, name, columns, partitionKey, clustering, comment },
  });
}

/** The full primary-key column names (partition + clustering), in order. */
export function keyColumns(t: TableDescriptor): string[] {
  return [...t.partitionKey, ...t.clustering.map((c) => c.name)];
}

/** Identity string for a row = its full-primary-key values joined (mirrors the
 *  prototype `keyOf`). Used to stage edits and target CRUD. */
export function keyOf(t: TableDescriptor, row: Row): string {
  return keyColumns(t)
    .map((k) => String(row[k]))
    .join("|");
}

/** The `{ col: value }` map of a row's full primary key. */
export function keyMap(t: TableDescriptor, row: Row): Row {
  const m: Row = {};
  for (const k of keyColumns(t)) m[k] = row[k];
  return m;
}

/** Pretty replication label for the dashboard, e.g. "NetworkTopologyStrategy ·
 *  dc1:3" or "SimpleStrategy · RF 1". */
export function replicationLabel(r: Record<string, string>): string {
  const cls = r.class ?? "—";
  if (cls === "SimpleStrategy") {
    return "SimpleStrategy · RF " + (r.replication_factor ?? "?");
  }
  const dcs = Object.entries(r)
    .filter(([k]) => k !== "class")
    .map(([k, v]) => k + ":" + v)
    .join(", ");
  return cls + (dcs ? " · " + dcs : "");
}
