// Sub-workspace scopes (M33) — the engine-agnostic half of the M32 schema
// sub-workspace feature.
//
// M32 shipped nesting for the SQL shell only, but nothing in the store was ever
// SQL-specific: `openSchemaWorkspace` clones the parent workspace whatever its
// kind, and the rail, the cascade-on-close and the session persistence all key
// off `parentId`/`schema` alone. What was missing everywhere else was the entry
// point and a name for the thing being scoped to — a Cassandra workspace nests
// per keyspace, Mongo and Redis per database.
//
// Two engines have no scope level and deliberately get no split action:
// DynamoDB (tables sit directly under the account — there is no schema to pick)
// and Typesense (collections are the top level, so a "collection workspace"
// would be a tab, not a workspace).

import { useMemo } from "react";

import type { Engine } from "../../shared/types";
import { useToast } from "../../shared/ui/toastContext";
import { useWorkspacesStore } from "./state";
import type { Workspace } from "./types";

/** Engines whose workspaces can be split into sub-workspaces. */
const SCOPE_NOUNS: Partial<Record<Engine, string>> = {
  sqlite: "schema",
  mysql: "schema",
  postgres: "schema",
  mssql: "schema",
  clickhouse: "schema",
  cassandra: "keyspace",
  mongodb: "database",
  redis: "database",
};

/**
 * What this engine calls the thing a sub-workspace scopes to, lower-case for
 * mid-sentence use ("Open “sales” as its own workspace" needs no noun; the rail
 * header and the close action do). Null for the engines with no scope level,
 * which is also the "can this be split at all?" test.
 */
export function scopeNoun(engine: Engine): string | null {
  return SCOPE_NOUNS[engine] ?? null;
}

/** `scopeNoun` capitalized, for a label that starts a phrase. */
export function scopeNounTitle(engine: Engine): string | null {
  const noun = scopeNoun(engine);
  return noun ? noun[0]?.toUpperCase() + noun.slice(1) : null;
}

/**
 * The split-action plumbing every engine's scope switcher needs: which scopes
 * already have a workspace, and the create-or-focus action.
 *
 * Nesting is ONE level, so this always attaches to `parentId ?? id` — opening a
 * keyspace from inside a keyspace workspace produces a sibling, not a
 * grandchild (the M32 rule, kept engine-wide).
 */
export function useScopeWorkspaces(workspace: Workspace): {
  openedScopes: string[];
  openScope: (scope: string) => void;
} {
  const openSchemaWorkspace = useWorkspacesStore((state) => state.openSchemaWorkspace);
  const toast = useToast();
  const railParentId = workspace.parentId ?? workspace.id;

  // Selects the STABLE `workspaces` array and derives outside the selector.
  // Returning `.filter().map()` straight from a zustand v5 selector hands
  // `useSyncExternalStore` a new array identity on every call, so React sees
  // the snapshot change on every render and loops until it tears the tree down
  // — a blank window with nothing in the backend logs.
  const allWorkspaces = useWorkspacesStore((state) => state.workspaces);
  const openedScopes = useMemo(
    () =>
      allWorkspaces
        .filter((ws) => ws.parentId === railParentId && ws.schema)
        .map((ws) => ws.schema as string),
    [allWorkspaces, railParentId],
  );

  const noun = scopeNounTitle(workspace.saved.engine) ?? "Schema";
  const openScope = (scope: string) => {
    openSchemaWorkspace(railParentId, scope);
    // Only announce the temporary state for a NEW workspace: re-opening an
    // existing one just focuses it, and saying "temporary" then would be wrong.
    if (!openedScopes.includes(scope)) {
      toast(
        noun + " “" + scope + "” opened as a temporary workspace — ⌘-click its tile to keep it",
        "ok",
      );
    }
  };

  return { openedScopes, openScope };
}
