// Typed invoke() wrappers + wire types for the MongoDB slice's Tauri commands
// (M18). The TS mirrors of the Rust types in `src-tauri/src/shared/mongo.rs` —
// field names camelCase per the serde attributes. Keep the two files in sync.
//
// The renderer speaks plain JSON with the prototype's Extended-JSON tags: an
// ObjectId is `{ $oid }`, an ISODate is `{ $date }` (the `mongo-data.js`
// OID/DATE contract). The adapter does the BSON marshalling, so the renderer
// never sees raw BSON Extended JSON.
//
// Routing: `connectionOpen` (connections/api.ts) returns `kind: "mongo"` for a
// MongoDB connection; the workspace host routes it here. The database +
// collection lists are fetched on mount (no payload rides the open result).

import { invoke } from "@tauri-apps/api/core";

/** An ObjectId, tagged so the UI can render `ObjectId(...)` distinctly. */
export interface OidTag {
  $oid: string;
}
/** An ISODate, tagged so the UI can render `ISODate(...)` distinctly. */
export interface DateTag {
  $date: string;
}

/** A MongoDB document — a schemaless JSON object of plain/tagged values. */
export type MongoDoc = Record<string, unknown>;

/** One index, mirrors Rust's `IndexInfo` / `mongo-data.js` indexes[]. */
export interface IndexInfo {
  name: string;
  keys: Record<string, number>;
  unique?: boolean;
  sparse?: boolean;
}

/** Per-collection descriptor — mirrors Rust's `CollectionDescriptor`. */
export interface CollectionDescriptor {
  name: string;
  count: number;
  indexes: IndexInfo[];
  validator?: unknown;
  storageBytes: number;
  avgDocBytes: number;
}

/** A bounded find request — mirrors Rust's `FindRequest`. `limit` null = All. */
export interface FindRequest {
  filter?: unknown;
  projection?: unknown;
  sort?: unknown;
  /** Page size; omit / null for *All* (the renderer pages with skip). */
  limit?: number | null;
  skip?: number;
}

/** A find result page — mirrors Rust's `FindResult`. */
export interface FindResult {
  docs: MongoDoc[];
  matched: number;
  returned: number;
  ms: number;
  usedIndex?: string;
}

/** An aggregation result — mirrors Rust's `AggregateResult`. */
export interface AggregateResult {
  docs: MongoDoc[];
  returned: number;
  ms: number;
  stages: string[];
}

/** A real explain("executionStats") summary — mirrors Rust's `ExplainResult`. */
export interface ExplainResult {
  namespace: string;
  stage: string;
  indexName?: string;
  nReturned: number;
  docsExamined: number;
  keysExamined: number;
  totalDocs: number;
  ratio: number;
  ms: number;
  plan: unknown;
}

/** One inferred-schema field row — mirrors Rust's `SchemaField`. */
export interface SchemaField {
  path: string;
  types: string[];
  presence: number;
  depth: number;
}

export interface WriteResult {
  matched: number;
  modified: number;
}
export interface DeleteResult {
  deleted: number;
}
export interface InsertManyResult {
  inserted: number;
}

/** A new index to create — mirrors Rust's `CreateIndexSpec`. */
export interface CreateIndexSpec {
  keys: Record<string, number>;
  name?: string;
  unique?: boolean;
  sparse?: boolean;
}

// -- invoke wrappers --------------------------------------------------------

/** `listDatabases` → database names. */
export function mongoListDatabases(handleId: string): Promise<string[]> {
  return invoke<string[]>("mongo_list_databases", { handleId });
}

/** `listCollections` + per-collection stats/indexes for one database. */
export function mongoListCollections(
  handleId: string,
  db: string,
): Promise<CollectionDescriptor[]> {
  return invoke<CollectionDescriptor[]>("mongo_list_collections", { handleId, db });
}

/** One bounded `find` page. */
export function mongoFind(
  handleId: string,
  db: string,
  coll: string,
  request: FindRequest,
): Promise<FindResult> {
  return invoke<FindResult>("mongo_find", { handleId, db, coll, request });
}

/** `countDocuments` for a filter. */
export function mongoCount(
  handleId: string,
  db: string,
  coll: string,
  filter: unknown,
): Promise<number> {
  return invoke<number>("mongo_count", { handleId, db, coll, filter });
}

/** Run an aggregation pipeline. */
export function mongoAggregate(
  handleId: string,
  db: string,
  coll: string,
  pipeline: unknown[],
): Promise<AggregateResult> {
  return invoke<AggregateResult>("mongo_aggregate", { handleId, db, coll, pipeline });
}

/** Real `explain("executionStats")` for a filter/sort. */
export function mongoExplain(
  handleId: string,
  db: string,
  coll: string,
  filter: unknown,
  sort?: unknown,
): Promise<ExplainResult> {
  return invoke<ExplainResult>("mongo_explain", { handleId, db, coll, filter, sort });
}

/** Inferred-schema field union. */
export function mongoInferSchema(
  handleId: string,
  db: string,
  coll: string,
): Promise<SchemaField[]> {
  return invoke<SchemaField[]>("mongo_infer_schema", { handleId, db, coll });
}

/** `listIndexes` for one collection. */
export function mongoListIndexes(handleId: string, db: string, coll: string): Promise<IndexInfo[]> {
  return invoke<IndexInfo[]>("mongo_list_indexes", { handleId, db, coll });
}

/** `insertOne` — returns the inserted `_id` tagged value. */
export function mongoInsertOne(
  handleId: string,
  db: string,
  coll: string,
  doc: MongoDoc,
): Promise<unknown> {
  return invoke<unknown>("mongo_insert_one", { handleId, db, coll, doc });
}

/** `replaceOne` by `_id`. */
export function mongoReplaceOne(
  handleId: string,
  db: string,
  coll: string,
  id: unknown,
  doc: MongoDoc,
): Promise<WriteResult> {
  return invoke<WriteResult>("mongo_replace_one", { handleId, db, coll, id, doc });
}

/** `deleteOne` by `_id`. */
export function mongoDeleteOne(
  handleId: string,
  db: string,
  coll: string,
  id: unknown,
): Promise<DeleteResult> {
  return invoke<DeleteResult>("mongo_delete_one", { handleId, db, coll, id });
}

/** Chunked `insertMany` import. */
export function mongoInsertMany(
  handleId: string,
  db: string,
  coll: string,
  docs: MongoDoc[],
): Promise<InsertManyResult> {
  return invoke<InsertManyResult>("mongo_insert_many", { handleId, db, coll, docs });
}

/** `createIndex`. */
export function mongoCreateIndex(
  handleId: string,
  db: string,
  coll: string,
  spec: CreateIndexSpec,
): Promise<string> {
  return invoke<string>("mongo_create_index", { handleId, db, coll, spec });
}

/** `collMod` the `$jsonSchema` validator (null clears it). */
export function mongoSetValidator(
  handleId: string,
  db: string,
  coll: string,
  validator: unknown | null,
): Promise<void> {
  return invoke("mongo_set_validator", { handleId, db, coll, validator });
}
