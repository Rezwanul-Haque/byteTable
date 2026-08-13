// Measurement for the Explain panel: the real numbers behind the plan.
//
// The prototype's `analyzeQuery` called its mock engine to execute the query
// and a second time to count the rows surviving WHERE. ByteTable does the same
// thing against the real connection — there is nowhere else honest numbers can
// come from, and inventing them in a database client is worse than showing
// none. Three round trips at most:
//
//   1. the statement itself      → wall-clock ms, rows returned
//   2. `SELECT COUNT(*) FROM …`  → rows read by the base scan
//   3. the same COUNT with WHERE → rows surviving the filter
//
// (2) and (3) are built by *slicing the user's own statement* between the
// offsets the parser recorded, so aliases, schema qualification and quoting are
// reproduced exactly and this module never quotes an identifier itself. With a
// JOIN present the predicate may address either side, so the filtered probe is
// skipped (MILESTONE_33 Task 3) and joined relations fall back to the cached
// introspection row estimates.
//
// Nothing here is speculative: a probe that fails is dropped and its column
// reads "—". The caller decides *when* to measure — the panel auto-measures on
// dev/staging and waits for an explicit click on production connections.

import { queryRun } from "../../../shared/api/engine";
import type { ExplainStats } from "./explainModel";
import type { SelectShape } from "./explainParse";

/**
 * Row cap for the measuring run. Above the 500-row default of a normal Run so
 * ordinary result sets are counted exactly; when the cap does bite, the result
 * is flagged `truncated` and the panel reports the count as a lower bound
 * rather than pretending it is exact.
 */
const ANALYZE_ROW_LIMIT = 1000;

/** Read a single COUNT(*) cell, which large engines may send as a string. */
async function countOf(handleId: string, sql: string, schema: string): Promise<number | null> {
  try {
    const res = await queryRun(handleId, sql, { schema, rowLimit: 1 });
    const cell = res.rows[0]?.[0];
    const n = typeof cell === "string" ? Number(cell) : typeof cell === "number" ? cell : NaN;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * Measure `sql` against the connection and return the counts the plan model
 * needs. `approxRows` is the cached introspection estimate per table (free —
 * the sidebar already loaded it), used for joined relations and as the base
 * count when no exact probe is warranted.
 *
 * Throws only if the statement itself fails, so the panel can show the driver's
 * message; the probes never throw.
 */
export async function measureQuery(
  handleId: string,
  schema: string,
  sql: string,
  shape: SelectShape,
  approxRows: (table: string) => number | null,
): Promise<ExplainStats> {
  const run = await queryRun(handleId, sql, { schema, rowLimit: ANALYZE_ROW_LIMIT });

  const joinRows: Record<string, number | null> = {};
  for (const j of shape.joins) joinRows[j.table] = approxRows(j.table);

  const canProbe = shape.fromStart != null && shape.baseEnd != null;
  const wantsFiltered = !!shape.whereText && shape.joins.length === 0 && shape.whereEnd != null;

  // With a filter we probe both counts so `rows read` and `rows kept` come
  // from the same source — an approximate base against an exact filtered count
  // would make "discards N%" wrong, and that number drives a warning.
  let scanned: number | null = wantsFiltered ? null : approxRows(shape.table ?? "");
  let kept: number | null = null;
  if (canProbe && (wantsFiltered || scanned == null)) {
    const from = sql.slice(shape.fromStart!, shape.baseEnd!);
    const probes: Promise<number | null>[] = [countOf(handleId, "SELECT COUNT(*) " + from, schema)];
    if (wantsFiltered) {
      probes.push(
        countOf(
          handleId,
          "SELECT COUNT(*) " + sql.slice(shape.fromStart!, shape.whereEnd!),
          schema,
        ),
      );
    }
    const [base, filtered] = await Promise.all(probes);
    scanned = base ?? scanned;
    if (wantsFiltered) kept = filtered ?? null;
  }
  // A stale estimate can undercut the exact filtered count; never report a
  // negative "rows removed".
  if (scanned != null && kept != null && kept > scanned) scanned = kept;

  return {
    ms: run.elapsedMs,
    final: run.rowCount,
    truncated: run.truncated,
    scanned,
    kept,
    joinRows,
  };
}
