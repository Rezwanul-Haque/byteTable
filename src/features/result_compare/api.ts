// Typed wrappers for result compare (M51) — the `result_compare` Rust slice.
// The backend runs both sides (read-only, capped, in one snapshot where the
// engine has one); the comparison itself is `compareModel.ts`.

import { invoke } from "@tauri-apps/api/core";

import type { QueryResult } from "../../shared/api/engine";

/** Why a side was not sent (or, for `tooMany`, not compared). */
export type Refusal = "empty" | "write" | "multi" | "tooMany";

export interface SideOutcome {
  result?: QueryResult;
  /** The engine's message. */
  error?: string;
  refused?: Refusal;
}

export interface CompareOutcome {
  a: SideOutcome;
  b: SideOutcome;
  /** Both sides read one snapshot. */
  snapshot: boolean;
  cancelled?: boolean;
}

export function compareRun(
  handleId: string,
  runId: string,
  sqlA: string,
  sqlB: string,
  schema: string,
): Promise<CompareOutcome> {
  return invoke<CompareOutcome>("compare_run", { handleId, runId, sqlA, sqlB, schema });
}

/** Stop a run: the query in flight is dropped and the other side is not sent. */
export function compareCancel(runId: string): Promise<void> {
  return invoke<void>("compare_cancel", { runId });
}
