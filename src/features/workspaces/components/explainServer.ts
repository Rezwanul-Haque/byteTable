// The server's own EXPLAIN, fetched through the ordinary query path.
//
// Everything else in the Explain panel is modelled client-side. This module is
// the one place that asks the database what it will actually do, so the "Raw
// output" view can show the plan verbatim — the same text you would get from
// psql or the mysql client, index choices and all. Nothing here reformats or
// reinterprets the result; the renderer prints whatever columns came back.
//
// No backend work is involved: `query_run` already runs arbitrary SQL, and an
// EXPLAIN is just SQL. The engine differences are entirely in the statement.

import { queryRun, type CellValue } from "../../../shared/api/engine";
import type { Engine } from "../../../shared/types";

/** One server plan, exactly as the engine returned it. */
export interface ServerExplain {
  /** The statement that was sent, for the prompt line. */
  statement: string;
  columns: string[];
  rows: CellValue[][];
  /**
   * True when the plan is a single text column (psql's `QUERY PLAN`, MySQL's
   * `EXPLAIN ANALYZE`, ClickHouse's `explain`) rather than a real table. The
   * renderer prints those as a preformatted block.
   */
  text: boolean;
}

/** What forms of EXPLAIN an engine can produce through a plain query. */
export interface ExplainSupport {
  /** `EXPLAIN` — plans only, executes nothing. */
  plan: boolean;
  /** `EXPLAIN ANALYZE` — executes the statement and reports actual figures. */
  analyze: boolean;
  /** Why a form is missing, phrased for the panel to show as-is. */
  note: string | null;
}

/**
 * Per-engine capability.
 *
 * SQL Server and Oracle are absent on purpose rather than by omission: SQL
 * Server's plan comes from `SET SHOWPLAN_ALL ON` applied to a *later* batch on
 * the same session, and Oracle's needs `EXPLAIN PLAN FOR` followed by a second
 * query against `DBMS_XPLAN`. Neither survives a single pooled `query_run`, so
 * the panel keeps its modelled view for them and says so.
 */
export function explainSupport(engine: Engine): ExplainSupport {
  switch (engine) {
    case "mysql":
      return { plan: true, analyze: true, note: null };
    case "postgres":
      return { plan: true, analyze: true, note: null };
    case "sqlite":
      return {
        plan: true,
        analyze: false,
        note: "SQLite has no EXPLAIN ANALYZE — `EXPLAIN QUERY PLAN` reports the access path only.",
      };
    case "clickhouse":
      return {
        plan: true,
        analyze: false,
        note: "ClickHouse's EXPLAIN describes the query pipeline; it has no ANALYZE form.",
      };
    case "mssql":
      return {
        plan: false,
        analyze: false,
        note: "SQL Server's showplan needs a session-wide SET applied to a following batch, which a pooled connection cannot guarantee.",
      };
    default:
      return {
        plan: false,
        analyze: false,
        note: "This engine has no SQL EXPLAIN that can be run as an ordinary statement.",
      };
  }
}

/** The statement to send, or null when the engine has no such form. */
export function explainStatement(engine: Engine, sql: string, analyze: boolean): string | null {
  // A trailing semicolon would land in the middle of the composed statement.
  const body = sql.trim().replace(/;\s*$/, "");
  if (!body) return null;
  const support = explainSupport(engine);
  if (analyze ? !support.analyze : !support.plan) return null;
  switch (engine) {
    case "mysql":
      return (analyze ? "EXPLAIN ANALYZE " : "EXPLAIN ") + body;
    case "postgres":
      // BUFFERS is free once ANALYZE is on and turns "this is slow" into "this
      // is slow because it read N blocks".
      return (analyze ? "EXPLAIN (ANALYZE, BUFFERS) " : "EXPLAIN ") + body;
    case "sqlite":
      return "EXPLAIN QUERY PLAN " + body;
    case "clickhouse":
      return "EXPLAIN " + body;
    default:
      return null;
  }
}

/**
 * Run the engine's EXPLAIN and return its result untouched.
 *
 * `analyze: false` is safe against any connection — the statement is planned,
 * not executed. `analyze: true` **does execute it**, which is why the panel
 * keeps it behind a deliberate toggle.
 *
 * Rejects with the driver's own message when the statement is invalid, so the
 * panel can show what the server said rather than a guess.
 */
export async function fetchServerExplain(
  handleId: string,
  schema: string,
  engine: Engine,
  sql: string,
  analyze: boolean,
): Promise<ServerExplain> {
  const statement = explainStatement(engine, sql, analyze);
  if (statement === null) throw new Error("This engine has no EXPLAIN for that form.");
  const res = await queryRun(handleId, statement, { schema, rowLimit: 500 });
  return {
    statement,
    columns: res.columns.map((c) => c.name),
    rows: res.rows,
    text: res.columns.length === 1,
  };
}

/** A cell as the plan prints it; NULL is spelled out, the way clients do. */
function cellText(value: CellValue | undefined): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  return String(value);
}

/**
 * A text plan as one block. Engines differ in how they break it up — psql and
 * ClickHouse return one row per line, MySQL's EXPLAIN ANALYZE returns the whole
 * tree in a single cell — and joining on newlines handles both.
 */
export function serverPlanText(plan: ServerExplain): string {
  return plan.rows.map((r) => cellText(r[0])).join("\n");
}

/** Right-align a column only when every value present in it is a number. */
export function numericColumns(plan: ServerExplain): boolean[] {
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
export function serverPlanAscii(plan: ServerExplain): string {
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
