// SQL clause detection for the M15 execution-order minimap + Explain panel.
//
// Pure, client-side, allocation-light helpers ported from the prototype's
// explain.jsx. There is no backend or engine here: clause presence is derived
// by string-matching the editor's SQL text. String literals (`'...'`, with `''`
// escapes) are collapsed and `--` line comments stripped first, so the clause
// regexes can never match inside quoted text or comments — robust on the same
// multi-line SQL the editor runs.

/** The 9 logical clauses, in *execution* order (how the engine runs them). */
export const EXEC_STEPS = [
  {
    key: "from",
    kw: "FROM",
    label: "Read source",
    desc: "Scan the table named in FROM to build the working set of rows. Everything else operates on this.",
  },
  {
    key: "join",
    kw: "JOIN … ON",
    label: "Join",
    desc: "Match rows against the joined table using ON, then — for an OUTER join — add back the rows that matched nothing, with NULLs. ON runs HERE; a WHERE on the joined table runs later and drops those NULL rows, quietly turning an outer join into an inner one.",
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
  join: boolean;
  /** A LEFT / RIGHT / FULL join — the one the WHERE-vs-ON trap applies to. */
  outerJoin: boolean;
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
    // An explicit JOIN, or the old comma form (`FROM a, b`) — which is an inner
    // join written differently, and runs at the same point.
    join: /\bjoin\b/i.test(s) || /\bfrom\s+[a-z_][\w.]*(?:\s+(?:as\s+)?[a-z_]\w*)?\s*,/i.test(s),
    outerJoin: /\b(left|right|full)\s+(outer\s+)?join\b/i.test(s),
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

/** Written-order keys that are nested inside the clause above them (JOIN … ON
 *  lives inside FROM), so the minimap can indent them and skip their number. */
export const NESTED_IN_WRITTEN: ReadonlySet<StepKey> = new Set<StepKey>(["join"]);

export const stepByKey = (key: StepKey) => EXEC_STEPS.find((s) => s.key === key)!;

/** The canonical WRITTEN (syntax) order — how you type the clauses. */
export const WRITTEN_ORDER: StepKey[] = [
  "select",
  "distinct",
  "from",
  // JOIN … ON is not a top-level clause — it is written INSIDE the FROM clause,
  // which is why the minimap renders it indented under FROM and leaves it out of
  // the written numbering. On the run side it IS its own step.
  "join",
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
