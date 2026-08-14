import { describe, expect, it } from "vitest";

import { dropFkOverride, dropSql, truncateFkOverride, truncateSql } from "./fkOverride";

describe("fk override option", () => {
  it("offers one on every engine that has foreign keys", () => {
    for (const engine of ["postgres", "mysql", "sqlite", "mssql"] as const) {
      expect(truncateFkOverride(engine), engine).not.toBeNull();
      expect(dropFkOverride(engine), engine).not.toBeNull();
    }
  });

  it("offers none where there are no foreign keys to get past", () => {
    // ClickHouse has no FK constraints; an unknown/unset engine gets no
    // checkbox rather than a guess.
    expect(truncateFkOverride("clickhouse")).toBeNull();
    expect(dropFkOverride("clickhouse")).toBeNull();
    expect(dropFkOverride(undefined)).toBeNull();
  });
});

describe("previewed SQL", () => {
  it("matches what the adapter runs when the override is off", () => {
    expect(truncateSql("postgres", "orders", false)).toBe("TRUNCATE TABLE orders;");
    // SQLite has no TRUNCATE — the adapter runs a DELETE.
    expect(truncateSql("sqlite", "orders", false)).toBe("DELETE FROM orders;");
    expect(dropSql("mysql", "orders", false)).toBe("DROP TABLE orders;");
  });

  it("shows each engine's own way past the foreign keys", () => {
    expect(truncateSql("postgres", "orders", true)).toBe("TRUNCATE TABLE orders CASCADE;");
    expect(dropSql("postgres", "orders", true)).toBe("DROP TABLE orders CASCADE;");
    expect(dropSql("mysql", "orders", true)).toContain("SET FOREIGN_KEY_CHECKS = 0;");
    expect(dropSql("mysql", "orders", true)).toContain("SET FOREIGN_KEY_CHECKS = 1;");
    expect(truncateSql("sqlite", "orders", true)).toContain("PRAGMA foreign_keys = OFF;");
    expect(dropSql("mssql", "orders", true)).toContain("DROP CONSTRAINT");
  });

  it("ignores the flag where the engine has nothing to relax", () => {
    expect(dropSql("clickhouse", "orders", true)).toBe(dropSql("clickhouse", "orders", false));
  });
});
