// SQL execution-order minimap + "Explain & analyze" teaching panel (M15).
//
// Ported from the prototype's explain.jsx. RENDERER-ONLY, CLIENT-SIDE: a
// teaching visualization of the *logical* processing order of a SELECT
// (FROM → WHERE → GROUP BY → HAVING → SELECT → DISTINCT → ORDER BY → LIMIT) —
// NOT a real engine EXPLAIN. No backend call: everything is derived from
// `detectClauses` (see explainClauses.ts), which masks string literals + `--`
// comments before matching.
//
// The prototype's `analyzeQuery` ran a mock engine for real row counts and a
// psql-style plan tree; we have no in-browser engine, so the panel is built
// from clause detection alone. When the detected FROM table has cached
// introspection columns (passed in by the editor, no fetch), the FROM step is
// enriched with its column count — optional and purely client-side.

import { Icon } from "../../../shared/ui/Icon";
import {
  clausePresent,
  type DetectedClauses,
  detectClauses,
  RUN_ORDER,
  type StepKey,
  stepByKey,
  WRITTEN_ORDER,
} from "./explainClauses";

/** Compact two-column "written vs. run order" minimap shown under the editor. */
export function ExecutionMinimap({ sql }: { sql: string }) {
  const c = detectClauses(sql);

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

interface ExplainStep {
  kw: string;
  label: string;
  desc: string;
  extra: string | null;
}

/** Build the per-step explanation list (only the clauses actually present). */
function buildSteps(c: DetectedClauses, columnCount: number | null): ExplainStep[] {
  const steps: ExplainStep[] = [];
  const add = (key: StepKey, extra: string | null) => {
    const def = stepByKey(key);
    steps.push({ kw: def.kw, label: def.label, desc: def.desc, extra });
  };

  add("from", c.table ? c.table + (columnCount != null ? ` · ${columnCount} cols` : "") : null);
  if (c.where) add("where", null);
  if (c.groupBy) add("groupBy", null);
  if (c.having) add("having", null);
  add("select", c.aggregate ? "with aggregates" : c.distinct ? "distinct rows" : null);
  if (c.distinct) add("distinct", null);
  if (c.orderBy) add("orderBy", null);
  if (c.limit) add("limit", null);
  return steps;
}

/**
 * "Explain & analyze" teaching panel: the present clauses listed in logical
 * execution order, each with its keyword badge, label, and description. The
 * right column shows the same clauses as a query-plan tree (outermost →
 * innermost) the way a planner nests them. `columnCount` is optional cached
 * enrichment for the FROM step.
 */
export function ExplainPanel({
  sql,
  columnCount = null,
}: {
  sql: string;
  schemaName?: string;
  columnCount?: number | null;
}) {
  const c = detectClauses(sql);

  if (!c.isSelect) {
    return (
      <div className="explain-panel">
        <div className="sql-error" style={{ margin: 14 }}>
          <Icon name="error" size={18} />
          <div>
            <div className="sql-error-title">Nothing to explain yet</div>
            <div className="sql-error-msg">
              The execution-order view explains a SELECT query — write one above to see how it runs.
            </div>
          </div>
        </div>
      </div>
    );
  }

  const steps = buildSteps(c, columnCount);

  // A psql-EXPLAIN-style plan tree built purely from detected clauses
  // (outermost → innermost). No row counts — those need a real planner.
  const table = c.table ?? "?";
  const plan: { node: string; filter?: string }[] = [];
  if (c.limit) plan.push({ node: "Limit" });
  if (c.orderBy) plan.push({ node: "Sort" });
  if (c.distinct) plan.push({ node: "Unique" });
  if (c.groupBy) plan.push({ node: "HashAggregate" });
  else if (c.aggregate) plan.push({ node: "Aggregate" });
  plan.push({
    node: "Seq Scan on " + table,
    filter: c.where ? "Filter: WHERE predicate" : undefined,
  });

  const planText = plan
    .map((p, i) => {
      const indent = "  ".repeat(i);
      const arrow = i === 0 ? "" : "->  ";
      let line = indent + arrow + p.node;
      if (p.filter) line += "\n" + "  ".repeat(i + 1) + "    " + p.filter;
      return line + (i < plan.length - 1 ? "\n" : "");
    })
    .join("");

  return (
    <div className="explain-panel">
      <div className="explain-cols">
        <div className="explain-steps">
          <div className="explain-h">
            <Icon name="account_tree" size={14} style={{ color: "var(--accent)" }} /> How this query
            runs · logical order
          </div>
          {steps.map((s, i) => (
            <div className="explain-step" key={i}>
              <span className="explain-step-n">{i + 1}</span>
              <div className="explain-step-body">
                <div className="explain-step-head">
                  <span className="explain-step-kw">{s.kw}</span>
                  {s.extra ? <code className="explain-step-extra">{s.extra}</code> : null}
                </div>
                <div className="explain-step-desc">{s.desc}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="explain-plan">
          <div className="explain-h">
            <Icon name="lan" size={14} style={{ color: "var(--accent)" }} /> Query plan
          </div>
          <pre className="explain-plan-tree">{planText}</pre>
          <div className="explain-note">
            This is the <b>logical</b> shape of the query — how the engine nests the operators,
            outermost to innermost. A real planner (EXPLAIN ANALYZE) also reports row estimates,
            index usage, buffers, and per-node timing.
          </div>
        </div>
      </div>
    </div>
  );
}
