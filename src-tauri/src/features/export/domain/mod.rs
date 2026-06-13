//! Domain types for the export slice (M15): the chosen output format and the
//! value formatters that mirror the export prototype's `csvVal` / `sqlVal`
//! (see `ByteTable_latest/bytetable/export.jsx`).
//!
//! These are pure functions over a JSON-mapped cell value (`fetch_rows` returns
//! `serde_json::Value`s — string / number / bool / null), with no engine, no
//! driver, and no I/O. The application layer pages rows through `fetch_rows`
//! and turns each cell into text with the helpers here.

use serde::{Deserialize, Serialize};

/// What `export_table` should produce. Lowercase on the wire (`"csv"` /
/// `"sql"`), matching the renderer's `ExportFormat` and the app's enum
/// convention (see `AppError::kind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    /// Comma-separated values: a header row of column names + one line per row.
    Csv,
    /// A SQL dump: the table's `CREATE TABLE` DDL + one `INSERT` per row.
    Sql,
}

/// Format one cell value for a CSV field, mirroring the prototype's `csvVal`:
///
/// - `null` → an empty field.
/// - everything else → its string form, quoted (and embedded `"` doubled) iff
///   it contains a quote, comma, or newline; otherwise emitted bare.
///
/// Numbers and booleans use their natural JSON string form (`42`, `true`),
/// which never needs quoting. Strings are quoted only when they contain a
/// CSV-special character — matching the prototype's `/[",\n]/` test.
pub fn csv_value(value: &serde_json::Value) -> String {
    let raw = match value {
        serde_json::Value::Null => return String::new(),
        other => json_scalar_to_string(other),
    };
    if raw.contains(['"', ',', '\n']) {
        format!("\"{}\"", raw.replace('"', "\"\""))
    } else {
        raw
    }
}

/// Format one cell value as a SQL literal, mirroring the prototype's `sqlVal`:
///
/// - `null` → `NULL`.
/// - bool → `true` / `false`.
/// - number → its raw JSON form (no quotes).
/// - string → `'…'` with every `'` doubled.
///
/// (A JSON value from `fetch_rows` is only ever string / number / bool / null;
/// arrays/objects do not occur, but if one ever did it is rendered as a quoted
/// string for safety rather than emitting bare structural text.)
pub fn sql_value(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Null => "NULL".to_string(),
        serde_json::Value::Bool(b) => {
            if *b {
                "true".to_string()
            } else {
                "false".to_string()
            }
        }
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::String(s) => format!("'{}'", s.replace('\'', "''")),
        // Defensive: a structural value (never produced by fetch_rows) is
        // single-quoted as its compact JSON text rather than emitted raw.
        other => format!("'{}'", other.to_string().replace('\'', "''")),
    }
}

/// The plain string form of a scalar JSON value for CSV (no quoting decision
/// here — that is `csv_value`'s job). Strings pass through verbatim; numbers
/// and bools use their JSON text; structural values use their compact JSON.
fn json_scalar_to_string(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Bool(b) => b.to_string(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::Null => String::new(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn export_format_is_lowercase_on_the_wire() {
        assert_eq!(serde_json::to_value(ExportFormat::Csv).unwrap(), "csv");
        assert_eq!(serde_json::to_value(ExportFormat::Sql).unwrap(), "sql");
        let back: ExportFormat = serde_json::from_value(json!("sql")).unwrap();
        assert_eq!(back, ExportFormat::Sql);
    }

    #[test]
    fn csv_value_null_is_empty() {
        assert_eq!(csv_value(&json!(null)), "");
    }

    #[test]
    fn csv_value_plain_values_are_unquoted() {
        assert_eq!(csv_value(&json!("hello")), "hello");
        assert_eq!(csv_value(&json!(42)), "42");
        assert_eq!(csv_value(&json!(3.5)), "3.5");
        assert_eq!(csv_value(&json!(true)), "true");
    }

    #[test]
    fn csv_value_quotes_and_escapes_comma_quote_newline() {
        // Comma → quoted.
        assert_eq!(csv_value(&json!("a,b")), "\"a,b\"");
        // Newline → quoted.
        assert_eq!(csv_value(&json!("line1\nline2")), "\"line1\nline2\"");
        // Embedded quote → quoted, with the quote doubled.
        assert_eq!(csv_value(&json!("say \"hi\"")), "\"say \"\"hi\"\"\"");
        // All three at once.
        assert_eq!(csv_value(&json!("a,\"b\"\nc")), "\"a,\"\"b\"\"\nc\"");
    }

    #[test]
    fn sql_value_null_bool_number() {
        assert_eq!(sql_value(&json!(null)), "NULL");
        assert_eq!(sql_value(&json!(true)), "true");
        assert_eq!(sql_value(&json!(false)), "false");
        assert_eq!(sql_value(&json!(42)), "42");
        assert_eq!(sql_value(&json!(-3.5)), "-3.5");
    }

    #[test]
    fn sql_value_string_is_single_quoted_with_apostrophes_doubled() {
        assert_eq!(sql_value(&json!("plain")), "'plain'");
        assert_eq!(sql_value(&json!("O'Brien")), "'O''Brien'");
        assert_eq!(sql_value(&json!("a'b'c")), "'a''b''c'");
        // A comma/newline in a SQL string needs no special handling (only the
        // apostrophe is special inside a single-quoted literal).
        assert_eq!(sql_value(&json!("a,b\nc")), "'a,b\nc'");
    }
}
