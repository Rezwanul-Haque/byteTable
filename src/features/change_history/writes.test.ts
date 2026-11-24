import { describe, expect, it } from "vitest";

import { isWrite } from "./writes";

describe("isWrite", () => {
  it("routes writes, structure and transaction control to the recorder", () => {
    for (const sql of [
      "UPDATE t SET a = 1",
      "  -- note\n/* x */ delete from t",
      "INSERT INTO t VALUES (1)",
      "WITH x AS (SELECT 1) UPDATE t SET a = 2",
      "ALTER TABLE t ADD c int",
      "BEGIN",
      "COMMIT",
    ]) {
      expect(isWrite(sql), sql).toBe(true);
    }
  });
  it("leaves plain reads on the editor's own path", () => {
    for (const sql of [
      "SELECT * FROM t",
      "with x as (select 1) select * from x",
      "EXPLAIN SELECT 1",
      "SHOW TABLES",
    ]) {
      expect(isWrite(sql), sql).toBe(false);
    }
  });
});
