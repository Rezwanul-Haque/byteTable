// Typed wrappers for the query debugger (M45) — the `query_debug` Rust slice.
//
// The backend cuts one SELECT at its clause boundaries and runs each prefix as
// its own read-only SELECT. It returns facts only (clauses, ranges, counts);
// every sentence the debug view shows is written here, in the renderer, so it
// can be translated (see `debugModel.ts`).

import { invoke } from "@tauri-apps/api/core";

import type { CellValue, ColumnMeta } from "../../shared/api/engine";

/** Why a statement cannot be stepped. */
export type CannotDebug =
  | { reason: "empty" }
  | { reason: "multiple" }
  | { reason: "notSelect" }
  | { reason: "noFrom" }
  | { reason: "parse"; message: string }
  | { reason: "multipleTargets" }
  | { reason: "unreadableWrite" };

/** A note fixed by the statement's shape. */
export type StaticNote =
  | { kind: "having" }
  | { kind: "window" }
  | { kind: "opaqueSource" }
  | { kind: "setOperation"; keyword: string }
  | { kind: "dryRun" };

export interface JoinProbe {
  left: boolean;
  on: string;
  alias: string;
  noneSql: string;
  manySql: string;
}

export interface CondProbe {
  text: string;
  sql: string;
}

/** One step of the run order, as planned. Sent back verbatim to run it. */
export interface DebugStep {
  /** `from`, `join0…n`, `where`, `groupBy`, `select`, `distinct`, `orderBy`, `limit`, `setOp`. */
  key: string;
  /** The Clause-order entry it belongs to (joins belong to `from`). */
  clause: string;
  kw: string;
  text: string;
  table?: string;
  /** `[start, end)` in the editor text, in UTF-16 units. */
  range: [number, number];
  sql: string;
  countSql: string[];
  join?: JoinProbe;
  conds?: CondProbe[];
  hasOr?: boolean;
  aggregate?: boolean;
  grouped?: boolean;
  ordered?: boolean;
  /** Count with `countSql` even when the sample fits (a joined write). */
  alwaysCount?: boolean;
  notes: StaticNote[];
}

export interface DebugPlan {
  steps: DebugStep[];
  /** Tables read, unquoted and without schema — for the large-table check. */
  sources: string[];
  canSample: boolean;
  /** The base table's row cap, when this plan is sampled. */
  sampled?: number;
  /** Set for an UPDATE / DELETE, which is stepped as a dry run. */
  write?: WriteInfo;
}

/** What an UPDATE / DELETE would do. Nothing is ever written. */
export interface WriteInfo {
  kind: "update" | "delete";
  /** The target table, unquoted and without schema. */
  table: string;
  /** Joined to other tables: one target row may match several times. */
  joined: boolean;
  /** The UPDATE's new values are shown as `→ column` columns. */
  preview: boolean;
}

export type PlanOutcome =
  | { kind: "ready"; plan: DebugPlan }
  | { kind: "cannot"; cannot: CannotDebug };

/** What one step found. */
export interface StepOutcome {
  count: number | null;
  /** Which of the step's `countSql` gave the count; absent when the sample did. */
  countSource?: number;
  columns: ColumnMeta[];
  rows: CellValue[][];
  ms: number;
  join?: { none: number | null; many: number | null };
  conds?: (number | null)[];
  error?: string;
  cancelled?: boolean;
}

/** Rows each step shows. Matches the backend's `SAMPLE_ROWS`. */
export const DEBUG_SAMPLE_ROWS = 200;

/**
 * Plan the steps of `sql`. Runs nothing but a plan-only EXPLAIN (to report a
 * statement that does not parse). With `sample`, every step reads the base
 * table through a `sample`-row cap.
 */
export function debugPlan(
  handleId: string,
  sql: string,
  schema: string,
  sample?: number,
): Promise<PlanOutcome> {
  return invoke<PlanOutcome>("debug_plan", { handleId, sql, schema, sample: sample ?? null });
}

/** Run one planned step: its sample rows, its exact count and its probes. */
export function debugRunStep(
  handleId: string,
  runId: string,
  step: DebugStep,
  schema: string,
): Promise<StepOutcome> {
  return invoke<StepOutcome>("debug_run_step", { handleId, runId, step, schema });
}

/** Stop a run: the step in flight is dropped. Also releases a finished run. */
export function debugCancel(runId: string): Promise<void> {
  return invoke<void>("debug_cancel", { runId });
}
