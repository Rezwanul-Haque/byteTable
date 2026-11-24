// The query debugger's view model (M45): from the backend's plan and the
// outcomes of the steps run so far, derive what the step list and the step
// detail say. Pure — no React, no IO — so the sentences and the "where to
// look" choices are unit-tested.
//
// Messages are returned as `{ key, vars }` rather than strings so the renderer
// translates them at render time (a language switch repaints). A var may itself
// be a message: counts with their noun ("5 rows") are plural messages nested in
// the sentence, which keeps word order free per locale.

import type { StringKey } from "../../shared/i18n";
import type { DebugPlan, DebugStep, StepOutcome, WriteInfo } from "./debugServer";

export type MsgArg = string | number | Msg;
export interface Msg {
  key: StringKey;
  vars?: Record<string, MsgArg>;
}

export type NoteTone = "warn" | "ok" | "info";
export interface StepNote extends Msg {
  tone: NoteTone;
}

export type StageStatus = "pending" | "running" | "done" | "error" | "skipped" | "cancelled";

/** One step as the view shows it. */
export interface Stage {
  step: DebugStep;
  status: StageStatus;
  outcome: StepOutcome | null;
  /** Rows going in: the count of the nearest earlier finished step. */
  prev: number | null;
  /** Rows after this step, once it has run. */
  count: number | null;
}

/** The base relation is sampled: every count is on its first `rows` rows. */
export interface Sampling {
  rows: number;
  table: string;
}

const msg = (key: StringKey, vars?: Record<string, MsgArg>): Msg => ({ key, vars });
const rows = (count: number): Msg => msg("debug.rows", { count });

/**
 * Pair each planned step with its outcome. Steps after a failed one are
 * `skipped` (the runner stops there); the step in flight is `running`.
 */
export function stagesOf(
  plan: DebugPlan,
  outcomes: (StepOutcome | undefined)[],
  runningIdx: number | null,
): Stage[] {
  let prev: number | null = null;
  let dead = false;
  return plan.steps.map((step, i) => {
    const outcome = outcomes[i] ?? null;
    let status: StageStatus;
    if (dead) status = "skipped";
    else if (outcome?.cancelled) status = "cancelled";
    else if (outcome?.error != null) status = "error";
    else if (outcome) status = "done";
    else status = runningIdx === i ? "running" : "pending";
    if (status === "error") dead = true;
    const count = status === "done" ? (outcome?.count ?? null) : null;
    const stage: Stage = { step, status, outcome, prev, count };
    if (count != null) prev = count;
    return stage;
  });
}

/** Steps whose row loss is worth pointing at: the joins and the WHERE. */
const isFilter = (key: string) => key === "where" || key.startsWith("join");

/**
 * Where to start looking. `zeroAt` is the first step that fails or takes a
 * non-zero input to zero rows; `drop` is the JOIN or WHERE step with the
 * largest relative loss. Both −1 when there is none.
 */
export function focusOf(stages: Stage[]): { zeroAt: number; drop: number } {
  let zeroAt = -1;
  let drop = -1;
  let worst = 0;
  stages.forEach((s, i) => {
    if (zeroAt < 0 && (s.status === "error" || (s.count === 0 && (s.prev ?? 0) > 0))) zeroAt = i;
    if (isFilter(s.step.key) && s.prev != null && s.prev > 0 && s.count != null) {
      const loss = (s.prev - s.count) / s.prev;
      if (loss > worst) {
        worst = loss;
        drop = i;
      }
    }
  });
  return { zeroAt, drop };
}

/** The largest count, for scaling the step bars. Never below 1. */
export function maxCount(stages: Stage[]): number {
  return Math.max(1, ...stages.map((s) => s.count ?? 0));
}

/** The step's one sentence, once it has run. `write` is the plan's, for the
 *  dry-run step of an UPDATE / DELETE. */
export function headOf(
  stage: Stage,
  sampling: Sampling | null,
  write: WriteInfo | null = null,
): Msg | null {
  const { step, count, prev, outcome } = stage;
  if (stage.status !== "done" || count == null) return null;
  const from = prev ?? count;
  let head: Msg;
  switch (true) {
    case step.key === "from":
      head = msg("debug.head.from", { rows: rows(count), table: step.table ?? step.text });
      break;
    case step.key.startsWith("join"):
      head = msg("debug.head.join", {
        table: step.table ?? step.text,
        from,
        rows: rows(count),
      });
      break;
    case step.key === "where":
      head = msg("debug.head.where", { kept: count, rows: rows(from), removed: from - count });
      break;
    case step.key === "groupBy":
      head = msg("debug.head.group", {
        rows: rows(from),
        groups: msg("debug.groups", { count }),
        key: step.text,
      });
      break;
    case step.key === "select": {
      const cols = msg("debug.cols", { count: outcome?.columns.length ?? 0 });
      if (step.grouped) head = msg("debug.head.selectGrouped", { cols, n: count });
      else if (step.aggregate)
        head = msg("debug.head.selectAgg", { rows: rows(from), out: rows(count) });
      else head = msg("debug.head.select", { cols, n: count });
      break;
    }
    case step.key === "distinct":
      head =
        from === count
          ? msg("debug.head.distinctNone", { rows: rows(count) })
          : msg("debug.head.distinct", {
              dups: msg("debug.dups", { count: from - count }),
              n: count,
            });
      break;
    case step.key === "orderBy":
      head = msg("debug.head.order", { rows: rows(count), expr: step.text });
      break;
    case step.key === "limit":
      head =
        from > count
          ? msg("debug.head.limit", { kept: count, rows: rows(from) })
          : msg("debug.head.limitNone", { rows: rows(from) });
      break;
    case step.key === "setOp":
      head = msg("debug.head.setOp", { keyword: step.kw, rows: rows(count) });
      break;
    case step.key === "write":
      head = msg(write?.kind === "delete" ? "debug.head.delete" : "debug.head.update", {
        rows: rows(count),
        table: write?.table ?? step.table ?? "",
      });
      break;
    default:
      return null;
  }
  if (sampling) {
    return msg("debug.head.sampled", { head, n: sampling.rows, table: sampling.table });
  }
  return head;
}

/** The notes under a step's sentence, in display order. */
export function notesOf(stage: Stage, write: WriteInfo | null = null): StepNote[] {
  const { step, count, prev, outcome } = stage;
  const out: StepNote[] = [];
  const note = (tone: NoteTone, key: StringKey, vars?: Record<string, MsgArg>) =>
    out.push({ tone, key, vars });

  // Fixed by the statement's shape: true whether or not the step has run.
  for (const n of step.notes) {
    if (n.kind === "having") note("info", "debug.note.having");
    else if (n.kind === "window") note("info", "debug.note.window");
    else if (n.kind === "opaqueSource") note("info", "debug.note.opaque");
    else if (n.kind === "dryRun") note("info", "debug.note.dryRun");
    else note("info", "debug.note.setOp", { keyword: n.keyword });
  }
  if (stage.status !== "done" || count == null) return out;
  const incoming = prev ?? 0;

  if (incoming > 0 && count === 0) {
    note("warn", "debug.note.runOut", { n: incoming });
  }

  const table = step.table ?? step.text;
  if (step.join && outcome?.join) {
    const { none, many } = outcome.join;
    if (none != null && none > 0 && !step.join.left) {
      note("warn", "debug.note.joinDropped", { rows: rows(none), table, on: step.join.on });
    }
    if (none != null && none > 0 && step.join.left) {
      note("info", "debug.note.joinLeftKept", { rows: rows(none), table, alias: step.join.alias });
    }
    if (many != null && many > 0) {
      note("warn", "debug.note.joinRepeated", { rows: rows(many), table });
    }
    if (none === 0 && many === 0) note("ok", "debug.note.joinExact", { table });
  }

  if (step.key === "where") {
    if (step.hasOr) note("info", "debug.note.or");
    step.conds?.forEach((c, i) => {
      const keeps = outcome?.conds?.[i];
      if (keeps == null) return;
      if (keeps === incoming) note("info", "debug.note.condNoop", { cond: c.text });
      if (keeps === 0) note("warn", "debug.note.condEmpty", { cond: c.text });
    });
  }

  // A joined write whose DISTINCT count failed was counted per joined row.
  if (step.key === "write" && write?.joined && outcome?.countSource !== 0) {
    note("warn", "debug.note.perJoinedRow", { table: write.table });
  }

  if (step.key === "select" && step.aggregate && incoming === 0) {
    note("warn", "debug.note.aggEmpty");
  }

  if (step.key === "limit" && !step.ordered && count > 0 && incoming > count) {
    note("warn", "debug.note.limitUnordered", { rows: rows(count) });
  }
  return out;
}

/** Each AND-ed condition's own count, for the per-condition table. */
export interface CondRow {
  text: string;
  keeps: number | null;
}

/** The per-condition table, or null when the step has none to show. */
export function condRowsOf(stage: Stage): CondRow[] | null {
  const conds = stage.step.conds;
  if (stage.status !== "done" || !conds || conds.length < 2 || !stage.outcome?.conds) return null;
  return conds.map((c, i) => ({ text: c.text, keeps: stage.outcome?.conds?.[i] ?? null }));
}

/**
 * Rows after each Clause-order entry, for the stepper column. A clause shows
 * the count after its last step, so joins fold into FROM.
 */
export function clauseCounts(stages: Stage[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of stages) if (s.count != null) out[s.step.clause] = s.count;
  return out;
}

/** The last step of a clause — what clicking that Clause-order entry selects. */
export function lastStepOfClause(stages: Stage[], clause: string): number {
  let at = -1;
  stages.forEach((s, i) => {
    if (s.step.clause === clause) at = i;
  });
  return at;
}

/** How many queries a run may issue: each step plus its probes. */
export function queryBudget(plan: DebugPlan): number {
  return plan.steps.reduce((n, s) => n + 2 + (s.join ? 2 : 0) + (s.conds?.length ?? 0), 0);
}

/** Above this many rows (by catalog estimate) Debug asks before running. */
export const LARGE_TABLE_ROWS = 1_000_000;

/** Rows a sampled run reads from the base table. */
export const SAMPLE_BASE_ROWS = 100_000;

/** The largest source over the threshold, by the catalog's estimate. */
export function largestSource(
  plan: DebugPlan,
  approxRows: (table: string) => number | null,
): { table: string; rows: number } | null {
  let best: { table: string; rows: number } | null = null;
  for (const table of plan.sources) {
    const n = approxRows(table) ?? approxRows(table.toLowerCase());
    if (n != null && n > LARGE_TABLE_ROWS && (!best || n > best.rows)) best = { table, rows: n };
  }
  return best;
}
