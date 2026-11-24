// Running notebook cells (M47 §3 "Running", tasks F1–F7).
//
// Module functions on the notebooks store, not component code, so a query
// keeps running — and lands its result — when its tab is switched away from.
//
// | Statement            | Its own Run                                  | Run all            |
// |----------------------|----------------------------------------------|--------------------|
// | read                 | runs; the result replaces the old one        | runs, in order     |
// | write                | the confirmation, with the rows it changes   | skipped, says so   |
// | transaction control  | an error: not run from a notebook            | skipped            |
//
// The affected-row count comes from the query debugger's dry run (the SELECT
// that finds the rows an UPDATE / DELETE would change), so it is a real count,
// not an estimate. Writes apply at once: the app has no manual-transaction
// mode, so nothing is "held".

import { appErrorMessage } from "../../shared/api/error";
import { t } from "../../shared/i18n";
import { debugCancel, debugPlan, debugRunStep } from "../workspaces/debugServer";
import { cancelCell, classify, runCell, type StatementKind } from "./api";
import { MAX_SHOWN_ROWS, stamp, type QueryCell } from "./format";
import { useNotebooksStore } from "./state";
import { historyRecord } from "../change_history/api";
import { currentLimits, recordingFor } from "../change_history/recording";
import { useHistoryStore } from "../change_history/state";

/** What a run needs from the workspace it runs in. */
export interface RunContext {
  handleId: string;
  schema: string;
  readOnly: boolean;
  prod: boolean;
  /** Saved connection id for the change history; null = never recorded
   *  (a data file's scratch database). */
  connectionId: string | null;
}

let runSeq = 0;
const nextRunId = () => `nbrun-${Date.now().toString(36)}-${++runSeq}`;

const store = () => useNotebooksStore.getState();
const cellOf = (tabId: string, cellId: string): QueryCell | undefined => {
  const c = store().docs[tabId]?.nb.cells.find((x) => x.id === cellId);
  return c?.type === "query" ? c : undefined;
};
const verbOf = (sql: string) => sql.trim().split(/\s+/)[0]?.toUpperCase() ?? "";

/** Run one read statement into its cell. Resolves true when it worked; a Stop
 *  resolves false without an error (the old result stays). */
async function execRead(tabId: string, cellId: string, ctx: RunContext): Promise<boolean> {
  const cell = cellOf(tabId, cellId);
  if (!cell) return false;
  const sql = cell.sql;
  const runId = nextRunId();
  store().patchCell(tabId, cellId, {
    running: true,
    runId,
    error: null,
    notice: null,
    skipped: false,
    confirm: null,
  });
  const started = performance.now();
  try {
    const run = await runCell(ctx.handleId, runId, sql, ctx.schema);
    if (run.cancelled || !run.result) {
      store().patchCell(tabId, cellId, {
        running: false,
        runId: undefined,
        notice: t("notebook.stopped"),
      });
      return false;
    }
    const r = run.result;
    store().patchCell(tabId, cellId, {
      running: false,
      runId: undefined,
      ranSql: sql,
      collapsed: false,
      result: {
        columns: r.columns.map((c) => c.name),
        rows: r.rows.slice(0, MAX_SHOWN_ROWS),
        rowCount: r.rowCount,
        truncated: r.truncated,
        ms: Math.max(1, Math.round(r.elapsedMs || performance.now() - started)),
        at: stamp(),
        saved: false,
      },
    });
    return true;
  } catch (err) {
    // F3: the error replaces the old result.
    store().patchCell(tabId, cellId, {
      running: false,
      runId: undefined,
      error: appErrorMessage(err, t("notebook.queryFailed")),
      result: null,
      ranSql: null,
    });
    return false;
  }
}

/** Count the rows an UPDATE / DELETE would change, with the dry run. */
async function countWrite(
  sql: string,
  ctx: RunContext,
): Promise<{ rows: number | null; error?: string }> {
  try {
    const out = await debugPlan(ctx.handleId, sql, ctx.schema);
    if (out.kind === "cannot") {
      // INSERT, DDL, or a shape the dry run cannot read: no count, still a
      // confirmation. A statement the engine rejects outright is an error.
      return out.cannot.reason === "parse"
        ? { rows: null, error: out.cannot.message }
        : { rows: null };
    }
    const step = out.plan.steps[out.plan.steps.length - 1];
    if (!step || !out.plan.write) return { rows: null };
    // A debug run registers a cancel token; cancelling releases it.
    const runId = `nbcount-${nextRunId()}`;
    const r = await debugRunStep(ctx.handleId, runId, step, ctx.schema).finally(
      () => void debugCancel(runId).catch(() => {}),
    );
    if (r.error) return { rows: null, error: r.error };
    return { rows: r.count ?? null };
  } catch (err) {
    return { rows: null, error: appErrorMessage(err, t("notebook.queryFailed")) };
  }
}

/** Run a cell from its own Run button (or ⌘↩). */
export async function runOne(tabId: string, cellId: string, ctx: RunContext): Promise<void> {
  const cell = cellOf(tabId, cellId);
  if (!cell || !cell.sql.trim() || cell.running) return;
  let kind: StatementKind;
  try {
    [kind] = (await classify([cell.sql])) as [StatementKind];
  } catch {
    kind = "read";
  }
  if (kind === "transaction") {
    store().patchCell(tabId, cellId, {
      error: t("notebook.txnRefused"),
      result: null,
      ranSql: null,
      notice: null,
      confirm: null,
    });
    return;
  }
  if (kind === "write") {
    const verb = verbOf(cell.sql);
    // F5: on a read-only workspace a write cannot run at all.
    if (ctx.readOnly) {
      store().patchCell(tabId, cellId, {
        confirm: { rows: null, readOnly: true, prod: ctx.prod, verb },
        error: null,
        notice: null,
        skipped: false,
      });
      return;
    }
    const sql = cell.sql;
    store().patchCell(tabId, cellId, {
      confirm: { rows: null, counting: true, prod: ctx.prod, verb },
      error: null,
      notice: null,
      skipped: false,
    });
    const counted = await countWrite(sql, ctx);
    // Editing the SQL while counting dismissed the strip: leave it dismissed.
    const now = cellOf(tabId, cellId);
    if (!now?.confirm || now.sql !== sql) return;
    store().patchCell(tabId, cellId, {
      confirm: { rows: counted.rows, error: counted.error, prod: ctx.prod, verb },
    });
    return;
  }
  await execRead(tabId, cellId, ctx);
}

/** Run the write the confirmation was showing (Run {VERB}). */
export async function confirmWrite(tabId: string, cellId: string, ctx: RunContext): Promise<void> {
  const cell = cellOf(tabId, cellId);
  if (!cell?.confirm || cell.confirm.error || cell.confirm.readOnly) return;
  const { rows, verb } = cell.confirm;
  const runId = nextRunId();
  store().patchCell(tabId, cellId, {
    confirm: null,
    running: true,
    runId,
    error: null,
    notice: null,
  });
  try {
    // Change history (M48): a recorded write runs through the recorder, which
    // reads the rows it touches in the write's own transaction. (It has no
    // cancel token: Stop does not reach it.)
    if (await recordingFor(ctx.connectionId)) {
      const rec = await historyRecord(
        ctx.handleId,
        ctx.connectionId ?? "",
        [cell.sql],
        ctx.schema,
        "statement",
        currentLimits(),
      );
      const out = rec.outcomes[0];
      if (out?.error) throw new Error(out.error);
      const n = out?.result?.rowCount;
      if (rec.entries.length) useHistoryStore.getState().bump();
      store().patchCell(tabId, cellId, {
        running: false,
        runId: undefined,
        result: null,
        ranSql: null,
        recorded: rec.entries.length > 0,
        notice:
          n == null && rows == null
            ? t("notebook.write.appliedNoCount", { verb })
            : t("notebook.write.applied", {
                verb,
                rows: t("notebook.rows", { count: n ?? rows ?? 0 }),
              }),
      });
      return;
    }
    const run = await runCell(ctx.handleId, runId, cell.sql, ctx.schema);
    store().patchCell(tabId, cellId, {
      recorded: false,
      running: false,
      runId: undefined,
      result: null,
      ranSql: null,
      notice: run.cancelled
        ? t("notebook.stopped")
        : rows == null
          ? t("notebook.write.appliedNoCount", { verb })
          : t("notebook.write.applied", { verb, rows: t("notebook.rows", { count: rows }) }),
    });
  } catch (err) {
    store().patchCell(tabId, cellId, {
      running: false,
      runId: undefined,
      error: appErrorMessage(err, t("notebook.queryFailed")),
    });
  }
}

/** Stop a cell's run in flight. */
export function stopCell(tabId: string, cellId: string): void {
  const runId = cellOf(tabId, cellId)?.runId;
  if (runId) void cancelCell(runId).catch(() => {});
}

export type RunAllOutcome =
  | { kind: "nothing" }
  | { kind: "done"; ran: number; skipped: number }
  | { kind: "failed"; ran: number; total: number }
  | { kind: "stopped"; ran: number; total: number };

/**
 * Run all (F6): reads only, top to bottom, one at a time. Every non-read cell
 * is marked skipped. Stops at the first failure, and on Stop.
 */
export async function runAll(tabId: string, ctx: RunContext): Promise<RunAllOutcome> {
  const doc = store().docs[tabId];
  if (!doc || doc.runAll) return { kind: "nothing" };
  const qs = doc.nb.cells.filter((c): c is QueryCell => c.type === "query" && !!c.sql.trim());
  let kinds: StatementKind[];
  try {
    kinds = await classify(qs.map((c) => c.sql));
  } catch {
    kinds = qs.map(() => "read");
  }
  const reads = qs.filter((_, i) => kinds[i] === "read");
  qs.forEach((c, i) => {
    if (kinds[i] !== "read") store().patchCell(tabId, c.id, { skipped: true, confirm: null });
  });
  if (!reads.length) return { kind: "nothing" };
  store().patch(tabId, () => ({ runAll: { done: 0, total: reads.length, stopping: false } }));
  let ran = 0;
  try {
    for (const c of reads) {
      if (store().docs[tabId]?.runAll?.stopping)
        return { kind: "stopped", ran, total: reads.length };
      const ok = await execRead(tabId, c.id, ctx);
      if (store().docs[tabId]?.runAll?.stopping)
        return { kind: "stopped", ran, total: reads.length };
      if (!ok) return { kind: "failed", ran, total: reads.length };
      ran++;
      store().patch(tabId, (d) => ({ runAll: d.runAll && { ...d.runAll, done: ran } }));
    }
    return { kind: "done", ran, skipped: qs.length - reads.length };
  } finally {
    store().patch(tabId, () => ({ runAll: null }));
  }
}

/** Stop Run all: the cell in flight is cancelled and no further cell starts. */
export function stopRunAll(tabId: string): void {
  const doc = store().docs[tabId];
  if (!doc?.runAll) return;
  store().patch(tabId, (d) => ({ runAll: d.runAll && { ...d.runAll, stopping: true } }));
  for (const c of doc.nb.cells)
    if (c.type === "query" && c.runId) void cancelCell(c.runId).catch(() => {});
}
