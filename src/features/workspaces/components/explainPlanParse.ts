// Turning a server's structured EXPLAIN into the panel's PlanNode model.
//
// The modelled plan (explainModel.ts `buildPlan`) reads the statement and
// assumes a sequential scan per relation, because reading SQL text cannot tell
// you which index the optimizer picked. These parsers replace that guess with
// the engine's own answer: real node types, real access paths, the chosen
// index, and the planner's row and cost estimates.
//
// One parser per engine, because there is no common format:
//
//   Postgres  EXPLAIN (FORMAT JSON)  — a recursive `Plan` tree, by far the
//             richest, and the only one that also carries actual times when
//             the plan came from an ANALYZE run.
//   MySQL     EXPLAIN FORMAT=JSON    — a `query_block` of nested operations
//             (ordering → grouping → nested_loop → tables), with derived
//             tables hanging off a table as `materialized_from_subquery`.
//   SQLite    EXPLAIN QUERY PLAN     — flat `(id, parent, notused, detail)`
//             rows re-assembled into a tree; prose details, no numbers at all.
//
// Every parser is defensive: a shape it does not recognise yields null and the
// panel keeps the modelled plan rather than showing half a tree.

import type { Engine } from "../../../shared/types";
import type { NodeKind, PlanNode } from "./explainModel";
import type { ServerExplain } from "./explainServer";

/** A plan tree read from a server, ready to be swapped into the analysis. */
export interface ServerPlan {
  nodes: PlanNode[];
  source: Engine;
  /** Execution time the server reported, when the plan came from an ANALYZE. */
  totalMs: number | null;
  /** What the per-node figure and its share bar mean. */
  share: "time" | "cost" | null;
  /**
   * The order `nodes` are listed in. Postgres and MySQL print outermost first,
   * the way psql draws a tree; SQLite's `EXPLAIN QUERY PLAN` lists steps in the
   * order they run. The "#" column has to number them the right way round, so
   * the parser states which it produced rather than the view assuming.
   */
  listing: "outermost-first" | "execution";
}

/** Node under construction — `pct` and `order` are assigned by the caller. */
type Draft = Omit<PlanNode, "pct" | "order">;

const draft = (n: Draft): PlanNode => ({ ...n, pct: 0, order: 0 });

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

/**
 * Classify a server's node type into one of the panel's kinds. Matching on
 * substrings on purpose: every engine spells these differently and new node
 * types appear with every release, so an unknown one lands on `other` and still
 * renders rather than breaking the tree.
 */
function kindOf(nodeType: string): NodeKind {
  const t = nodeType.toLowerCase();
  if (/limit/.test(t)) return "limit";
  if (/sort|filesort|order by/.test(t)) return "sort";
  if (/unique|distinct|duplicates/.test(t)) return "unique";
  if (/aggregate|group|grouping/.test(t)) return "agg";
  if (/join|nested loop/.test(t)) return "join";
  if (/scan|seek|search|lookup|index|table/.test(t)) return "scan";
  return "other";
}

/** Dispatch to the engine's parser. Returns null when nothing usable came back. */
export function parseServerPlan(engine: Engine, explain: ServerExplain): ServerPlan | null {
  try {
    if (engine === "postgres") return fromPostgres(explain);
    if (engine === "mysql") return fromMysql(explain);
    if (engine === "sqlite") return fromSqlite(explain);
  } catch {
    // A plan we cannot read is not worth a broken panel: fall back silently to
    // the modelled tree, which always renders.
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Postgres — EXPLAIN (FORMAT JSON)
// ---------------------------------------------------------------------------

interface PgNode {
  "Node Type": string;
  "Relation Name"?: string;
  Alias?: string;
  "Index Name"?: string;
  "Plan Rows"?: number;
  "Actual Rows"?: number;
  "Actual Total Time"?: number;
  "Actual Loops"?: number;
  "Total Cost"?: number;
  "Startup Cost"?: number;
  "Rows Removed by Filter"?: number;
  Filter?: string;
  "Index Cond"?: string;
  "Hash Cond"?: string;
  "Join Filter"?: string;
  "Recheck Cond"?: string;
  "Group Key"?: string[];
  "Sort Key"?: string[];
  "Sort Method"?: string;
  Strategy?: string;
  "Join Type"?: string;
  "Parent Relationship"?: string;
  "Subplan Name"?: string;
  Plans?: PgNode[];
}

/** `HashAggregate` etc. — psql's display name, which the JSON splits apart. */
function pgName(n: PgNode): string {
  const type = n["Node Type"];
  let name = type;
  if (type === "Aggregate" && n.Strategy && n.Strategy !== "Plain") {
    name = n.Strategy === "Hashed" ? "HashAggregate" : n.Strategy + " Aggregate";
  }
  if (n["Join Type"] && n["Join Type"] !== "Inner" && /join|nested loop/i.test(type)) {
    name += " " + n["Join Type"] + " Join";
  }
  if (n["Index Name"]) name += " using " + n["Index Name"];
  if (n["Relation Name"]) {
    name += " on " + n["Relation Name"];
    if (n.Alias && n.Alias !== n["Relation Name"]) name += " " + n.Alias;
  }
  return name;
}

/** The one line under the node name — whichever condition psql would print. */
function pgDetail(n: PgNode): string {
  if (n.Filter) return "Filter: " + n.Filter;
  if (n["Index Cond"]) return "Index Cond: " + n["Index Cond"];
  if (n["Recheck Cond"]) return "Recheck Cond: " + n["Recheck Cond"];
  if (n["Hash Cond"]) return "Hash Cond: " + n["Hash Cond"];
  if (n["Join Filter"]) return "Join Filter: " + n["Join Filter"];
  if (n["Group Key"]) return "Group Key: " + n["Group Key"].join(", ");
  if (n["Sort Key"]) return "Sort Key: " + n["Sort Key"].join(", ");
  return "";
}

function fromPostgres(explain: ServerExplain): ServerPlan | null {
  const text = explain.rows.map((r) => String(r[0] ?? "")).join("\n");
  const doc = JSON.parse(text) as { Plan: PgNode; "Execution Time"?: number }[];
  const root = doc[0]?.Plan;
  if (!root) return null;

  const nodes: PlanNode[] = [];
  const analyzed = root["Actual Total Time"] != null;
  // Postgres reports time and cost inclusive of the subtree. Ranking nodes by
  // those figures would put the root on top every time, so each node's own
  // share is worked out afterwards by subtracting its direct children.
  const tree: { ms: number | null; cost: number | null; children: number[] }[] = [];
  const walk = (n: PgNode, depth: number, subplan: boolean): number => {
    const rows = n["Actual Rows"] ?? n["Plan Rows"] ?? null;
    const removed = n["Rows Removed by Filter"] ?? null;
    const kind = kindOf(n["Node Type"]);
    // Rows read = what survived plus what the filter threw away. Only knowable
    // from an ANALYZE run; the estimate has no equivalent. Meaningless off a
    // scan, so it stays null there rather than echoing `rows`.
    const scanned =
      kind !== "scan" ? null : rows != null && removed != null ? rows + removed : rows;
    // `Actual Total Time` is per loop; the node's real cost is that times the
    // number of loops the executor ran it for.
    const perLoop = n["Actual Total Time"] ?? null;
    const ms = perLoop == null ? null : perLoop * (n["Actual Loops"] ?? 1);
    const index = nodes.length;
    nodes.push(
      draft({
        node: pgName(n),
        kind,
        rows,
        detail: pgDetail(n),
        ms,
        cost: n["Total Cost"] ?? null,
        depth,
        scanned,
        removed,
        method: n["Sort Method"] ?? undefined,
        rel: n["Relation Name"],
        alias: n.Alias,
        index: n["Index Name"] ?? null,
        subplan,
      }),
    );
    const children: number[] = [];
    for (const child of n.Plans ?? []) {
      // A SubPlan / InitPlan is a separate query, not part of this branch.
      children.push(walk(child, depth + 1, subplan || child["Subplan Name"] != null));
    }
    tree[index] = { ms, cost: n["Total Cost"] ?? null, children };
    return index;
  };
  walk(root, 0, false);

  // Self = inclusive minus the direct children's inclusive figures.
  nodes.forEach((node, i) => {
    const entry = tree[i];
    if (!entry) return;
    const inclusive = analyzed ? entry.ms : entry.cost;
    if (inclusive == null) return;
    const childSum = entry.children.reduce((sum, c) => {
      const child = tree[c];
      const value = analyzed ? child?.ms : child?.cost;
      return sum + (value ?? 0);
    }, 0);
    node.self = Math.max(0, inclusive - childSum);
  });

  return {
    nodes,
    source: "postgres",
    totalMs: doc[0]?.["Execution Time"] ?? null,
    share: analyzed ? "time" : "cost",
    listing: "outermost-first",
  };
}

// ---------------------------------------------------------------------------
// MySQL — EXPLAIN FORMAT=JSON
// ---------------------------------------------------------------------------

interface MyCost {
  read_cost?: string;
  eval_cost?: string;
  prefix_cost?: string;
  sort_cost?: string;
  query_cost?: string;
}
interface MyTable {
  table_name?: string;
  access_type?: string;
  key?: string;
  possible_keys?: string[];
  rows_examined_per_scan?: number;
  rows_produced_per_join?: number;
  filtered?: string;
  attached_condition?: string;
  using_index?: boolean;
  cost_info?: MyCost;
  materialized_from_subquery?: { query_block?: MyBlock };
  ref?: string[];
}
interface MyBlock {
  select_id?: number;
  cost_info?: MyCost;
  ordering_operation?: MyBlock & { using_filesort?: boolean };
  grouping_operation?: MyBlock & { using_temporary_table?: boolean };
  duplicates_removal?: MyBlock;
  nested_loop?: { table?: MyTable }[];
  table?: MyTable;
}

/** MySQL's access types, named the way the plan tree reads elsewhere. */
function myAccessName(t: MyTable): string {
  const access = t.access_type ?? "ALL";
  const label =
    access === "ALL"
      ? "Seq Scan"
      : access === "index"
        ? "Index Scan"
        : access === "range"
          ? "Index Range Scan"
          : access === "eq_ref" || access === "const"
            ? "Unique Index Lookup"
            : access === "ref"
              ? "Index Lookup"
              : access.toUpperCase();
  let name = label;
  if (t.key) name += " using " + t.key;
  if (t.table_name) name += " on " + t.table_name;
  return name;
}

/**
 * Per-node cost. `prefix_cost` is cumulative down the join order, so the parts
 * are what we want. Rounded because summing MySQL's decimal strings as floats
 * otherwise yields costs like `1.8399999999999999`.
 */
function myCost(c: MyCost | undefined): number | null {
  if (!c) return null;
  const read = num(c.read_cost);
  const evaluate = num(c.eval_cost);
  const total =
    read != null || evaluate != null
      ? (read ?? 0) + (evaluate ?? 0)
      : (num(c.sort_cost) ?? num(c.query_cost));
  return total == null ? null : Math.round(total * 100) / 100;
}

function fromMysql(explain: ServerExplain): ServerPlan | null {
  const text = explain.rows.map((r) => String(r[0] ?? "")).join("\n");
  const doc = JSON.parse(text) as { query_block?: MyBlock };
  if (!doc.query_block) return null;

  const nodes: PlanNode[] = [];
  const pushTable = (t: MyTable, depth: number, subplan: boolean) => {
    const scanned = t.rows_examined_per_scan ?? null;
    const filtered = num(t.filtered);
    // `filtered` is the percentage of scanned rows expected to survive, which
    // is the only handle MySQL gives on how much a condition discards.
    const rows =
      t.rows_produced_per_join ??
      (scanned != null && filtered != null ? Math.round((scanned * filtered) / 100) : scanned);
    nodes.push(
      draft({
        node: myAccessName(t),
        kind: "scan",
        rows,
        detail: t.attached_condition
          ? "Filter: " + t.attached_condition
          : t.ref?.length
            ? "Ref: " + t.ref.join(", ")
            : t.using_index
              ? "covering index — no table lookup"
              : "",
        ms: null,
        cost: myCost(t.cost_info),
        depth,
        scanned,
        removed: scanned != null && rows != null && scanned > rows ? scanned - rows : null,
        rel: t.table_name,
        alias: t.table_name,
        index: t.key ?? null,
        subplan,
      }),
    );
    const inner = t.materialized_from_subquery?.query_block;
    if (inner) {
      nodes.push(
        draft({
          node: "Materialize",
          kind: "other",
          rows: null,
          detail: "derived table — the plan below produces its rows",
          ms: null,
          cost: null,
          depth: depth + 1,
          subplan: true,
        }),
      );
      walkBlock(inner, depth + 2, true);
    }
  };

  const walkBlock = (block: MyBlock, depth: number, subplan: boolean) => {
    let d = depth;
    const order = block.ordering_operation;
    if (order) {
      nodes.push(
        draft({
          node: order.using_filesort ? "Sort (filesort)" : "Sort",
          kind: "sort",
          rows: null,
          detail: "ORDER BY",
          ms: null,
          cost: myCost(order.cost_info),
          depth: d++,
          subplan,
        }),
      );
    }
    const group = (order ?? block).grouping_operation;
    if (group) {
      nodes.push(
        draft({
          node: group.using_temporary_table ? "Aggregate using temporary table" : "Aggregate",
          kind: "agg",
          rows: null,
          detail: "GROUP BY",
          ms: null,
          cost: myCost(group.cost_info),
          depth: d++,
          subplan,
        }),
      );
    }
    const dedupe = (group ?? order ?? block).duplicates_removal;
    if (dedupe) {
      nodes.push(
        draft({
          node: "Duplicate removal",
          kind: "unique",
          rows: null,
          detail: "DISTINCT",
          ms: null,
          cost: myCost(dedupe.cost_info),
          depth: d++,
          subplan,
        }),
      );
    }

    const inner = dedupe ?? group ?? order ?? block;
    const loop = inner.nested_loop;
    if (loop?.length) {
      if (loop.length > 1) {
        nodes.push(
          draft({
            node: "Nested Loop",
            kind: "join",
            rows: null,
            detail: "joins " + loop.length + " tables, left to right",
            ms: null,
            cost: null,
            depth: d++,
            subplan,
          }),
        );
      }
      for (const entry of loop) if (entry.table) pushTable(entry.table, d, subplan);
      return;
    }
    if (inner.table) pushTable(inner.table, d, subplan);
  };

  walkBlock(doc.query_block, 0, false);
  return nodes.length
    ? { nodes, source: "mysql", totalMs: null, share: "cost", listing: "outermost-first" }
    : null;
}

// ---------------------------------------------------------------------------
// SQLite — EXPLAIN QUERY PLAN
// ---------------------------------------------------------------------------

/**
 * SQLite reports prose, not fields: `SCAN o`, `SEARCH u USING INTEGER PRIMARY
 * KEY (rowid=?)`, `USE TEMP B-TREE FOR GROUP BY`. The detail line is kept
 * verbatim — it *is* the plan — and only the name, kind and index are lifted
 * out of it. There are no rows, costs or timings anywhere in this output, which
 * is why SQLite plans show "—" in the numeric columns instead of a number that
 * came from somewhere else.
 */
function fromSqlite(explain: ServerExplain): ServerPlan | null {
  const cols = explain.columns.map((c) => c.toLowerCase());
  const idAt = cols.indexOf("id");
  const parentAt = cols.indexOf("parent");
  const detailAt = cols.indexOf("detail");
  if (idAt < 0 || parentAt < 0 || detailAt < 0) return null;

  interface Row {
    id: number;
    parent: number;
    detail: string;
  }
  const rows: Row[] = explain.rows.map((r) => ({
    id: num(r[idAt]) ?? 0,
    parent: num(r[parentAt]) ?? 0,
    detail: String(r[detailAt] ?? ""),
  }));
  if (rows.length === 0) return null;

  const nodes: PlanNode[] = [];
  const emit = (row: Row, depth: number) => {
    const d = row.detail;
    const scan = /^(SCAN|SEARCH)\s+(\S+)/.exec(d);
    const index = /USING (?:COVERING )?INDEX (\S+)/.exec(d);
    const pk = /USING INTEGER PRIMARY KEY/.test(d);
    let node = d;
    let kind: NodeKind = kindOf(d);
    if (scan) {
      const table = scan[2]!;
      const lookup = scan[1] === "SEARCH";
      node =
        (lookup ? "Index Lookup" : "Seq Scan") +
        (index ? " using " + index[1] : pk ? " using PRIMARY KEY" : "") +
        " on " +
        table;
      kind = "scan";
    } else if (/CO-ROUTINE|MATERIALIZE/.test(d)) {
      kind = "other";
    }
    nodes.push(
      draft({
        node,
        kind,
        rows: null,
        detail: scan ? d : "",
        ms: null,
        cost: null,
        depth,
        rel: scan?.[2],
        alias: scan?.[2],
        index: index?.[1] ?? (pk ? "PRIMARY KEY" : null),
        subplan: depth > 0,
      }),
    );
    for (const child of rows.filter((r) => r.parent === row.id && r.id !== row.id)) {
      emit(child, depth + 1);
    }
  };
  // `parent: 0` marks a top-level step; SQLite never issues 0 as an id.
  for (const row of rows.filter((r) => r.parent === 0)) emit(row, 0);

  return nodes.length
    ? { nodes, source: "sqlite", totalMs: null, share: null, listing: "execution" }
    : null;
}
