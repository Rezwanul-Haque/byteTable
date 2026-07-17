//! SQLite driver-error → AppError mapping, message humanising, and value
//! rendering (`value_to_json`). Engine-private.

use rusqlite::types::ValueRef;
use rusqlite::Connection;

use crate::shared::error::AppError;

use super::introspect::schema_names;
use super::sql::quote_ident;

/// JavaScript's `Number.MAX_SAFE_INTEGER` (2^53 − 1). SQLite integers whose
/// magnitude exceeds this serialize as JSON *strings* — a JSON number would
/// silently lose precision the moment the renderer parses it into a `number`.
const JS_MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// SQLite value → JSON. Blobs become hex or a `"[N bytes]"` placeholder (see
/// module docs); non-finite reals become null (JSON has no NaN/Infinity);
/// integers beyond ±[`JS_MAX_SAFE_INTEGER`] become decimal strings so the
/// renderer never rounds them (see `QueryResult::rows` in `shared::engine`).
pub(super) fn value_to_json(value: ValueRef<'_>) -> serde_json::Value {
    match value {
        ValueRef::Null => serde_json::Value::Null,
        ValueRef::Integer(i) if i.unsigned_abs() <= JS_MAX_SAFE_INTEGER as u64 => {
            serde_json::Value::from(i)
        }
        ValueRef::Integer(i) => serde_json::Value::String(i.to_string()),
        ValueRef::Real(f) => serde_json::Number::from_f64(f)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        ValueRef::Text(bytes) => {
            serde_json::Value::String(String::from_utf8_lossy(bytes).into_owned())
        }
        // Blobs: hex when small (UUID/key), `[N bytes]` placeholder when large.
        // Shared with MySQL/Postgres so binary renders identically everywhere.
        ValueRef::Blob(bytes) => crate::shared::engine::binary_to_json(bytes),
    }
}

/// The bare driver message, without rusqlite's error-chain wrapping.
pub(super) fn driver_message(err: &rusqlite::Error) -> String {
    match err {
        rusqlite::Error::SqliteFailure(_, Some(message)) => message.clone(),
        other => other.to_string(),
    }
}

/// Map a query-time driver error to a §5-style human message.
///
/// Best effort: "no such table" gets the available-tables suffix, "no such
/// column" passes through cleaned, everything else is the driver message
/// capitalized — never a Rust error chain.
pub(super) fn map_query_error(conn: &Connection, err: rusqlite::Error) -> AppError {
    let raw = driver_message(&err);
    if let Some(table) = raw.strip_prefix("no such table: ") {
        return missing_table_error(conn, strip_location_suffix(table));
    }
    if let Some(column) = raw.strip_prefix("no such column: ") {
        return AppError::Database(format!(
            "Column '{}' does not exist.",
            strip_location_suffix(column)
        ));
    }
    AppError::Database(humanize(&raw))
}

/// The §5 unknown-table message, with the "available tables" listing.
pub(super) fn missing_table_error(conn: &Connection, table: &str) -> AppError {
    let tables = all_table_names(conn);
    let listing = if tables.is_empty() {
        "(none)".to_string()
    } else {
        tables.join(", ")
    };
    AppError::Database(format!(
        "Table '{table}' does not exist. Available tables: {listing}."
    ))
}

/// Newer SQLite appends ` in <sql> at offset N` to "no such …" messages;
/// drop it so only the offending name remains.
fn strip_location_suffix(name: &str) -> &str {
    match name.find(" in ") {
        Some(index) => &name[..index],
        None => name,
    }
}

/// Every user table across all schemas, for "available tables" listings.
/// Attached-schema tables are qualified (`aux.users`); failures are skipped
/// — this only feeds an error message.
fn all_table_names(conn: &Connection) -> Vec<String> {
    let Ok(schemas) = schema_names(conn) else {
        return Vec::new();
    };
    let mut names = Vec::new();
    for schema in schemas {
        let sql = format!(
            "SELECT name FROM {}.sqlite_schema \
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
            quote_ident(&schema)
        );
        let Ok(mut stmt) = conn.prepare(&sql) else {
            continue;
        };
        let Ok(rows) = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .and_then(Iterator::collect::<Result<Vec<String>, _>>)
        else {
            continue;
        };
        for name in rows {
            if schema == "main" {
                names.push(name);
            } else {
                names.push(format!("{schema}.{name}"));
            }
        }
    }
    names
}

/// Capitalize the first letter and ensure a trailing period.
fn humanize(message: &str) -> String {
    let trimmed = message.trim();
    let mut chars = trimmed.chars();
    let capitalized = match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => "The database reported an unknown error".to_string(),
    };
    if capitalized.ends_with(['.', '!', '?']) {
        capitalized
    } else {
        format!("{capitalized}.")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn value_to_json_switches_to_strings_exactly_past_the_safe_boundary() {
        let safe = JS_MAX_SAFE_INTEGER;
        assert_eq!(
            value_to_json(ValueRef::Integer(safe)),
            serde_json::json!(9_007_199_254_740_991_i64)
        );
        assert_eq!(
            value_to_json(ValueRef::Integer(-safe)),
            serde_json::json!(-9_007_199_254_740_991_i64)
        );
        assert_eq!(
            value_to_json(ValueRef::Integer(safe + 1)),
            serde_json::json!("9007199254740992")
        );
        assert_eq!(
            value_to_json(ValueRef::Integer(-safe - 1)),
            serde_json::json!("-9007199254740992")
        );
    }

    #[test]
    fn humanize_capitalizes_and_punctuates() {
        assert_eq!(
            humanize("near \"x\": syntax error"),
            "Near \"x\": syntax error."
        );
        assert_eq!(humanize("Already done."), "Already done.");
    }
}
