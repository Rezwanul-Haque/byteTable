//! Locating the clauses of a SELECT well enough to count its rows.
//!
//! The Explain panel's "Rows read" and "Selectivity" are the one pair of
//! figures no plan can supply: a planner reports *estimates*, and the whole
//! point of those two is that they are exact. Getting them means counting —
//! `SELECT COUNT(*) FROM <the same source>`, with and without the filter.
//!
//! The probes are built by **slicing the statement the user wrote**, never by
//! re-rendering it: aliases, schema qualification, quoting and vendor syntax
//! then come out exactly right, and this module never has to quote an
//! identifier or know a dialect. It only has to find where the FROM clause
//! starts and where it and the WHERE predicate end.
//!
//! Deliberately not a SQL parser. It skips over comments, string literals and
//! quoted identifiers so a keyword inside one is never mistaken for a clause,
//! and it only recognises keywords at paren depth 0 so a subquery cannot be
//! mistaken for the outer statement. Anything it cannot make sense of yields
//! `None`, and the panel simply shows no row counts.

/// The two statements that count what the base relation read and what survived
/// its filter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CountProbes {
    /// `SELECT COUNT(*) FROM <base relation and alias>`.
    pub scanned: String,
    /// The same with the WHERE predicate appended.
    ///
    /// `None` when there is no WHERE, and — deliberately — when the statement
    /// joins: the predicate may then address a relation the base probe does not
    /// select from, so the count would be wrong or the statement invalid.
    pub kept: Option<String>,
}

/// Build the count probes for `sql`, or `None` if it has no readable FROM.
pub fn count_probes(sql: &str) -> Option<CountProbes> {
    let extent = clause_extent(sql)?;
    let source = sql.get(extent.from_start..extent.base_end)?.trim();
    if source.is_empty() {
        return None;
    }
    let kept = match (extent.where_end, extent.has_join) {
        (Some(end), false) => sql
            .get(extent.from_start..end)
            .map(|s| format!("SELECT COUNT(*) {}", s.trim())),
        _ => None,
    };
    Some(CountProbes {
        scanned: format!("SELECT COUNT(*) {source}"),
        kept,
    })
}

/// Byte offsets of the parts of a SELECT the probes need.
#[derive(Debug, PartialEq, Eq)]
struct ClauseExtent {
    /// Start of the `FROM` keyword.
    from_start: usize,
    /// End of the base relation and its alias, before any JOIN.
    base_end: usize,
    /// End of the WHERE predicate, when there is one.
    where_end: Option<usize>,
    /// Whether a JOIN follows the base relation.
    has_join: bool,
}

/// One lexical unit. Only what the scan needs to tell apart.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Tok {
    Word(String),
    Punct(char),
    /// A string literal or quoted identifier — inert, but it holds a position.
    Opaque,
}

struct Lexed {
    tok: Tok,
    start: usize,
    end: usize,
    depth: usize,
}

/// Clause keywords that end the WHERE predicate at the top level.
const CLAUSE_END: &[&str] = &[
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
];

/// Words that introduce a join, so a bare one is never read as an alias.
const JOIN_INTRO: &[&str] = &[
    "join",
    "inner",
    "left",
    "right",
    "full",
    "cross",
    "natural",
    "straight_join",
];

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
    "as",
];

fn clause_extent(sql: &str) -> Option<ClauseExtent> {
    let toks = lex(sql);
    let word_at = |i: usize| match toks.get(i) {
        Some(Lexed {
            tok: Tok::Word(w),
            depth: 0,
            ..
        }) => Some(w.as_str()),
        _ => None,
    };
    let is = |i: usize, kw: &str| word_at(i) == Some(kw);

    // The outer FROM: the first one at depth 0. A subquery's FROM is deeper, and
    // a `FROM` inside a string or comment never became a token at all.
    let from = (0..toks.len()).find(|&i| is(i, "from"))?;
    let from_start = toks[from].start;

    let mut p = from + 1;
    // The relation: a parenthesised derived table, or a name.
    match toks.get(p) {
        Some(Lexed {
            tok: Tok::Punct('('),
            ..
        }) => {
            let mut depth = 1;
            p += 1;
            while p < toks.len() && depth > 0 {
                match toks[p].tok {
                    Tok::Punct('(') => depth += 1,
                    Tok::Punct(')') => depth -= 1,
                    _ => {}
                }
                p += 1;
            }
        }
        Some(Lexed {
            tok: Tok::Word(_), ..
        }) => p += 1,
        // A quoted relation name is opaque to us but still one unit.
        Some(Lexed {
            tok: Tok::Opaque, ..
        }) => p += 1,
        _ => return None,
    }

    // An optional alias: `AS x`, or a bare word that is not a clause keyword.
    if is(p, "as") {
        p += 2;
    } else if let Some(word) = word_at(p) {
        if !NOT_AN_ALIAS.contains(&word) {
            p += 1;
        }
    }
    let base_end = toks.get(p.saturating_sub(1)).map(|t| t.end)?;

    let has_join = word_at(p).is_some_and(|w| JOIN_INTRO.contains(&w));

    // The WHERE predicate, if this statement has one at the top level.
    let where_end = (p..toks.len()).find(|&i| is(i, "where")).map(|w| {
        let end = (w + 1..toks.len())
            .find(|&i| {
                word_at(i).is_some_and(|word| CLAUSE_END.contains(&word))
                    || matches!(
                        toks.get(i),
                        Some(Lexed {
                            tok: Tok::Punct(';'),
                            depth: 0,
                            ..
                        })
                    )
            })
            .unwrap_or(toks.len());
        toks[end - 1].end
    });

    Some(ClauseExtent {
        from_start,
        base_end,
        where_end,
        has_join,
    })
}

/// Lex far enough to find clauses: comments and quoted text become inert, and
/// every token records its paren depth so only top-level keywords count.
fn lex(sql: &str) -> Vec<Lexed> {
    let bytes = sql.as_bytes();
    let mut out = Vec::new();
    let mut depth = 0usize;
    let mut i = 0usize;

    while i < bytes.len() {
        let c = bytes[i];
        // Whitespace.
        if c.is_ascii_whitespace() {
            i += 1;
            continue;
        }
        // `-- line comment`
        if c == b'-' && bytes.get(i + 1) == Some(&b'-') {
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        // `/* block comment */`
        if c == b'/' && bytes.get(i + 1) == Some(&b'*') {
            i += 2;
            while i < bytes.len() && !(bytes[i] == b'*' && bytes.get(i + 1) == Some(&b'/')) {
                i += 1;
            }
            i = (i + 2).min(bytes.len());
            continue;
        }
        // String literal / quoted identifier — inert, doubled quote escapes.
        if let Some(close) = match c {
            b'\'' => Some(b'\''),
            b'"' => Some(b'"'),
            b'`' => Some(b'`'),
            b'[' => Some(b']'),
            _ => None,
        } {
            let start = i;
            i += 1;
            while i < bytes.len() {
                if bytes[i] == close {
                    if close != b']' && bytes.get(i + 1) == Some(&close) {
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                i += 1;
            }
            out.push(Lexed {
                tok: Tok::Opaque,
                start,
                end: i,
                depth,
            });
            continue;
        }
        // A word, possibly a dotted path — `public.orders` is one unit.
        // Bytes at or above 0x80 are the continuation of a multi-byte character
        // and belong to the word: identifiers are not ASCII-only, and stepping
        // over one byte at a time would land mid-character and panic on slice.
        if c.is_ascii_alphabetic() || c == b'_' || c >= 0x80 {
            let start = i;
            while i < bytes.len() {
                let ch = bytes[i];
                if ch.is_ascii_alphanumeric()
                    || ch == b'_'
                    || ch == b'$'
                    || ch == b'.'
                    || ch >= 0x80
                {
                    i += 1;
                } else if ch == b'"' || ch == b'`' || ch == b'[' {
                    // A quoted part of a dotted path (`public."my table"`).
                    let close = if ch == b'[' { b']' } else { ch };
                    i += 1;
                    while i < bytes.len() && bytes[i] != close {
                        i += 1;
                    }
                    i = (i + 1).min(bytes.len());
                } else {
                    break;
                }
            }
            let word = sql[start..i].to_ascii_lowercase();
            out.push(Lexed {
                tok: Tok::Word(word),
                start,
                end: i,
                depth,
            });
            continue;
        }
        // Punctuation. Parens carry the OUTER depth so a `(` reads as top-level.
        let start = i;
        if c == b'(' {
            out.push(Lexed {
                tok: Tok::Punct('('),
                start,
                end: i + 1,
                depth,
            });
            depth += 1;
        } else if c == b')' {
            depth = depth.saturating_sub(1);
            out.push(Lexed {
                tok: Tok::Punct(')'),
                start,
                end: i + 1,
                depth,
            });
        } else {
            out.push(Lexed {
                tok: Tok::Punct(c as char),
                start,
                end: i + 1,
                depth,
            });
        }
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn probes(sql: &str) -> CountProbes {
        count_probes(sql).unwrap_or_else(|| panic!("no probes for {sql}"))
    }

    #[test]
    fn slices_the_from_clause_rather_than_rebuilding_it() {
        let p = probes("SELECT a, b FROM orders WHERE total > 10");
        assert_eq!(p.scanned, "SELECT COUNT(*) FROM orders");
        assert_eq!(
            p.kept.as_deref(),
            Some("SELECT COUNT(*) FROM orders WHERE total > 10")
        );
    }

    /// The reason for slicing: aliases, schema qualification and quoting come
    /// out exactly as written, with no identifier quoting of our own.
    #[test]
    fn preserves_aliases_qualification_and_quoting_verbatim() {
        let p = probes(r#"SELECT o.id FROM public."my orders" AS o WHERE o.total > 1"#);
        assert_eq!(p.scanned, r#"SELECT COUNT(*) FROM public."my orders" AS o"#);
        assert_eq!(
            p.kept.as_deref(),
            Some(r#"SELECT COUNT(*) FROM public."my orders" AS o WHERE o.total > 1"#)
        );
        assert_eq!(
            probes("SELECT * FROM `weird table` t").scanned,
            "SELECT COUNT(*) FROM `weird table` t"
        );
    }

    #[test]
    fn stops_the_base_probe_before_a_join_and_skips_the_filtered_one() {
        // The predicate may address either side of the join, so counting it
        // against the base relation alone would be wrong or invalid.
        let p = probes("SELECT * FROM orders o JOIN users u ON u.id = o.user_id WHERE u.active");
        assert_eq!(p.scanned, "SELECT COUNT(*) FROM orders o");
        assert_eq!(p.kept, None);
        assert_eq!(
            probes("SELECT * FROM a LEFT OUTER JOIN b ON b.id = a.id").scanned,
            "SELECT COUNT(*) FROM a"
        );
    }

    #[test]
    fn ends_the_predicate_at_the_next_top_level_clause() {
        for (sql, expected) in [
            (
                "SELECT s FROM t WHERE a = 1 GROUP BY s",
                "SELECT COUNT(*) FROM t WHERE a = 1",
            ),
            (
                "SELECT s FROM t WHERE a = 1 ORDER BY s LIMIT 5",
                "SELECT COUNT(*) FROM t WHERE a = 1",
            ),
            (
                "SELECT s FROM t WHERE a = 1;",
                "SELECT COUNT(*) FROM t WHERE a = 1",
            ),
        ] {
            assert_eq!(probes(sql).kept.as_deref(), Some(expected), "for {sql}");
        }
    }

    /// A keyword inside a subquery, a string or a comment must never be read as
    /// the outer statement's.
    #[test]
    fn ignores_keywords_that_are_not_really_clauses() {
        let nested = probes("SELECT id FROM orders WHERE id IN (SELECT id FROM users WHERE x)");
        assert_eq!(nested.scanned, "SELECT COUNT(*) FROM orders");
        assert_eq!(
            nested.kept.as_deref(),
            Some("SELECT COUNT(*) FROM orders WHERE id IN (SELECT id FROM users WHERE x)")
        );

        let quoted = probes("SELECT a FROM t WHERE b = 'from where group by'");
        assert_eq!(
            quoted.kept.as_deref(),
            Some("SELECT COUNT(*) FROM t WHERE b = 'from where group by'")
        );

        let commented = probes("SELECT a -- from elsewhere\nFROM t WHERE b = 1");
        assert_eq!(commented.scanned, "SELECT COUNT(*) FROM t");
        let block = probes("SELECT a /* FROM nope */ FROM t");
        assert_eq!(block.scanned, "SELECT COUNT(*) FROM t");
    }

    #[test]
    fn counts_a_derived_table_by_wrapping_it_whole() {
        let p = probes("SELECT s.x FROM (SELECT x FROM t GROUP BY x) s ORDER BY s.x");
        assert_eq!(
            p.scanned,
            "SELECT COUNT(*) FROM (SELECT x FROM t GROUP BY x) s"
        );
        assert_eq!(p.kept, None);
    }

    #[test]
    fn a_bare_clause_keyword_is_never_taken_for_an_alias() {
        assert_eq!(
            probes("SELECT * FROM orders WHERE id = 1").scanned,
            "SELECT COUNT(*) FROM orders"
        );
        assert_eq!(
            probes("SELECT * FROM orders ORDER BY id").scanned,
            "SELECT COUNT(*) FROM orders"
        );
        assert_eq!(
            probes("SELECT * FROM orders LIMIT 5").scanned,
            "SELECT COUNT(*) FROM orders"
        );
    }

    #[test]
    fn statements_without_a_readable_from_yield_nothing() {
        assert_eq!(count_probes("SELECT 1"), None);
        assert_eq!(count_probes(""), None);
        assert_eq!(count_probes("UPDATE t SET a = 1"), None);
        // `FROM` with nothing after it.
        assert_eq!(count_probes("SELECT a FROM"), None);
    }

    /// Byte offsets must land on character boundaries, or slicing panics.
    #[test]
    fn survives_multibyte_text() {
        let p = probes("SELECT naïve FROM café c WHERE naïve = 'niño'");
        assert_eq!(p.scanned, "SELECT COUNT(*) FROM café c");
        assert_eq!(
            p.kept.as_deref(),
            Some("SELECT COUNT(*) FROM café c WHERE naïve = 'niño'")
        );
    }
}
