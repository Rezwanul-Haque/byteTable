import { describe, expect, it } from "vitest";

import type { GrantEntry, PrivilegeState } from "./api";
import { fillCell, grantsByGrantee, matrixObjects, roleChainsFor, specificity } from "./matrix";

function grant(
  partial: Partial<GrantEntry> & { privilege: string; state: PrivilegeState },
): GrantEntry {
  return { grantee: "app", ...partial };
}

describe("specificity", () => {
  it("orders object over schema over global", () => {
    expect(
      specificity(grant({ schema: "s", object: "t", privilege: "SELECT", state: "granted" })),
    ).toBe(2);
    expect(specificity(grant({ schema: "s", privilege: "SELECT", state: "granted" }))).toBe(1);
    expect(specificity(grant({ privilege: "SELECT", state: "granted" }))).toBe(0);
  });
});

describe("fillCell", () => {
  it("returns null when nothing covers the cell", () => {
    const grants = [grant({ schema: "other", object: "t", privilege: "SELECT", state: "granted" })];
    expect(fillCell(grants, "shop", "orders", "SELECT")).toBeNull();
  });

  it("returns null when the privilege is unrelated", () => {
    const grants = [
      grant({ schema: "shop", object: "orders", privilege: "INSERT", state: "granted" }),
    ];
    expect(fillCell(grants, "shop", "orders", "SELECT")).toBeNull();
  });

  it("takes a direct grant on the object", () => {
    const grants = [
      grant({ schema: "shop", object: "orders", privilege: "SELECT", state: "grantable" }),
    ];
    const cell = fillCell(grants, "shop", "orders", "SELECT");
    expect(cell).toEqual({ state: "grantable", via: [], wildcard: false });
  });

  it("expands a schema-wide grant across objects", () => {
    const grants = [grant({ schema: "shop", privilege: "SELECT", state: "granted" })];
    const cell = fillCell(grants, "shop", "orders", "SELECT");
    expect(cell?.state).toBe("granted");
    // Marked so the UI can distinguish it from a grant written on this table.
    expect(cell?.wildcard).toBe(true);
  });

  it("expands a global grant across every schema", () => {
    const grants = [grant({ privilege: "SELECT", state: "granted" })];
    expect(fillCell(grants, "anything", "at_all", "SELECT")?.state).toBe("granted");
  });

  it("lets a schema-scoped deny beat a global grant", () => {
    // The ClickHouse partial-revoke shape: GRANT SELECT ON *.* then
    // REVOKE SELECT ON system.*. Specificity must win over state here.
    const grants = [
      grant({ privilege: "SELECT", state: "granted" }),
      grant({ schema: "system", privilege: "SELECT", state: "denied" }),
    ];
    expect(fillCell(grants, "system", "parts", "SELECT")?.state).toBe("denied");
    // …and the global grant still applies everywhere else.
    expect(fillCell(grants, "shop", "orders", "SELECT")?.state).toBe("granted");
  });

  it("lets an object grant beat a schema-wide deny", () => {
    const grants = [
      grant({ schema: "shop", privilege: "SELECT", state: "denied" }),
      grant({ schema: "shop", object: "orders", privilege: "SELECT", state: "granted" }),
    ];
    expect(fillCell(grants, "shop", "orders", "SELECT")?.state).toBe("granted");
    expect(fillCell(grants, "shop", "customers", "SELECT")?.state).toBe("denied");
  });

  it("fills every column from an ALL PRIVILEGES grant", () => {
    const grants = [grant({ schema: "shop", privilege: "ALL PRIVILEGES", state: "granted" })];
    expect(fillCell(grants, "shop", "orders", "SELECT")?.state).toBe("granted");
    expect(fillCell(grants, "shop", "orders", "DELETE")?.state).toBe("granted");
  });

  it("prefers a named privilege over an ALL wildcard at the same scope", () => {
    const grants = [
      grant({ schema: "shop", privilege: "ALL", state: "granted" }),
      grant({ schema: "shop", privilege: "SELECT", state: "denied" }),
    ];
    expect(fillCell(grants, "shop", "orders", "SELECT")?.state).toBe("denied");
    expect(fillCell(grants, "shop", "orders", "INSERT")?.state).toBe("granted");
  });

  it("breaks a specificity tie by how much access the state carries", () => {
    const grants = [
      grant({ schema: "shop", object: "orders", privilege: "SELECT", state: "granted" }),
      grant({ schema: "shop", object: "orders", privilege: "SELECT", state: "denied" }),
    ];
    expect(fillCell(grants, "shop", "orders", "SELECT")?.state).toBe("denied");
  });

  it("carries the role chain of the winning entry", () => {
    const grants = [
      grant({
        schema: "shop",
        object: "orders",
        privilege: "SELECT",
        state: "granted",
        via: ["writer", "owner"],
      }),
    ];
    expect(fillCell(grants, "shop", "orders", "SELECT")?.via).toEqual(["writer", "owner"]);
  });
});

describe("grantsByGrantee", () => {
  it("buckets entries by grantee", () => {
    const a = grant({ grantee: "alice", privilege: "SELECT", state: "granted" });
    const b = grant({ grantee: "bob", privilege: "SELECT", state: "granted" });
    const c = grant({ grantee: "alice", privilege: "INSERT", state: "granted" });
    const map = grantsByGrantee([a, b, c]);
    expect(map.get("alice")).toEqual([a, c]);
    expect(map.get("bob")).toEqual([b]);
  });
});

describe("matrixObjects", () => {
  it("keeps catalog order and appends objects only grants know about", () => {
    const grants = [
      grant({ schema: "shop", object: "legacy_audit", privilege: "SELECT", state: "granted" }),
      grant({ schema: "shop", object: "orders", privilege: "SELECT", state: "granted" }),
    ];
    expect(matrixObjects(["orders", "customers"], grants, "shop")).toEqual([
      "orders",
      "customers",
      "legacy_audit",
    ]);
  });

  it("ignores objects from another schema and wildcard entries", () => {
    const grants = [
      grant({ schema: "other", object: "elsewhere", privilege: "SELECT", state: "granted" }),
      grant({ schema: "shop", privilege: "SELECT", state: "granted" }),
    ];
    expect(matrixObjects(["orders"], grants, "shop")).toEqual(["orders"]);
  });
});

describe("roleChainsFor", () => {
  it("walks membership transitively, nearest first", () => {
    const edges = [
      { member: "app", role: "writer" },
      { member: "writer", role: "owner" },
    ];
    expect(roleChainsFor(edges, "app")).toEqual([
      { role: "writer", depth: 1 },
      { role: "owner", depth: 2 },
    ]);
  });

  it("terminates on a membership cycle", () => {
    const edges = [
      { member: "a", role: "b" },
      { member: "b", role: "c" },
      { member: "c", role: "a" },
    ];
    expect(roleChainsFor(edges, "a").map((r) => r.role)).toEqual(["b", "c"]);
  });

  it("returns nothing for a principal with no roles", () => {
    expect(roleChainsFor([{ member: "x", role: "y" }], "app")).toEqual([]);
  });
});
