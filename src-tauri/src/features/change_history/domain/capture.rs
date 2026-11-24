//! How to record one statement (M48 A2–A4): read it, and decide what the
//! recorder must do around it. Pure — it never touches a database.
//!
//! The rows an UPDATE / DELETE will touch are read with the query debugger's
//! dry-run SELECT (the same slices of the user's text, with the target table's
//! columns only). An INSERT's new rows come back from the write itself:
//! `RETURNING *` (Postgres, SQLite), `OUTPUT inserted.*` (SQL Server), or —
//! MySQL has neither — one row found by its key afterwards. Anything that
//! cannot be captured faithfully is recorded as "can't undo", never guessed.

use crate::features::query_debug::domain as debug;
use crate::shared::engine::Engine;
use crate::shared::readonly::sql_is_read_only;
use crate::shared::sql_lex::{lex, Lexed, Tok};

use super::{Cant, Kind};

/// How the new rows of an INSERT are read back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InsertHow {
    /// Append ` RETURNING *` to the statement.
    Returning,
    /// Insert ` OUTPUT inserted.*` at this byte offset.
    Output { at: usize },
    /// MySQL, one row: read it back by its key — the auto-increment id
    /// (`LAST_INSERT_ID()`) or the key values written in the statement.
    MysqlSingle {
        columns: Option<Vec<String>>,
        values: Vec<String>,
    },
}

/// What the recorder does with a statement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Plan {
    /// Reads and session statements: run as they are, nothing recorded.
    Plain,
    Begin,
    Commit,
    Rollback,
    /// UPDATE / DELETE / TRUNCATE on one table: read `target_sql` (locked)
    /// before, run, read the same keys after.
    Rows {
        kind: Kind,
        verb: String,
        schema: Option<String>,
        table: String,
        target_sql: String,
    },
    Insert {
        verb: String,
        schema: Option<String>,
        table: String,
        how: InsertHow,
    },
    /// Listed, but cannot be undone.
    Cant {
        verb: String,
        reason: Cant,
        tables: Vec<String>,
    },
}

fn word(t: &Lexed) -> Option<&str> {
    match &t.tok {
        Tok::Word(w) => Some(w.as_str()),
        _ => None,
    }
}

/// Split a possibly-qualified name at its last unquoted dot, unquoting both
/// halves: `public."My Orders"` → (`Some("public")`, `My Orders`).
pub fn split_name(name: &str) -> (Option<String>, String) {
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
    let unq = |s: &str| {
        s.trim_matches(|c| matches!(c, '"' | '`' | '[' | ']'))
            .to_string()
    };
    match cut {
        Some(i) => (Some(unq(&name[..i])), unq(&name[i + 1..])),
        None => (None, unq(name)),
    }
}

/// Session and housekeeping statements: they change no rows worth recording.
const PLAIN_LEADERS: &[&str] = &[
    "set",
    "use",
    "reset",
    "discard",
    "savepoint",
    "release",
    "lock",
    "unlock",
    "analyze",
    "vacuum",
    "optimize",
    "checkpoint",
    "listen",
    "notify",
    "unlisten",
    "declare",
    "fetch",
    "close",
    "prepare",
    "deallocate",
    "pragma",
    "show",
    "explain",
    "describe",
    "desc",
];

const STRUCTURE_LEADERS: &[&str] = &[
    "create", "alter", "drop", "rename", "comment", "grant", "revoke",
];

pub fn analyze(sql: &str, engine: Engine) -> Plan {
    let toks = lex(sql);
    let top = |i: usize| toks.get(i).filter(|t| t.depth == 0).and_then(word);
    let Some(first) = toks.iter().position(|t| t.tok != Tok::Punct(';')) else {
        return Plan::Plain;
    };
    let lead = top(first).unwrap_or("");
    let verb_of = |w: &str| w.to_ascii_uppercase();
    match lead {
        "begin" | "start" => {
            // `BEGIN` / `START TRANSACTION`, but not a T-SQL `BEGIN … END` block.
            return if lead == "start"
                || matches!(
                    top(first + 1),
                    None | Some(
                        "transaction" | "tran" | "work" | "immediate" | "deferred" | "exclusive"
                    )
                ) {
                Plan::Begin
            } else {
                Plan::Cant {
                    verb: "BEGIN".into(),
                    reason: Cant::Unsupported,
                    tables: Vec::new(),
                }
            };
        }
        "commit" | "end" => return Plan::Commit,
        // `ROLLBACK TO SAVEPOINT` undoes part of a transaction, which the
        // recorder cannot follow; only a full ROLLBACK ends one.
        "rollback" | "abort" if top(first + 1) != Some("to") => return Plan::Rollback,
        // Part of a transaction the user is driving: run it, record nothing.
        "rollback" => return Plan::Plain,
        _ => {}
    }
    if PLAIN_LEADERS.contains(&lead) || sql_is_read_only(sql) {
        return Plan::Plain;
    }
    if STRUCTURE_LEADERS.contains(&lead) {
        return Plan::Cant {
            verb: verb_of(lead),
            reason: Cant::Structure,
            tables: Vec::new(),
        };
    }
    match lead {
        "truncate" => {
            let mut p = first + 1;
            if top(p) == Some("table") {
                p += 1;
            }
            let Some(t) = toks
                .get(p)
                .filter(|t| matches!(t.tok, Tok::Word(_) | Tok::Opaque))
            else {
                return Plan::Cant {
                    verb: "TRUNCATE".into(),
                    reason: Cant::Unsupported,
                    tables: Vec::new(),
                };
            };
            let written = &sql[t.start..t.end];
            // `TRUNCATE a, b` empties several tables at once.
            if toks.get(p + 1).is_some_and(|t| t.tok == Tok::Punct(',')) {
                return Plan::Cant {
                    verb: "TRUNCATE".into(),
                    reason: Cant::Multitable,
                    tables: Vec::new(),
                };
            }
            let (schema, table) = split_name(written);
            Plan::Rows {
                kind: Kind::Delete,
                verb: "TRUNCATE".into(),
                schema,
                table,
                target_sql: format!("SELECT * FROM {written}"),
            }
        }
        "update" | "delete" | "with" => update_or_delete(sql, engine, lead),
        "insert" => insert(sql, engine, &toks, first),
        "replace" | "merge" | "upsert" | "call" | "exec" | "execute" | "do" | "copy" | "load" => {
            Plan::Cant {
                verb: verb_of(lead),
                reason: Cant::Unsupported,
                tables: Vec::new(),
            }
        }
        _ => Plan::Cant {
            verb: verb_of(lead),
            reason: Cant::Unsupported,
            tables: Vec::new(),
        },
    }
}

fn update_or_delete(sql: &str, engine: Engine, lead: &str) -> Plan {
    let verb = lead.to_ascii_uppercase();
    match debug::plan(sql, engine, None) {
        Ok(p) => match p.write {
            Some(w) if w.joined => Plan::Cant {
                verb: w.kind.to_ascii_uppercase(),
                reason: Cant::Multitable,
                tables: vec![w.table],
            },
            Some(w) => {
                let (schema, table) = split_name(&w.target);
                Plan::Rows {
                    kind: if w.kind == "update" {
                        Kind::Update
                    } else {
                        Kind::Delete
                    },
                    verb: w.kind.to_ascii_uppercase(),
                    schema,
                    table,
                    target_sql: w.target_sql,
                }
            }
            // A WITH … SELECT that is not read-only (a data-modifying CTE).
            None => Plan::Cant {
                verb,
                reason: Cant::Unsupported,
                tables: Vec::new(),
            },
        },
        Err(debug::CannotDebug::MultipleTargets) => Plan::Cant {
            verb,
            reason: Cant::Multitable,
            tables: Vec::new(),
        },
        Err(_) => Plan::Cant {
            verb,
            reason: Cant::Unsupported,
            tables: Vec::new(),
        },
    }
}

fn insert(sql: &str, engine: Engine, toks: &[Lexed], first: usize) -> Plan {
    let top = |i: usize| toks.get(i).filter(|t| t.depth == 0).and_then(word);
    let cant = |reason| Plan::Cant {
        verb: "INSERT".into(),
        reason,
        tables: Vec::new(),
    };
    let mut p = first + 1;
    while matches!(
        top(p),
        Some("ignore" | "low_priority" | "delayed" | "high_priority")
    ) {
        p += 1;
    }
    if top(p) == Some("into") {
        p += 1;
    }
    let Some(t) = toks
        .get(p)
        .filter(|t| t.depth == 0 && matches!(t.tok, Tok::Word(_) | Tok::Opaque))
    else {
        return cant(Cant::Unsupported);
    };
    let (schema, table) = split_name(&sql[t.start..t.end]);
    let after_table = p + 1;
    // Upserts change existing rows as well as adding them, and a RETURNING the
    // user wrote already shapes the result: neither can be captured honestly.
    let words: Vec<&str> = (after_table..toks.len()).filter_map(top).collect();
    let upsert = words
        .windows(2)
        .any(|w| w[0] == "on" && matches!(w[1], "conflict" | "duplicate"));
    if upsert || words.contains(&"returning") || words.contains(&"output") {
        return cant(Cant::Unsupported);
    }
    // The column list, if written.
    let mut q = after_table;
    let mut columns = None;
    if toks.get(q).map(|t| &t.tok) == Some(&Tok::Punct('(')) {
        let close =
            (q + 1..toks.len()).find(|&i| toks[i].depth == 0 && toks[i].tok == Tok::Punct(')'));
        let Some(close) = close else {
            return cant(Cant::Unsupported);
        };
        columns = Some(
            (q + 1..close)
                .filter(|&i| matches!(toks[i].tok, Tok::Word(_) | Tok::Opaque))
                .map(|i| split_name(&sql[toks[i].start..toks[i].end]).1)
                .collect::<Vec<_>>(),
        );
        q = close + 1;
    }
    let how = match engine {
        Engine::Postgres | Engine::Sqlite => InsertHow::Returning,
        Engine::Mssql => match toks.get(q) {
            Some(t) if t.depth == 0 => InsertHow::Output { at: t.start },
            _ => return cant(Cant::Unsupported),
        },
        Engine::Mysql => {
            // Exactly one VALUES tuple; anything else (several rows, a SELECT)
            // has no way to say which rows it added.
            if top(q) != Some("values") && top(q) != Some("value") {
                return cant(Cant::Unsupported);
            }
            let open = q + 1;
            if toks.get(open).map(|t| &t.tok) != Some(&Tok::Punct('(')) {
                return cant(Cant::Unsupported);
            }
            let close = (open + 1..toks.len())
                .find(|&i| toks[i].depth == 0 && toks[i].tok == Tok::Punct(')'));
            let Some(close) = close else {
                return cant(Cant::Unsupported);
            };
            if toks
                .get(close + 1)
                .is_some_and(|t| t.tok == Tok::Punct(','))
            {
                return cant(Cant::Unsupported);
            }
            // The tuple's values as written, split on its top-level commas.
            let inner = toks[open].depth + 1;
            let mut values = Vec::new();
            let mut from = open + 1;
            for i in open + 1..=close {
                if i == close || (toks[i].depth == inner && toks[i].tok == Tok::Punct(',')) {
                    if i > from {
                        values.push(sql[toks[from].start..toks[i - 1].end].to_string());
                    }
                    from = i + 1;
                }
            }
            InsertHow::MysqlSingle { columns, values }
        }
        _ => return cant(Cant::Unsupported),
    };
    Plan::Insert {
        verb: "INSERT".into(),
        schema,
        table,
        how,
    }
}

/// The INSERT with its new rows coming back (`RETURNING` / `OUTPUT`).
pub fn with_returning(sql: &str, how: &InsertHow) -> String {
    // Trimmed at the END only: `at` is an offset into the text as written.
    let body = sql.trim_end().trim_end_matches(';').trim_end();
    match how {
        InsertHow::Returning => format!("{body} RETURNING *"),
        InsertHow::Output { at } => {
            format!(
                "{} OUTPUT inserted.* {}",
                body[..*at].trim_end(),
                &body[*at..]
            )
        }
        InsertHow::MysqlSingle { .. } => body.to_string(),
    }
}
