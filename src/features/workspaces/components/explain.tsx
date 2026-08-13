// SQL execution-order minimap + the "Explain & analyze" panel (M15, redesigned
// in M33).
//
// Three views over ONE analysis, chosen from the summary strip:
//
//   Plan         a plan-node table beside a visual plan tree, plus warnings
//   How it runs  the original clause-order teaching view, kept behind a mode
//   Raw output   the server's own shapes — MySQL's tabular EXPLAIN or psql's
//                QUERY PLAN text — with an EXPLAIN / EXPLAIN ANALYZE toggle
//
// The plan's *shape* is parsed client-side (explainParse.ts); its *numbers*
// are measured against the real connection (explainRun.ts). Measuring executes
// the statement, so it happens automatically on dev/staging connections and
// only on an explicit click for production ones. Until then the plan renders
// with every numeric column reading "—" — the shape is still worth seeing, and
// an invented number in a database client is worse than no number.

import { useEffect, useMemo, useRef, useState } from "react";

import { appErrorMessage } from "../../../shared/api/error";
import { Icon } from "../../../shared/ui/Icon";
import { normalizeEnv } from "../../../shared/types";
import {
  clausePresent,
  detectClauses,
  RUN_ORDER,
  type StepKey,
  stepByKey,
  WRITTEN_ORDER,
} from "./explainClauses";
import {
  type Analysis,
  analyzeQuery,
  EMPTY_STATS,
  type ExplainStats,
  fmtMs,
  fmtRows,
  MYSQL_COLS,
  mysqlExplainRows,
  mysqlExplainText,
  NODE_ICON,
  psqlPlanLines,
  psqlPlanText,
  rawPlanText,
} from "./explainModel";
import { parseSelectShape } from "./explainParse";
import { measureQuery } from "./explainRun";
import { statementContextAt } from "./sqlStatement";

/**
 * Compact two-column "written vs. run order" minimap shown under the editor.
 * Cursor-aware: in a multi-statement buffer it shows the clause order for only
 * the statement the caret is in (live on click / key / select), with a
 * "Statement N of M" label; the label is hidden when there is a single
 * statement.
 */
export function ExecutionMinimap({ sql, caret = 0 }: { sql: string; caret?: number }) {
  const stmt = statementContextAt(sql, caret);
  const c = detectClauses(stmt.text);

  const renderCol = (label: string, sub: string, orderKeys: StepKey[]) => {
    let n = 0;
    return (
      <div className="exec-mini-col">
        <div className="exec-mini-collabel">{label}</div>
        <div className="exec-mini-colsub">{sub}</div>
        {orderKeys.map((key) => {
          const on = clausePresent(c, key);
          if (on) n += 1;
          const def = stepByKey(key);
          return (
            <div key={key} className={"exec-mini-step" + (on ? " on" : "")} title={def.desc}>
              <span className="exec-mini-num">{on ? n : "·"}</span>
              <span className="exec-mini-kw">{def.kw}</span>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="exec-minimap">
      <div className="exec-mini-title">
        <Icon name="account_tree" size={13} style={{ color: "var(--accent)" }} /> Clause order
      </div>
      {stmt.count > 1 ? (
        <div className="exec-mini-stmt">
          <Icon name="my_location" size={11} style={{ color: "var(--accent)" }} /> Statement{" "}
          {stmt.index + 1} of {stmt.count}{" "}
          <span className="exec-mini-stmt-hint">· where the cursor is</span>
        </div>
      ) : null}
      <div className="exec-mini-cols">
        {renderCol("Written", "how you type it", WRITTEN_ORDER)}
        {renderCol("Run", "how it executes", RUN_ORDER)}
      </div>
      <div className="exec-mini-foot">
        SELECT is written 1st but runs 5th — that’s why ORDER BY can use its aliases but WHERE
        can’t.
      </div>
    </div>
  );
}

/** The share-of-time bar; the slowest node burns amber. */
function ShareBar({ pct, hot, small }: { pct: number; hot: boolean; small?: boolean }) {
  return (
    <div className={"ex-bar" + (small ? " sm" : "")}>
      <span style={{ width: Math.max(2, pct) + "%" }} className={hot ? "hot" : ""} />
    </div>
  );
}

/**
 * Raw server output: MySQL's tabular `EXPLAIN` (the default — it plans only
 * and executes nothing) or psql's `QUERY PLAN` text with actual timings. Copy
 * exports whichever is showing, as a terminal-pasteable ASCII table or text
 * block.
 */
export function PsqlPlanView({ a, sql }: { a: Analysis; sql: string }) {
  const oneLine =
    String(sql || "")
      .replace(/--[^\n]*/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/;$/, "") + ";";
  const [analyze, setAnalyze] = useState(false);
  const [copied, setCopied] = useState(false);
  const rows = psqlPlanLines(a, true);
  const w = Math.max(10, ...rows.map((r) => r.length));
  const mrows = mysqlExplainRows(a);

  const copy = () => {
    const t = analyze ? psqlPlanText(a, true) : mysqlExplainText(a);
    void navigator.clipboard?.writeText(t);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div className="ex-psql-pane">
      <div className="explain-h">
        <Icon name="terminal" size={14} style={{ color: "var(--accent)" }} /> Server output
        <div className="seg ex-psql-modes">
          <button
            type="button"
            className={"seg-btn" + (!analyze ? " active" : "")}
            onClick={() => setAnalyze(false)}
            title="Plan only — the access path the optimizer chose; the query is not executed"
          >
            EXPLAIN
          </button>
          <button
            type="button"
            className={"seg-btn" + (analyze ? " active" : "")}
            onClick={() => setAnalyze(true)}
            title="Runs the query and adds actual time, rows and loops per node"
          >
            EXPLAIN ANALYZE
          </button>
        </div>
      </div>
      <div className="ex-psql-box">
        <div className="ex-psql-bar">
          <code>
            bytetable&gt; {analyze ? "EXPLAIN ANALYZE" : "EXPLAIN"}{" "}
            {oneLine.length > 90 ? oneLine.slice(0, 90) + "…" : oneLine}
          </code>
          <button type="button" className="ex-copy" onClick={copy}>
            <Icon name={copied ? "check" : "content_copy"} size={12} /> {copied ? "Copied" : "Copy"}
          </button>
        </div>
        {analyze ? (
          <pre className="ex-psql">
            <span className="pq-head">
              {" ".repeat(Math.max(0, Math.floor((w - 10) / 2))) + "QUERY PLAN"}
            </span>
            {"\n"}
            <span className="pq-rule">{"-".repeat(w + 1)}</span>
            {"\n"}
            {rows.map((r, i) => (
              <span
                key={i}
                className={"pq-row" + (/^ (Planning|Execution) Time/.test(r) ? " pq-time" : "")}
              >
                {r + "\n"}
              </span>
            ))}
            <span className="pq-count">
              {"(" + rows.length + " row" + (rows.length === 1 ? "" : "s") + ")"}
            </span>
          </pre>
        ) : (
          <div className="ex-my-wrap">
            <table className="ex-my">
              <thead>
                <tr>
                  {MYSQL_COLS.map((c) => (
                    <th
                      key={c}
                      className={c === "rows" || c === "filtered" || c === "id" ? "num" : ""}
                    >
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {mrows.map((r, i) => (
                  <tr key={i}>
                    {MYSQL_COLS.map((c) => (
                      <td
                        key={c}
                        className={
                          (c === "rows" || c === "filtered" || c === "id" ? "num " : "") +
                          (r[c] == null ? "nul" : "")
                        }
                      >
                        {r[c] ?? "NULL"}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="ex-my-count">
              ({mrows.length} row{mrows.length === 1 ? "" : "s"})
            </div>
          </div>
        )}
      </div>
      <div className="explain-note">
        {analyze ? (
          <>
            <b>EXPLAIN ANALYZE</b> executes the query and prints the plan tree: each node carries
            estimates <i>and</i> actual time, rows and loops — compare the two to spot bad
            estimates.
          </>
        ) : (
          <>
            <b>EXPLAIN</b> only plans the query — nothing is executed. One row per accessed table:{" "}
            <code>type=ALL</code> means a full scan, <code>key</code> is the index actually chosen,{" "}
            <code>filtered</code> is the % of scanned rows expected to survive the WHERE.
          </>
        )}
      </div>
    </div>
  );
}

interface ExplainPanelProps {
  sql: string;
  /** Connection handle the measuring run goes to. */
  handleId: string;
  /** Schema the statement runs against. */
  schemaName: string;
  /** Connection environment — production connections never auto-measure. */
  env: string;
  /** Cached introspection row estimate for a table (no fetch is issued). */
  approxRows: (table: string) => number | null;
  /** Cached column count for the FROM relation, shown on the FROM step. */
  columnCount?: number | null;
}

/**
 * "Explain & analyze": summary strip + the Plan / How it runs / Raw output
 * modes. Selection is shared between the plan table and the plan tree, so
 * clicking a node in either highlights it in both.
 */
export function ExplainPanel({
  sql,
  handleId,
  schemaName,
  env,
  approxRows,
  columnCount = null,
}: ExplainPanelProps) {
  const [mode, setMode] = useState<"plan" | "steps" | "psql">("plan");
  const [raw, setRaw] = useState(false);
  // Every per-statement piece of state is tagged with the statement it belongs
  // to and read back through that tag, so switching statements resets the
  // panel by derivation instead of by a cascade of effects.
  const [result, setResult] = useState<{ key: string; stats: ExplainStats } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [asked, setAsked] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ key: string; order: number } | null>(null);

  const key = handleId + " " + schemaName + " " + sql;
  const stats = result?.key === key ? result.stats : EMPTY_STATS;
  const runError = failure?.key === key ? failure.message : null;
  const sel = selected?.key === key ? selected.order : null;
  const setSel = (order: number | null) => setSelected(order == null ? null : { key, order });

  const shape = useMemo(() => parseSelectShape(sql), [sql]);
  const a = useMemo(() => analyzeQuery(shape, stats), [shape, stats]);

  // Measuring executes the statement, so it runs on its own for dev and
  // staging connections and waits for the Measure button on production ones,
  // where running someone's query unasked is not on. `doneKey` keeps the
  // request idempotent across re-renders; the effect's cleanup drops a
  // result that lands after the user moved to another statement.
  const analyzable = a.error == null;
  const isProd = normalizeEnv(env) === "production";
  const shouldMeasure = analyzable && (!isProd || asked === key);
  const busy = shouldMeasure && result?.key !== key && failure?.key !== key;
  const doneKey = useRef<string | null>(null);

  const measure = () => {
    doneKey.current = null;
    setAsked(key);
  };

  useEffect(() => {
    if (!shouldMeasure || doneKey.current === key) return;
    doneKey.current = key;
    let live = true;
    measureQuery(handleId, schemaName, sql, shape, approxRows)
      .then((s) => {
        if (live) setResult({ key, stats: s });
      })
      .catch((e: unknown) => {
        if (live) setFailure({ key, message: appErrorMessage(e, "Could not analyze this query") });
      });
    return () => {
      live = false;
    };
  }, [shouldMeasure, key, handleId, schemaName, sql, shape, approxRows]);

  if (a.error) {
    return (
      <div className="explain-panel">
        <div className="sql-error" style={{ margin: 14 }}>
          <Icon name="error" size={18} />
          <div>
            <div className="sql-error-title">Can’t analyze this query</div>
            <div className="sql-error-msg">{a.error}</div>
          </div>
        </div>
      </div>
    );
  }
  if (runError) {
    return (
      <div className="explain-panel">
        <div className="sql-error" style={{ margin: 14 }}>
          <Icon name="error" size={18} />
          <div>
            <div className="sql-error-title">Can’t analyze this query</div>
            <div className="sql-error-msg">{runError}</div>
          </div>
        </div>
      </div>
    );
  }

  // Selectivity: the share of rows read that survive to the result. Above 60%
  // the query is reading far more than it returns.
  const kept = a.base && a.final != null ? Math.round((a.final / a.base) * 100) : null;
  const rowsOut = a.final == null ? "—" : (a.truncated ? "≥ " : "") + a.final.toLocaleString();
  const steps = a.steps.map((s, i) =>
    i === 0 && columnCount != null && s.extra
      ? { ...s, extra: `${s.extra} · ${columnCount} cols` }
      : s,
  );

  return (
    <div className="explain-panel">
      <div className="ex-summary">
        <div className="ex-stat">
          <span>Total time</span>
          <b>{a.ms == null ? "—" : a.ms + " ms"}</b>
        </div>
        <div className="ex-stat">
          <span>Rows returned</span>
          <b>{rowsOut}</b>
        </div>
        <div className="ex-stat">
          <span>Rows read</span>
          <b>{fmtRows(a.base)}</b>
        </div>
        <div className="ex-stat">
          <span>Selectivity</span>
          <b className={kept != null && kept > 60 ? "warn" : ""}>
            {kept == null ? "—" : kept + "%"}
            <i> of rows read kept</i>
          </b>
        </div>
        <div className="ex-stat">
          <span>Slowest node</span>
          <b>
            {a.slowest ? a.slowest.node.replace(/ on .*/, "") : "—"}
            {a.slowest ? <i> {Math.round(a.slowest.pct)}% of time</i> : null}
          </b>
        </div>
        <div className="ex-sum-sp" />
        {!a.measured ? (
          <button
            type="button"
            className="ex-measure"
            onClick={measure}
            disabled={busy}
            title={
              isProd
                ? "Runs the statement against this production connection to measure rows and time"
                : "Run the statement to measure rows and time"
            }
          >
            <Icon name={busy ? "hourglass_top" : "speed"} size={13} />
            {busy ? "Measuring…" : "Measure"}
          </button>
        ) : null}
        <div className="seg ex-modes">
          <button
            type="button"
            className={"seg-btn" + (mode === "plan" ? " active" : "")}
            onClick={() => setMode("plan")}
          >
            Plan
          </button>
          <button
            type="button"
            className={"seg-btn" + (mode === "steps" ? " active" : "")}
            onClick={() => setMode("steps")}
          >
            How it runs
          </button>
          <button
            type="button"
            className={"seg-btn" + (mode === "psql" ? " active" : "")}
            onClick={() => setMode("psql")}
            title="Raw server output, exactly as EXPLAIN ANALYZE prints it in a terminal"
          >
            Raw output
          </button>
        </div>
      </div>

      {mode === "plan" ? (
        <div className="ex-cols">
          <div className="ex-pane">
            <div className="explain-h">
              <Icon name="table_chart" size={14} style={{ color: "var(--accent)" }} /> Plan nodes
              <span className="ex-h-note">in execution order</span>
            </div>
            <div className="ex-table-wrap">
              <table className="ex-table">
                <thead>
                  <tr>
                    <th className="num">#</th>
                    <th>Node</th>
                    <th className="num">Rows out</th>
                    <th className="num">Time</th>
                    <th className="share">Share of time</th>
                  </tr>
                </thead>
                <tbody>
                  {a.plan
                    .slice()
                    .reverse()
                    .map((p) => (
                      <tr
                        key={p.order}
                        className={sel === p.order ? "sel" : ""}
                        onClick={() => setSel(sel === p.order ? null : p.order)}
                      >
                        <td className="num ex-ord">{p.order}</td>
                        <td>
                          <div className="ex-node-cell">
                            <Icon
                              name={NODE_ICON[p.kind]}
                              size={13}
                              className={"ex-nic " + p.kind}
                            />
                            <div>
                              <div className="ex-node-name">{p.node}</div>
                              <div className="ex-node-detail">
                                {p.detail}
                                {p.removed ? " · removed " + p.removed.toLocaleString() : ""}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="num ex-rows">
                          {fmtRows(p.rows)}
                          {p.kind === "scan" && p.scanned != null && p.scanned !== p.rows ? (
                            <i> of {p.scanned.toLocaleString()}</i>
                          ) : null}
                        </td>
                        <td className="num ex-ms">
                          {p.ms == null ? (
                            "—"
                          ) : (
                            <>
                              {fmtMs(p.ms)}
                              <small>ms</small>
                            </>
                          )}
                        </td>
                        <td className="share">
                          <ShareBar pct={p.pct} hot={p === a.slowest} />
                          <em>{Math.round(p.pct)}%</em>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            {a.warnings.length ? (
              <div className="ex-warns">
                {a.warnings.map((w, i) => (
                  <div className="ex-warn" key={i}>
                    <Icon name="lightbulb" size={13} />
                    <div>
                      <b>{w.node}</b> — {w.text}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          <div className="ex-pane ex-treepane">
            <div className="explain-h">
              <Icon name="lan" size={14} style={{ color: "var(--accent)" }} /> Plan tree
              <span className="ex-h-note">data flows upward</span>
            </div>
            <div className="ex-tree">
              {a.plan.map((p) => (
                <div className="ex-tnode-row" key={p.order} style={{ marginLeft: p.depth * 14 }}>
                  {p.depth ? <span className="ex-tlink" /> : null}
                  <button
                    type="button"
                    className={"ex-tnode " + p.kind + (sel === p.order ? " sel" : "")}
                    onClick={() => setSel(sel === p.order ? null : p.order)}
                  >
                    <div className="ex-tnode-head">
                      <Icon name={NODE_ICON[p.kind]} size={13} className={"ex-nic " + p.kind} />
                      <span className="ex-tnode-name">{p.node}</span>
                      <span className="ex-tnode-ms">
                        {p.ms == null ? "—" : fmtMs(p.ms) + " ms"}
                      </span>
                    </div>
                    <div className="ex-tnode-detail">{p.detail}</div>
                    <div className="ex-tnode-foot">
                      <span className="ex-tnode-rows">
                        {p.rows == null
                          ? "— rows out"
                          : p.rows.toLocaleString() + " row" + (p.rows === 1 ? "" : "s") + " out"}
                      </span>
                      <ShareBar pct={p.pct} hot={p === a.slowest} small />
                    </div>
                  </button>
                </div>
              ))}
            </div>
            <div className="ex-tree-foot">
              <button type="button" className="ex-raw-toggle" onClick={() => setRaw((r) => !r)}>
                <Icon name={raw ? "expand_less" : "expand_more"} size={13} /> Compact text plan
              </button>
              {raw ? <pre className="explain-plan-tree">{rawPlanText(a)}</pre> : null}
              <div className="explain-note">
                {a.measured
                  ? "Row counts and the total time are measured against this connection; the per-node split distributes that total across nodes by relative work. A real planner also reports index usage, buffers and loops per node."
                  : "No numbers yet — measuring runs the statement against this connection. The plan’s shape, nodes and order are read from the statement itself."}
              </div>
            </div>
          </div>
        </div>
      ) : mode === "psql" ? (
        <PsqlPlanView a={a} sql={sql} />
      ) : (
        <div className="ex-steps-pane">
          <div className="explain-h">
            <Icon name="account_tree" size={14} style={{ color: "var(--accent)" }} /> How this query
            runs<span className="ex-h-note">logical clause order</span>
          </div>
          <div className="ex-steps-grid">
            {steps.map((s, i) => (
              <div className="explain-step" key={i}>
                <span className="explain-step-n">{i + 1}</span>
                <div className="explain-step-body">
                  <div className="explain-step-head">
                    <span className="explain-step-kw">{s.kw}</span>
                    {s.extra ? <code className="explain-step-extra">{s.extra}</code> : null}
                    {s.rows != null ? (
                      <span className="explain-step-rows">
                        {s.rows.toLocaleString()} row{s.rows === 1 ? "" : "s"}
                      </span>
                    ) : null}
                  </div>
                  <div className="explain-step-desc">{s.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
