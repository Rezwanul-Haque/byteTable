// SQL over an open data file (M35 Task 6).
//
// The file is loaded into a private in-memory SQLite database (`:memory:`, the
// one non-file path the SQLite adapter accepts) as a single table named after
// the file. Every query then runs through the SAME `query_run` command as a
// real connection — no second query engine, no forked result shape, so the
// result grid, timings and §5 error messages behave exactly as everywhere else.
//
// The scratch database lives only for the handle's lifetime and is discarded
// when the workspace closes. It is a QUERY surface, not the editing one: the
// file is edited in the Data tab and written by `csvWrite.ts`, so a statement
// that wrote here would change a throwaway copy and silently do nothing the
// user could see. SELECT-only is enforced below rather than by the backend,
// because that is a promise of this tab, not of SQLite.

import { connectionClose, connectionOpen, type OpenResult } from "../connections/api";
import { executeScriptText, queryRun, type QueryResult } from "../../shared/api/engine";
import { sqlLiteral } from "../import/parse";
import type { AdhocSchema, ColumnProfile, DataFileValue } from "./core";
import { toObjects } from "./core";

/** SQLite's only schema for an in-memory database. */
const SCRATCH_SCHEMA = "main";

/**
 * Rows per generated INSERT. One statement per row would send tens of thousands
 * of statements through the script runner; a single statement would build one
 * enormous string. 200-row batches keep both bounded.
 */
const INSERT_BATCH = 200;

/** Quote a SQL identifier, doubling any embedded `"`. */
function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

/**
 * `CREATE TABLE` for the ad-hoc schema. The declared types come from
 * `TYPES[t].sql` so the grid's type hints match what a real table would report;
 * SQLite's affinity rules make `BOOLEAN`/`TIMESTAMP`/`JSON` behave sensibly.
 *
 * NO column is declared `PRIMARY KEY`, deliberately. An `INTEGER PRIMARY KEY`
 * column in SQLite *is* the table's rowid, which would make `rowid` the id
 * VALUE rather than the insertion counter — and the viewer's raw-WHERE filter
 * ({@link selectMatchingRows}) relies on `rowid` being the row's position in the
 * file. Nothing else wants the constraint: `AdhocSchema.pk` stays metadata, and
 * a data file with a repeated key must open regardless (that is a Data quality
 * warning, not a load failure).
 */
function createTableSql(schema: AdhocSchema): string {
  const cols = schema.columns.map((c) => "  " + quoteIdent(c.name) + " " + c.type);
  return "CREATE TABLE " + quoteIdent(schema.name) + " (\n" + cols.join(",\n") + "\n);";
}

/** Batched `INSERT INTO t (cols) VALUES (…),(…);` statements for every row. */
function insertScript(schema: AdhocSchema, objects: Record<string, DataFileValue>[]): string {
  if (objects.length === 0) return "";
  const names = schema.columns.map((c) => c.name);
  const head =
    "INSERT INTO " +
    quoteIdent(schema.name) +
    " (" +
    names.map(quoteIdent).join(", ") +
    ") VALUES\n";
  const out: string[] = [];
  for (let i = 0; i < objects.length; i += INSERT_BATCH) {
    const tuples = objects
      .slice(i, i + INSERT_BATCH)
      .map((o) => "(" + names.map((n) => sqlLiteral(o[n] ?? null)).join(", ") + ")");
    out.push(head + tuples.join(",\n") + ";");
  }
  return out.join("\n");
}

/**
 * The whole script that turns an empty scratch database into the file: one
 * CREATE TABLE plus batched INSERTs. Exported (and pure) so the generated SQL
 * can be exercised without a backend — a quoting or batching bug here would
 * otherwise only show up as a driver error at open time.
 *
 * Rows are inserted in FILE ORDER into a table with no `INTEGER PRIMARY KEY`,
 * so SQLite's implicit `rowid` counts 1…N in that order. That is the contract
 * {@link selectMatchingRows} maps a raw WHERE result back onto file rows with.
 */
export function buildLoadScript(
  schema: AdhocSchema,
  cols: ColumnProfile[],
  rows: (string | null)[][],
): string {
  return createTableSql(schema) + "\n" + insertScript(schema, toObjects(cols, rows));
}

/** A loaded file's scratch database. */
export interface DataFileSession {
  /** The connection handle every query and the eventual close take. */
  handleId: string;
  /** SQLite's version string, for the workspace's engine info. */
  serverVersion: string;
}

/**
 * Open a scratch database, create the file's table in it, and insert every row.
 *
 * Throws the backend's §5 message on failure — callers surface it; there is no
 * partial state to clean up beyond the handle, which is released here.
 */
export async function loadDataFile(
  schema: AdhocSchema,
  cols: ColumnProfile[],
  rows: (string | null)[][],
): Promise<DataFileSession> {
  const opened: OpenResult = await connectionOpen({
    params: { engine: "sqlite", path: ":memory:" },
  });
  try {
    await executeScriptText(opened.handleId, SCRATCH_SCHEMA, buildLoadScript(schema, cols, rows));
  } catch (error) {
    // A half-built scratch database is useless; do not leak its handle.
    void connectionClose(opened.handleId).catch(() => {});
    throw error;
  }
  return { handleId: opened.handleId, serverVersion: opened.engineInfo.serverVersion };
}

/**
 * Release a scratch database (fire-and-forget, like `closeWorkspace`'s own
 * release). Closing a workspace already does this for the handle it holds; this
 * is for the handle a re-open replaced, which no workspace references any more.
 */
export function closeScratchDatabase(handleId: string): void {
  connectionClose(handleId).catch((err: unknown) => {
    console.warn("closing the data-file scratch database failed", err);
  });
}

/**
 * The statement kinds this tab runs. Anything that would write is refused
 * before it reaches the backend — with a message that points at the Data tab
 * rather than a driver error, because a write here would only ever land in the
 * scratch copy and never in the file.
 */
const SELECT_ONLY = /^\s*(select|with|explain|pragma)\b/i;

/** Thrown for a non-SELECT statement; the SQL tab shows it in its error card. */
export class ReadOnlyError extends Error {
  constructor() {
    super(
      "Only SELECT queries run here. To change the file, edit it in the Data tab " +
        "and save from there.",
    );
    this.name = "ReadOnlyError";
  }
}

/**
 * Run one statement against the file's scratch database. The backend's own
 * `row_limit` applies, exactly as in the SQL editor, so a `SELECT *` over a
 * large file returns a truncated page rather than the whole thing.
 */
export function runDataFileQuery(handleId: string, sql: string): Promise<QueryResult> {
  const q = sql.trim().replace(/;+\s*$/, "");
  if (!SELECT_ONLY.test(q)) return Promise.reject(new ReadOnlyError());
  return queryRun(handleId, q, { schema: SCRATCH_SCHEMA });
}

/**
 * The file rows matching a raw WHERE clause, as 0-based indexes into
 * `parsed.rows` — the Data tab's filter in raw mode.
 *
 * SQLite evaluates the clause, so the escape hatch is the real thing (`total >
 * 100 OR country IN ('DE','FR')`, `LIKE`, `BETWEEN`, expressions) rather than a
 * re-implementation of SQL in the renderer. The mapping back to file rows is
 * `rowid - 1`: rows were inserted in file order into a table with no `INTEGER
 * PRIMARY KEY`, so rowid IS the 1-based file row number (see
 * {@link buildLoadScript}).
 *
 * The clause is the user's own text against their own scratch database — the
 * same trust level as the SQL editor. A syntax error surfaces as the backend's
 * §5 message, which the filter panel shows inline.
 *
 * The row limit is the file's own row count — the most a WHERE can match. The
 * backend always enforces SOME limit (default 500), and silently hiding matched
 * rows from a filter would be worse than the extra ids on the wire; they are
 * identifiers, not data, and the Data tab pages the result itself.
 */
export async function selectMatchingRows(
  handleId: string,
  table: string,
  where: string,
  rowCount: number,
): Promise<number[]> {
  const clause = where.trim().replace(/;+\s*$/, "");
  if (clause === "") return [];
  const sql = "SELECT rowid FROM " + quoteIdent(table) + " WHERE " + clause;
  const result = await queryRun(handleId, sql, {
    schema: SCRATCH_SCHEMA,
    rowLimit: Math.max(1, rowCount),
  });
  return result.rows.map((r) => Number(r[0]) - 1).filter((n) => Number.isInteger(n) && n >= 0);
}

/**
 * The four starter queries the SQL tab offers, generated from the file's own
 * columns: first rows, a count, a GROUP BY over the best low-cardinality text
 * column, and a top-N by the best numeric column.
 */
export function sampleQueries(
  schema: AdhocSchema,
  cols: ColumnProfile[],
): { label: string; sql: string }[] {
  const table = quoteIdent(schema.name);
  const first = (pred: (c: ColumnProfile) => boolean): string =>
    (cols.find(pred) ?? cols[0] ?? { name: "column_1" }).name;
  // A dimension worth grouping by: text, more than one value, but not so many
  // that the result is just the file again.
  const textCol = first((c) => c.type === "text" && c.distinct > 1 && c.distinct < 40);
  const numCol = first((c) => c.type === "integer" || c.type === "decimal");
  return [
    { label: "First 50 rows", sql: "SELECT * FROM " + table + " LIMIT 50" },
    { label: "Count rows", sql: 'SELECT COUNT(*) AS "rows" FROM ' + table },
    {
      label: "Group by " + textCol,
      sql:
        "SELECT " +
        quoteIdent(textCol) +
        ", COUNT(*) AS n FROM " +
        table +
        " GROUP BY " +
        quoteIdent(textCol) +
        " ORDER BY n DESC",
    },
    {
      label: "Top " + numCol,
      sql: "SELECT * FROM " + table + " ORDER BY " + quoteIdent(numCol) + " DESC LIMIT 20",
    },
  ];
}
