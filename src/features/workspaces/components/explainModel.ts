// The Explain analysis model (MILESTONE_33 Task 3) and the raw-output
// renderers (Task 5). Pure and synchronous: one analysis feeds all three views
// — plan table, plan tree and raw server output — so they can never disagree.
//
// Row counts and the total time come from `ExplainStats` (explainRun.ts), which
// measures the statement against the real connection. Everything is nullable:
// before a measurement lands, the plan still renders with its nodes, depths and
// details, and only the numeric columns read "—".
//
// Per-node milliseconds are *modelled*, not measured — the measured total is
// distributed across the nodes by relative work, and the panel's footnote says
// so. The field names match what a server's `actual time` would fill in, so the
// views stay unchanged the day those numbers arrive from a real plan.

import { EXEC_STEPS, type StepKey } from "./explainClauses";
import type { JoinShape, SelectShape } from "./explainParse";

/** The operator kinds the plan can contain. Drives icon, colour and cost. */
export type NodeKind = "scan" | "join" | "agg" | "sort" | "unique" | "limit";

/** One node of the plan, shared by the table, the tree and the raw views. */
export interface PlanNode {
  /** Display name, psql style (`Seq Scan on orders o`, `HashAggregate`). */
  node: string;
  kind: NodeKind;
  /** Rows leaving this node, or null when not measured. */
  rows: number | null;
  /** The one-line explanation under the name (`Filter: …`, `Sort Key: …`). */
  detail: string;
  /** Modelled milliseconds, or null before a measurement. */
  ms: number | null;
  /** Share of the total modelled work, 0–100. */
  pct: number;
  /**
   * Nesting level, assigned explicitly — never the array index. The two sides
   * of a join sit at the *same* depth; index-derived indentation drew the
   * second scan as a child of the first.
   */
  depth: number;
  /** Execution order, innermost = 1. */
  order: number;
  /** Rows read before the filter (scans only). */
  scanned?: number | null;
  /** Rows the filter discarded (scans only). */
  removed?: number | null;
  /** `quicksort` / `external merge` (sorts only). */
  method?: string;
  /** Relation and alias behind a scan node. */
  rel?: string;
  alias?: string;
  /** True on the inner side of a join — the row the join buffer feeds from. */
  joinSide?: boolean;
}

/** One entry of the "How it runs" clause list. */
export interface ExplainStep {
  kw: string;
  label: string;
  desc: string;
  rows: number | null;
  extra: string | null;
}

/** An actionable tip computed with the plan, never in the view. */
export interface PlanWarning {
  node: string;
  text: string;
}

/**
 * What the statement actually did, as measured against the connection. All
 * fields are optional: the panel renders a plan without them and fills the
 * numbers in when a measurement arrives.
 */
export interface ExplainStats {
  /** Wall-clock ms for the statement. */
  ms: number | null;
  /** Rows the statement returned (after LIMIT). */
  final: number | null;
  /** True when the row cap cut the result — `final` is then a lower bound. */
  truncated: boolean;
  /** Rows in the base relation, before any filter. */
  scanned: number | null;
  /** Rows of the base relation surviving WHERE (single-table queries only). */
  kept: number | null;
  /** Rows per joined relation, keyed by table name. */
  joinRows: Record<string, number | null>;
}

export const EMPTY_STATS: ExplainStats = {
  ms: null,
  final: null,
  truncated: false,
  scanned: null,
  kept: null,
  joinRows: {},
};

/** The whole analysis: one object, three views. */
export interface Analysis {
  /** Why the statement can't be analyzed, or null when it can. */
  error: string | null;
  plan: PlanNode[];
  steps: ExplainStep[];
  warnings: PlanWarning[];
  /** Measured total ms, or null. */
  ms: number | null;
  /** Rows returned, rows read, and rows before LIMIT. */
  final: number | null;
  base: number | null;
  beforeLimit: number | null;
  truncated: boolean;
  table: string;
  joins: JoinShape[];
  slowest: PlanNode | null;
  /** True once real numbers back the plan. */
  measured: boolean;
}

const stepDef = (key: StepKey) => EXEC_STEPS.find((s) => s.key === key)!;

/** Milliseconds, two significant-ish digits — psql's own precision. */
export const fmtMs = (n: number): string => (n >= 10 ? n.toFixed(1) : n.toFixed(2));

/** Row counts with thousands separators; "—" when the number is unknown. */
export const fmtRows = (n: number | null): string => (n == null ? "—" : n.toLocaleString());

/** Material Symbols glyph per node kind. */
export const NODE_ICON: Record<NodeKind, string> = {
  scan: "table_rows",
  join: "lan",
  sort: "sort",
  agg: "functions",
  unique: "filter_alt",
  limit: "vertical_align_bottom",
};

/**
 * Build the analysis for one parsed statement.
 *
 * The plan is written outermost-first (Limit → Sort → Unique → Aggregate →
 * joins → scans), the way psql prints it; `order` numbers it the other way, so
 * the table can list it in execution order.
 */
export function analyzeQuery(shape: SelectShape, stats: ExplainStats): Analysis {
  const empty: Analysis = {
    error: null,
    plan: [],
    steps: [],
    warnings: [],
    ms: null,
    final: null,
    base: null,
    beforeLimit: null,
    truncated: false,
    table: "",
    joins: [],
    slowest: null,
    measured: false,
  };

  if (!shape.isSelect) {
    return {
      ...empty,
      error:
        "The execution-plan view analyzes a SELECT query — write one above to see how it runs.",
    };
  }
  if (shape.unsupported) return { ...empty, error: shape.unsupported };
  if (shape.subquery) {
    return {
      ...empty,
      error:
        "This SELECT reads from a derived table. Plans are built for queries whose FROM names a relation — analyze the inner SELECT on its own.",
    };
  }
  if (!shape.table) {
    return { ...empty, error: "No FROM clause — there is no relation to build a plan over." };
  }

  const table = shape.table;
  const baseAlias = shape.alias || table;
  const joins = shape.joins;
  const hasAgg = shape.aggregates.length > 0;
  const base = stats.scanned;
  const afterWhere = shape.whereText && joins.length === 0 ? stats.kept : null;
  const final = stats.final;

  // Rows before LIMIT: equal to the result when nothing was capped, and equal
  // to the post-filter count when the filter is the only row-reducing step.
  let beforeLimit: number | null;
  if (shape.limit == null) beforeLimit = final;
  else if (
    joins.length === 0 &&
    !shape.groupByText &&
    !shape.distinct &&
    !hasAgg &&
    afterWhere != null
  )
    beforeLimit = afterWhere;
  else if (final != null && !stats.truncated && final < shape.limit) beforeLimit = final;
  else beforeLimit = null;

  const orderCols = shape.orderBy.map((o) => o.col + (o.dir === "desc" ? " ↓" : " ↑")).join(", ");
  const aggText = shape.aggregates.map((a) => a.fn + "(" + a.arg + ")").join(", ");
  const limitText =
    (shape.offset != null ? "offset " + shape.offset + " · " : "") + "limit " + shape.limit;

  // --- the per-clause teaching list, in logical execution order ---
  const steps: ExplainStep[] = [];
  const addStep = (key: StepKey, rows: number | null, extra: string | null) => {
    const def = stepDef(key);
    steps.push({ kw: def.kw, label: def.label, desc: def.desc, rows, extra });
  };
  addStep(
    "from",
    base,
    joins.length ? table + " + " + joins.map((j) => j.table).join(", ") : table,
  );
  if (shape.whereText) addStep("where", afterWhere, shape.whereText);
  if (shape.groupByText) addStep("groupBy", beforeLimit, shape.groupByText);
  if (shape.havingText) addStep("having", null, shape.havingText);
  addStep(
    "select",
    beforeLimit,
    hasAgg
      ? "aggregates: " + aggText
      : shape.items.some((i) => i.kind === "star")
        ? "all columns"
        : shape.items.map((i) => i.alias || i.base).join(", ") || null,
  );
  if (shape.distinct) addStep("distinct", beforeLimit, null);
  if (shape.orderBy.length) addStep("orderBy", beforeLimit, orderCols);
  if (shape.limit != null) addStep("limit", final, limitText);

  // --- the plan tree, outermost → innermost, with explicit depths ---
  const plan: PlanNode[] = [];
  let dep = 0;
  const push = (n: Omit<PlanNode, "ms" | "pct" | "order">) => {
    plan.push({ ...n, ms: null, pct: 0, order: 0 });
  };
  if (shape.limit != null) {
    push({ depth: dep++, node: "Limit", kind: "limit", rows: final, detail: limitText });
  }
  if (shape.orderBy.length) {
    push({
      depth: dep++,
      node: "Sort",
      kind: "sort",
      rows: beforeLimit,
      detail: "Sort Key: " + orderCols,
      method: beforeLimit != null && beforeLimit > 500 ? "external merge" : "quicksort",
    });
  }
  if (shape.distinct) {
    push({
      depth: dep++,
      node: "Unique",
      kind: "unique",
      rows: beforeLimit,
      detail: "de-duplicate projected rows",
    });
  }
  if (shape.groupByText) {
    push({
      depth: dep++,
      node: "HashAggregate",
      kind: "agg",
      rows: beforeLimit,
      detail: "Group Key: " + shape.groupByText,
    });
  } else if (hasAgg) {
    push({
      depth: dep++,
      node: "Aggregate",
      kind: "agg",
      rows: 1,
      detail: aggText || "aggregate",
    });
  }
  for (const j of joins) {
    push({
      depth: dep++,
      node: j.kind === "left" ? "Nested Loop Left Join" : "Nested Loop",
      kind: "join",
      rows: beforeLimit,
      detail: "Join Filter: " + (j.onText || "cross product"),
    });
  }
  // Both sides of the join sit at the depth *below* the join node.
  const scanDepth = dep;
  push({
    depth: scanDepth,
    node: "Seq Scan on " + table + (shape.alias ? " " + shape.alias : ""),
    kind: "scan",
    rel: table,
    alias: baseAlias,
    rows: afterWhere != null ? afterWhere : base,
    scanned: base,
    removed: shape.whereText && afterWhere != null && base != null ? base - afterWhere : null,
    detail: shape.whereText ? "Filter: " + shape.whereText : "no filter — every row read",
  });
  for (const j of joins) {
    const n = stats.joinRows[j.table] ?? null;
    push({
      depth: scanDepth,
      node: "Seq Scan on " + j.table + (j.alias !== j.table ? " " + j.alias : ""),
      kind: "scan",
      rel: j.table,
      alias: j.alias,
      rows: n,
      scanned: n,
      removed: null,
      joinSide: true,
      detail: j.onText ? "Join Key: " + j.onText : "cross join — no join key",
    });
  }

  // --- distribute the measured total across nodes by relative work ---
  const weight = (p: PlanNode): number => {
    const n = Math.max(1, (p.kind === "scan" ? p.scanned : p.rows) ?? 1);
    if (p.kind === "scan") return n;
    if (p.kind === "join") return n * 0.8;
    if (p.kind === "sort") return n * Math.log2(Math.max(2, n)) * 0.22;
    if (p.kind === "agg") return n * 0.55;
    if (p.kind === "unique") return n * 0.3;
    return 0.6;
  };
  const ws = plan.map(weight);
  const wsum = ws.reduce((a, b) => a + b, 0) || 1;
  const total = stats.ms != null ? Math.max(0.05, stats.ms) : null;
  plan.forEach((p, i) => {
    p.pct = (ws[i]! / wsum) * 100;
    p.ms = total == null ? null : Math.max(0.01, (ws[i]! / wsum) * total);
    p.order = plan.length - i;
  });
  const slowest =
    total == null
      ? null
      : plan.reduce<PlanNode | null>(
          (a, b) => (a == null || (b.ms ?? 0) > (a.ms ?? 0) ? b : a),
          null,
        );

  // --- warnings: computed here, actionable, each naming its node ---
  const warnings: PlanWarning[] = [];
  const scanNode = plan.find((p) => p.kind === "scan" && !p.joinSide)!;
  if (scanNode.removed != null && base != null && base > 0 && scanNode.removed / base > 0.6) {
    warnings.push({
      node: scanNode.node,
      text:
        "Filter discards " +
        Math.round((scanNode.removed / base) * 100) +
        "% of rows read (" +
        scanNode.removed.toLocaleString() +
        " of " +
        base.toLocaleString() +
        "). An index on the filtered column would let the engine skip them.",
    });
  }
  if (!shape.whereText && shape.limit == null && base != null && base > 200) {
    warnings.push({
      node: scanNode.node,
      text:
        "Unbounded scan of " +
        base.toLocaleString() +
        " rows — add WHERE or LIMIT before this runs against production volumes.",
    });
  }
  const sortNode = plan.find((p) => p.kind === "sort");
  if (sortNode && sortNode.method === "external merge" && sortNode.rows != null) {
    warnings.push({
      node: "Sort",
      text:
        "Sorting " +
        sortNode.rows.toLocaleString() +
        " rows spills past a comfortable in-memory quicksort. An index matching the ORDER BY can remove this node entirely.",
    });
  }

  return {
    error: null,
    plan,
    steps,
    warnings,
    ms: stats.ms,
    final,
    base,
    beforeLimit,
    truncated: stats.truncated,
    table,
    joins,
    slowest,
    measured: stats.ms != null,
  };
}

/**
 * The compact text plan behind the tree's disclosure. Indented by the node's
 * explicit `depth`, not its index, so the two sides of a join line up as
 * siblings instead of the second scan hanging off the first.
 */
export function rawPlanText(a: Analysis): string {
  const body = a.plan
    .map((p) => {
      const i = p.depth;
      const indent = "  ".repeat(i);
      let line =
        indent +
        (i === 0 ? "" : "->  ") +
        p.node +
        "  (actual time=" +
        (p.ms == null ? "?" : fmtMs(p.ms) + "ms") +
        " rows=" +
        fmtRows(p.rows) +
        ")";
      if (p.detail) line += "\n" + "  ".repeat(i + 1) + "  " + p.detail;
      if (p.removed)
        line +=
          "\n" + "  ".repeat(i + 1) + "  Rows Removed by Filter: " + p.removed.toLocaleString();
      return line;
    })
    .join("\n");
  return body + "\nPlanning + execution time: " + (a.ms == null ? "not measured" : a.ms + " ms");
}

// ---------------------------------------------------------------------------
// Raw output — MySQL's tabular EXPLAIN
// ---------------------------------------------------------------------------

/** The MySQL client's column set, in its exact order. */
export const MYSQL_COLS = [
  "id",
  "select_type",
  "table",
  "partitions",
  "type",
  "possible_keys",
  "key",
  "key_len",
  "ref",
  "rows",
  "filtered",
  "Extra",
] as const;

export type MysqlRow = Record<(typeof MYSQL_COLS)[number], string | null>;

/**
 * One row per accessed table, derived from the plan: `Extra` from which
 * operators touch that table, `ref` from the left side of the join key,
 * `filtered` from rows-after-filter ÷ rows-scanned.
 */
export function mysqlExplainRows(a: Analysis): MysqlRow[] {
  const scans = a.plan.filter((p) => p.kind === "scan");
  const sort = a.plan.find((p) => p.kind === "sort");
  const agg = a.plan.find((p) => p.kind === "agg");
  return scans.map((s, i) => {
    const hasWhere = s.detail.startsWith("Filter:");
    const joinKey = s.detail.startsWith("Join Key:") ? s.detail.replace("Join Key: ", "") : null;
    const extra: string[] = [];
    if (hasWhere) extra.push("Using where");
    if (i === 0 && agg && agg.node === "HashAggregate") extra.push("Using temporary");
    if (i === 0 && sort) extra.push("Using filesort");
    if (joinKey) extra.push("Using join buffer (hash join)");
    const filtered =
      s.scanned && s.rows != null ? (s.rows / s.scanned) * 100 : s.scanned == null ? null : 100;
    return {
      id: "1",
      select_type: "SIMPLE",
      table: s.alias || s.rel || "",
      partitions: null,
      type: "ALL",
      possible_keys: null,
      key: null,
      key_len: null,
      ref: joinKey ? (joinKey.split(/\s*=\s*/)[0] ?? null) : null,
      rows: s.scanned == null ? null : String(s.scanned),
      filtered: filtered == null ? null : (Math.round(filtered * 100) / 100).toFixed(2),
      Extra: extra.length ? extra.join("; ") : null,
    };
  });
}

/** The same rows as a `+---+` ASCII table, ready to paste into a terminal. */
export function mysqlExplainText(a: Analysis): string {
  const rows = mysqlExplainRows(a);
  const cell = (r: MysqlRow, c: (typeof MYSQL_COLS)[number]) => r[c] ?? "NULL";
  const w = MYSQL_COLS.map((c) => Math.max(c.length, ...rows.map((r) => cell(r, c).length)));
  const rule = "+" + w.map((n) => "-".repeat(n + 2)).join("+") + "+";
  const line = (vals: string[]) => "| " + vals.map((v, i) => v.padEnd(w[i]!)).join(" | ") + " |";
  return [
    rule,
    line([...MYSQL_COLS]),
    rule,
    ...rows.map((r) => line(MYSQL_COLS.map((c) => cell(r, c)))),
    rule,
    rows.length + " row" + (rows.length === 1 ? "" : "s") + " in set",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Raw output — psql's `QUERY PLAN` text column
// ---------------------------------------------------------------------------

/**
 * The plan as psql prints it. `analyze: false` is the plan-only form: every
 * actual-time fragment is dropped. One function, one flag — so the two forms
 * can never drift apart. Indentation follows the node's explicit `depth`, so
 * the two inputs of a join print as siblings.
 */
export function psqlPlanLines(a: Analysis, analyze: boolean): string[] {
  const lines: string[] = [];
  let cum = 0;
  a.plan.forEach((p, i) => {
    const startup = cum;
    cum += p.ms ?? 0;
    const cost = (p.kind === "scan" ? 0 : startup * 12).toFixed(2) + ".." + (cum * 12).toFixed(2);
    const width = p.kind === "scan" ? 64 : 32 + i * 8;
    const d = p.depth;
    lines.push(
      " " +
        "  ".repeat(d) +
        (d === 0 ? "" : "->  ") +
        p.node +
        "  (cost=" +
        cost +
        " rows=" +
        (p.rows ?? "?") +
        " width=" +
        width +
        ")" +
        (analyze
          ? " (actual time=" +
            fmtMs(startup) +
            ".." +
            fmtMs(cum) +
            " rows=" +
            (p.rows ?? "?") +
            " loops=1)"
          : ""),
    );
    const pad = " " + "  ".repeat(d + 1) + (d === 0 ? "" : "    ");
    if (p.kind === "scan" && p.detail.startsWith("Filter:")) {
      lines.push(pad + p.detail);
      if (analyze && p.removed) lines.push(pad + "Rows Removed by Filter: " + p.removed);
    } else if (p.kind === "sort") {
      lines.push(pad + p.detail);
      if (analyze)
        lines.push(
          pad +
            "Sort Method: " +
            p.method +
            "  Memory: " +
            Math.max(25, Math.round((p.rows ?? 0) * 0.09)) +
            "kB",
        );
    } else if (p.kind === "agg") {
      lines.push(pad + p.detail);
      if (analyze && p.node === "HashAggregate")
        lines.push(
          pad +
            "Batches: 1  Memory Usage: " +
            Math.max(24, Math.round((p.rows ?? 0) * 0.12)) +
            "kB",
        );
    }
  });
  const ms = a.ms ?? 0;
  lines.push(" Planning Time: " + (ms * 0.18).toFixed(3) + " ms");
  if (analyze) lines.push(" Execution Time: " + (ms * 0.82).toFixed(3) + " ms");
  return lines;
}

/** The psql lines wrapped in the centred `QUERY PLAN` header + row count. */
export function psqlPlanText(a: Analysis, analyze: boolean): string {
  const rows = psqlPlanLines(a, analyze);
  const w = Math.max(10, ...rows.map((r) => r.length));
  const head = "QUERY PLAN";
  const padHead = " ".repeat(Math.max(0, Math.floor((w - head.length) / 2)));
  return [
    padHead + head,
    "-".repeat(w + 1),
    ...rows,
    "(" + rows.length + " row" + (rows.length === 1 ? "" : "s") + ")",
  ].join("\n");
}
