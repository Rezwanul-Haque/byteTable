//! UPDATE and DELETE as a dry run.
//!
//! A write is never run. Instead the statement is rewritten into the SELECT
//! that finds the rows it would change — built from slices of the user's own
//! text, like every other step query — and that SELECT is stepped as usual:
//! FROM, each JOIN, WHERE (with its per-condition counts), ORDER BY, LIMIT. A
//! last step says how many rows the write would change and shows them; for an
//! UPDATE, each SET column's new value appears beside the row as `→ column`.
//!
//! The dialects spell a joined write differently, and each maps to one SELECT:
//!
//! | Written                                         | Stepped as                          |
//! |-------------------------------------------------|-------------------------------------|
//! | `UPDATE t a SET … WHERE …` (all)                | `SELECT … FROM t a WHERE …`         |
//! | `UPDATE t a SET … FROM x WHERE …` (Postgres, SQLite) | `… FROM t a, x WHERE …`        |
//! | `UPDATE a SET … FROM t a JOIN x …` (SQL Server) | `… FROM t a JOIN x …`               |
//! | `UPDATE t a JOIN x ON … SET …` (MySQL)          | `… FROM t a JOIN x ON …`            |
//! | `DELETE FROM t a WHERE …` (all)                 | `SELECT a.* FROM t a WHERE …`       |
//! | `DELETE FROM t a USING x WHERE …` (Postgres)    | `… FROM t a, x WHERE …`             |
//! | `DELETE a FROM t a JOIN x …` (MySQL, SQL Server)| `… FROM t a JOIN x …`               |
//!
//! What a SELECT cannot see, the dry run cannot either: rows changed by
//! cascades or triggers, and errors that only the write would raise. The
//! renderer says so on the last step.

use super::{
    one_line, plan_select, relation_extent, word, CannotDebug, DebugPlan, DebugStep, StaticNote,
    WriteInfo,
};
use crate::shared::engine::Engine;
use crate::shared::sql_lex::{Lexed, Tok};

/// A SELECT assembled from slices of the original text and a few literals,
/// remembering where each slice came from so step ranges map back onto the
/// text the user wrote.
struct Synth {
    text: String,
    /// `(start in text, start in the original, length)` per slice.
    map: Vec<(usize, usize, usize)>,
    orig_len: usize,
}

impl Synth {
    fn new(orig_len: usize) -> Self {
        Self {
            text: String::new(),
            map: Vec::new(),
            orig_len,
        }
    }
    fn lit(&mut self, s: &str) {
        self.text.push_str(s);
    }
    fn take(&mut self, orig: &str, a: usize, b: usize) {
        self.map.push((self.text.len(), a, b - a));
        self.text.push_str(&orig[a..b]);
    }
    /// An offset in `text` as one in the original. One that falls in a
    /// literal maps to the start of the next slice.
    fn to_orig(&self, at: usize) -> usize {
        for &(syn, orig, len) in &self.map {
            if at <= syn + len {
                return if at >= syn { orig + (at - syn) } else { orig };
            }
        }
        self.orig_len
    }
}

/// Quote an output column name in the engine's dialect.
fn quote(engine: Engine, name: &str) -> String {
    match engine {
        Engine::Mssql => format!("[{}]", name.replace(']', "]]")),
        Engine::Mysql | Engine::Clickhouse => format!("`{}`", name.replace('`', "``")),
        _ => format!("\"{}\"", name.replace('"', "\"\"")),
    }
}

/// Clause keywords that end a write's table list or SET list.
const WRITE_MARKS: &[&str] = &[
    "set",
    "from",
    "using",
    "where",
    "order",
    "limit",
    "returning",
    "output",
    "option",
];

/// Plan an UPDATE or DELETE whose verb is token `verb`. Ranges are in bytes.
pub(super) fn plan_write(
    sql: &str,
    toks: &[Lexed],
    first: usize,
    end: usize,
    verb: usize,
    engine: Engine,
    sample: Option<u64>,
) -> Result<DebugPlan, CannotDebug> {
    let top = |i: usize| -> Option<&str> {
        (i < end)
            .then(|| toks.get(i))
            .flatten()
            .filter(|t| t.depth == 0)
            .and_then(word)
    };
    let start = |t: usize| toks[t].start;
    let stop = |t: usize| toks[t].end;
    let text = |a: usize, b: usize| &sql[start(a)..stop(b)];
    let is_update = top(verb) == Some("update");

    // ---- clause marks after the verb ---------------------------------------
    // (keyword, token index), in order. A second FROM (SQL Server's
    // `DELETE FROM t FROM t JOIN …`) is a mark of its own.
    let mut p = verb + 1;
    // SQL Server's `TOP (n)` right after the verb.
    let mut top_n = None;
    if engine == Engine::Mssql && top(p) == Some("top") {
        let mut e = p + 1;
        if toks.get(e).map(|t| &t.tok) == Some(&Tok::Punct('(')) {
            e = super::close_paren(toks, e);
        }
        if top(e + 1) == Some("percent") {
            e += 1;
        }
        top_n = Some((p, e));
        p = e + 1;
    }
    let body_start = p;
    let marks: Vec<(&str, usize)> = (body_start..end)
        .filter_map(|i| {
            let w = top(i)?;
            let next = top(i + 1);
            let hit = WRITE_MARKS.contains(&w) && (w != "order" || next == Some("by"));
            hit.then_some((w, i))
        })
        .collect();
    // The tokens of a clause: from after its keyword(s) to before the next mark.
    let after = |at: usize| -> (usize, usize) {
        let next = marks
            .iter()
            .map(|&(_, i)| i)
            .find(|&i| i > at)
            .unwrap_or(end);
        (at, next - 1)
    };
    let find = |kw: &str, from: usize| {
        marks
            .iter()
            .find(|&&(w, i)| w == kw && i >= from)
            .map(|&(_, i)| i)
    };

    // ---- the target and the source -----------------------------------------
    // `source` is a list of original token ranges (inclusive), joined with ", "
    // — the FROM list of the SELECT. `target` is the table being written.
    let mut source: Vec<(usize, usize)> = Vec::new();
    let target: (usize, usize);
    let mut set_seg = None;
    // A FROM / USING list of other sources.
    let extra_from;

    if is_update {
        let set_at = find("set", body_start).ok_or(CannotDebug::UnreadableWrite)?;
        if set_at == body_start {
            return Err(CannotDebug::UnreadableWrite);
        }
        target = (body_start, set_at - 1);
        set_seg = Some(after(set_at));
        extra_from = find("from", set_at).map(after);
    } else if top(body_start) == Some("from") {
        // DELETE FROM t … [USING x] / SQL Server's DELETE FROM t FROM t JOIN x.
        let (_, t_last) = after(body_start);
        if t_last <= body_start {
            return Err(CannotDebug::UnreadableWrite);
        }
        target = (body_start + 1, t_last);
        extra_from = find("using", t_last)
            .or_else(|| find("from", t_last + 1))
            .map(after);
    } else {
        // DELETE a FROM t a JOIN x … (MySQL, SQL Server) or DELETE t WHERE …
        let from_at = find("from", body_start);
        let t_last = from_at.map_or_else(|| after(body_start).1, |f| f - 1);
        if t_last < body_start {
            return Err(CannotDebug::UnreadableWrite);
        }
        if (body_start..=t_last).any(|i| toks[i].depth == 0 && toks[i].tok == Tok::Punct(',')) {
            return Err(CannotDebug::MultipleTargets);
        }
        target = (body_start, t_last);
        extra_from = from_at.map(after);
    }

    // Where the rows come from, and how the target is named in the SELECT.
    let mssql_from = engine == Engine::Mssql && extra_from.is_some();
    let named_in_from =
        mssql_from || (!is_update && extra_from.is_some() && top(body_start) != Some("from"));
    let (q, target_table) = if named_in_from {
        // The target is an alias (or name) declared in the FROM list.
        let name = text(target.0, target.1).trim_end_matches(".*").to_string();
        let (sf, sl) = extra_from.expect("named_in_from");
        source.push((sf + 1, sl));
        let table = resolve_alias(sql, toks, sf + 1, sl, &name).unwrap_or_else(|| name.clone());
        (name, table)
    } else {
        source.push(target);
        if let Some((sf, sl)) = extra_from {
            source.push((sf + 1, sl));
        }
        // The first relation of the target list: its alias, else its name.
        let (_, alias) = relation_extent(toks, target.0, target.1);
        let table = text(target.0, target.0).to_string();
        // Unaliased, the select list names it by its LAST part: `orders.*`, not
        // `public.orders.*`, which SQLite rejects.
        let q = alias.map_or_else(|| last_part(&table).to_string(), |a| text(a, a).to_string());
        (q, table)
    };
    let joined = source.len() > 1
        || source.iter().any(|&(a, b)| {
            (a..=b).any(|i| {
                toks[i].depth == 0
                    && (toks[i].tok == Tok::Punct(',') || matches!(top(i), Some("join" | "apply")))
            })
        });

    // ---- the select list ----------------------------------------------------
    // DELETE: the rows that would go. UPDATE: the rows, then each SET column's
    // new value as `→ column` (when every assignment reads `column = value`).
    let mut preview = false;
    let mut select_list = format!("{q}.*");
    if let Some((s_at, s_last)) = set_seg {
        // Assignments split on top-level commas: `(first, last)` token ranges.
        let commas = (s_at + 1..=s_last)
            .filter(|&k| toks[k].depth == 0 && toks[k].tok == Tok::Punct(','))
            .chain(std::iter::once(s_last + 1));
        let mut parts = Vec::new();
        let mut from = s_at + 1;
        for k in commas {
            if k > from {
                parts.push((from, k - 1));
            }
            from = k + 1;
        }
        let cols: Option<Vec<String>> = parts
            .iter()
            .map(|&(a, b)| {
                let assign = toks.get(a + 1).map(|t| &t.tok) == Some(&Tok::Punct('='));
                let col_ok = matches!(toks[a].tok, Tok::Word(_) | Tok::Opaque);
                (assign && col_ok && a + 2 <= b).then(|| {
                    let col = super::bare_name(text(a, a));
                    format!(
                        "{} AS {}",
                        text(a + 2, b),
                        quote(engine, &format!("→ {col}"))
                    )
                })
            })
            .collect();
        if let Some(cols) = cols.filter(|c| !c.is_empty()) {
            preview = true;
            select_list = format!("{select_list}, {}", cols.join(", "));
        }
    }

    // ---- the SELECT -----------------------------------------------------------
    // Built from the user's own slices, around a given select list: once with
    // the preview columns (the dry run), once with just the target's columns
    // (`target_sql`, which the change history reads the rows with).
    let build = |select_list: &str| -> Synth {
        let mut synth = Synth::new(sql.len());
        if verb > first {
            synth.take(sql, start(first), stop(verb - 1));
            synth.lit("\n");
        }
        synth.lit("SELECT ");
        if let Some((a, b)) = top_n {
            synth.take(sql, start(a), stop(b));
            synth.lit(" ");
        }
        synth.lit(select_list);
        synth.lit("\nFROM ");
        for (k, &(a, b)) in source.iter().enumerate() {
            if k > 0 {
                synth.lit(", ");
            }
            synth.take(sql, start(a), stop(b));
        }
        // WHERE, ORDER BY and LIMIT as written; RETURNING / OUTPUT / OPTION
        // are about the write, not the rows, and are left out.
        let tail_from = find("where", body_start)
            .or_else(|| find("order", body_start))
            .or_else(|| find("limit", body_start));
        if let Some(t0) = tail_from {
            let mut k = t0;
            while k < end {
                let (_, last) = after(k);
                if matches!(top(k), Some("where" | "order" | "limit")) {
                    synth.lit("\n");
                    synth.take(sql, start(k), stop(last));
                }
                k = last + 1;
            }
        }
        synth
    };
    let synth = build(&select_list);
    let target_sql = build(&format!("{q}.*")).text;

    let mut sub = plan_select(&synth.text, engine, sample)?;
    for st in &mut sub.steps {
        st.range = [synth.to_orig(st.range[0]), synth.to_orig(st.range[1])];
    }

    // The SELECT step means nothing for a write; the dry-run step replaces it
    // as the last word. Its query is the whole SELECT (sampled like the rest).
    let last = sub
        .steps
        .last()
        .cloned()
        .ok_or(CannotDebug::UnreadableWrite)?;
    sub.steps
        .retain(|s| s.key != "select" && s.key != "distinct");

    let prefix = if verb > first {
        format!("{}\n", text(first, verb - 1).trim_end())
    } else {
        String::new()
    };
    let mut count_sql = Vec::new();
    if joined {
        // One target row can match several source rows but is written once:
        // count distinct target rows. `SELECT DISTINCT a.*` fails on types
        // that cannot be compared (JSON), so the joined count is the fallback.
        let mut d = Synth::new(sql.len());
        d.lit(&prefix);
        d.lit(&format!("SELECT DISTINCT {q}.*\nFROM "));
        for (k, &(a, b)) in source.iter().enumerate() {
            if k > 0 {
                d.lit(", ");
            }
            d.take(sql, start(a), stop(b));
        }
        if let Some(w) = find("where", body_start) {
            d.lit("\n");
            d.take(sql, start(w), stop(after(w).1));
        }
        if let Ok(dp) = plan_select(&d.text, engine, sample) {
            if let Some(ds) = dp.steps.iter().find(|s| s.key == "distinct") {
                let body = ds.sql.strip_prefix(prefix.as_str()).unwrap_or(&ds.sql);
                count_sql.push(format!("{prefix}SELECT COUNT(*) FROM (\n{body}\n) bt_step"));
            }
        }
    }
    count_sql.extend(last.count_sql.iter().cloned());

    let (range, kw, step_text) = match set_seg {
        Some((s_at, s_last)) => (
            [start(s_at), stop(s_last)],
            "UPDATE".to_string(),
            one_line(text(s_at + 1, s_last)),
        ),
        None => (
            [start(verb), stop(target.1)],
            "DELETE".to_string(),
            one_line(text(target.0, target.1)),
        ),
    };
    sub.steps.push(DebugStep {
        key: "write".into(),
        clause: "write".into(),
        kw,
        text: step_text,
        table: Some(target_table.clone()),
        range,
        sql: last.sql.clone(),
        count_sql,
        join: None,
        conds: None,
        has_or: false,
        aggregate: false,
        grouped: false,
        ordered: false,
        always_count: joined,
        notes: vec![StaticNote::DryRun],
    });
    sub.write = Some(WriteInfo {
        kind: if is_update { "update" } else { "delete" }.into(),
        target_sql,
        target: target_table.clone(),
        table: super::bare_name(&target_table),
        joined,
        preview,
    });
    Ok(sub)
}

/// The table an alias stands for in a FROM list (`… FROM orders o …` → `orders`
/// for `o`), or the name itself when it is a table there. Only relation
/// positions are read: the list's start, after a top-level comma, after JOIN.
fn resolve_alias(sql: &str, toks: &[Lexed], a: usize, b: usize, alias: &str) -> Option<String> {
    let want = alias.to_ascii_lowercase();
    let starts = std::iter::once(a).chain((a..b).filter_map(|i| {
        let t = &toks[i];
        let opens = t.depth == 0
            && (t.tok == Tok::Punct(',')
                || matches!(word(t), Some("join" | "apply" | "straight_join")));
        opens.then_some(i + 1)
    }));
    for rel in starts {
        if rel > b || !matches!(toks[rel].tok, Tok::Word(_) | Tok::Opaque) {
            continue;
        }
        let name = &sql[toks[rel].start..toks[rel].end];
        let (_, alias_at) = relation_extent(toks, rel, b);
        let matches = match alias_at {
            Some(k) => sql[toks[k].start..toks[k].end].eq_ignore_ascii_case(&want),
            None => {
                name.eq_ignore_ascii_case(&want)
                    || super::bare_name(name).eq_ignore_ascii_case(&want)
            }
        };
        if matches {
            return Some(name.to_string());
        }
    }
    None
}

/// The last part of a dotted name, quotes and all: `"main"."t"` → `"t"`.
fn last_part(name: &str) -> &str {
    let mut quote: Option<u8> = None;
    let mut cut = 0;
    for (i, c) in name.bytes().enumerate() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => {}
            None => match c {
                b'"' | b'`' => quote = Some(c),
                b'[' => quote = Some(b']'),
                b'.' => cut = i + 1,
                _ => {}
            },
        }
    }
    &name[cut..]
}
