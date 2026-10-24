// Matrix cell resolution (M39) — pure, so it is unit-testable without React.
//
// The backend's effective resolver folds ROLE inheritance (and fills `via`),
// but it deliberately does not collapse WILDCARD scopes: expanding a
// `GRANT … ON *.*` needs the object list, and only this layer has it. So a
// global grant and a narrower deny arrive as two separate entries, and filling
// one cell means choosing between every entry whose scope covers it.
//
// The order is SPECIFICITY FIRST, state second. Reversed, it inverts real
// configurations: on ClickHouse, `GRANT SELECT ON *.*` followed by
// `REVOKE SELECT ON system.*` produces exactly a global `granted` and a
// schema-scoped `denied`, and only specificity-first reports `system` as
// denied. (Verified against clickhouse-server 24.10.)

import type { GrantEntry, PrivilegeState } from "./api";

/** How much access a state represents, for tie-breaks at equal specificity.
 *  `denied` outranks everything — mirrors Rust `PrivilegeState::rank`. */
const STATE_RANK: Record<PrivilegeState, number> = {
  none: 0,
  granted: 1,
  grantable: 2,
  denied: 3,
};

/** The privilege tokens that stand for "every privilege". A grant of one of
 *  these fills every column, but loses to an entry naming the privilege. */
const ALL_PRIVILEGES = new Set(["ALL", "ALL PRIVILEGES"]);

/** A resolved cell: the winning entry's state plus the chain it came through. */
export interface Cell {
  state: PrivilegeState;
  /** The role chain, nearest first; empty when granted directly. */
  via: string[];
  /** True when the winning entry was a wildcard rather than a grant naming
   *  this object — the UI marks these so an inherited-from-`*.*` cell is not
   *  mistaken for a grant someone wrote against this table. */
  wildcard: boolean;
}

/**
 * How narrowly an entry is scoped: `2` one object, `1` a whole schema, `0`
 * global. Mirrors Rust `GrantEntry::specificity`.
 */
export function specificity(grant: GrantEntry): number {
  if (grant.schema && grant.object) return 2;
  if (grant.schema) return 1;
  return 0;
}

/** Does this entry's scope cover `schema.object`? */
function coversScope(grant: GrantEntry, schema: string, object: string): boolean {
  if (grant.schema && grant.schema !== schema) return false;
  if (grant.object && grant.object !== object) return false;
  return true;
}

/** `1` when the entry names this privilege, `0` when it is an ALL wildcard,
 *  `-1` when it is unrelated. */
function coversPrivilege(grant: GrantEntry, privilege: string): number {
  if (grant.privilege === privilege) return 1;
  if (ALL_PRIVILEGES.has(grant.privilege)) return 0;
  return -1;
}

/**
 * Resolve one cell from the entries held by a single grantee.
 *
 * Returns `null` when nothing covers it — an empty cell, which the UI renders
 * as a dim dash rather than inventing a `none` entry.
 */
export function fillCell(
  grants: GrantEntry[],
  schema: string,
  object: string,
  privilege: string,
): Cell | null {
  let best: GrantEntry | null = null;
  let bestScope = -1;
  let bestPriv = -1;

  for (const grant of grants) {
    if (!coversScope(grant, schema, object)) continue;
    const priv = coversPrivilege(grant, privilege);
    if (priv < 0) continue;

    const scope = specificity(grant);
    // Specificity first (scope, then how precisely the privilege is named),
    // and only then how much access the state represents.
    const better =
      best === null ||
      scope > bestScope ||
      (scope === bestScope && priv > bestPriv) ||
      (scope === bestScope &&
        priv === bestPriv &&
        STATE_RANK[grant.state] > STATE_RANK[best.state]);

    if (better) {
      best = grant;
      bestScope = scope;
      bestPriv = priv;
    }
  }

  if (!best) return null;
  return {
    state: best.state,
    via: best.via ?? [],
    wildcard: bestScope < 2 || bestPriv === 0,
  };
}

/** Group entries by grantee once, so the matrix does not rescan the whole
 *  grant list per cell. */
export function grantsByGrantee(grants: GrantEntry[]): Map<string, GrantEntry[]> {
  const out = new Map<string, GrantEntry[]>();
  for (const grant of grants) {
    const bucket = out.get(grant.grantee);
    if (bucket) bucket.push(grant);
    else out.set(grant.grantee, [grant]);
  }
  return out;
}

/**
 * The objects the matrix should show as rows: the schema's own tables, plus
 * any object a grant names that the table list does not already cover (a view,
 * or a table dropped since the grant was written). Grant-named extras come
 * last so the common case reads in catalog order.
 */
export function matrixObjects(tables: string[], grants: GrantEntry[], schema: string): string[] {
  const seen = new Set(tables);
  const extra: string[] = [];
  for (const grant of grants) {
    if (!grant.object) continue;
    if (grant.schema && grant.schema !== schema) continue;
    if (seen.has(grant.object)) continue;
    seen.add(grant.object);
    extra.push(grant.object);
  }
  extra.sort((a, b) => a.localeCompare(b));
  return [...tables, ...extra];
}

/** The roles a principal belongs to, transitively, nearest first.
 *
 *  Cycle-guarded like the backend walk: Postgres and MySQL both permit role
 *  cycles, and an unguarded walk would hang the tab rather than fail. */
export function roleChainsFor(
  memberships: { member: string; role: string }[],
  principal: string,
): { role: string; depth: number }[] {
  const rolesOf = new Map<string, string[]>();
  for (const edge of memberships) {
    const bucket = rolesOf.get(edge.member);
    if (bucket) bucket.push(edge.role);
    else rolesOf.set(edge.member, [edge.role]);
  }

  const out: { role: string; depth: number }[] = [];
  const seen = new Set<string>([principal]);
  let frontier = [principal];
  let depth = 1;

  while (frontier.length) {
    const next: string[] = [];
    for (const name of frontier) {
      for (const role of rolesOf.get(name) ?? []) {
        if (seen.has(role)) continue;
        seen.add(role);
        out.push({ role, depth });
        next.push(role);
      }
    }
    frontier = next;
    depth += 1;
  }
  return out;
}
