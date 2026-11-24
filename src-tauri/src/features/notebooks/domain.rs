//! What a notebook cell's statement does, which decides how it may run:
//! a read runs on Run and on Run all; a write runs only from its own cell
//! after a confirmation; transaction control is never run from a notebook.

use serde::Serialize;

use crate::shared::readonly::sql_is_read_only;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StatementKind {
    Read,
    Write,
    /// BEGIN / COMMIT / ROLLBACK and friends. A notebook runs each cell on
    /// whatever pooled connection is free, so it cannot hold a transaction.
    Transaction,
}

/// Leading keywords of transaction control.
const TRANSACTION_LEADERS: &[&str] = &[
    "begin",
    "start",
    "commit",
    "rollback",
    "end",
    "abort",
    "savepoint",
    "release",
];

/// The first word of `sql`, lowercased, skipping comments.
fn leader(sql: &str) -> Option<String> {
    let mut rest = sql.trim_start();
    loop {
        if let Some(r) = rest.strip_prefix("--") {
            rest = r
                .split_once('\n')
                .map_or("", |(_, after)| after)
                .trim_start();
        } else if let Some(r) = rest.strip_prefix("/*") {
            rest = r
                .split_once("*/")
                .map_or("", |(_, after)| after)
                .trim_start();
        } else {
            break;
        }
    }
    let word: String = rest
        .chars()
        .take_while(|c| c.is_ascii_alphabetic() || *c == '_')
        .collect();
    (!word.is_empty()).then(|| word.to_ascii_lowercase())
}

/// Classify one cell's SQL. Any statement in it that writes makes it a write;
/// a cell that opens with transaction control is that.
pub fn classify(sql: &str) -> StatementKind {
    if leader(sql).is_some_and(|w| TRANSACTION_LEADERS.contains(&w.as_str())) {
        return StatementKind::Transaction;
    }
    if sql_is_read_only(sql) {
        StatementKind::Read
    } else {
        StatementKind::Write
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_writes_and_transaction_control() {
        assert_eq!(classify("SELECT * FROM orders"), StatementKind::Read);
        assert_eq!(
            classify("  -- note\nWITH x AS (SELECT 1) SELECT * FROM x"),
            StatementKind::Read
        );
        assert_eq!(
            classify("UPDATE orders SET status = 'x'"),
            StatementKind::Write
        );
        assert_eq!(classify("DELETE FROM t"), StatementKind::Write);
        assert_eq!(classify("CREATE TABLE t (id int)"), StatementKind::Write);
        assert_eq!(classify("SELECT 1; DROP TABLE t"), StatementKind::Write);
        for sql in [
            "BEGIN",
            "begin;",
            "START TRANSACTION",
            "COMMIT",
            "ROLLBACK",
            "/* c */ END",
        ] {
            assert_eq!(classify(sql), StatementKind::Transaction, "{sql}");
        }
    }

    #[test]
    fn a_keyword_inside_a_string_is_not_a_write() {
        assert_eq!(
            classify("SELECT * FROM audit WHERE action = 'delete'"),
            StatementKind::Read
        );
    }
}
