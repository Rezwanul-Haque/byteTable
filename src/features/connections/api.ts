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
 * Granular TLS mode for a server connection (M12 Task 3) — mirrors Rust's
 * `TlsMode`, kebab-case on the wire. Replaces the old `tls: boolean`; the
 * backend still reads the legacy boolean from connections saved before Task 3.
 */
export type TlsMode = "disable" | "prefer" | "require" | "verify-ca" | "verify-full";

/**
 * How to authenticate to an SSH bastion (M12 Task 3) — mirrors Rust's
 * `SshAuth`, tagged with `method`. NO secret material: the key passphrase /
 * bastion password are sent separately (transiently) and stored in the OS
 * keychain, never on params.
 */
export type SshAuth =
  | { method: "key"; keyPath: string }
  | { method: "password" }
  | { method: "agent" };

/**
 * An SSH bastion a server connection is tunnelled through (M12 Task 3) —
 * mirrors Rust's `SshConfig`. No secrets here (see {@link SshAuth}).
 */
export interface SshConfig {
  host: string;
  port: number;
  user: string;
  auth: SshAuth;
}

/**
 * Everything needed to reach a database, per engine. Internally tagged with
 * `engine`, mirroring Rust's `ConnectionParams` — so the tag doubles as the
 * discriminant of this union.
 *
 * Server variants have NO password/SSH-secret field by design: secrets go to
 * the OS keychain (M12 Task 3) and never cross the wire as part of params.
 * `tlsMode` carries the granular TLS mode; `ssh` is present when the connection
 * is reached through a bastion.
 */
export type ConnectionParams =
  | { engine: "sqlite"; path: string }
  | {
      engine: "mysql";
      host: string;
      port: number;
      database: string;
      user: string;
      tlsMode: TlsMode;
      ssh?: SshConfig;
    }
  | {
      engine: "postgres";
      host: string;
      port: number;
      database: string;
      user: string;
      tlsMode: TlsMode;
      ssh?: SshConfig;
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

/**
 * Insert or update; returns the stored value (with assigned id/createdAt).
 *
 * `password` / `sshSecret` are the transient secrets the connect modal typed:
 * when present they are stored in the OS keychain keyed by the (assigned)
 * connection id — the registry file stores only non-secret params. Empty/absent
 * leaves any stored secret untouched (re-save without retyping keeps it).
 */
export function connectionSave(
  connection: SavedConnection,
  secrets?: { password?: string; sshSecret?: string },
): Promise<SavedConnection> {
  return invoke<SavedConnection>("connection_save", {
    connection,
    password: secrets?.password,
    sshSecret: secrets?.sshSecret,
  });
}

export function connectionDelete(id: string): Promise<void> {
  return invoke("connection_delete", { id });
}

/**
 * Probe the target without keeping a connection open ("Test connection").
 *
 * `password` / `sshSecret` are the transient secrets typed in the modal, sent
 * only for this call and never persisted. Testing happens before save, so the
 * keychain is not touched here. SQLite ignores both.
 */
export function connectionTest(
  params: ConnectionParams,
  secrets?: { password?: string; sshSecret?: string },
): Promise<EngineInfo> {
  return invoke<EngineInfo>("connection_test", {
    params,
    password: secrets?.password,
    sshSecret: secrets?.sshSecret,
  });
}

/**
 * Open a saved entry by id or ad-hoc params. For a saved id the secrets come
 * from the OS keychain (M12 Task 3); a transiently-typed `password` / `sshSecret`
 * overrides them (first connect before save). SQLite needs no secrets.
 */
export function connectionOpen(
  target: OpenTarget,
  secrets?: { password?: string; sshSecret?: string },
): Promise<OpenResult> {
  return invoke<OpenResult>("connection_open", {
    id: target.id,
    params: target.params,
    password: secrets?.password,
    sshSecret: secrets?.sshSecret,
  });
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

/**
 * Whether a connection is reached through an SSH bastion tunnel (M12 Task 3) —
 * drives the lock indicator in the sidebar header and status bar. Always false
 * for SQLite (it never tunnels) and for direct server connections.
 */
export function connectionIsTunneled(params: ConnectionParams): boolean {
  return params.engine !== "sqlite" && params.ssh !== undefined;
}

/**
 * Hover title for the tunnel-lock indicator, naming the bastion the connection
 * routes through (e.g. "Tunnelled through tunnel@bastion.example.com:22").
 * Returns "" when the connection is not tunnelled.
 */
export function tunnelTitle(params: ConnectionParams): string {
  if (params.engine === "sqlite" || params.ssh === undefined) return "";
  const { user, host, port } = params.ssh;
  return "Tunnelled through " + user + "@" + host + ":" + port;
}
