// Typed invoke() wrappers + wire types for the DynamoDB (document-store) slice's
// Tauri commands (M17). The TS mirrors of the Rust types in
// `src-tauri/src/shared/document.rs` — field names camelCase, enum values
// snake_case per the serde attributes. Keep the two files in sync.
//
// The renderer never sees DynamoDB-typed JSON: an *item* is a plain JSON object
// of already-unmarshalled values (the adapter does the AttributeValue
// translation), modeled here as `DynamoItem`.
//
// Routing: `connectionOpen` (connections/api.ts) returns `kind: "document"` for
// DynamoDB; the workspace host routes it here. The table list is fetched on
// mount via `dynamoListTables` (no initial payload rides the open result).

import { invoke } from "@tauri-apps/api/core";

/** A DynamoDB item — a schemaless JSON object of plain (unmarshalled) values. */
export type DynamoItem = Record<string, unknown>;

/** A table's primary key schema. `sk` absent ⇒ partition-only. */
export interface KeySchema {
  pk: string;
  sk?: string;
}

/** One secondary index (GSI or LSI) — mirrors Rust's `SecondaryIndex`. */
export interface SecondaryIndex {
  name: string;
  pk: string;
  sk?: string;
  /** `ALL` / `KEYS_ONLY` / `INCLUDE`. */
  projection: string;
}

/**
 * Per-table descriptor from `DescribeTable`, mapped to the `dynamo-data.js`
 * shape — mirrors Rust's `TableDescriptor`. Item/size counts are approximate
 * (from `DescribeTable`, never a scan).
 */
export interface TableDescriptor {
  name: string;
  keySchema: KeySchema;
  attrTypes: Record<string, string>;
  gsis: SecondaryIndex[];
  lsis: SecondaryIndex[];
  billing: string;
  rcu?: number;
  wcu?: number;
  ttlAttribute?: string;
  itemCount: number;
  sizeBytes: number;
  status: string;
  created?: string;
}

/** Sort-key comparison operators (snake_case on the wire). */
export type SortKeyOp = "eq" | "lt" | "lte" | "gt" | "gte" | "begins_with" | "between";

/** A bounded scan request — mirrors Rust's `ScanRequest`. */
export interface ScanRequest {
  limit: number;
  nextToken?: string;
  /** Comma-separated attribute names to return (ProjectionExpression); omit for all. */
  projection?: string;
}

/** A query request — mirrors Rust's `QueryRequest`. */
export interface QueryRequest {
  pkValue: string;
  skOp?: SortKeyOp;
  skValue?: string;
  skValue2?: string;
  index?: string;
  limit: number;
  nextToken?: string;
  /** Comma-separated attribute names to return (ProjectionExpression); omit for all. */
  projection?: string;
}

/** One page of a scan/query — mirrors Rust's `ItemPage`. */
export interface ItemPage {
  items: DynamoItem[];
  count: number;
  scannedCount: number;
  capacity: number;
  indexName?: string;
  nextToken?: string;
}

/** A PartiQL `ExecuteStatement` result — mirrors Rust's `StatementResult`. */
export interface StatementResult {
  columns: string[];
  items: DynamoItem[];
  count: number;
  op: string;
  nextToken?: string;
}

/** A chunked `BatchWriteItem` outcome — mirrors Rust's `BatchWriteResult`. */
export interface BatchWriteResult {
  written: number;
  unprocessed: number;
}

// -- invoke wrappers --------------------------------------------------------

/** `ListTables` — returns only table names (no `DescribeTable` per table). */
export function dynamoListTableNames(handleId: string): Promise<string[]> {
  return invoke<string[]>("dynamo_list_table_names", { handleId });
}

/** `ListTables` + per-table `DescribeTable`. */
export function dynamoListTables(handleId: string): Promise<TableDescriptor[]> {
  return invoke<TableDescriptor[]>("dynamo_list_tables", { handleId });
}

/** `DescribeTable` for one table. */
export function dynamoDescribeTable(handleId: string, table: string): Promise<TableDescriptor> {
  return invoke<TableDescriptor>("dynamo_describe_table", { handleId, table });
}

/** One bounded `Scan` page (Limit + continuation token). */
export function dynamoScan(
  handleId: string,
  table: string,
  request: ScanRequest,
): Promise<ItemPage> {
  return invoke<ItemPage>("dynamo_scan", { handleId, table, request });
}

/** One `Query` page (key-condition + optional GSI/LSI). */
export function dynamoQuery(
  handleId: string,
  table: string,
  request: QueryRequest,
): Promise<ItemPage> {
  return invoke<ItemPage>("dynamo_query", { handleId, table, request });
}

/** `GetItem` by full primary key. */
export function dynamoGetItem(
  handleId: string,
  table: string,
  key: DynamoItem,
): Promise<DynamoItem | null> {
  return invoke<DynamoItem | null>("dynamo_get_item", { handleId, table, key });
}

/** `PutItem` — create/overwrite a whole item. */
export function dynamoPutItem(handleId: string, table: string, item: DynamoItem): Promise<void> {
  return invoke("dynamo_put_item", { handleId, table, item });
}

/** `DeleteItem` by full primary key. */
export function dynamoDeleteItem(handleId: string, table: string, key: DynamoItem): Promise<void> {
  return invoke("dynamo_delete_item", { handleId, table, key });
}

/** Chunked `BatchWriteItem` import. */
export function dynamoBatchWrite(
  handleId: string,
  table: string,
  items: DynamoItem[],
): Promise<BatchWriteResult> {
  return invoke<BatchWriteResult>("dynamo_batch_write", { handleId, table, items });
}

/** Chunked `BatchWriteItem` delete-by-key (grid multi-select). Each key holds
 *  the table's PK (and SK for a composite-key table). */
export function dynamoBatchDelete(
  handleId: string,
  table: string,
  keys: DynamoItem[],
): Promise<BatchWriteResult> {
  return invoke<BatchWriteResult>("dynamo_batch_delete", { handleId, table, keys });
}

/** `ExecuteStatement` (PartiQL). `nextToken` paginates a prior statement. */
export function dynamoExecuteStatement(
  handleId: string,
  statement: string,
  nextToken?: string,
): Promise<StatementResult> {
  return invoke<StatementResult>("dynamo_execute_statement", { handleId, statement, nextToken });
}
