// Measurement for the Explain panel: the real numbers behind the summary strip.
//
// The measuring itself lives in Rust (`explain_measure`) — it runs the
// statement and counts what its base relation read, and building those COUNT
// probes means slicing the statement, which is exactly the sort of thing that
// belongs beside the rest of the backend's SQL. This file only crosses the wire
// and folds in the row estimates the sidebar already has cached, which are
// client state and never worth a round trip.

import { invoke } from "@tauri-apps/api/core";

import type { ExplainStats } from "./explainModel";
import type { SelectShape } from "./explainParse";

/** Mirrors Rust `explain::domain::Measurement`. */
interface Measurement {
  ms: number;
  rows: number;
  truncated: boolean;
  scanned: number | null;
  kept: number | null;
}

/**
 * Run the statement and count what it read.
 *
 * **This executes `sql`** — it is the only part of the panel that does, which
 * is why the caller gates it (automatic on dev/staging, an explicit click on
 * production). Rejects with the driver's message when the statement fails, so
 * the panel can show what the server said rather than a guess.
 *
 * `approxRows` supplies the cached introspection estimate per relation, used
 * for the plan's joined tables and anything inside a derived table. Free — the
 * sidebar already loaded it — and approximate, which is why it never feeds a
 * warning.
 */
export async function measureQuery(
  handleId: string,
  schema: string,
  sql: string,
  shape: SelectShape,
  approxRows: (table: string) => number | null,
): Promise<ExplainStats> {
  const measured = await invoke<Measurement>("explain_measure", { handleId, sql, schema });

  const relationRows: Record<string, number | null> = {};
  const collect = (s: SelectShape) => {
    if (s.table) relationRows[s.table] = approxRows(s.table);
    for (const j of s.joins) relationRows[j.table] = approxRows(j.table);
    if (s.derived) collect(s.derived);
  };
  collect(shape);

  return {
    ms: measured.ms,
    final: measured.rows,
    truncated: measured.truncated,
    scanned: measured.scanned,
    kept: measured.kept,
    relationRows,
  };
}
