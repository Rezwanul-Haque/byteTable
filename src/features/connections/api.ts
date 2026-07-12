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
      // `database` + `user` optional: omitted, MySQL connects with no default
      // schema / the server's default user (passwordless/socket auth).
      engine: "mysql";
      host: string;
      port: number;
      database?: string;
      user?: string;
      tlsMode: TlsMode;
      ssh?: SshConfig;
    }
  | {
      // `database` + `user` optional: omitted, libpq defaults the database to
      // the user name and the user to the OS role.
      engine: "postgres";
      host: string;
      port: number;
      database?: string;
      user?: string;
      tlsMode: TlsMode;
      ssh?: SshConfig;
    }
  | {
      // SQL Server (M21). Same relational shape as MySQL/Postgres — `database`
      // + `user` optional (omitted, the driver connects to the login's default
      // database with the server's default user). Default port 1433. Password +
      // SSH secrets live in the OS keychain.
      engine: "mssql";
      host: string;
      port: number;
      database?: string;
      user?: string;
      tlsMode: TlsMode;
      ssh?: SshConfig;
    }
  | {
      // Redis (M13). No relational `database`; instead a numbered logical db
      // (`dbIndex`, 0–15, default 0). `user` is the optional ACL username
      // (absent → the Redis `default` user). Password + SSH secrets live in the
      // keychain like the SQL server engines.
      engine: "redis";
      host: string;
      port: number;
      dbIndex: number;
      user?: string;
      tlsMode: TlsMode;
      ssh?: SshConfig;
    }
  | {
      // DynamoDB (M17). No relational `database`, no SSH tunnel, no TLS knob
      // (the AWS SDK manages HTTPS). `region` is the AWS region; `endpoint` is
      // set only for DynamoDB Local / LocalStack (absent → real AWS). `auth`
      // picks the credential mode; the secret access key (for `keys` auth) lives
      // in the OS keychain like the SQL server password.
      engine: "dynamodb";
      region: string;
      endpoint?: string;
      auth: DynamoAuth;
    }
  | {
      // MongoDB (M18). Two connect shapes (the modal's Host/port ⇄ Connection
      // string toggle): when `uri` is present it is a full `mongodb://` /
      // `mongodb+srv://` (Atlas SRV) string and host/port/database/user are
      // ignored; otherwise the connector assembles a URI from the fields. The
      // password (either mode) lives in the OS keychain, never in params.
      engine: "mongodb";
      uri?: string;
      host: string;
      port: number;
      database?: string;
      user?: string;
      tlsMode: TlsMode;
    }
  | {
      // Cassandra (M19). A wide-column store reached over the native (CQL)
      // protocol. `contactPoints` is the host (or comma-separated list of hosts)
      // the driver connects to and discovers the ring from; `port` is the native
      // port (default 9042). `keyspace` (optional) is the initial keyspace;
      // `localDatacenter` (optional, e.g. `dc1`) enables token-aware DC-local
      // routing; `user` is the optional auth username. The password lives in the
      // OS keychain, never in params. No SSH tunnel (mirrors DynamoDB / MongoDB).
      engine: "cassandra";
      contactPoints: string;
      port: number;
      keyspace?: string;
      localDatacenter?: string;
      user?: string;
      tlsMode: TlsMode;
    };

/**
 * DynamoDB credential mode (M17) — mirrors Rust's `DynamoAuth`, tagged with
 * `mode`. The `keys` variant carries only the NON-secret access-key id; the
 * secret access key is sent transiently and stored in the keychain.
 */
export type DynamoAuth =
  | { mode: "profile"; profile: string }
  | { mode: "keys"; accessKeyId: string };

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
  /**
   * Tile/accent color for this connection (m15 env picker). The new-connection
   * modal stores the env's chosen swatch here; the workspace uses it for the
   * rail tile + sidebar bar (falling back to the auto-cycle palette when
   * absent — connections saved before m15, or the SQLite file auto-open).
   * Optional + omitted-when-absent on the Rust side.
   */
  color?: string;
  /** Optional project label for grouping connections on the connect screen
   *  (absent ⇒ "Ungrouped"). Assigned/created in the new-connection modal. */
  project?: string;
  createdAt?: number;
}

/**
 * The engine *family* of an open connection (M13) — the discriminator the
 * renderer routes on: `"sql"` → the relational workspace, `"kv"` → the Redis
 * workspace. Lowercase on the wire, mirroring Rust's `ConnectionKind`.
 */
export type ConnectionKind = "sql" | "kv" | "document" | "mongo" | "cassandra";

/**
 * Server identity for the Redis dashboard header — mirrors Rust's
 * `KvServerInfo`. (Re-exported from `browse/redis/api.ts` for the Redis slice.)
 */
export interface KvServerInfo {
  serverVersion: string;
  mode: string;
  role: string;
  respVersion: number;
}

/** Per-database key count from `INFO keyspace` — mirrors Rust's `KvDbInfo`. */
export interface KvDbInfo {
  index: number;
  keyCount: number;
}

/**
 * The initial Redis payload returned alongside the open handle (M13) — mirrors
 * Rust's `KeyspaceOverview`: the dashboard header identity + per-db key counts,
 * so the Redis workspace renders immediately.
 */
export interface KeyspaceOverview {
  serverInfo: KvServerInfo;
  databases: KvDbInfo[];
}

/**
 * What `connection_open` returns — mirrors Rust's `OpenedConnection`: the
 * opaque handle id every follow-up command takes, plus what opening learned.
 *
 * M13 added `kind` (the engine family — drives workspace routing) and the two
 * mutually-exclusive initial payloads:
 * - `kind: "sql"` → `schemas` holds the initial schema list, `keyspace` absent.
 * - `kind: "kv"` → `schemas` is empty, `keyspace` carries the Redis overview
 *   (server identity + per-db key counts). Per-key reads/scans are fetched on
 *   demand via the `kv*` wrappers in `browse/redis/api.ts`.
 *
 * The SQL open-result is unchanged except for the additive `kind`/`keyspace`
 * fields, which a relational renderer can ignore.
 */
export interface OpenResult {
  handleId: string;
  engineInfo: EngineInfo;
  kind: ConnectionKind;
  schemas: SchemaInfo[];
  keyspace?: KeyspaceOverview;
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
  // Redis has numbered logical dbs (db{N}) rather than a relational database
  // name (REDIS_SPEC §1: "cache.byteshop.io:6379 · db0").
  if (params.engine === "redis") {
    return params.host + ":" + params.port + " · db" + params.dbIndex;
  }
  // DynamoDB: "<region> · Local" for a custom endpoint, else "<region> · AWS".
  if (params.engine === "dynamodb") {
    return params.region + (params.endpoint ? " · Local" : " · AWS");
  }
  // MongoDB: the connection string itself when in URI mode, else "host:port · db".
  if (params.engine === "mongodb") {
    if (params.uri) return params.uri;
    return params.database
      ? params.host + ":" + params.port + " · " + params.database
      : params.host + ":" + params.port;
  }
  // Cassandra: "<contactPoints>:<port> · <keyspace>" (prototype detail
  // "127.0.0.1:9042 · byteshop"). The contact-points field may already carry a
  // port per host; the modal stores a bare host, so append the native port.
  if (params.engine === "cassandra") {
    const points = params.contactPoints.includes(":")
      ? params.contactPoints
      : params.contactPoints + ":" + params.port;
    return params.keyspace ? points + " · " + params.keyspace : points;
  }
  // database is optional now; omit the " · db" suffix when absent.
  return params.database
    ? params.host + ":" + params.port + " · " + params.database
    : params.host + ":" + params.port;
}

/**
 * Whether a connection is reached through an SSH bastion tunnel (M12 Task 3) —
 * drives the lock indicator in the sidebar header and status bar. Always false
 * for SQLite (it never tunnels) and for direct server connections.
 */
export function connectionIsTunneled(params: ConnectionParams): boolean {
  // Only the server engines carry an `ssh` field; SQLite (local file) and
  // DynamoDB (HTTPS to AWS) never tunnel.
  if (
    params.engine === "sqlite" ||
    params.engine === "dynamodb" ||
    params.engine === "mongodb" ||
    params.engine === "cassandra"
  )
    return false;
  return params.ssh !== undefined;
}

/**
 * Hover title for the tunnel-lock indicator, naming the bastion the connection
 * routes through (e.g. "Tunnelled through tunnel@bastion.example.com:22").
 * Returns "" when the connection is not tunnelled.
 */
export function tunnelTitle(params: ConnectionParams): string {
  if (
    params.engine === "sqlite" ||
    params.engine === "dynamodb" ||
    params.engine === "mongodb" ||
    params.engine === "cassandra"
  )
    return "";
  if (params.ssh === undefined) return "";
  const { user, host, port } = params.ssh;
  return "Tunnelled through " + user + "@" + host + ":" + port;
}
