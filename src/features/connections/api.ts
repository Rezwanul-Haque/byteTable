// Typed invoke() wrappers for the connections slice's Tauri commands, plus
// the TS mirrors of the Rust wire types. Field names are camelCase and enum
// values lowercase per the serde attributes on the Rust side — keep in sync
// with `src-tauri/src/shared/engine.rs` and
// `src-tauri/src/features/connections/domain/mod.rs`.
//
// This module (with state.ts) is the slice's public contract: other slices
// (workspaces) import these types and wrappers rather than reaching into
// internals.

import { invoke } from "@tauri-apps/api/core";

import type { Engine, Env } from "../../shared/types";

/**
 * Everything needed to reach a database, per engine. Internally tagged with
 * `engine`, mirroring Rust's `ConnectionParams` — so the tag doubles as the
 * discriminant of this union.
 *
 * Server variants have NO password field by design: secrets go to the OS
 * keychain in M12 and never cross the wire as part of params.
 */
export type ConnectionParams =
  | { engine: "sqlite"; path: string }
  | { engine: "mysql"; host: string; port: number; database: string; user: string; tls: boolean }
  | {
      engine: "postgres";
      host: string;
      port: number;
      database: string;
      user: string;
      tls: boolean;
    };

/**
 * A connection the user has saved in the registry. Mirrors Rust's
 * `SavedConnection`: `engine` is denormalized from `params` (the backend
 * rejects mismatches), `id` is assigned on first save (send "" for new
 * entries), `createdAt` is epoch milliseconds and absent until first save.
 */
export interface SavedConnection {
  id: string;
  name: string;
  engine: Engine;
  params: ConnectionParams;
  env: Env;
  createdAt?: number;
}

/** What a successful test/open learned about the target. */
export interface EngineInfo {
  engine: Engine;
  /** Display version string, e.g. "SQLite 3.46.0". */
  serverVersion: string;
}

/** A schema (SQLite: `main` + attached databases). */
export interface SchemaInfo {
  name: string;
  /** Number of user tables, when cheaply known (`null` otherwise). */
  tableCount: number | null;
}

/** A table within a schema. */
export interface TableInfo {
  name: string;
  /** Approximate row count, when cheaply known (`null` otherwise). */
  approxRowCount: number | null;
}

/** Column metadata accompanying a query result. */
export interface ColumnMeta {
  name: string;
  /** Best-effort type label — a display hint, never for logic. */
  typeHint: string;
}

/** Options for a single query execution (backend defaults: rowLimit 500). */
export interface QueryOptions {
  rowLimit?: number;
  schema?: string;
}

/**
 * One result cell. Engine values map to JSON: NULL → null, integers/reals →
 * numbers, text → strings; integers beyond ±2^53 arrive as strings to
 * preserve precision (see the SQLite adapter docs).
 */
export type CellValue = string | number | null;

/** The outcome of a query: column metadata, row-major values, timing. */
export interface QueryResult {
  columns: ColumnMeta[];
  rows: CellValue[][];
  rowCount: number;
  truncated: boolean;
  elapsedMs: number;
}

/**
 * What `connection_open` returns — mirrors Rust's `OpenedConnection`:
 * the opaque handle id every follow-up command takes, plus what opening
 * learned (engine info + initial schema list).
 */
export interface OpenResult {
  handleId: string;
  engineInfo: EngineInfo;
  schemas: SchemaInfo[];
}

/**
 * `connection_open` opens a saved entry by id *or* ad-hoc params ("Open
 * SQLite file…") — exactly one, enforced by the backend and by this union.
 */
export type OpenTarget =
  | { id: string; params?: undefined }
  | { params: ConnectionParams; id?: undefined };

export function connectionList(): Promise<SavedConnection[]> {
  return invoke<SavedConnection[]>("connection_list");
}

/** Insert or update; returns the stored value (with assigned id/createdAt). */
export function connectionSave(connection: SavedConnection): Promise<SavedConnection> {
  return invoke<SavedConnection>("connection_save", { connection });
}

export function connectionDelete(id: string): Promise<void> {
  return invoke("connection_delete", { id });
}

/** Probe the target without keeping a connection open ("Test connection"). */
export function connectionTest(params: ConnectionParams): Promise<EngineInfo> {
  return invoke<EngineInfo>("connection_test", { params });
}

export function connectionOpen(target: OpenTarget): Promise<OpenResult> {
  return invoke<OpenResult>("connection_open", { id: target.id, params: target.params });
}

export function connectionClose(handleId: string): Promise<void> {
  return invoke("connection_close", { handleId });
}

export function connectionSchemas(handleId: string): Promise<SchemaInfo[]> {
  return invoke<SchemaInfo[]>("connection_schemas", { handleId });
}

export function connectionTables(handleId: string, schema: string): Promise<TableInfo[]> {
  return invoke<TableInfo[]>("connection_tables", { handleId, schema });
}

export function queryRun(
  handleId: string,
  sql: string,
  options?: QueryOptions,
): Promise<QueryResult> {
  return invoke<QueryResult>("query_run", { handleId, sql, options });
}

/**
 * Display line for a connection card or workspace header, derived from
 * params: file path for SQLite, "host:port · db" for server engines
 * (replaces the mock `Connection.detail` field).
 */
export function connectionDetail(params: ConnectionParams): string {
  if (params.engine === "sqlite") return params.path;
  return params.host + ":" + params.port + " · " + params.database;
}
