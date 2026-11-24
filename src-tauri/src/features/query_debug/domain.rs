//! Cutting one SELECT into the steps a database runs it in.
//!
//! A database runs a query as one unit, so there is nothing to pause. Debug
//! mode instead cuts the statement at its clause boundaries and runs each
//! prefix as its own read-only SELECT: FROM, then each JOIN, then WHERE, and so
//! on. This module finds the clauses and writes those step queries; it runs
//! nothing.
//!
//! The step queries are built by **slicing the statement the user wrote**, the
//! way the explain slice's count probes are: quoting, aliases, schema
//! qualification and vendor syntax come out exactly as written, so no dialect
//! knowledge is needed beyond `LIMIT` vs `TOP` for sampling. Clauses are found
//! with the shared lexer, which never reads a keyword inside a string, a
//! comment, a quoted identifier or a subquery.
//!
//! Everything a step *says* (its sentence and notes) is written by the
//! renderer from the counts, so it can be translated. This module returns the
//! raw facts: which clause, its text, its range in the editor, and the SQL.

use serde::{Deserialize, Serialize};

use crate::shared::engine::Engine;
use crate::shared::sql_lex::{lex, Lexed, Tok};

/// Why a statement cannot be stepped. Each reaches the UI as its own message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "reason", rename_all = "camelCase")]
pub enum CannotDebug {
    /// Nothing in the editor but whitespace and comments.
    Empty,
    /// More than one statement.
    Multiple,
    /// Not a SELECT, or a SELECT that writes or locks (`INTO`, `FOR UPDATE`).
    NotSelect,
    /// A SELECT with no top-level FROM: nothing to start from.
    NoFrom,
    /// The engine rejected the statement. Set by the application layer, which
    /// asks the engine to plan it; this module never parses SQL fully.
    Parse { message: String },
    /// A DELETE naming more than one target table (MySQL's `DELETE a, b FROM`).
    MultipleTargets,
    /// An UPDATE or DELETE whose shape this module cannot read (no SET, no
    /// table), so there is no SELECT to step instead of it.
    UnreadableWrite,
}

/// A note fixed by the statement's shape, attached to the step it concerns.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum StaticNote {
    /// HAVING runs inside the GROUP BY (or SELECT) step and is not broken out.
    Having,
    /// Window functions are computed inside the SELECT step.
    Window,
    /// The FROM source is a subquery or a CTE, stepped as one opaque source.
    OpaqueSource,
    /// The steps before this one cover only the first SELECT of a set operation.
    SetOperation { keyword: String },
    /// An UPDATE / DELETE dry run: what would change, computed with SELECTs.
    DryRun,
}

/// The extra counts that explain what a JOIN did. Only for an INNER or LEFT
/// join on a single equality between the joined table and what came before.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinProbe {
    /// `true` for LEFT JOIN, `false` for INNER.
    pub left: bool,
    /// The equality as written, e.g. `p.order_id = o.id`.
    pub on: String,
    /// The joined table's alias, or its name when it has none.
    pub alias: String,
    /// Incoming rows with no match: an anti-join count.
    pub none_sql: String,
    /// Incoming rows that match more than one row.
    pub many_sql: String,
}

/// One AND-ed WHERE condition, counted on its own against the pre-WHERE rows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CondProbe {
    pub text: String,
    pub sql: String,
}

/// One step of the run order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugStep {
    /// `from`, `join0…n`, `where`, `groupBy`, `select`, `distinct`, `orderBy`,
    /// `limit`, `setOp`.
    pub key: String,
    /// The Clause-order entry it belongs to (joins belong to `from`).
    pub clause: String,
    /// Label for the step list: `FROM`, `LEFT JOIN`, `TOP`, `UNION`, …
    pub kw: String,
    /// The clause's own text, on one line, without its keyword.
    pub text: String,
    /// The table a FROM or JOIN step reads, as written. For sentences.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub table: Option<String>,
    /// `[start, end)` in the editor text, in UTF-16 code units (what the
    /// renderer's string offsets are).
    pub range: [usize; 2],
    /// The exact SELECT this step runs. Copy / Open as query use it.
    pub sql: String,
    /// Statements that count the step's rows, tried in order, when its sample
    /// was cut short. Each returns one COUNT(*) cell.
    pub count_sql: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub join: Option<JoinProbe>,
    /// WHERE only, with two or more AND-ed conditions.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conds: Option<Vec<CondProbe>>,
    /// WHERE only: a top-level OR, so conditions cannot be counted one by one.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub has_or: bool,
    /// SELECT only: the select list aggregates with no GROUP BY.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub aggregate: bool,
    /// SELECT only: a GROUP BY ran before it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub grouped: bool,
    /// LIMIT only: an ORDER BY decides which rows survive.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub ordered: bool,
    /// Count with `count_sql` even when the sample fits: the sample's row
    /// count is not the answer (a joined write's distinct target rows).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub always_count: bool,
    pub notes: Vec<StaticNote>,
}

/// What an UPDATE / DELETE would do, for the dry-run step's sentence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteInfo {
    /// `update` or `delete`.
    pub kind: String,
    /// The target table, unquoted and without schema.
    pub table: String,
    /// The target is joined to other tables, so one target row can match
    /// several times: the count is of distinct target rows when that works.
    pub joined: bool,
    /// The UPDATE's new values are shown as `→ column` columns.
    pub preview: bool,
}

/// Everything needed to step one statement.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugPlan {
    pub steps: Vec<DebugStep>,
    /// The tables the statement reads, unquoted and without schema, for the
    /// renderer's large-table check against the catalog's row estimates.
    pub sources: Vec<String>,
    /// Whether the base relation can be sampled (it is a plain table).
    pub can_sample: bool,
    /// The row cap applied to the base relation, when this plan is sampled.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sampled: Option<u64>,
    /// Set for an UPDATE / DELETE, which is stepped as a dry run.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub write: Option<WriteInfo>,
}

/// Aggregate functions that fold rows. A call to one directly in the select
/// list (not inside a subquery, not followed by OVER) makes the SELECT fold.
const AGGREGATES: &[&str] = &[
    "count",
    "count_big",
    "sum",
    "avg",
    "min",
    "max",
    "group_concat",
    "string_agg",
    "array_agg",
    "json_agg",
    "jsonb_agg",
    "json_group_array",
    "listagg",
    "bool_and",
    "bool_or",
    "every",
    "stddev",
    "stddev_pop",
    "stddev_samp",
    "variance",
    "var_pop",
    "var_samp",
    "total",
    "uniq",
    "any",
    "groupuniqarray",
    "grouparray",
];

/// A clause boundary at the top level, in source order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mark {
    From,
    Join,
    Where,
    Group,
    Having,
    Window,
    Order,
    /// `LIMIT`, `OFFSET` or `FETCH`; they form one segment.
    Limit,
    /// `UNION` / `INTERSECT` / `EXCEPT` / `MINUS`: the first branch ends here.
    SetOp,
}

/// A clause segment: its first and last token (inclusive).
#[derive(Debug, Clone, Copy)]
struct Seg {
    mark: Mark,
    first: usize,
    last: usize,
}

/// The statement text, with the base relation optionally swapped for a
/// sampled subquery. Every step query is sliced through here, so a sampled plan
/// samples every step the same way while ranges stay on the original text.
struct Src<'a> {
    text: &'a str,
    swap: Option<(usize, usize, String)>,
}

impl Src<'_> {
    fn slice(&self, a: usize, b: usize) -> String {
        match &self.swap {
            Some((s, e, with)) if a <= *s && *e <= b => {
                format!("{}{}{}", &self.text[a..*s], with, &self.text[*e..b])
            }
            _ => self.text[a..b].to_string(),
        }
    }
}

/// Collapse whitespace runs so a clause reads on one line in the step list.
fn one_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A byte offset as a UTF-16 offset, which is what the editor counts in.
fn utf16(text: &str, byte: usize) -> usize {
    text[..byte].encode_utf16().count()
}

/// The last part of a dotted name, unquoted: `public."My Orders"` → `My Orders`.
fn bare_name(name: &str) -> String {
    let last = split_last_part(name).1;
    let trimmed = last.trim_matches(|c| matches!(c, '"' | '`' | '[' | ']'));
    trimmed.to_string()
}

/// Split a possibly-qualified name at its last unquoted dot.
fn split_last_part(name: &str) -> (&str, &str) {
    let mut quote: Option<char> = None;
    let mut cut = None;
    for (i, c) in name.char_indices() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => {}
            None => match c {
                '"' | '`' => quote = Some(c),
                '[' => quote = Some(']'),
                '.' => cut = Some(i),
                _ => {}
            },
        }
    }
    match cut {
        Some(i) => (&name[..i], &name[i + 1..]),
        None => ("", name),
    }
}

fn word(t: &Lexed) -> Option<&str> {
    match &t.tok {
        Tok::Word(w) => Some(w.as_str()),
        _ => None,
    }
}

/// Index of the token closing the paren group that opens at `open`.
fn close_paren(toks: &[Lexed], open: usize) -> usize {
    let depth = toks[open].depth;
    (open + 1..toks.len())
        .find(|&i| toks[i].tok == Tok::Punct(')') && toks[i].depth == depth)
        .unwrap_or(toks.len() - 1)
}

/// The statement's tokens `[first, end)`: the first that is not a `;`, and
/// the end before a trailing `;`. Errors on an empty buffer or a second
/// statement.
fn statement_bounds(toks: &[Lexed]) -> Result<(usize, usize), CannotDebug> {
    let Some(first) = toks.iter().position(|t| t.tok != Tok::Punct(';')) else {
        return Err(CannotDebug::Empty);
    };
    let semi = toks
        .iter()
        .position(|t| t.depth == 0 && t.tok == Tok::Punct(';') && t.start > toks[first].start);
    match semi {
        Some(s) if toks[s..].iter().any(|t| t.tok != Tok::Punct(';')) => Err(CannotDebug::Multiple),
        Some(s) => Ok((first, s)),
        None => Ok((first, toks.len())),
    }
}

/// Plan the steps of `sql` on `engine`. With `sample`, the base relation is
/// read through a capped subquery in every step.
///
/// A SELECT is stepped as written. An UPDATE or DELETE is stepped as a dry
/// run: the SELECT that finds the rows it would change (see `write`).
pub fn plan(sql: &str, engine: Engine, sample: Option<u64>) -> Result<DebugPlan, CannotDebug> {
    let toks = lex(sql);
    let (first, end) = statement_bounds(&toks)?;
    let top = |i: usize| toks.get(i).filter(|t| t.depth == 0).and_then(word);
    // The statement's own verb: the first top-level one after a CTE list.
    let verb = match top(first) {
        Some("with") => (first + 1..end).find(|&i| {
            matches!(
                top(i),
                Some("select" | "update" | "delete" | "insert" | "merge")
            )
        }),
        _ => Some(first),
    };
    let mut plan = match verb.and_then(top) {
        Some("update" | "delete") => {
            write::plan_write(sql, &toks, first, end, verb.unwrap(), engine, sample)?
        }
        _ => plan_select(sql, engine, sample)?,
    };
    for st in &mut plan.steps {
        st.range = [utf16(sql, st.range[0]), utf16(sql, st.range[1])];
    }
    Ok(plan)
}

/// Plan a SELECT, with step ranges in BYTES of `sql` (`plan` converts them).
fn plan_select(sql: &str, engine: Engine, sample: Option<u64>) -> Result<DebugPlan, CannotDebug> {
    let toks = lex(sql);
    let top = |i: usize| -> Option<&str> { toks.get(i).filter(|t| t.depth == 0).and_then(word) };

    // ---- eligibility -------------------------------------------------------
    let Some(first) = toks.iter().position(|t| t.tok != Tok::Punct(';')) else {
        return Err(CannotDebug::Empty);
    };
    // A top-level `;` followed by anything but more `;` is a second statement.
    let semi = toks
        .iter()
        .position(|t| t.depth == 0 && t.tok == Tok::Punct(';') && t.start > toks[first].start);
    let end_tok = match semi {
        Some(s) => {
            if toks[s..].iter().any(|t| t.tok != Tok::Punct(';')) {
                return Err(CannotDebug::Multiple);
            }
            s
        }
        None => toks.len(),
    };
    let toks_end = end_tok; // tokens [first, toks_end) are the statement

    let lead = top(first);
    let select = match lead {
        Some("select") => first,
        Some("with") => (first + 1..toks_end)
            .find(|&i| top(i) == Some("select"))
            .ok_or(CannotDebug::NotSelect)?,
        _ => return Err(CannotDebug::NotSelect),
    };
    let stmt_text = &sql[toks[first].start..toks[toks_end - 1].end];
    if !crate::shared::readonly::sql_is_read_only(stmt_text) {
        return Err(CannotDebug::NotSelect);
    }
    // The CTE list, kept verbatim in front of every step.
    let prefix = if select > first {
        format!(
            "{}\n",
            sql[toks[first].start..toks[select - 1].end].trim_end()
        )
    } else {
        String::new()
    };
    let cte_names: Vec<String> = if select > first {
        // A CTE's name follows `WITH`, `RECURSIVE` or a top-level comma.
        (first..select)
            .filter(|&i| {
                let opens = matches!(top(i), Some("with" | "recursive"));
                let comma = toks[i].depth == 0 && toks[i].tok == Tok::Punct(',');
                opens || comma
            })
            .filter_map(|i| toks.get(i + 1))
            .filter(|t| t.depth == 0)
            .map(|t| bare_name(&sql[t.start..t.end]).to_ascii_lowercase())
            .filter(|n| n != "recursive")
            .collect()
    } else {
        Vec::new()
    };

    // ---- clause marks ------------------------------------------------------
    let mut marks: Vec<(Mark, usize)> = Vec::new();
    let mut in_join_header = false;
    let mut i = select + 1;
    let mut from_seen = false;
    while i < toks_end {
        let Some(w) = top(i) else {
            i += 1;
            continue;
        };
        let next = top(i + 1);
        let mark = if !from_seen {
            (w == "from").then_some(Mark::From)
        } else if in_join_header {
            if matches!(w, "join" | "apply" | "straight_join") {
                in_join_header = false;
            }
            None
        } else {
            match w {
                "join" | "straight_join" => Some(Mark::Join),
                // `left(…)` cannot reach here: no function call follows a FROM
                // item at the top level.
                "inner" | "left" | "right" | "full" | "cross" | "natural" | "global" | "asof" => {
                    in_join_header = true;
                    Some(Mark::Join)
                }
                "outer" if next == Some("apply") => {
                    in_join_header = true;
                    Some(Mark::Join)
                }
                "array" if matches!(next, Some("join")) => {
                    in_join_header = true;
                    Some(Mark::Join)
                }
                "where" => Some(Mark::Where),
                "group" if next == Some("by") => Some(Mark::Group),
                "having" => Some(Mark::Having),
                "window" => Some(Mark::Window),
                "order" if next == Some("by") => Some(Mark::Order),
                "limit" | "offset" | "fetch" => Some(Mark::Limit),
                "union" | "intersect" | "except" | "minus" => Some(Mark::SetOp),
                _ => None,
            }
        };
        if let Some(m) = mark {
            if m == Mark::From {
                from_seen = true;
            }
            // OFFSET after LIMIT (or FETCH after OFFSET) continues one segment.
            let continues =
                m == Mark::Limit && marks.last().is_some_and(|(p, _)| *p == Mark::Limit);
            if !continues {
                marks.push((m, i));
            }
            if m == Mark::SetOp {
                break;
            }
        }
        i += 1;
    }
    if !from_seen {
        return Err(CannotDebug::NoFrom);
    }

    let set_op = marks
        .iter()
        .find(|(m, _)| *m == Mark::SetOp)
        .map(|&(_, at)| at);
    let branch_end = set_op.unwrap_or(toks_end); // exclusive token index
    let segs: Vec<Seg> = marks
        .iter()
        .enumerate()
        .filter(|(_, (m, _))| *m != Mark::SetOp)
        .map(|(k, &(mark, first))| {
            let next = marks.get(k + 1).map_or(branch_end, |&(_, at)| at);
            Seg {
                mark,
                first,
                last: next - 1,
            }
        })
        .collect();
    let seg = |m: Mark| segs.iter().find(|s| s.mark == m).copied();
    let from = seg(Mark::From).expect("from_seen");
    let joins: Vec<Seg> = segs
        .iter()
        .filter(|s| s.mark == Mark::Join)
        .copied()
        .collect();
    let where_ = seg(Mark::Where);
    let group = seg(Mark::Group);
    let having = seg(Mark::Having);
    let window = seg(Mark::Window);
    let order = seg(Mark::Order);
    let limit = seg(Mark::Limit);

    let start = |t: usize| toks[t].start;
    let end = |t: usize| toks[t].end;
    let seg_text = |s: Seg| &sql[start(s.first)..end(s.last)];
    // The clause text without its keyword(s), on one line.
    let body_of = |s: Seg, kw_tokens: usize| -> String {
        let b = s.first + kw_tokens;
        if b > s.last {
            String::new()
        } else {
            one_line(&sql[start(b)..end(s.last)])
        }
    };

    // ---- the select list: TOP and DISTINCT ---------------------------------
    let list_first = select + 1;
    let list_last = from.first - 1; // inclusive; may precede list_first if empty
    let mut distinct: Option<(usize, usize)> = None; // token range, inclusive
    let mut top_n: Option<(usize, usize)> = None;
    let mut p = list_first;
    if top(p) == Some("all") {
        p += 1;
    } else if top(p) == Some("distinct") {
        let mut e = p;
        if top(p + 1) == Some("on") && toks.get(p + 2).map(|t| &t.tok) == Some(&Tok::Punct('(')) {
            e = close_paren(&toks, p + 2);
        }
        distinct = Some((p, e));
        p = e + 1;
    }
    if engine == Engine::Mssql && top(p) == Some("top") {
        let mut e = p + 1;
        if toks.get(e).map(|t| &t.tok) == Some(&Tok::Punct('(')) {
            e = close_paren(&toks, e);
        }
        if top(e + 1) == Some("percent") {
            e += 1;
        }
        if top(e + 1) == Some("with") && top(e + 2) == Some("ties") {
            e += 2;
        }
        top_n = Some((p, e));
    }
    if list_last < list_first {
        return Err(CannotDebug::NotSelect);
    }
    let sel_start = start(select);
    let sel_end = end(list_last);
    // The select list with token ranges cut out, as written otherwise.
    let select_without = |cuts: &[(usize, usize)]| -> String {
        let mut out = String::new();
        let mut at = sel_start;
        for &(a, b) in cuts {
            out.push_str(&sql[at..start(a)]);
            at = end(b);
        }
        out.push_str(&sql[at..sel_end]);
        one_space_after_select(&out)
    };
    let mut no_top_cuts = Vec::new();
    if let Some(t) = top_n {
        no_top_cuts.push(t);
    }
    let select_no_top = select_without(&no_top_cuts);
    let mut plain_cuts = Vec::new();
    if let Some(d) = distinct {
        plain_cuts.push(d);
    }
    plain_cuts.extend(top_n);
    plain_cuts.sort();
    let select_plain = select_without(&plain_cuts);

    // Aggregates and window functions directly in the select list.
    let mut aggregate = false;
    let mut windowed = false;
    for k in list_first..=list_last {
        let Some(w) = top(k) else { continue };
        if w == "over" {
            windowed = true;
        }
        if AGGREGATES.contains(&w) && toks.get(k + 1).map(|t| &t.tok) == Some(&Tok::Punct('(')) {
            let close = close_paren(&toks, k + 1);
            if top(close + 1) != Some("over") {
                aggregate = true;
            }
        }
    }

    // ---- the base relation -------------------------------------------------
    let rel = from.first + 1; // first token of the relation
    let (rel_last, alias) = relation_extent(&toks, rel, from.last);
    let base_is_table = rel <= from.last
        && matches!(toks[rel].tok, Tok::Word(_) | Tok::Opaque)
        && toks[rel].depth == 0;
    let base_name = if rel <= from.last {
        sql[start(rel)..end(rel)].to_string()
    } else {
        String::new()
    };
    let opaque_source =
        !base_is_table || cte_names.contains(&bare_name(&base_name).to_ascii_lowercase());
    let can_sample = base_is_table && !opaque_source && rel <= from.last;

    let swap = match sample {
        Some(n) if can_sample => {
            let alias_text = match alias {
                Some(a) => sql[start(a)..end(a)].to_string(),
                None => split_last_part(&base_name).1.to_string(),
            };
            let inner = if engine == Engine::Mssql {
                format!("(SELECT TOP ({n}) * FROM {base_name})")
            } else {
                format!("(SELECT * FROM {base_name} LIMIT {n})")
            };
            Some((start(rel), end(rel_last), format!("{inner} {alias_text}")))
        }
        _ => None,
    };
    let src = Src { text: sql, swap };
    let sampled = src.swap.as_ref().and(sample);

    let mut sources = Vec::new();
    if base_is_table && !opaque_source {
        sources.push(bare_name(&base_name));
    }

    // ---- steps -------------------------------------------------------------
    let from_at = start(from.first);
    let wrap = |body: &str| format!("{prefix}SELECT COUNT(*) FROM (\n{body}\n) bt_step");
    let row_count = |upto: usize| format!("{prefix}SELECT COUNT(*)\n{}", src.slice(from_at, upto));
    let range = |a: usize, b: usize| [a, b];
    let step = |key: &str, clause: &str, kw: String, text: String, r: [usize; 2], body: String| {
        DebugStep {
            key: key.into(),
            clause: clause.into(),
            kw,
            text,
            table: None,
            range: r,
            sql: format!("{prefix}{body}"),
            count_sql: Vec::new(),
            join: None,
            conds: None,
            has_or: false,
            aggregate: false,
            grouped: false,
            ordered: false,
            always_count: false,
            notes: Vec::new(),
        }
    };
    let mut steps: Vec<DebugStep> = Vec::new();

    // 1 · FROM
    {
        let mut st = step(
            "from",
            "from",
            "FROM".into(),
            body_of(from, 1),
            range(start(from.first), end(from.last)),
            format!("SELECT *\n{}", src.slice(from_at, end(from.last))),
        );
        st.table = Some(base_name.clone());
        st.count_sql = vec![row_count(end(from.last))];
        if opaque_source {
            st.notes.push(StaticNote::OpaqueSource);
        }
        steps.push(st);
    }

    // 2 · each JOIN
    let mut src_end = end(from.last);
    for (n, &j) in joins.iter().enumerate() {
        let incoming_end = src_end;
        src_end = end(j.last);
        let kw_last = (j.first..=j.last)
            .find(|&k| matches!(top(k), Some("join" | "apply" | "straight_join")))
            .unwrap_or(j.first);
        let kw = one_line(&sql[start(j.first)..end(kw_last)]).to_ascii_uppercase();
        let jrel = kw_last + 1;
        let jrel = if top(jrel) == Some("lateral") {
            jrel + 1
        } else {
            jrel
        };
        let on_at = (jrel..=j.last).find(|&k| matches!(top(k), Some("on" | "using")));
        let rel_end = on_at.map_or(j.last, |k| k - 1);
        let (jrel_last, jalias) = relation_extent(&toks, jrel, rel_end);
        let table = (jrel <= j.last).then(|| sql[start(jrel)..end(jrel)].to_string());
        let mut st = step(
            &format!("join{n}"),
            "from",
            kw.clone(),
            body_of(j, kw_last + 1 - j.first),
            range(start(j.first), end(j.last)),
            format!("SELECT *\n{}", src.slice(from_at, src_end)),
        );
        st.count_sql = vec![row_count(src_end)];
        if let Some(t) = &table {
            if matches!(toks[jrel].tok, Tok::Word(_) | Tok::Opaque) {
                sources.push(bare_name(t));
            }
        }
        st.table = table.clone();

        // Diagnostics for INNER / LEFT on one equality.
        let kind_words: Vec<&str> = (j.first..kw_last).filter_map(top).collect();
        let left = kind_words.contains(&"left");
        let plain = kind_words
            .iter()
            .all(|w| matches!(*w, "inner" | "left" | "outer"))
            && !kind_words.contains(&"natural")
            && top(kw_last) == Some("join");
        if let (true, Some(on)) = (plain, on_at) {
            if top(on) == Some("on") && on + 3 == j.last {
                let (a, eq, b) = (on + 1, on + 2, on + 3);
                let side = |k: usize| matches!(toks[k].tok, Tok::Word(_)) && toks[k].depth == 0;
                if side(a) && side(b) && toks[eq].tok == Tok::Punct('=') {
                    let alias_text = jalias.map_or_else(
                        || {
                            split_last_part(table.as_deref().unwrap_or(""))
                                .1
                                .to_string()
                        },
                        |k| sql[start(k)..end(k)].to_string(),
                    );
                    let qual = |k: usize| {
                        split_last_part(&sql[start(k)..end(k)])
                            .0
                            .to_ascii_lowercase()
                    };
                    let me = alias_text.to_ascii_lowercase();
                    let (mine, theirs) = if qual(a) == me {
                        (Some(a), b)
                    } else if qual(b) == me {
                        (Some(b), a)
                    } else {
                        (None, a)
                    };
                    if let Some(mine) = mine {
                        let rel_text = &sql[start(jrel)..end(jrel_last)];
                        let mine_t = &sql[start(mine)..end(mine)];
                        let theirs_t = &sql[start(theirs)..end(theirs)];
                        let incoming = src.slice(from_at, incoming_end);
                        let inner =
                            format!("SELECT {{}} FROM {rel_text} WHERE {mine_t} = {theirs_t}");
                        st.join = Some(JoinProbe {
                            left,
                            on: one_line(&sql[start(a)..end(b)]),
                            alias: alias_text.clone(),
                            none_sql: format!(
                                "{prefix}SELECT COUNT(*)\n{incoming}\nWHERE NOT EXISTS ({})",
                                inner.replace("{}", "1")
                            ),
                            many_sql: format!(
                                "{prefix}SELECT COUNT(*)\n{incoming}\nWHERE ({}) > 1",
                                inner.replace("{}", "COUNT(*)")
                            ),
                        });
                    }
                }
            }
        }
        steps.push(st);
    }

    // 3 · WHERE
    if let Some(w) = where_ {
        let before_where = src_end;
        src_end = end(w.last);
        let mut st = step(
            "where",
            "where",
            "WHERE".into(),
            body_of(w, 1),
            range(start(w.first), end(w.last)),
            format!("SELECT *\n{}", src.slice(from_at, src_end)),
        );
        st.count_sql = vec![row_count(src_end)];
        match split_and(&toks, w.first + 1, w.last) {
            None => st.has_or = true,
            Some(parts) if parts.len() > 1 => {
                st.conds = Some(
                    parts
                        .iter()
                        .map(|&(a, b)| {
                            let cond = &sql[start(a)..end(b)];
                            CondProbe {
                                text: one_line(cond),
                                sql: format!(
                                    "{prefix}SELECT COUNT(*)\n{}\nWHERE {cond}",
                                    src.slice(from_at, before_where)
                                ),
                            }
                        })
                        .collect(),
                );
            }
            Some(_) => {}
        }
        steps.push(st);
    }

    // The rows-then-groups core: FROM … WHERE … GROUP BY … HAVING … WINDOW.
    let core_last = [group, having, window]
        .iter()
        .flatten()
        .map(|s| s.last)
        .max();
    let core_end = core_last.map_or(src_end, end);
    let core = src.slice(from_at, core_end);
    let one_row = |core: &str| wrap(&format!("SELECT 1 AS bt_one\n{core}"));

    // 4 · GROUP BY (with HAVING inside it)
    if let Some(g) = group {
        let upto = [Some(g), having]
            .iter()
            .flatten()
            .map(|s| s.last)
            .max()
            .unwrap_or(g.last);
        let body = format!("{select_no_top}\n{}", src.slice(from_at, end(upto)));
        let mut st = step(
            "groupBy",
            "groupBy",
            "GROUP BY".into(),
            body_of(g, 2),
            range(start(g.first), end(g.last)),
            body.clone(),
        );
        let ones = format!("SELECT 1 AS bt_one\n{}", src.slice(from_at, end(upto)));
        st.count_sql = vec![wrap(&body), wrap(&ones)];
        if having.is_some() {
            st.notes.push(StaticNote::Having);
        }
        steps.push(st);
    }

    // 5 · SELECT, then DISTINCT
    {
        let body = format!("{select_plain}\n{core}");
        let mut st = step(
            "select",
            "select",
            "SELECT".into(),
            one_line(select_plain.get(7..).unwrap_or("")),
            range(sel_start, sel_end),
            body.clone(),
        );
        st.count_sql = vec![wrap(&body)];
        // Without aggregates (or with GROUP BY) the select list keeps every
        // row, so counting `1` per row is the same count without the
        // duplicate-column trouble a `SELECT *` across a join has.
        if !aggregate || group.is_some() {
            st.count_sql.push(one_row(&core));
        }
        st.aggregate = aggregate && group.is_none();
        st.grouped = group.is_some();
        if windowed {
            st.notes.push(StaticNote::Window);
        }
        if having.is_some() && group.is_none() {
            st.notes.push(StaticNote::Having);
        }
        steps.push(st);
    }
    if let Some((d0, d1)) = distinct {
        let body = format!("{select_no_top}\n{core}");
        let mut st = step(
            "distinct",
            "distinct",
            "DISTINCT".into(),
            one_line(&sql[start(d0)..end(d1)]),
            range(sel_start, sel_end),
            body.clone(),
        );
        st.count_sql = vec![wrap(&body)];
        steps.push(st);
    }

    // 6 · ORDER BY. Sorting never changes the count, so it is counted without
    // the ORDER BY (which SQL Server refuses inside a derived table).
    let ordered_count = steps
        .last()
        .map(|s| s.count_sql.clone())
        .unwrap_or_default();
    if let Some(o) = order {
        let body = format!("{select_no_top}\n{}", src.slice(from_at, end(o.last)));
        let mut st = step(
            "orderBy",
            "orderBy",
            "ORDER BY".into(),
            body_of(o, 2),
            range(start(o.first), end(o.last)),
            body,
        );
        st.count_sql = ordered_count;
        steps.push(st);
    }

    // 7 · LIMIT / OFFSET / FETCH, or SQL Server's TOP: the whole first branch.
    let branch_last = branch_end - 1;
    let whole_branch = format!(
        "{}\n{}",
        one_space_after_select(&sql[sel_start..sel_end]),
        src.slice(from_at, end(branch_last))
    );
    let limit_part = match (limit, top_n) {
        (Some(l), _) => Some((
            sql[start(l.first)..end(l.first)].to_ascii_uppercase(),
            one_line(seg_text(l)),
            range(start(l.first), end(l.last)),
        )),
        (None, Some((a, b))) => Some((
            "TOP".to_string(),
            body_of(
                Seg {
                    mark: Mark::Limit,
                    first: a,
                    last: b,
                },
                1,
            ),
            range(start(a), end(b)),
        )),
        _ => None,
    };
    if let Some((kw, text, r)) = limit_part {
        let text = if limit.is_some() {
            text.split_once(' ')
                .map(|(_, rest)| rest.to_string())
                .unwrap_or_default()
        } else {
            text
        };
        let mut st = step("limit", "limit", kw, text, r, whole_branch.clone());
        st.count_sql = vec![wrap(&whole_branch)];
        st.ordered = order.is_some();
        steps.push(st);
    }

    // 8 · a set operation: the whole statement, after the first branch's steps.
    if let Some(at) = set_op {
        let keyword = one_line(&sql[start(at)..end(at)]).to_ascii_uppercase();
        let whole = src.slice(sel_start, end(toks_end - 1));
        let mut st = step(
            "setOp",
            "select",
            keyword.clone(),
            one_line(&sql[start(at)..end(toks_end - 1)])
                .split_once(' ')
                .map(|(_, r)| r.to_string())
                .unwrap_or_default(),
            range(start(at), end(toks_end - 1)),
            whole.clone(),
        );
        st.count_sql = vec![wrap(&whole)];
        st.notes.push(StaticNote::SetOperation { keyword });
        steps.push(st);
    }

    Ok(DebugPlan {
        steps,
        sources,
        can_sample,
        sampled,
        write: None,
    })
}

/// `SELECT  a, b` after a cut can leave a double space; keep the text tidy
/// without touching anything past the keyword.
fn one_space_after_select(s: &str) -> String {
    let trimmed = s.trim_start();
    match trimmed.get(..6) {
        Some(kw) if kw.eq_ignore_ascii_case("select") => {
            let rest = trimmed[6..].trim_start();
            format!("{kw} {rest}")
        }
        _ => s.to_string(),
    }
}

/// The last token of a FROM / JOIN item starting at `rel` (inclusive, at most
/// `limit`), and its alias token if it has one.
fn relation_extent(toks: &[Lexed], rel: usize, limit: usize) -> (usize, Option<usize>) {
    let top = |i: usize| toks.get(i).filter(|t| t.depth == 0).and_then(word);
    if rel > limit {
        return (limit, None);
    }
    let mut p = rel;
    if toks[rel].tok == Tok::Punct('(') {
        p = close_paren(toks, rel);
    } else if toks.get(rel + 1).map(|t| &t.tok) == Some(&Tok::Punct('(')) {
        // A table function: `generate_series(1, 10)`.
        p = close_paren(toks, rel + 1);
    }
    let alias_at = if top(p + 1) == Some("as") {
        p + 2
    } else {
        p + 1
    };
    let is_alias = alias_at <= limit
        && match &toks[alias_at].tok {
            Tok::Opaque => toks[alias_at].depth == 0,
            Tok::Word(w) => toks[alias_at].depth == 0 && !NOT_AN_ALIAS.contains(&w.as_str()),
            _ => false,
        };
    if is_alias {
        (alias_at, Some(alias_at))
    } else {
        (p, None)
    }
}

/// Words that can never be a table alias.
const NOT_AN_ALIAS: &[&str] = &[
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
    "minus",
    "for",
    "on",
    "using",
    "join",
    "inner",
    "left",
    "right",
    "full",
    "cross",
    "natural",
    "straight_join",
    "outer",
    "apply",
    "array",
    "global",
    "asof",
    "as",
    "final",
    "sample",
    "prewhere",
    "tablesample",
    "with",
];

/// Split a WHERE predicate (tokens `a..=b`) on its top-level ANDs, as token
/// ranges. `None` when a top-level OR makes the parts not independent. The AND
/// of a `BETWEEN x AND y` is part of its condition, not a split.
fn split_and(toks: &[Lexed], a: usize, b: usize) -> Option<Vec<(usize, usize)>> {
    if a > b {
        return Some(Vec::new());
    }
    // The outer statement sits at depth 0; a CTE list never reaches WHERE.
    let depth = 0;
    let mut parts = Vec::new();
    let mut from = a;
    let mut between = false;
    for (k, tok) in toks.iter().enumerate().take(b + 1).skip(a) {
        if tok.depth != depth {
            continue;
        }
        match word(tok) {
            Some("or") => return None,
            Some("between") => between = true,
            Some("and") if between => between = false,
            Some("and") => {
                if k > from {
                    parts.push((from, k - 1));
                }
                from = k + 1;
            }
            _ => {}
        }
    }
    if from <= b {
        parts.push((from, b));
    }
    Some(parts)
}

mod write;

#[cfg(test)]
mod tests;
