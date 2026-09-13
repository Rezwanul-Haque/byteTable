// SQL execution-order minimap + the "Explain & analyze" panel (M15, redesigned
// in M33).
//
// Three views over ONE analysis, chosen from the summary strip:
//
//   Plan         a plan-node table beside a visual plan tree, plus warnings
//   How it runs  the clause-order teaching view, kept behind a mode
//   Raw output   the engine's EXPLAIN printed verbatim (explainServer.ts)
//
// WHERE THE PLAN COMES FROM. The `explain_plan` command asks the engine for its
// own plan and returns it in the node model; which statement each engine takes
// and how to read its answer lives in Rust (`features/explain`), not here. So
// the tree shows the access paths and indexes the optimizer actually chose. It
// is the plan-only form, which executes nothing, so this happens on production
// connections too. An engine with no machine-readable plan — and any plan the
// backend could not read — falls back to the tree modelled from the statement
// (explainModel.ts). The summary strip says which, because a table of node
// names reads as authoritative either way.
//
// WHERE THE NUMBERS COME FROM. The summary figures — total time, rows returned,
// rows read — are measured by running the statement (explainRun.ts). That
// executes, so it is automatic on dev/staging and waits for the Measure button
// on production. Per-node figures come from the plan: actual milliseconds if it
// came from an ANALYZE, the planner's cost if not, and nothing at all for
// SQLite, which reports neither. The column heading follows.

import { useEffect, useMemo, useRef, useState } from "react";

import { appErrorMessage } from "../../../shared/api/error";
import { useT } from "../../../shared/i18n/useT";
import { CopyButton } from "../../../shared/ui/CopyButton";
import { Icon } from "../../../shared/ui/Icon";
import { normalizeEnv, type Engine } from "../../../shared/types";
import {
  clausePresent,
  NESTED_IN_WRITTEN,
  detectClauses,
  RUN_ORDER,
  type StepKey,
  stepByKey,
  WRITTEN_ORDER,
} from "../explainClauses";
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
  type PlanNode,
  psqlPlanLines,
  psqlPlanText,
  rawPlanText,
  withServerPlan,
} from "../explainModel";
import { parseSelectShape } from "../explainParse";
import { measureQuery } from "../explainRun";
import {
  explainCapabilities,
  type ExplainCapabilities,
  explainPlan,
  explainRaw,
  numericColumns,
  rawPlanAscii,
  type RawPlan,
  rawPlanTextOf,
  type ServerPlan,
} from "../explainServer";
import { statementContextAt } from "../sqlStatement";

/**
 * Compact two-column "written vs. run order" minimap shown under the editor.
 * Cursor-aware: in a multi-statement buffer it shows the clause order for only
 * the statement the caret is in (live on click / key / select), with a
 * "Statement N of M" label; the label is hidden when there is a single
 * statement.
 */
export function ExecutionMinimap({ sql, caret = 0 }: { sql: string; caret?: number }) {
  const t = useT();
  const stmt = statementContextAt(sql, caret);
  const c = detectClauses(stmt.text);

  // `nest` marks the column where a nested clause (JOIN … ON, written inside
  // FROM) is shown indented and unnumbered — it is not a top-level clause there.
  // In the run column it is a step like any other and takes its own number.
  const renderCol = (label: string, sub: string, orderKeys: StepKey[], nest: boolean) => {
    let n = 0;
    return (
      <div className="exec-mini-col">
        <div className="exec-mini-collabel">{label}</div>
        <div className="exec-mini-colsub">{sub}</div>
        {orderKeys.map((key) => {
          const nested = nest && NESTED_IN_WRITTEN.has(key);
          const on = clausePresent(c, key);
          if (on && !nested) n += 1;
          const def = stepByKey(key);
          return (
            <div
              key={key}
              className={
                "exec-mini-step" + (on ? " on" : "") + (nested ? " exec-mini-step-nested" : "")
              }
              title={t(def.descKey)}
            >
              <span className="exec-mini-num">{nested ? "↳" : on ? n : "·"}</span>
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
        <Icon name="account_tree" size={13} style={{ color: "var(--accent)" }} />{" "}
        {t("expl.clauseOrder")}
      </div>
      {stmt.count > 1 ? (
        <div className="exec-mini-stmt">
          <Icon name="my_location" size={11} style={{ color: "var(--accent)" }} />{" "}
          {t("expl.statement", { index: stmt.index + 1, count: stmt.count })}{" "}
          <span className="exec-mini-stmt-hint">{t("expl.cursorHint")}</span>
        </div>
      ) : null}
      <div className="exec-mini-cols">
        {renderCol(t("expl.written"), t("expl.writtenSub"), WRITTEN_ORDER, true)}
        {renderCol(t("expl.run"), t("expl.runSub"), RUN_ORDER, false)}
      </div>
      <div className="exec-mini-foot">
        {c.outerJoin ? <>{t("expl.mini.outerJoin")}</> : <>{t("expl.mini.clause")}</>}
      </div>
    </div>
  );
}

/**
 * The per-node figure: measured milliseconds where a plan reported them, the
 * planner's own cost where it only estimated, and "—" where the engine gives
 * neither (SQLite reports no numbers at all). Never a millisecond value under a
 * heading that says Cost, or the reverse.
 */
function NodeCost({ node, share }: { node: PlanNode; share: "time" | "cost" | null }) {
  if (share === "cost") {
    return node.cost == null ? <>—</> : <>{node.cost.toLocaleString()}</>;
  }
  if (node.ms == null) return <>—</>;
  return (
    <>
      {fmtMs(node.ms)}
      <small>ms</small>
    </>
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
 * Raw output — the plan the **server** produced, not ours.
 *
 * Every other view in this panel is modelled client-side, which is fine for
 * teaching the shape of a query and useless for the questions people actually
 * bring to an EXPLAIN: which index was chosen, why a scan is full, what the
 * optimizer estimated. So this one asks the database and prints the answer
 * verbatim — the same rows psql or the mysql client would show.
 *
 * `EXPLAIN` is the default because it plans without executing, which makes it
 * safe on any connection, production included. `EXPLAIN ANALYZE` runs the
 * statement, so it stays behind a deliberate click.
 *
 * Engines whose plan cannot be fetched as an ordinary statement (SQL Server,
 * Oracle) fall back to the modelled rendering, labelled as such — a plan drawn
 * from our own model is worth something as long as it does not pretend to have
 * come from the server.
 */
function PsqlPlanView({
  a,
  sql,
  handleId,
  schemaName,
  engine,
  capabilities,
}: {
  a: Analysis;
  sql: string;
  handleId: string;
  schemaName: string;
  engine: Engine;
  /** Null while the backend is still being asked what this engine supports. */
  capabilities: ExplainCapabilities | null;
}) {
  const [analyze, setAnalyze] = useState(false);
  const [copied, setCopied] = useState(false);
  const t = useT();
  // Keyed by (connection, schema, form, statement) and kept per form, not
  // replaced: flipping back to EXPLAIN ANALYZE would otherwise re-execute the
  // query every time, which is exactly the cost that toggle is warning about.
  const [plans, setPlans] = useState<Record<string, RawPlan>>({});
  const [failures, setFailures] = useState<Record<string, string>>({});

  const support = capabilities;
  const form = analyze ? "analyze" : "plan";
  const available = support != null && (analyze ? support.analyze : support.plan);
  // ANALYZE executes, so it is never fetched until the user selects it.
  const key = handleId + " " + schemaName + " " + form + " " + sql;
  // Keys with a call in flight. There is deliberately no "already asked" latch
  // and no live/cancelled flag: under StrictMode React mounts, tears down and
  // remounts, so a latch set on the first mount blocks the second while the
  // first call's result is thrown away by the cancelled flag — the plan then
  // never arrives and the pane spins forever. Results are keyed by `key`
  // instead, which makes a late result harmless: it is stored under its own key
  // and simply not shown if the user has moved on.
  const inflight = useRef(new Set<string>());
  const server = plans[key] ?? null;
  const error = failures[key] ?? null;
  // Still waiting on capabilities counts as loading: flashing the modelled
  // fallback for a frame and then replacing it with the server's plan reads as
  // a glitch, and briefly asserts the wrong provenance.
  const loading = (support == null || available) && !server && !error;

  useEffect(() => {
    if (!available) return;
    if (plans[key] !== undefined || failures[key] !== undefined) return;
    if (inflight.current.has(key)) return;
    inflight.current.add(key);
    explainRaw(handleId, sql, schemaName, analyze)
      .then((data) => setPlans((p) => ({ ...p, [key]: data })))
      .catch((e: unknown) => {
        const message = appErrorMessage(e, t("expl.err.refused"));
        setFailures((f) => ({ ...f, [key]: message }));
      })
      .finally(() => inflight.current.delete(key));
  }, [available, key, handleId, schemaName, sql, analyze, plans, failures, t]);

  // Fall back to the modelled renderers whenever the server's plan is not
  // available — unsupported engine, or a failed call.
  const modelled = (support != null && !available) || !!error;
  const modelLines = psqlPlanLines(a, true);
  const modelWidth = Math.max(10, ...modelLines.map((r) => r.length));

  // Before the server answers there is no statement to echo, and guessing one
  // would print a form the engine may not even take — SQLite's is `EXPLAIN
  // QUERY PLAN`, Postgres' analyze is `EXPLAIN (ANALYZE, BUFFERS)`. Echo the
  // query itself until the real statement comes back with the plan.
  const shown = server?.statement ?? oneLine(sql);
  const numeric = server ? numericColumns(server) : [];

  const copy = () => {
    const text = server
      ? server.text
        ? rawPlanTextOf(server)
        : rawPlanAscii(server)
      : analyze
        ? psqlPlanText(a, true)
        : mysqlExplainText(a);
    void navigator.clipboard?.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div className="ex-psql-pane">
      <div className="explain-h">
        <Icon name="terminal" size={14} style={{ color: "var(--accent)" }} />{" "}
        {t("expl.serverOutput")}
        <div className="seg ex-psql-modes">
          <button
            type="button"
            className={"seg-btn" + (!analyze ? " active" : "")}
            onClick={() => setAnalyze(false)}
            title={t("expl.mode.planTitle")}
          >
            EXPLAIN
          </button>
          <button
            type="button"
            className={"seg-btn" + (analyze ? " active" : "")}
            onClick={() => setAnalyze(true)}
            disabled={!support?.analyze}
            title={
              support?.analyze
                ? t("expl.mode.analyzeTitle")
                : (support?.note ?? t("expl.mode.analyzeUnavailable"))
            }
          >
            EXPLAIN ANALYZE
          </button>
        </div>
      </div>
      <div className="ex-psql-box">
        <div className="ex-psql-bar">
          <code>bytetable&gt; {shown.length > 90 ? shown.slice(0, 90) + "…" : shown}</code>
          <button type="button" className="ex-copy" onClick={copy}>
            <Icon name={copied ? "check" : "content_copy"} size={12} />{" "}
            {copied ? t("expl.copied") : t("expl.copy")}
          </button>
        </div>
        {loading ? (
          <div className="ex-psql-wait">
            <span className="spinner" /> {t("expl.asking")}
          </div>
        ) : server ? (
          server.text ? (
            <ServerTextPlan plan={server} />
          ) : (
            <div className="ex-my-wrap">
              <table className="ex-my">
                <thead>
                  <tr>
                    {server.columns.map((c, i) => (
                      <th key={i} className={numeric[i] ? "num" : ""}>
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {server.rows.map((row, i) => (
                    <tr key={i}>
                      {server.columns.map((_, j) => {
                        const v = row[j] ?? null;
                        return (
                          <td
                            key={j}
                            className={(numeric[j] ? "num " : "") + (v === null ? "nul" : "")}
                          >
                            {v === null ? "NULL" : String(v)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="ex-my-count">{t("expl.rowCount", { count: server.rows.length })}</div>
            </div>
          )
        ) : analyze ? (
          <pre className="ex-psql">
            <span className="pq-head">
              {" ".repeat(Math.max(0, Math.floor((modelWidth - 10) / 2))) + "QUERY PLAN"}
            </span>
            {"\n"}
            <span className="pq-rule">{"-".repeat(modelWidth + 1)}</span>
            {"\n"}
            {modelLines.map((r, i) => (
              <span
                key={i}
                className={"pq-row" + (/^ (Planning|Execution) Time/.test(r) ? " pq-time" : "")}
              >
                {r + "\n"}
              </span>
            ))}
            <span className="pq-count">{t("expl.rowCount", { count: modelLines.length })}</span>
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
                {mysqlExplainRows(a).map((r, i) => (
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
              {t("expl.rowCount", { count: mysqlExplainRows(a).length })}
            </div>
          </div>
        )}
      </div>
      {error ? (
        <div className="ex-warn ex-psql-note">
          <Icon name="error" size={13} />
          <div>
            <b>{engineLabel(engine)}</b> — {error}
          </div>
        </div>
      ) : null}
      {modelled && !error && support?.note ? (
        <div className="ex-warn ex-psql-note">
          <Icon name="info" size={13} />
          <div>{support?.note}</div>
        </div>
      ) : null}
      <div className="explain-note">
        {modelled ? (
          <>{t("expl.note.modelled")}</>
        ) : analyze ? (
          <>{t("expl.note.analyze")}</>
        ) : (
          <>{t("expl.note.explain", { engine: engineLabel(engine) })}</>
        )}
      </div>
    </div>
  );
}

/**
 * A single-text-column plan (psql's `QUERY PLAN`, MySQL's `EXPLAIN ANALYZE`,
 * ClickHouse's `explain`), laid out the way a terminal client does: the column
 * name centred over the widest line, a dashed rule, then the plan, then the
 * row count. The count is the *line* count, since MySQL returns the whole tree
 * in one cell and "(1 row)" over eight lines would just look wrong.
 */
function ServerTextPlan({ plan }: { plan: RawPlan }) {
  const t = useT();
  const lines = rawPlanTextOf(plan).split("\n");
  const head = plan.columns[0] ?? "QUERY PLAN";
  const width = Math.max(head.length, ...lines.map((l) => l.length));
  const pad = " ".repeat(Math.max(0, Math.floor((width - head.length) / 2)));
  return (
    <pre className="ex-psql">
      <span className="pq-head">{pad + head}</span>
      {"\n"}
      <span className="pq-rule">{"-".repeat(width + 1)}</span>
      {"\n"}
      {lines.map((line, i) => (
        <span
          key={i}
          className={
            "pq-row" + (/(Planning|Execution) Time|actual time/.test(line) ? " pq-time" : "")
          }
        >
          {line + "\n"}
        </span>
      ))}
      <span className="pq-count">{t("expl.rowCount", { count: lines.length })}</span>
    </pre>
  );
}

/** The statement on one line, for the prompt echo. */
function oneLine(sql: string): string {
  return (
    String(sql || "")
      .replace(/--[^\n]*/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/;$/, "") + ";"
  );
}

/** Engine name as the notes refer to it. */
function engineLabel(engine: Engine): string {
  const names: Partial<Record<Engine, string>> = {
    mysql: "MySQL",
    postgres: "Postgres",
    sqlite: "SQLite",
    mssql: "SQL Server",
    clickhouse: "ClickHouse",
  };
  return names[engine] ?? engine;
}

interface ExplainPanelProps {
  sql: string;
  /** Connection handle the measuring run goes to. */
  handleId: string;
  /** Schema the statement runs against. */
  schemaName: string;
  /** Connection environment — production connections never auto-measure. */
  env: string;
  /** Which engine to ask for the raw plan, and in what dialect. */
  engine: Engine;
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
  engine,
  approxRows,
  columnCount = null,
}: ExplainPanelProps) {
  const t = useT();
  const [mode, setMode] = useState<"plan" | "steps" | "psql">("plan");
  const [raw, setRaw] = useState(false);
  // Every per-statement piece of state is tagged with the statement it belongs
  // to and read back through that tag, so switching statements resets the
  // panel by derivation instead of by a cascade of effects.
  const [result, setResult] = useState<{ key: string; stats: ExplainStats } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [asked, setAsked] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ key: string; order: number } | null>(null);
  const [serverPlans, setServerPlans] = useState<Record<string, ServerPlan>>({});
  // Per connection, not per statement: what an engine can be asked for does not
  // change between queries. Fetched rather than derived, so the renderer never
  // has to know a dialect.
  const [caps, setCaps] = useState<Record<string, ExplainCapabilities>>({});
  const capabilities = caps[handleId] ?? null;

  const key = handleId + " " + schemaName + " " + sql;
  const stats = result?.key === key ? result.stats : EMPTY_STATS;
  const runError = failure?.key === key ? failure.message : null;
  const sel = selected?.key === key ? selected.order : null;
  const setSel = (order: number | null) => setSelected(order == null ? null : { key, order });

  const shape = useMemo(() => parseSelectShape(sql), [sql]);
  const modelledPlan = useMemo(() => analyzeQuery(shape, stats), [shape, stats]);
  // The server's tree replaces the modelled one wherever we can get it; the
  // measured summary figures on `modelledPlan` carry over either way.
  const serverPlan = serverPlans[key] ?? null;
  const a = useMemo(
    () => (serverPlan ? withServerPlan(modelledPlan, serverPlan) : modelledPlan),
    [modelledPlan, serverPlan],
  );

  // Measuring executes the statement, so it runs on its own for dev and
  // staging connections and waits for the Measure button on production ones,
  // where running someone's query unasked is not on.
  //
  // `inflight` only stops two calls overlapping. It is deliberately not an
  // "already asked" latch, and there is no cancelled flag: StrictMode mounts,
  // tears down and remounts, so a latch would block the second mount while the
  // cancelled flag discarded the first mount's result, and the numbers would
  // never appear. Results carry their own key, so a late one is stored against
  // the statement it belongs to and ignored if the user has moved on.
  const analyzable = a.error == null;
  const isProd = normalizeEnv(env) === "production";
  const shouldMeasure = analyzable && (!isProd || asked === key);
  const busy = shouldMeasure && result?.key !== key && failure?.key !== key;
  const inflight = useRef(new Set<string>());

  const measure = () => {
    setFailure((f) => (f?.key === key ? null : f));
    setAsked(key);
  };

  useEffect(() => {
    if (!shouldMeasure) return;
    if (result?.key === key || failure?.key === key) return;
    if (inflight.current.has(key)) return;
    inflight.current.add(key);
    measureQuery(handleId, schemaName, sql, shape, approxRows)
      .then((s) => setResult({ key, stats: s }))
      .catch((e: unknown) =>
        setFailure({ key, message: appErrorMessage(e, t("expl.err.analyze")) }),
      )
      .finally(() => inflight.current.delete(key));
  }, [shouldMeasure, key, handleId, schemaName, sql, shape, approxRows, result, failure, t]);

  // The structured plan is fetched unconditionally, production included: it is
  // the plan-only form, so it executes nothing. A failure is not surfaced —
  // there is a complete modelled tree to fall back to, and an error card over a
  // working view would be noise.
  useEffect(() => {
    if (caps[handleId] !== undefined || inflight.current.has(handleId)) return;
    inflight.current.add(handleId);
    explainCapabilities(handleId)
      .then((c) => setCaps((prev) => ({ ...prev, [handleId]: c })))
      .catch(() => undefined)
      .finally(() => inflight.current.delete(handleId));
  }, [handleId, caps]);

  const planKey = "plan " + key;
  useEffect(() => {
    if (!analyzable || !capabilities?.structured) return;
    if (serverPlans[key] !== undefined || inflight.current.has(planKey)) return;
    inflight.current.add(planKey);
    explainPlan(handleId, sql, schemaName)
      .then((plan) => {
        if (plan) setServerPlans((p) => ({ ...p, [key]: plan }));
      })
      .catch(() => undefined)
      .finally(() => inflight.current.delete(planKey));
  }, [analyzable, capabilities, key, planKey, handleId, schemaName, sql, serverPlans]);

  if (a.error) {
    return (
      <div className="explain-panel">
        <div className="sql-error" style={{ margin: 14 }}>
          <Icon name="error" size={18} />
          <div>
            <div className="sql-error-title">{t("expl.canAnalyze")}</div>
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
            <div className="sql-error-title">{t("expl.canAnalyze")}</div>
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
      ? { ...s, extra: `${s.extra} ${t("expl.colsCount", { count: columnCount })}` }
      : s,
  );

  return (
    <div className="explain-panel">
      <div className="ex-summary">
        <div className="ex-stat">
          <span>{t("expl.totalTime")}</span>
          <b>{a.ms == null ? "—" : a.ms + " ms"}</b>
        </div>
        <div className="ex-stat">
          <span>{t("expl.rowsReturned")}</span>
          <b>{rowsOut}</b>
        </div>
        <div className="ex-stat">
          <span>{t("expl.rowsRead")}</span>
          <b>{fmtRows(a.base)}</b>
        </div>
        <div className="ex-stat">
          <span>{t("expl.selectivity")}</span>
          <b className={kept != null && kept > 60 ? "warn" : ""}>
            {kept == null ? "—" : kept + "%"}
            <i> {t("expl.kept")}</i>
          </b>
        </div>
        <div className="ex-stat">
          <span>{a.share === "cost" ? t("expl.costliest") : t("expl.slowest")}</span>
          <b>
            {a.slowest ? a.slowest.node.replace(/ on .*/, "") : "—"}
            {a.slowest ? (
              <i> {t("expl.pctOf", { pct: Math.round(a.slowest.pct), share: a.share ?? "" })}</i>
            ) : null}
          </b>
        </div>
        <div className="ex-sum-sp" />
        {/* Which tree is on screen is the first thing to know about it, so it
            is stated here rather than only in the footnote below the fold. */}
        <span
          className={"ex-source" + (a.source === "modelled" ? " modelled" : "")}
          title={
            a.source === "modelled"
              ? t("expl.modelledTitle")
              : t("expl.fetchedTitle", { engine: engineLabel(a.source) })
          }
        >
          <Icon name={a.source === "modelled" ? "draw" : "dns"} size={12} />
          {a.source === "modelled"
            ? t("expl.modelled")
            : t("expl.enginePlan", { engine: engineLabel(a.source) })}
        </span>
        {!a.measured ? (
          <button
            type="button"
            className="ex-measure"
            onClick={measure}
            disabled={busy}
            title={isProd ? t("expl.measureTitleProd") : t("expl.measureTitle")}
          >
            <Icon name={busy ? "hourglass_top" : "speed"} size={13} />
            {busy ? t("expl.measuring") : t("expl.measure")}
          </button>
        ) : null}
        <div className="seg ex-modes">
          <button
            type="button"
            className={"seg-btn" + (mode === "plan" ? " active" : "")}
            onClick={() => setMode("plan")}
          >
            {t("expl.mode.plan")}
          </button>
          <button
            type="button"
            className={"seg-btn" + (mode === "steps" ? " active" : "")}
            onClick={() => setMode("steps")}
          >
            {t("expl.mode.steps")}
          </button>
          <button
            type="button"
            className={"seg-btn" + (mode === "psql" ? " active" : "")}
            onClick={() => setMode("psql")}
            title={t("expl.mode.rawTitle")}
          >
            {t("expl.mode.raw")}
          </button>
        </div>
      </div>

      {mode === "plan" ? (
        <div className="ex-cols">
          <div className="ex-pane">
            <div className="explain-h">
              <Icon name="table_chart" size={14} style={{ color: "var(--accent)" }} />{" "}
              {t("expl.planNodes")}
              <span className="ex-h-note">{t("expl.execOrder")}</span>
            </div>
            <div className="ex-table-wrap">
              <table className="ex-table">
                <thead>
                  <tr>
                    <th className="num">#</th>
                    <th>{t("expl.node")}</th>
                    <th className="num">{t("expl.rowsOut")}</th>
                    <th className="num">{a.share === "cost" ? t("expl.cost") : t("expl.time")}</th>
                    <th className="share">
                      {a.share === null ? t("expl.share") : t("expl.shareOf", { share: a.share })}
                    </th>
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
                                {p.removed
                                  ? " " + t("expl.removed", { count: p.removed.toLocaleString() })
                                  : ""}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="num ex-rows">
                          {fmtRows(p.rows)}
                          {p.kind === "scan" && p.scanned != null && p.scanned !== p.rows ? (
                            <i> {t("expl.of", { count: p.scanned.toLocaleString() })}</i>
                          ) : null}
                        </td>
                        <td className="num ex-ms">
                          <NodeCost node={p} share={a.share} />
                        </td>
                        <td className="share">
                          {a.share === null ? (
                            <em>—</em>
                          ) : (
                            <>
                              <ShareBar pct={p.pct} hot={p === a.slowest} />
                              <em>{Math.round(p.pct)}%</em>
                            </>
                          )}
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
              <Icon name="lan" size={14} style={{ color: "var(--accent)" }} /> {t("expl.planTree")}
              <span className="ex-h-note">{t("expl.dataUp")}</span>
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
                        {a.share === "cost"
                          ? p.cost == null
                            ? "—"
                            : t("expl.costValue", { cost: p.cost.toLocaleString() })
                          : p.ms == null
                            ? "—"
                            : t("expl.ms", { ms: fmtMs(p.ms) })}
                      </span>
                    </div>
                    <div className="ex-tnode-detail">
                      {p.detail}
                      {p.index ? (
                        <>
                          {p.detail ? " · " : ""}
                          <span className="ex-tnode-index">
                            {t("expl.index", { index: p.index })}
                          </span>
                        </>
                      ) : null}
                    </div>
                    <div className="ex-tnode-foot">
                      <span className="ex-tnode-rows">
                        {p.rows == null
                          ? t("expl.noRows")
                          : t("expl.rowsOutCount", { count: p.rows.toLocaleString() })}
                      </span>
                      {a.share === null ? null : (
                        <ShareBar pct={p.pct} hot={p === a.slowest} small />
                      )}
                    </div>
                  </button>
                </div>
              ))}
            </div>
            <div className="ex-tree-foot">
              <div className="ex-tree-foot-bar">
                <button type="button" className="ex-raw-toggle" onClick={() => setRaw((r) => !r)}>
                  <Icon name={raw ? "expand_less" : "expand_more"} size={13} /> {t("expl.compact")}
                </button>
                {/* Only once the plan is showing — a copy button for content
                    that is still collapsed invites copying something unseen. */}
                {raw ? (
                  <CopyButton
                    className="ex-copy ex-plan-copy"
                    label={t("expl.copyPlan")}
                    text={rawPlanText(a)}
                  />
                ) : null}
              </div>
              {raw ? <pre className="explain-plan-tree">{rawPlanText(a)}</pre> : null}
              <div className="explain-note">
                {a.source === "modelled" ? (
                  <>
                    {a.measured
                      ? t("expl.note.treeModelledMeasured")
                      : t("expl.note.treeModelledNoData")}{" "}
                    {t("expl.note.treeModelledTail")}
                  </>
                ) : (
                  <>
                    {t("expl.note.treeServerHead", { engine: engineLabel(a.source) })}{" "}
                    {a.share === "cost"
                      ? t("expl.note.treeServerCost")
                      : a.share === "time"
                        ? t("expl.note.treeServerTime")
                        : t("expl.note.treeServerNone")}
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : mode === "psql" ? (
        <PsqlPlanView
          a={a}
          sql={sql}
          handleId={handleId}
          schemaName={schemaName}
          engine={engine}
          capabilities={capabilities}
        />
      ) : (
        <div className="ex-steps-pane">
          <div className="explain-h">
            <Icon name="account_tree" size={14} style={{ color: "var(--accent)" }} />{" "}
            {t("expl.stepsTitle")}
            <span className="ex-h-note">{t("expl.logicalOrder")}</span>
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
                        {t("expl.rowsPlain", { count: s.rows.toLocaleString() })}
                      </span>
                    ) : null}
                  </div>
                  <div className="explain-step-desc">{t(s.descKey)}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
