// Privileges feature (M39) — backend wrapper + per-engine display metadata.
//
// `privilegeSnapshot` invokes the Rust `privilege_snapshot` command (see
// `src-tauri/src/features/privileges`). PRIV_SOURCES carries the per-engine
// bits the UI needs: the system source tag shown in the toolbar, and the
// privilege vocabulary that becomes the matrix columns — the engines genuinely
// disagree about which privileges exist, so there is no shared column set.
//
// Phase 1 is READ-ONLY: there is no grant/revoke wrapper here, and the backend
// exposes no command that could mutate.

import { invoke } from "@tauri-apps/api/core";

import type { Engine } from "../../shared/types";

/** One grantee × privilege × object cell (mirrors Rust `PrivilegeState`).
 *
 *  Four states, not a boolean: SQL Server's `DENY` and ClickHouse's
 *  `is_partial_revoke` both beat an inherited grant, so neither can be
 *  modelled as the absence of one. */
export type PrivilegeState = "none" | "granted" | "grantable" | "denied";

/** Mirrors Rust `PrincipalKind`. `login` is SQL Server's server-level principal,
 *  a different object from the database user it maps to. */
export type PrincipalKind = "user" | "role" | "login";

/** Mirrors Rust `PrincipalScope`. Only SQL Server has two principal spaces. */
export type PrincipalScope = "server" | "database";

/** One row of the Attributes pane (mirrors Rust `PrincipalAttribute`). */
export interface PrincipalAttribute {
  key: string;
  value: string;
}

/** A user / role / login (mirrors Rust `Principal`). */
export interface Principal {
  /** MySQL uses `user@host` — the account identity is the pair, not the name. */
  name: string;
  kind: PrincipalKind;
  scope: PrincipalScope;
  canLogin: boolean;
  /** Rendered as a badge; the matrix is NOT expanded for these, because the
   *  catalog does not record a superuser's implicit privileges at all. */
  isSuperuser: boolean;
  attributes: PrincipalAttribute[];
}

/** `member` belongs to `role` (mirrors Rust `MembershipEdge`). */
export interface MembershipEdge {
  member: string;
  role: string;
  adminOption: boolean;
}

/**
 * One grant (mirrors Rust `GrantEntry`).
 *
 * `schema` / `object` encode wildcards instead of materialising them:
 * - both set — that one object,
 * - `schema` only — every object in it,
 * - neither — every object anywhere (a global grant).
 *
 * Expanding a wildcard is this layer's job, because only the renderer knows
 * which objects are on screen. See `fillCell` in `matrix.ts`.
 */
export interface GrantEntry {
  grantee: string;
  schema?: string;
  object?: string;
  /** The engine's own token, uppercased. Not normalised across engines. */
  privilege: string;
  state: PrivilegeState;
  /** The role chain the grant arrived through, nearest first; absent when it
   *  was granted directly. */
  via?: string[];
}

/** Everything the tab shows, in one round trip (mirrors Rust
 *  `PrivilegeSnapshot`). */
export interface PrivilegeSnapshot {
  principals: Principal[];
  memberships: MembershipEdge[];
  grants: GrantEntry[];
  /** The grant list hit the backend's row cap — the matrix is partial. */
  truncated: boolean;
}

/**
 * Read the connection's privilege catalog.
 *
 * `schema` scopes the grant listing so the matrix stays bounded (wildcard and
 * database-level grants come back regardless). `effective` folds role
 * inheritance in and fills each grant's `via` chain; with it off the caller
 * gets the catalog's literal direct grants.
 */
export function privilegeSnapshot(
  handleId: string,
  schema: string | null,
  effective: boolean,
): Promise<PrivilegeSnapshot> {
  return invoke<PrivilegeSnapshot>("privilege_snapshot", { handleId, schema, effective });
}

/** Per-engine display metadata for the Privileges tab. */
export interface PrivSource {
  /** System source tag shown in the toolbar (e.g. `pg_roles`). */
  src: string;
  /** The matrix columns, in display order — this engine's object-level
   *  privilege vocabulary. */
  privileges: string[];
}

/**
 * Per-engine sources & privilege vocabularies (M39).
 *
 * An engine with no entry here has no privilege catalog ByteTable reads, and
 * the tab shows its empty state: SQLite has no principals at all, Redis ACL is
 * command-categories plus key-globs, MongoDB is role documents over resources,
 * and DynamoDB / Typesense are governed outside the database connection. Those
 * are different models, not missing ones — mapping them into this shape would
 * misreport, so they are deliberately absent. The backend agrees: its
 * `as_privilege_reader` returns `None` for every one of them.
 */
export const PRIV_SOURCES: Partial<Record<Engine, PrivSource>> = {
  postgres: {
    src: "pg_roles",
    privileges: ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"],
  },
  mysql: {
    src: "mysql.user",
    privileges: [
      "SELECT",
      "INSERT",
      "UPDATE",
      "DELETE",
      "CREATE",
      "DROP",
      "ALTER",
      "INDEX",
      "REFERENCES",
    ],
  },
  mssql: {
    src: "sys.database_principals",
    privileges: [
      "SELECT",
      "INSERT",
      "UPDATE",
      "DELETE",
      "EXECUTE",
      "REFERENCES",
      "VIEW DEFINITION",
      "ALTER",
      "CONTROL",
    ],
  },
  clickhouse: {
    src: "system.users",
    privileges: ["SELECT", "INSERT", "ALTER", "CREATE", "DROP", "TRUNCATE", "OPTIMIZE", "SHOW"],
  },
};
