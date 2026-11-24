//! A SQL lexer just deep enough to find clauses.
//!
//! Comments, string literals and quoted identifiers become inert, and every
//! token records its paren depth, so a keyword inside a subquery, a string or a
//! comment is never mistaken for one of the outer statement's clauses. It is
//! deliberately not a parser: callers slice the statement the user wrote at the
//! offsets it reports, so quoting, aliases and vendor syntax survive verbatim.
//!
//! Shared by the explain slice (row-count probes) and the query debugger (step
//! queries).

/// One lexical unit. Only what the scan needs to tell apart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Tok {
    Word(String),
    Punct(char),
    /// A string literal or quoted identifier — inert, but it holds a position.
    Opaque,
}

pub struct Lexed {
    pub tok: Tok,
    pub start: usize,
    pub end: usize,
    pub depth: usize,
}

/// Lex far enough to find clauses: comments and quoted text become inert, and
/// every token records its paren depth so only top-level keywords count.
pub fn lex(sql: &str) -> Vec<Lexed> {
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
            // A quoted identifier that starts a dotted path (`"main"."orders"`,
            // `[dbo].[t]`, `"s".t`) is one unit, like `public.orders` below.
            if close != b'\'' {
                while bytes.get(i) == Some(&b'.') {
                    let n = bytes.get(i + 1).copied().unwrap_or(0);
                    if matches!(n, b'"' | b'`' | b'[') {
                        let close = if n == b'[' { b']' } else { n };
                        i += 2;
                        while i < bytes.len() && bytes[i] != close {
                            i += 1;
                        }
                        i = (i + 1).min(bytes.len());
                    } else if n.is_ascii_alphabetic() || n == b'_' || n >= 0x80 {
                        i += 1;
                        while i < bytes.len()
                            && (bytes[i].is_ascii_alphanumeric()
                                || bytes[i] == b'_'
                                || bytes[i] == b'$'
                                || bytes[i] >= 0x80)
                        {
                            i += 1;
                        }
                    } else {
                        break;
                    }
                }
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
