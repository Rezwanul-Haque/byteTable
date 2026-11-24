// The query debugger's runner (M45): plan a statement, ask before running it
// over a big table, then run its steps one at a time.
//
// Steps run sequentially — each is its own SELECT, and the step list fills in
// as their counts arrive. The run stops at the first step that fails (later
// steps read "Not reached"). `stop()` cancels the step in flight on the
// backend and starts nothing more; leaving debug mode does the same.

import { useCallback, useEffect, useRef, useState } from "react";

import { appErrorMessage } from "../../../shared/api/error";
import {
  debugCancel,
  debugPlan,
  debugRunStep,
  type CannotDebug,
  type DebugPlan,
  type StepOutcome,
} from "../debugServer";
import { largestSource, queryBudget, SAMPLE_BASE_ROWS } from "../debugModel";

/** Asking before a run over a table the catalog says is large (task A5). */
export interface BigTableAsk {
  table: string;
  rows: number;
  queries: number;
  canSample: boolean;
}

export type DebugPhase = "idle" | "planning" | "cannot" | "confirm" | "running" | "done";

export interface QueryDebugState {
  phase: DebugPhase;
  plan: DebugPlan | null;
  cannot: CannotDebug | null;
  ask: BigTableAsk | null;
  outcomes: (StepOutcome | undefined)[];
  /** The step in flight, while running. */
  runningIdx: number | null;
}

const IDLE: QueryDebugState = {
  phase: "idle",
  plan: null,
  cannot: null,
  ask: null,
  outcomes: [],
  runningIdx: null,
};

let runSeq = 0;

export function useQueryDebug({
  handleId,
  schema,
  approxRows,
  failMessage,
}: {
  handleId: string;
  schema: string;
  /** Catalog row estimate for a table, from the cached table list. */
  approxRows: (table: string) => number | null;
  /** Fallback text for an error with no message of its own. */
  failMessage: string;
}) {
  const [state, setState] = useState<QueryDebugState>(IDLE);
  // The live run: its id (for cancel), and the SQL it was planned from.
  const runRef = useRef<{ id: string; sql: string } | null>(null);

  /** Cancel the run in flight (or release a finished one) on the backend. */
  const release = useCallback(() => {
    const run = runRef.current;
    runRef.current = null;
    if (run) void debugCancel(run.id).catch(() => {});
  }, []);

  // Leaving the tab mid-run must not leave steps running.
  useEffect(() => release, [release]);

  const runSteps = useCallback(
    async (plan: DebugPlan, run: { id: string; sql: string }) => {
      setState({ ...IDLE, phase: "running", plan, runningIdx: 0 });
      const outcomes: (StepOutcome | undefined)[] = [];
      for (let i = 0; i < plan.steps.length; i++) {
        if (runRef.current !== run) return;
        setState((s) => ({ ...s, runningIdx: i }));
        let outcome: StepOutcome;
        try {
          outcome = await debugRunStep(handleId, run.id, plan.steps[i]!, schema);
        } catch (err) {
          outcome = {
            count: null,
            columns: [],
            rows: [],
            ms: 0,
            error: appErrorMessage(err, failMessage),
          };
        }
        if (runRef.current !== run) return;
        outcomes[i] = outcome;
        const stop = outcome.error != null || outcome.cancelled === true;
        setState((s) => ({
          ...s,
          outcomes: [...outcomes],
          runningIdx: stop ? null : s.runningIdx,
          phase: stop ? "done" : s.phase,
        }));
        if (stop) {
          release();
          return;
        }
      }
      setState((s) => ({ ...s, runningIdx: null, phase: "done" }));
      release();
    },
    [handleId, schema, failMessage, release],
  );

  const planAndRun = useCallback(
    async (run: { id: string; sql: string }, sample?: number, skipAsk = false) => {
      setState({ ...IDLE, phase: "planning" });
      let out;
      try {
        out = await debugPlan(handleId, run.sql, schema, sample);
      } catch (err) {
        if (runRef.current !== run) return;
        setState({
          ...IDLE,
          phase: "cannot",
          cannot: { reason: "parse", message: appErrorMessage(err, failMessage) },
        });
        return;
      }
      if (runRef.current !== run) return;
      if (out.kind === "cannot") {
        setState({ ...IDLE, phase: "cannot", cannot: out.cannot });
        return;
      }
      const big = skipAsk ? null : largestSource(out.plan, approxRows);
      if (big) {
        setState({
          ...IDLE,
          phase: "confirm",
          plan: out.plan,
          ask: {
            table: big.table,
            rows: big.rows,
            queries: queryBudget(out.plan),
            canSample: out.plan.canSample,
          },
        });
        return;
      }
      await runSteps(out.plan, run);
    },
    [handleId, schema, approxRows, failMessage, runSteps],
  );

  /** Enter debug mode on `sql`. */
  const start = useCallback(
    (sql: string) => {
      release();
      const run = { id: `dbg-${Date.now()}-${++runSeq}`, sql };
      runRef.current = run;
      void planAndRun(run);
    },
    [release, planAndRun],
  );

  /** Answer the big-table question: run as planned, or on a sample. */
  const confirm = useCallback(
    (sampled: boolean) => {
      const run = runRef.current;
      if (!run || !state.plan) return;
      if (sampled) void planAndRun(run, SAMPLE_BASE_ROWS, true);
      else void runSteps(state.plan, run);
    },
    [state.plan, planAndRun, runSteps],
  );

  /** Stop the step in flight; no further step starts. Results so far stay. */
  const stop = useCallback(() => {
    const run = runRef.current;
    if (!run) return;
    void debugCancel(run.id).catch(() => {});
    runRef.current = null;
    setState((s) => ({ ...s, phase: "done", runningIdx: null }));
  }, []);

  /** Leave debug mode entirely. */
  const exit = useCallback(() => {
    release();
    setState(IDLE);
  }, [release]);

  return { state, start, confirm, stop, exit };
}
