import { describe, expect, it } from "vitest";

import type { GrantCapabilities, PrivilegeState } from "./api";
import type { CellFacts } from "./edit";
import { blockedReason, cellKey, editableStates, opsForTransition, stagedOps } from "./edit";

const PG: GrantCapabilities = { canDeny: false, atomic: true, canNarrowWildcard: true };
const MSSQL: GrantCapabilities = { canDeny: true, atomic: true, canNarrowWildcard: true };
const MYSQL: GrantCapabilities = {
  canDeny: false,
  atomic: false,
  canNarrowWildcard: false,
};

const SCOPE = { schema: "shop", object: "orders" };

function ops(from: PrivilegeState, to: PrivilegeState) {
  return opsForTransition("app", "SELECT", SCOPE, from, to);
}

describe("editableStates", () => {
  it("omits denied where the engine cannot write it", () => {
    expect(editableStates(PG)).toEqual(["none", "granted", "grantable"]);
  });

  it("includes denied on SQL Server and ClickHouse", () => {
    expect(editableStates(MSSQL)).toEqual(["none", "granted", "grantable", "denied"]);
  });
});

function facts(over: Partial<CellFacts> = {}): CellFacts {
  return {
    from: "granted",
    to: "none",
    wildcard: false,
    coveredByWider: false,
    inherited: false,
    ...over,
  };
}

describe("blockedReason", () => {
  it("allows anything on a plain, directly granted cell", () => {
    expect(blockedReason(facts(), MYSQL)).toBeNull();
  });

  it("allows narrowing a wildcard cell where the engine supports it", () => {
    expect(blockedReason(facts({ wildcard: true }), PG)).toBeNull();
  });

  it("blocks narrowing a wildcard cell on MySQL", () => {
    // REVOKE at table level against a grant held via *.* is error 1147.
    expect(blockedReason(facts({ wildcard: true }), MYSQL)).toBe("wildcardNarrow");
  });

  it("blocks dropping the grant option on a wildcard cell on MySQL too", () => {
    // Verified on mysql:8 against a user holding only `GRANT … ON *.* WITH
    // GRANT OPTION`: `REVOKE GRANT OPTION ON db.tbl` raises error 1147 just
    // like a privilege revoke does. Both need a grant at that exact scope.
    expect(blockedReason(facts({ from: "grantable", to: "granted", wildcard: true }), MYSQL)).toBe(
      "wildcardNarrow",
    );
  });

  it("still allows WIDENING a wildcard cell on MySQL", () => {
    // A plain GRANT needs no prior grant at that scope.
    expect(
      blockedReason(facts({ from: "granted", to: "grantable", wildcard: true }), MYSQL),
    ).toBeNull();
  });

  it("blocks clearing a cell that a wider grant would uncover", () => {
    expect(blockedReason(facts({ from: "grantable", coveredByWider: true }), PG)).toBe(
      "widerGrantRemains",
    );
  });

  it("still allows denying a covered cell where the engine has DENY", () => {
    // A deny is exactly how you beat an underlying wider grant.
    expect(blockedReason(facts({ to: "denied", coveredByWider: true }), MSSQL)).toBeNull();
  });

  it("blocks revoking a cell that is granted through a role", () => {
    // The grant belongs to the role; revoking it from this principal touches
    // nothing, so the cell would come back unchanged after apply.
    expect(blockedReason(facts({ inherited: true }), PG)).toBe("inherited");
  });

  it("blocks dropping the grant option on an inherited cell too", () => {
    expect(blockedReason(facts({ from: "grantable", to: "granted", inherited: true }), PG)).toBe(
      "inherited",
    );
  });

  it("still allows GRANTING directly over an inherited cell", () => {
    // Writing a grant against this principal is a real, effective change.
    expect(
      blockedReason(facts({ from: "granted", to: "grantable", inherited: true }), PG),
    ).toBeNull();
  });

  it("still allows denying an inherited cell", () => {
    // A deny on the principal beats the role's grant — the honest way to stop
    // an inherited privilege without editing the role.
    expect(blockedReason(facts({ to: "denied", inherited: true }), MSSQL)).toBeNull();
  });

  it("reports inheritance before scope when a cell is both", () => {
    expect(blockedReason(facts({ wildcard: true, inherited: true }), MYSQL)).toBe("inherited");
  });
});

describe("opsForTransition", () => {
  it("stages nothing for a no-op move", () => {
    expect(ops("granted", "granted")).toEqual([]);
  });

  it("grants from nothing with a single op", () => {
    expect(ops("none", "granted")).toEqual([
      { kind: "grant", grantee: "app", privilege: "SELECT", scope: SCOPE, grantable: false },
    ]);
  });

  it("adds the grant option when moving to grantable", () => {
    expect(ops("none", "grantable")).toEqual([
      { kind: "grant", grantee: "app", privilege: "SELECT", scope: SCOPE, grantable: true },
    ]);
  });

  it("revokes to reach none", () => {
    expect(ops("granted", "none")).toEqual([
      { kind: "revoke", grantee: "app", privilege: "SELECT", scope: SCOPE },
    ]);
  });

  it("denies in one op", () => {
    expect(ops("granted", "denied")).toEqual([
      { kind: "deny", grantee: "app", privilege: "SELECT", scope: SCOPE },
    ]);
  });

  it("revokes BEFORE granting when leaving denied", () => {
    // SQL Server: a GRANT does not clear a DENY. One op here would run clean
    // and change nothing.
    const result = ops("denied", "granted");
    expect(result.map((o) => o.kind)).toEqual(["revoke", "grant"]);
  });

  it("drops the grant option with its own op, keeping the privilege", () => {
    // Verified on mysql:8: REVOKE SELECT + GRANT SELECT leaves IS_GRANTABLE
    // YES, so a revoke/re-grant pair here would appear to do nothing.
    expect(ops("grantable", "granted")).toEqual([
      { kind: "revokeGrantOption", grantee: "app", privilege: "SELECT", scope: SCOPE },
    ]);
  });

  it("drops the grant option before revoking, so the bit cannot linger", () => {
    // On MySQL the GRANT OPTION bit outlives the privilege and would come
    // back the next time it is granted.
    expect(ops("grantable", "none").map((o) => o.kind)).toEqual(["revokeGrantOption", "revoke"]);
  });

  it("revokes before granting when going denied straight to grantable", () => {
    const result = ops("denied", "grantable");
    expect(result.map((o) => o.kind)).toEqual(["revoke", "grant"]);
    expect(result[1]).toMatchObject({ grantable: true });
  });
});

describe("stagedOps", () => {
  it("flattens staged cells in a stable order", () => {
    const staged = new Map([
      [
        cellKey("orders", "INSERT"),
        { object: "orders", privilege: "INSERT", from: "none" as const, to: "granted" as const },
      ],
      [
        cellKey("customers", "SELECT"),
        { object: "customers", privilege: "SELECT", from: "none" as const, to: "granted" as const },
      ],
    ]);
    const result = stagedOps(staged, "app", "shop");
    expect(result).toHaveLength(2);
    // customers before orders, regardless of insertion order.
    expect(result[0]).toMatchObject({ scope: { schema: "shop", object: "customers" } });
    expect(result[1]).toMatchObject({ scope: { schema: "shop", object: "orders" } });
  });

  it("drops cells clicked back to where they started", () => {
    const staged = new Map([
      [
        cellKey("orders", "SELECT"),
        { object: "orders", privilege: "SELECT", from: "granted" as const, to: "granted" as const },
      ],
    ]);
    expect(stagedOps(staged, "app", "shop")).toEqual([]);
  });

  it("expands a two-op transition inside the batch", () => {
    const staged = new Map([
      [
        cellKey("orders", "SELECT"),
        { object: "orders", privilege: "SELECT", from: "denied" as const, to: "granted" as const },
      ],
    ]);
    expect(stagedOps(staged, "app", "shop").map((o) => o.kind)).toEqual(["revoke", "grant"]);
  });
});
