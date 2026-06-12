// Typed invoke() wrappers for the connections slice's Tauri commands, plus
// the TS mirrors of the Rust wire types. Field names are camelCase and enum
// values lowercase per the serde attributes on the Rust side — keep in sync
// with `src-tauri/src/features/connections/domain/mod.rs`. Engine-level
// wire types (EngineInfo, SchemaInfo, query results, …) live in
// `src/shared/api/engine.ts` and are re-exported here for back-compat.
//
// ARCHITECTURE pattern: this module (with state.ts) is the slice's public
// contract — cross-feature consumption of another feature's `api.ts` /
// `state.ts` is sanctioned; reaching into a feature's internals (components,
// hooks) is not.

import { invoke } from "@tauri-apps/api/core";

import type { EngineInfo, SchemaInfo, TableInfo } from "../../shared/api/engine";
import type { Engine, Env } from "../../shared/types";

export {
  queryRun,
  type CellValue,
  type ColumnMeta,
  type EngineInfo,
  type QueryOptions,
  type QueryResult,
  type SchemaInfo,
  type TableInfo,
} from "../../shared/api/engine";

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

/**
 * Display line for a connection card or workspace header, derived from
 * params: file path for SQLite, "host:port · db" for server engines
 * (replaces the mock `Connection.detail` field).
 */
export function connectionDetail(params: ConnectionParams): string {
  if (params.engine === "sqlite") return params.path;
  return params.host + ":" + params.port + " · " + params.database;
}
