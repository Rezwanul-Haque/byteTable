// SQL-script text utilities: statement counting + splitting for import /
// execute-script, and the [`ImportResult`] count DTO. Engine-agnostic, quote /
// comment-aware — NOT a full SQL tokenizer.

use serde::{Deserialize, Serialize};

/// The outcome of an [`EngineConnection::execute_script`] call (M15 import):
/// the number of top-level SQL statements that were executed.
///
/// `statements` is a best-effort count derived by splitting the script on
/// statement-terminating `;` outside string literals and comments (see
/// [`count_statements`]) — it is the same count the success toast shows
/// ("Imported {file} — {N} statements"). For an atomic engine (SQLite in a
/// transaction, Postgres's implicit BEGIN/COMMIT) all `statements` ran or none
/// did; for MySQL (DDL auto-commits) a mid-script failure leaves the statements
/// before the failure already applied — the §5 error names how far it got.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    /// Top-level statements executed by the script (best-effort count).
    pub statements: u64,
}

/// Count the top-level SQL statements in a dump for [`ImportResult::statements`]
/// — a best-effort, engine-agnostic parse, NOT a full SQL tokenizer.
///
/// A statement boundary is a `;` that is NOT inside a string/identifier literal
/// or a comment. We track: single-quoted (`'…'`) and double-quoted (`"…"`)
/// literals with doubled-quote escaping (`''` / `""` stay inside the literal);
/// backtick-quoted identifiers (MySQL); `--` line comments (to end of line);
/// and `/* … */` block comments. A trailing fragment with no terminating `;`
/// (e.g. a final statement the dump left unterminated) still counts as one
/// statement when it contains non-whitespace, non-comment text.
///
/// This intentionally does not understand dollar-quoting (`$$…$$`) or other
/// engine-specific quoting; for the CREATE TABLE + INSERT dumps ByteTable's own
/// export produces (and ordinary hand-written scripts) it is accurate, and a
/// miscount only affects the cosmetic toast number, never correctness.
pub fn count_statements(script: &str) -> u64 {
    let bytes = script.as_bytes();
    let mut i = 0usize;
    let len = bytes.len();
    let mut count: u64 = 0;
    // Whether the current statement has any meaningful (non-whitespace,
    // non-comment) content yet — so empty segments between `;`s don't count.
    let mut has_content = false;

    while i < len {
        let c = bytes[i];
        match c {
            b'\'' | b'"' | b'`' => {
                // Consume a quoted literal/identifier, honouring doubled-quote
                // escaping (`''` inside a '…' literal is an escaped quote).
                let quote = c;
                has_content = true;
                i += 1;
                while i < len {
                    if bytes[i] == quote {
                        if i + 1 < len && bytes[i + 1] == quote {
                            i += 2; // doubled quote → stays inside
                            continue;
                        }
                        i += 1; // closing quote
                        break;
                    }
                    i += 1;
                }
            }
            b'-' if i + 1 < len && bytes[i + 1] == b'-' => {
                // Line comment to end of line.
                i += 2;
                while i < len && bytes[i] != b'\n' {
                    i += 1;
                }
            }
            b'/' if i + 1 < len && bytes[i + 1] == b'*' => {
                // Block comment to the closing `*/`.
                i += 2;
                while i + 1 < len && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                    i += 1;
                }
                i += 2; // skip the closing `*/` (or run off the end harmlessly)
            }
            b';' => {
                if has_content {
                    count += 1;
                }
                has_content = false;
                i += 1;
            }
            other => {
                if !other.is_ascii_whitespace() {
                    has_content = true;
                }
                i += 1;
            }
        }
    }
    // A trailing un-terminated statement with real content still counts.
    if has_content {
        count += 1;
    }
    count
}

/// Split a multi-statement SQL script into its individual statements, using the
/// same quote/comment-aware scan as [`count_statements`]. Each returned string
/// is one statement WITHOUT its trailing `;` (trimmed of surrounding
/// whitespace); empty / comment-only segments are dropped, so
/// `split_statements(s).len() == count_statements(s)`.
///
/// Used by the MySQL adapter, which executes a dump statement-by-statement (its
/// DDL auto-commits, so it tracks exactly how far it got on a mid-script
/// failure). The same best-effort caveats as [`count_statements`] apply.
pub fn split_statements(script: &str) -> Vec<String> {
    let bytes = script.as_bytes();
    let mut i = 0usize;
    let len = bytes.len();
    let mut statements: Vec<String> = Vec::new();
    let mut start = 0usize;

    // Keep a segment only if it carries real (non-whitespace, non-comment)
    // content — exactly the predicate `count_statements` uses — so that
    // `split_statements(s).len() == count_statements(s)`.
    let push = |statements: &mut Vec<String>, slice: &str| {
        if count_statements(slice) > 0 {
            statements.push(slice.trim().to_string());
        }
    };

    while i < len {
        let c = bytes[i];
        match c {
            b'\'' | b'"' | b'`' => {
                let quote = c;
                i += 1;
                while i < len {
                    if bytes[i] == quote {
                        if i + 1 < len && bytes[i + 1] == quote {
                            i += 2;
                            continue;
                        }
                        i += 1;
                        break;
                    }
                    i += 1;
                }
            }
            b'-' if i + 1 < len && bytes[i + 1] == b'-' => {
                i += 2;
                while i < len && bytes[i] != b'\n' {
                    i += 1;
                }
            }
            b'/' if i + 1 < len && bytes[i + 1] == b'*' => {
                i += 2;
                while i + 1 < len && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                    i += 1;
                }
                i += 2;
            }
            b';' => {
                // `start..i` is the statement body (the slice is valid UTF-8
                // because we only ever split on ASCII bytes outside literals).
                push(&mut statements, &script[start.min(len)..i.min(len)]);
                i += 1;
                start = i;
            }
            _ => i += 1,
        }
    }
    if start < len {
        push(&mut statements, &script[start..]);
    }
    statements
}
