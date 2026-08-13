// Wire types + invoke wrappers for the Rust explain slice
// (`src-tauri/src/features/explain`).
//
// Everything engine-specific about an EXPLAIN — which statement each engine
// takes, and how to read its answer — lives in Rust, beside the other
// per-engine SQL and covered by `cargo test` against output captured from real
// servers. This file only crosses the wire; it must never learn a dialect.

import { invoke } from "@tauri-apps/api/core";

import type { CellValue } from "../../../shared/api/engine";
import type { Engine } from "../../../shared/types";

/** Mirrors Rust `explain::domain::NodeKind`. */
export type NodeKind = "scan" | "join" | "agg" | "sort" | "unique" | "limit" | "other";

/** What a node's headline figure and its share bar represent. */
export type Share = "time" | "cost";

/** The order the engine listed its nodes in. */
export type Listing = "outermost-first" | "execution";

/** One plan node. Mirrors Rust `explain::domain::PlanNode`. */
export interface ServerPlanNode {
  node: string;
  kind: NodeKind;
  rows: number | null;
  detail: string;
  /** Milliseconds, inclusive of children, when the engine measured them. */
  ms: number | null;
  depth: number;
  scanned: number | null;
  removed: number | null;
  method: string | null;
  rel: string | null;
  alias: string | null;
  /** The index the optimizer chose, when it reported one. */
  index: string | null;
  /** The planner's cost for this node, inclusive of children. */
  cost: number | null;
  subplan: boolean;
  /**
   * This node's own share of the work, excluding children. Postgres reports
   * time and cost inclusive of the subtree, so this is what the share bar ranks
   * by; `ms` / `cost` stay inclusive to match what a terminal client prints.
   */
  selfWork: number | null;
}

/** A plan tree as one engine reported it. */
export interface ServerPlan {
  nodes: ServerPlanNode[];
  source: Engine;
  totalMs: number | null;
  share: Share | null;
  listing: Listing;
}

/** What forms of EXPLAIN a connection's engine supports. */
export interface ExplainCapabilities {
  /** `EXPLAIN` — plans only, executes nothing. */
  plan: boolean;
  /** `EXPLAIN ANALYZE` — executes the statement. */
  analyze: boolean;
  /** Whether a machine-readable plan is available for the plan tree. */
  structured: boolean;
  /** Why a form is missing, phrased to be shown as-is. */
  note: string | null;
}

/** A plan exactly as the engine printed it, for the "Raw output" view. */
export interface RawPlan {
  statement: string;
  columns: string[];
  rows: CellValue[][];
  /** True when the plan is a single text column rather than a real table. */
  text: boolean;
}

/** Which forms this connection can be asked for, so the UI can disable the rest. */
export function explainCapabilities(handleId: string): Promise<ExplainCapabilities> {
  return invoke<ExplainCapabilities>("explain_capabilities", { handleId });
}

/**
 * The engine's own plan, parsed into the node model. **Executes nothing.**
 * `null` when the engine has no machine-readable plan or returned one the
 * backend could not read — the panel then keeps its modelled tree.
 */
export function explainPlan(
  handleId: string,
  sql: string,
  schema: string,
): Promise<ServerPlan | null> {
  return invoke<ServerPlan | null>("explain_plan", { handleId, sql, schema });
}

/**
 * The plan as the engine prints it. `analyze: false` plans without executing;
 * **`analyze: true` runs the statement**, which is why it stays behind a
 * deliberate toggle.
 */
export function explainRaw(
  handleId: string,
  sql: string,
  schema: string,
  analyze: boolean,
): Promise<RawPlan> {
  return invoke<RawPlan>("explain_raw", { handleId, sql, schema, analyze });
}

/** A cell as the plan prints it; NULL is spelled out, the way clients do. */
function cellText(value: CellValue | undefined): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  return String(value);
}

/** A text plan as one block. */
export function rawPlanTextOf(plan: RawPlan): string {
  return plan.rows.map((r) => cellText(r[0])).join("\n");
}

/** Right-align a column only when every value present in it is a number. */
export function numericColumns(plan: RawPlan): boolean[] {
  return plan.columns.map((_, i) => {
    let seen = false;
    for (const row of plan.rows) {
      const v = row[i];
      if (v === null || v === undefined) continue;
      seen = true;
      if (typeof v === "number") continue;
      if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) continue;
      return false;
    }
    return seen;
  });
}

/** The tabular plan as a `+---+` ASCII table, ready to paste into a terminal. */
export function rawPlanAscii(plan: RawPlan): string {
  const cells = plan.rows.map((r) => plan.columns.map((_, i) => cellText(r[i])));
  const w = plan.columns.map((c, i) => Math.max(c.length, ...cells.map((r) => r[i]!.length), 0));
  const rule = "+" + w.map((n) => "-".repeat(n + 2)).join("+") + "+";
  const line = (vals: string[]) => "| " + vals.map((v, i) => v.padEnd(w[i]!)).join(" | ") + " |";
  return [
    rule,
    line(plan.columns),
    rule,
    ...cells.map(line),
    rule,
    plan.rows.length + " row" + (plan.rows.length === 1 ? "" : "s") + " in set",
  ].join("\n");
}
