// Getting a live connection for each side of a comparison (M28).
//
// The diff compares two *saved* connections, but a workspace only holds the one
// it was opened with. So each side is resolved to a handle:
//
//   - already open as a workspace → reuse that handle (and the schema the user
//     is standing on). Borrowed, never closed here — the workspace owns it.
//   - otherwise → open it transiently from the registry (secrets come from the
//     OS keychain, as everywhere else). Owned, and closed when the diff unmounts.
//
// Handles are cached per comparison so swapping direction, re-picking a side, or
// re-rendering never reopens a connection.

import {
  connectionOpen,
  connectionClose,
  type ConnectionParams,
  type SavedConnection,
  type SchemaInfo,
} from "../connections/api";
import type { Engine } from "../../shared/types";

/** Engines the diff can compare — the ones with a column/index snapshot. */
export const DIFF_ENGINES: readonly Engine[] = ["postgres", "mysql", "sqlite"];

/** Whether a saved connection can appear in either card's picker. */
export function isDiffable(conn: SavedConnection): boolean {
  return DIFF_ENGINES.includes(conn.engine);
}

/** A resolved side of the comparison: which handle, and which schemas it has. */
export interface DiffHandle {
  handleId: string;
  /** Where the side starts — the user can pick any other name in `schemas`. */
  schema: string;
  /** Every schema the connection exposes, for the card's schema picker. */
  schemas: string[];
  /** True when we opened it and must close it again. */
  owned: boolean;
}

/**
 * The schema a connection is diffed on when the user is not already standing on
 * one: the engine's home schema when the connection lists it, else whatever the
 * engine listed first.
 *
 * - **SQLite** — `main` (attached databases are the exception, not the default).
 * - **Postgres** — `public`; a Postgres *database* is chosen by the connection,
 *   the schema is a namespace inside it.
 * - **MySQL** — schema *is* the database, so the connection's own `database`.
 */
export function defaultSchemaFor(params: ConnectionParams, schemas: SchemaInfo[]): string {
  const names = schemas.map((s) => s.name);
  const prefer = (name: string | undefined) =>
    name !== undefined && names.includes(name) ? name : undefined;
  if (params.engine === "sqlite") return prefer("main") ?? names[0] ?? "main";
  if (params.engine === "postgres") return prefer("public") ?? names[0] ?? "public";
  if (params.engine === "mysql") return prefer(params.database) ?? names[0] ?? "";
  return names[0] ?? "";
}

/**
 * A handle for `conn`, reusing an already-open workspace when `borrow` supplies
 * one. `borrow` is how the caller injects the workspaces store without this
 * module depending on it.
 *
 * The returned `schema` is only where the side *starts*: the card's schema
 * picker offers every name in `schemas`, so a multi-schema database is fully
 * reachable from either side of the diff.
 */
export async function acquireHandle(
  conn: SavedConnection,
  borrow: (connectionId: string) => { handleId: string; schema: string; schemas: string[] } | null,
): Promise<DiffHandle> {
  const open = borrow(conn.id);
  if (open) {
    return { handleId: open.handleId, schema: open.schema, schemas: open.schemas, owned: false };
  }
  const result = await connectionOpen({ id: conn.id });
  return {
    handleId: result.handleId,
    schema: defaultSchemaFor(conn.params, result.schemas),
    schemas: result.schemas.map((s) => s.name),
    owned: true,
  };
}

/** Close a handle this feature opened; borrowed ones are left alone. */
export async function releaseHandle(handle: DiffHandle): Promise<void> {
  if (!handle.owned) return;
  // A failed close is not worth surfacing: the comparison is already over and
  // the backend drops the handle when the app exits.
  await connectionClose(handle.handleId).catch(() => undefined);
}
