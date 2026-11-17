import { describe, expect, it } from "vitest";

import { analyzeQuery, EMPTY_STATS } from "./explainModel";
import { parseSelectShape } from "./explainParse";

describe("analyzeQuery", () => {
  // A SELECT with no FROM is a statement every engine can EXPLAIN — scalar
  // subqueries in the select list are where its work is. Refusing it here also
  // stopped the panel from ever asking the server for the real plan.
  it("analyzes a FROM-less SELECT of scalar subqueries instead of refusing it", () => {
    const sql =
      "SELECT (SELECT COUNT(*) FROM cms_users), (SELECT COUNT(*) FROM cms_roles WHERE deleted_at IS NULL);";
    const a = analyzeQuery(parseSelectShape(sql), EMPTY_STATS);

    expect(a.error).toBeNull();
    expect(a.plan.map((p) => p.node)).toEqual(["Result"]);
    // There is no relation, so "How it runs" must not invent a FROM step.
    expect(a.steps.map((s) => s.kw)).not.toContain("FROM");
  });

  it("analyzes a bare constant SELECT", () => {
    const a = analyzeQuery(parseSelectShape("SELECT 1"), EMPTY_STATS);
    expect(a.error).toBeNull();
    expect(a.plan).toHaveLength(1);
  });

  it("still refuses a statement that is not a SELECT", () => {
    const a = analyzeQuery(parseSelectShape("UPDATE t SET a = 1"), EMPTY_STATS);
    expect(a.error).not.toBeNull();
  });
});
