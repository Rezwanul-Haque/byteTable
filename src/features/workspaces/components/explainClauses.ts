// SQL clause detection for the M15 execution-order minimap + Explain panel.
//
// Pure, client-side, allocation-light helpers ported from the prototype's
// explain.jsx. There is no backend or engine here: clause presence is derived
// by string-matching the editor's SQL text. String literals (`'...'`, with `''`
// escapes) are collapsed and `--` line comments stripped first, so the clause
// regexes can never match inside quoted text or comments — robust on the same
// multi-line SQL the editor runs.

/** The 8 logical clauses, in *execution* order (how the engine runs them). */
export const EXEC_STEPS = [
  {
    key: "from",
    kw: "FROM",
    label: "Read source",
    desc: "Scan the table named in FROM (and any JOINs) to build the working set of rows. Everything else operates on this.",
  },
  {
    key: "where",
    kw: "WHERE",
    label: "Filter rows",
    desc: "Discard rows that fail the WHERE predicate. Runs before SELECT, so SELECT-list aliases are NOT visible here.",
  },
  {
    key: "groupBy",
    kw: "GROUP BY",
    label: "Group",
    desc: "Collapse the surviving rows into one row per distinct group key.",
  },
  {
    key: "having",
    kw: "HAVING",
    label: "Filter groups",
    desc: "Filter the grouped rows — unlike WHERE, HAVING can test aggregates like COUNT(*).",
  },
  {
    key: "select",
    kw: "SELECT",
    label: "Project & aggregate",
    desc: "Evaluate the select list and aggregate functions, then attach column aliases.",
  },
  {
    key: "distinct",
    kw: "DISTINCT",
    label: "De-duplicate",
    desc: "Remove duplicate rows from the projected result.",
  },
  {
    key: "orderBy",
    kw: "ORDER BY",
    label: "Sort",
    desc: "Order the result. Runs after SELECT, so it CAN reference SELECT-list aliases.",
  },
  {
    key: "limit",
    kw: "LIMIT",
    label: "Limit / offset",
    desc: "Skip OFFSET rows, then keep at most LIMIT rows — the last thing the engine does.",
  },
] as const;

export type StepKey = (typeof EXEC_STEPS)[number]["key"];

export interface DetectedClauses {
  table: string | null;
  from: boolean;
  where: boolean;
  groupBy: boolean;
  having: boolean;
  distinct: boolean;
  orderBy: boolean;
  limit: boolean;
  aggregate: boolean;
  isSelect: boolean;
}

/**
 * Cheap clause-presence detector. String literals are collapsed and `--`
 * comments stripped first, so the clause regexes never match inside quoted
 * text or comments. Forgiving by design — works on multi-line editor SQL.
 */
export function detectClauses(sql: string): DetectedClauses {
  const s = (sql || "").replace(/'(?:[^']|'')*'/g, "''").replace(/--[^\n]*/g, "");
  const fromM = s.match(/\bfrom\s+([a-z_][\w]*)/i);
  return {
    table: fromM ? (fromM[1] ?? null) : null,
    from: !!fromM,
    where: /\bwhere\b/i.test(s),
    groupBy: /\bgroup\s+by\b/i.test(s),
    having: /\bhaving\b/i.test(s),
    distinct: /\bselect\s+distinct\b/i.test(s),
    orderBy: /\border\s+by\b/i.test(s),
    limit: /\blimit\b/i.test(s),
    aggregate: /\b(count|sum|avg|min|max)\s*\(/i.test(s),
    isSelect: /^\s*select\b/i.test(s),
  };
}

export function clausePresent(c: DetectedClauses, key: StepKey): boolean {
  if (key === "select") return c.isSelect;
  return c[key];
}

export const stepByKey = (key: StepKey) => EXEC_STEPS.find((s) => s.key === key)!;

/** The canonical WRITTEN (syntax) order — how you type the clauses. */
export const WRITTEN_ORDER: StepKey[] = [
  "select",
  "distinct",
  "from",
  "where",
  "groupBy",
  "having",
  "orderBy",
  "limit",
];

/** The RUN (logical execution) order is the order of EXEC_STEPS itself. */
export const RUN_ORDER: StepKey[] = EXEC_STEPS.map((s) => s.key);

/** The detected FROM table for the current SQL, or null. */
export function detectedTable(sql: string): string | null {
  return detectClauses(sql).table;
}
