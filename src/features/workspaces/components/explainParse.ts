// SELECT shape parser for the M33 Explain redesign.
//
// The prototype (MILESTONE_33 Tasks 1–2) taught its *mock engine* about table
// aliases, qualified columns and JOINs so `analyzeQuery` could run the query
// for real row counts. ByteTable has no in-browser engine — it runs the user's
// SQL against a real server — so the same capability lands here instead: a
// forgiving, read-only parse of the statement's *shape*, which is everything
// the plan model needs to name relations, aliases and join predicates.
//
// Forgiving is the whole design. The prototype's parser threw on anything it
// did not implement; that is right for an engine and wrong for a panel that
// must survive the CTEs, subqueries, window functions and vendor syntax people
// actually type. Every field is optional, nothing throws, and clause keywords
// are only matched at paren depth 0 so subqueries never leak into the shape.

/** A token of the statement. `kw` is reserved-word, lowercased in `value`. */
interface Tok {
  type: "kw" | "ident" | "num" | "str" | "punct";
  /** Lowercased keyword, dotted identifier path, or the punctuation itself. */
  value: string;
  /** Identifier path with quoting removed (`["o", "status"]`). */
  parts?: string[];
  /** Paren nesting at this token (an opening paren carries the outer depth). */
  depth: number;
  pos: number;
  end: number;
}

// Words that must never be mistaken for a table name or an alias. Not a full
// reserved list — just the ones that terminate or introduce the clauses below.
const KEYWORDS = new Set([
  "select",
  "distinct",
  "all",
  "top",
  "from",
  "as",
  "join",
  "inner",
  "left",
  "right",
  "full",
  "outer",
  "cross",
  "natural",
  "lateral",
  "on",
  "using",
  "where",
  "group",
  "by",
  "having",
  "order",
  "asc",
  "desc",
  "limit",
  "offset",
  "fetch",
  "next",
  "first",
  "rows",
  "row",
  "only",
  "and",
  "or",
  "not",
  "union",
  "intersect",
  "except",
  "with",
  "into",
  "window",
  "for",
]);

/** Aggregate functions the plan model reports on the SELECT / Aggregate node. */
const AGG_FNS = new Set(["count", "sum", "avg", "min", "max", "group_concat", "string_agg"]);

const isIdentStart = (ch: string) => /[A-Za-z_@#$]/.test(ch);
const isIdentChar = (ch: string) => /[A-Za-z0-9_@#$]/.test(ch);

/** Read a possibly-quoted, possibly-dotted identifier path starting at `i`. */
function readIdentPath(sql: string, i: number): { parts: string[]; end: number } {
  const parts: string[] = [];
  for (;;) {
    const ch = sql[i];
    if (ch === '"' || ch === "`" || ch === "[") {
      const close = ch === "[" ? "]" : ch;
      let j = i + 1;
      let buf = "";
      while (j < sql.length) {
        if (sql[j] === close) {
          // Doubled quote is an escaped quote ("a""b"); `]` has no escape form.
          if (close !== "]" && sql[j + 1] === close) {
            buf += close;
            j += 2;
            continue;
          }
          break;
        }
        buf += sql[j];
        j += 1;
      }
      parts.push(buf);
      i = j + 1;
    } else if (ch && isIdentStart(ch)) {
      let j = i;
      while (j < sql.length && isIdentChar(sql[j]!)) j += 1;
      parts.push(sql.slice(i, j));
      i = j;
    } else if (ch === "*") {
      parts.push("*");
      i += 1;
    } else {
      break;
    }
    if (sql[i] === ".") {
      i += 1;
      continue;
    }
    break;
  }
  return { parts, end: i };
}

/** Tokenize far enough to find clauses — comments and literals become inert. */
function tokenize(sql: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  let depth = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    if (ch === "'") {
      const start = i;
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      out.push({ type: "str", value: sql.slice(start, i), depth, pos: start, end: i });
      continue;
    }
    if (isIdentStart(ch) || ch === '"' || ch === "`" || ch === "[") {
      const start = i;
      const { parts, end } = readIdentPath(sql, i);
      i = end;
      const value = parts.join(".");
      const lower = value.toLowerCase();
      const kw = parts.length === 1 && KEYWORDS.has(lower);
      out.push({
        type: kw ? "kw" : "ident",
        value: kw ? lower : value,
        parts,
        depth,
        pos: start,
        end: i,
      });
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < sql.length && /[0-9._eE]/.test(sql[j]!)) j += 1;
      out.push({ type: "num", value: sql.slice(i, j), depth, pos: i, end: j });
      i = j;
      continue;
    }
    if (ch === "(") {
      out.push({ type: "punct", value: "(", depth, pos: i, end: i + 1 });
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === ")") {
      depth = Math.max(0, depth - 1);
      out.push({ type: "punct", value: ")", depth, pos: i, end: i + 1 });
      i += 1;
      continue;
    }
    const two = sql.slice(i, i + 2);
    if (two === "<=" || two === ">=" || two === "<>" || two === "!=" || two === "||") {
      out.push({ type: "punct", value: two, depth, pos: i, end: i + 2 });
      i += 2;
      continue;
    }
    out.push({ type: "punct", value: ch, depth, pos: i, end: i + 1 });
    i += 1;
  }
  return out;
}

/** One entry of the SELECT list, in the prototype's `items` shape. */
export interface SelectItem {
  kind: "star" | "col" | "agg" | "expr";
  /** Qualified name as written (`o.status`) — addressing, not a display name. */
  name: string;
  /** The unqualified name (`status`); the output column is `alias || base`. */
  base: string;
  alias: string | null;
  /** Aggregate function (lowercase) and its argument, for `kind: "agg"`. */
  fn?: string;
  arg?: string;
  /** The alias a `o.*` star is filtered to, or null for a bare `*`. */
  qual?: string | null;
}

/** One JOIN clause. `kind` mirrors the prototype's `ast.joins[].kind`. */
export interface JoinShape {
  kind: "inner" | "left" | "right" | "full" | "cross";
  table: string;
  /** The alias, defaulting to the table name (never null — plans address it). */
  alias: string;
  /** The ON predicate as written, whitespace-normalized. */
  onText: string | null;
  /** `[left, op, right]` when ON is a plain column-to-column comparison. */
  onCols: [string, string, string] | null;
}

/** The parsed shape of a single SELECT statement. Every field is best-effort. */
export interface SelectShape {
  isSelect: boolean;
  distinct: boolean;
  items: SelectItem[];
  aggregates: { fn: string; arg: string }[];
  /** The base relation of the FROM clause, unqualified. */
  table: string | null;
  /** Its schema qualifier when written as `schema.table`. */
  schema: string | null;
  /** The FROM alias, or null when none was written. */
  alias: string | null;
  /** True when FROM targets a derived table / subquery rather than a relation. */
  subquery: boolean;
  joins: JoinShape[];
  whereText: string | null;
  groupByText: string | null;
  havingText: string | null;
  orderBy: { col: string; dir: "asc" | "desc" }[];
  limit: number | null;
  offset: number | null;
  /**
   * Set when the statement uses a construct this shape cannot describe
   * honestly (RIGHT / FULL JOIN). The panel refuses rather than draw a plan
   * that is quietly wrong — a clear refusal beats a misleading picture.
   */
  unsupported: string | null;
  /**
   * Source offsets used to build the row-count probes (explainRun.ts) by
   * *slicing the statement the user wrote* rather than re-rendering it —
   * aliases, schema qualification and quoting therefore come out exactly
   * right, with no identifier quoting of our own.
   *
   * `fromStart` is the `FROM` keyword; `baseEnd` is just past the base
   * relation and its alias (before any JOIN); `whereEnd` is just past the
   * WHERE predicate (equal to `baseEnd` when there is no WHERE).
   */
  fromStart: number | null;
  baseEnd: number | null;
  whereEnd: number | null;
}

const EMPTY_SHAPE: SelectShape = {
  isSelect: false,
  distinct: false,
  items: [],
  aggregates: [],
  table: null,
  schema: null,
  alias: null,
  subquery: false,
  joins: [],
  whereText: null,
  groupByText: null,
  havingText: null,
  orderBy: [],
  limit: null,
  offset: null,
  unsupported: null,
  fromStart: null,
  baseEnd: null,
  whereEnd: null,
};

/** Keywords that end a clause body at the top level. */
const CLAUSE_END = new Set([
  "where",
  "group",
  "having",
  "order",
  "limit",
  "offset",
  "fetch",
  "window",
  "union",
  "intersect",
  "except",
  "for",
]);

/**
 * Parse the shape of a SELECT. Returns `isSelect: false` for anything that is
 * not one; never throws. Only paren-depth-0 keywords are recognised, so
 * subqueries in the select list or WHERE cannot be mistaken for clauses.
 */
export function parseSelectShape(sql: string): SelectShape {
  const src = sql || "";
  const toks = tokenize(src);
  const selIdx = toks.findIndex((t) => t.type === "kw" && t.value === "select" && t.depth === 0);
  if (selIdx < 0) return { ...EMPTY_SHAPE };

  const shape: SelectShape = { ...EMPTY_SHAPE, isSelect: true, items: [], joins: [], orderBy: [] };
  const at = (p: number): Tok | undefined => toks[p];
  const isKw = (p: number, kw: string) => {
    const t = at(p);
    return !!t && t.type === "kw" && t.value === kw && t.depth === 0;
  };
  /** Source text of `[from, to)`, with runs of whitespace collapsed. */
  const textOf = (from: number, to: number): string | null => {
    const a = at(from);
    const b = at(to - 1);
    if (!a || !b || to <= from) return null;
    const t = src.slice(a.pos, b.end).replace(/\s+/g, " ").trim();
    return t || null;
  };
  /** First index at/after `p` holding a top-level clause terminator. */
  const clauseEnd = (p: number): number => {
    for (let i = p; i < toks.length; i += 1) {
      const t = toks[i]!;
      if (t.depth !== 0) continue;
      if (t.type === "kw" && CLAUSE_END.has(t.value)) return i;
      if (t.type === "punct" && t.value === ";") return i;
    }
    return toks.length;
  };

  let p = selIdx + 1;
  if (isKw(p, "distinct")) {
    shape.distinct = true;
    p += 1;
  } else if (isKw(p, "all")) {
    p += 1;
  }
  // SQL Server's row cap sits where LIMIT would be in other dialects.
  if (isKw(p, "top")) {
    p += 1;
    const n = at(p);
    if (n?.type === "num") {
      shape.limit = Number(n.value);
      p += 1;
    }
  }

  // --- select list: split on top-level commas, up to the top-level FROM ---
  const fromIdx = toks.findIndex(
    (t, i) => i >= p && t.type === "kw" && t.value === "from" && t.depth === 0,
  );
  const listEnd = fromIdx < 0 ? clauseEnd(p) : fromIdx;
  let itemStart = p;
  for (let i = p; i <= listEnd; i += 1) {
    const t = at(i);
    const isComma = !!t && t.type === "punct" && t.value === "," && t.depth === 0;
    if (i === listEnd || isComma) {
      const item = parseSelectItem(toks, itemStart, i, src);
      if (item) shape.items.push(item);
      itemStart = i + 1;
    }
  }
  shape.aggregates = shape.items
    .filter((it) => it.kind === "agg")
    .map((it) => ({ fn: it.fn!, arg: it.arg! }));

  if (fromIdx < 0) return shape;
  shape.fromStart = toks[fromIdx]!.pos;
  p = fromIdx + 1;

  // --- FROM relation + alias ---
  const fromTok = at(p);
  if (fromTok?.type === "punct" && fromTok.value === "(") {
    shape.subquery = true;
    let d = 1;
    p += 1;
    while (p < toks.length && d > 0) {
      const t = toks[p]!;
      if (t.type === "punct" && t.value === "(") d += 1;
      else if (t.type === "punct" && t.value === ")") d -= 1;
      p += 1;
    }
  } else if (fromTok?.type === "ident") {
    const parts = fromTok.parts ?? [fromTok.value];
    shape.table = parts[parts.length - 1] ?? null;
    shape.schema = parts.length > 1 ? (parts[parts.length - 2] ?? null) : null;
    p += 1;
  } else {
    return shape;
  }
  const baseAliasStart = p;
  p = readAlias(p);
  if (p > baseAliasStart) shape.alias = aliasOf(p);
  shape.baseEnd = at(p - 1)?.end ?? null;
  shape.whereEnd = shape.baseEnd;

  // --- JOINs ---
  for (;;) {
    const kind = joinKindAt(p);
    if (!kind) break;
    p = kind.next;
    const jt = at(p);
    if (jt?.type !== "ident") {
      // A joined subquery / VALUES list: skip it rather than guess a name.
      break;
    }
    const jparts = jt.parts ?? [jt.value];
    const jtable = jparts[jparts.length - 1] ?? jt.value;
    p += 1;
    const aliasStart = p;
    p = readAlias(p);
    const jalias = p > aliasStart ? aliasOf(p) : jtable;
    let onText: string | null = null;
    let onCols: [string, string, string] | null = null;
    if (isKw(p, "on")) {
      const onStart = p + 1;
      let onEnd = onStart;
      while (onEnd < toks.length) {
        const t = toks[onEnd]!;
        if (t.depth === 0 && t.type === "kw" && (CLAUSE_END.has(t.value) || joinKindAt(onEnd)))
          break;
        if (t.depth === 0 && t.type === "punct" && t.value === ";") break;
        onEnd += 1;
      }
      onText = textOf(onStart, onEnd);
      onCols = plainColumnCompare(toks, onStart, onEnd);
      p = onEnd;
    } else if (isKw(p, "using")) {
      const usingStart = p;
      let usingEnd = p + 1;
      while (usingEnd < toks.length && toks[usingEnd]!.depth > 0) usingEnd += 1;
      onText = textOf(usingStart, usingEnd + 1);
      p = usingEnd + 1;
    }
    if (kind.kind === "right" || kind.kind === "full") {
      shape.unsupported =
        kind.kind.toUpperCase() +
        " JOIN cannot be modelled here — rewrite it as an INNER or LEFT JOIN to see a plan.";
    }
    shape.joins.push({ kind: kind.kind, table: jtable, alias: jalias, onText, onCols });
  }

  // --- WHERE / GROUP BY / HAVING / ORDER BY / LIMIT ---
  if (isKw(p, "where")) {
    const end = clauseEnd(p + 1);
    shape.whereText = textOf(p + 1, end);
    shape.whereEnd = at(end - 1)?.end ?? shape.whereEnd;
    p = end;
  }
  if (isKw(p, "group")) {
    p += 1;
    if (isKw(p, "by")) p += 1;
    const end = clauseEnd(p);
    shape.groupByText = textOf(p, end);
    p = end;
  }
  if (isKw(p, "having")) {
    const end = clauseEnd(p + 1);
    shape.havingText = textOf(p + 1, end);
    p = end;
  }
  if (isKw(p, "order")) {
    p += 1;
    if (isKw(p, "by")) p += 1;
    const end = clauseEnd(p);
    let start = p;
    for (let i = p; i <= end; i += 1) {
      const t = at(i);
      const isComma = !!t && t.type === "punct" && t.value === "," && t.depth === 0;
      if (i === end || isComma) {
        let dir: "asc" | "desc" = "asc";
        let stop = i;
        const last = at(i - 1);
        if (last?.type === "kw" && (last.value === "asc" || last.value === "desc")) {
          dir = last.value as "asc" | "desc";
          stop = i - 1;
        }
        const col = textOf(start, stop);
        if (col) shape.orderBy.push({ col, dir });
        start = i + 1;
      }
    }
    p = end;
  }
  if (isKw(p, "limit")) {
    p += 1;
    const a = at(p);
    if (a?.type === "num") {
      p += 1;
      // MySQL's `LIMIT offset, count` — the first number is the offset.
      if (at(p)?.type === "punct" && at(p)!.value === ",") {
        const b = at(p + 1);
        if (b?.type === "num") {
          shape.offset = Number(a.value);
          shape.limit = Number(b.value);
          p += 2;
        }
      } else {
        shape.limit = Number(a.value);
      }
    }
  }
  if (isKw(p, "offset")) {
    p += 1;
    const a = at(p);
    if (a?.type === "num") {
      shape.offset = Number(a.value);
      p += 1;
    }
    if (isKw(p, "rows") || isKw(p, "row")) p += 1;
  }
  if (isKw(p, "fetch")) {
    p += 1;
    if (isKw(p, "next") || isKw(p, "first")) p += 1;
    const a = at(p);
    if (a?.type === "num") {
      shape.limit = Number(a.value);
      p += 1;
    }
  }
  return shape;

  /** Consume `AS x` or a bare alias; returns the new position. */
  function readAlias(q: number): number {
    if (isKw(q, "as")) {
      const a = at(q + 1);
      return a && (a.type === "ident" || a.type === "kw") ? q + 2 : q + 1;
    }
    const a = at(q);
    // Guard on `type === "ident"`: `FROM orders WHERE …` must not read WHERE
    // as an alias, and a qualified token is never an alias.
    if (a?.type === "ident" && a.depth === 0 && (a.parts?.length ?? 1) === 1) return q + 1;
    return q;
  }

  /** The alias text `readAlias` consumed, i.e. the token before `end`. */
  function aliasOf(end: number): string {
    const t = at(end - 1);
    return t ? t.value : "";
  }

  /** Recognise a JOIN introducer at `q`; returns its kind and the ON-side pos. */
  function joinKindAt(q: number): { kind: JoinShape["kind"]; next: number } | null {
    let i = q;
    let kind: JoinShape["kind"] = "inner";
    if (isKw(i, "natural")) i += 1;
    if (isKw(i, "inner")) i += 1;
    else if (isKw(i, "left")) {
      kind = "left";
      i += 1;
      if (isKw(i, "outer")) i += 1;
    } else if (isKw(i, "right")) {
      kind = "right";
      i += 1;
      if (isKw(i, "outer")) i += 1;
    } else if (isKw(i, "full")) {
      kind = "full";
      i += 1;
      if (isKw(i, "outer")) i += 1;
    } else if (isKw(i, "cross")) {
      kind = "cross";
      i += 1;
    }
    if (!isKw(i, "join")) return null;
    i += 1;
    if (isKw(i, "lateral")) i += 1;
    return { kind, next: i };
  }
}

/** `col OP col` and nothing else — the prototype's `cmpcol` predicate node. */
function plainColumnCompare(
  toks: Tok[],
  start: number,
  end: number,
): [string, string, string] | null {
  if (end - start !== 3) return null;
  const [l, op, r] = [toks[start], toks[start + 1], toks[start + 2]];
  if (!l || !op || !r) return null;
  if (l.type !== "ident" || r.type !== "ident" || op.type !== "punct") return null;
  if (!["=", "<", ">", "<=", ">=", "<>", "!="].includes(op.value)) return null;
  return [l.value, op.value, r.value];
}

/** Parse one SELECT-list entry from the token range `[start, end)`. */
function parseSelectItem(toks: Tok[], start: number, end: number, src: string): SelectItem | null {
  if (end <= start) return null;
  const first = toks[start]!;
  const text = src
    .slice(first.pos, toks[end - 1]!.end)
    .replace(/\s+/g, " ")
    .trim();

  // Trailing alias: `AS x`, or a bare trailing identifier after an expression.
  let alias: string | null = null;
  let stop = end;
  const lastKw = toks[end - 2];
  if (end - start >= 2 && lastKw?.type === "kw" && lastKw.value === "as") {
    alias = toks[end - 1]!.value;
    stop = end - 2;
  } else if (end - start === 2 && first.type === "ident" && toks[end - 1]?.type === "ident") {
    alias = toks[end - 1]!.value;
    stop = end - 1;
  }

  const head = toks[start]!;
  if (stop - start === 1 && head.type === "punct" && head.value === "*") {
    return { kind: "star", name: "*", base: "*", alias: null, qual: null };
  }
  if (stop - start === 1 && head.type === "ident") {
    const parts = head.parts ?? [head.value];
    if (parts[parts.length - 1] === "*") {
      const qual = parts.length > 1 ? (parts[parts.length - 2] ?? null) : null;
      return { kind: "star", name: head.value, base: "*", alias: null, qual };
    }
    const base = parts[parts.length - 1] ?? head.value;
    return { kind: "col", name: head.value, base, alias };
  }
  // `FN( … )` — an aggregate when FN is one we report on the Aggregate node.
  const open = toks[start + 1];
  if (
    (head.type === "ident" || head.type === "kw") &&
    open?.type === "punct" &&
    open.value === "(" &&
    AGG_FNS.has(head.value.toLowerCase())
  ) {
    const close = stop - 1;
    const argToks = toks.slice(start + 2, close);
    const arg = argToks.length
      ? src
          .slice(argToks[0]!.pos, argToks[argToks.length - 1]!.end)
          .replace(/\s+/g, " ")
          .trim()
      : "";
    const fn = head.value.toLowerCase();
    return { kind: "agg", name: text, base: fn + "(" + arg + ")", alias, fn, arg };
  }
  return { kind: "expr", name: text, base: text, alias };
}
