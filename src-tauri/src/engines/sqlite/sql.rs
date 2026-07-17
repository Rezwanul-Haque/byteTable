//! SQLite SQL dialect: identifier quoting, WHERE/ORDER building, LIKE
//! escaping, and JSON↔SQL value mapping. Engine-private; no port equivalent.

use rusqlite::types::Value as SqlValue;

use crate::shared::engine::*;
use crate::shared::error::AppError;

/// Map a JSON scalar to a bound SQLite value for a `SET col = ?` clause. Unlike
/// [`json_to_sql_value`] (written for WHERE-equality, where `= NULL` is a bug),
/// a NULL here is the legitimate "set the cell to NULL" case and binds as
/// [`SqlValue::Null`]. Non-null values reuse [`json_to_sql_value`]'s mapping;
/// nested arrays/objects (not valid scalars) fall back to their JSON text so
/// the engine — not a panic — decides (a NOT-a-scalar value is unusual for a
/// cell edit, but we never lose data or interpolate).
pub(super) fn json_to_set_value(value: &serde_json::Value) -> SqlValue {
    match value {
        serde_json::Value::Null => SqlValue::Null,
        other => json_to_sql_value(other).unwrap_or_else(|_| SqlValue::Text(other.to_string())),
    }
}

/// Bind a binary-column operand (filter/pk) as a SQLite BLOB: the renderer's
/// `0x`-hex / UUID value decoded to raw bytes. NULL is rejected like any operand
/// NULL (use IS NULL / IS NOT NULL).
pub(super) fn json_to_blob_operand(value: &serde_json::Value) -> Result<SqlValue, AppError> {
    match crate::shared::engine::parse_binary_value(value)? {
        Some(bytes) => Ok(SqlValue::Blob(bytes)),
        None => Err(AppError::Database(
            "Use IS NULL / IS NOT NULL to compare with NULL.".to_string(),
        )),
    }
}

/// Bind a binary-column `SET col = ?` value as a SQLite BLOB: decoded bytes, or
/// NULL when the renderer sends null.
pub(super) fn json_to_blob_set(value: &serde_json::Value) -> Result<SqlValue, AppError> {
    Ok(match crate::shared::engine::parse_binary_value(value)? {
        Some(bytes) => SqlValue::Blob(bytes),
        None => SqlValue::Null,
    })
}

/// Render a JSON scalar as a display SQL literal for the cosmetic toast string.
/// Strings are single-quoted with `'` doubled (so the displayed statement is
/// itself valid SQL); NULL/number/bool render verbatim. NOT for execution — the
/// real query binds (see [`display_update_statement`]).
pub(super) fn sql_literal(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Null => "NULL".to_string(),
        serde_json::Value::Bool(b) => i64::from(*b).to_string(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::String(s) => format!("'{}'", s.replace('\'', "''")),
        // Arrays/objects are not valid cell scalars; show their JSON text quoted
        // so the toast still renders something truthful.
        other => format!("'{}'", other.to_string().replace('\'', "''")),
    }
}

/// Map a JSON `null` (SQLite NULL aggregate result) to `None`, anything else
/// to `Some`. Used for min/max which return SQL NULL over an empty/all-NULL set.
pub(super) fn non_null(value: serde_json::Value) -> Option<serde_json::Value> {
    match value {
        serde_json::Value::Null => None,
        other => Some(other),
    }
}

/// Validate that `column` is a real column of the table (§5 error otherwise,
/// listing the available columns) — the shared check used by the FK peek and
/// column-stats lookups, identical to the sort/filter column validation.
pub(super) fn validate_column(meta: &TableMeta, table: &str, column: &str) -> Result<(), AppError> {
    if meta.columns.iter().any(|c| c.name == column) {
        return Ok(());
    }
    let listing: Vec<&str> = meta.columns.iter().map(|c| c.name.as_str()).collect();
    Err(AppError::Database(format!(
        "Column '{column}' does not exist on '{table}' (columns: {}).",
        listing.join(", ")
    )))
}

/// A compiled WHERE clause: the SQL body (without the `WHERE` keyword) and the
/// values to bind, in placeholder order. `sql == None` means "no predicate"
/// (an empty structured filter), which the caller renders as no WHERE clause
/// at all.
#[derive(Default)]
pub(super) struct WhereClause {
    pub(super) sql: Option<String>,
    pub(super) params: Vec<SqlValue>,
}

/// The character used in `ESCAPE '\'` for the LIKE family. A backslash is the
/// conventional choice and never appears unescaped in our patterns.
const LIKE_ESCAPE: char = '\\';

/// Compile a [`FilterSpec`] into a WHERE body + bound parameters.
///
/// Structured conditions validate every column against `meta`, emit a fixed
/// per-operator SQL fragment, and bind every value as a parameter. The raw
/// mode wraps the user string in parentheses verbatim (the documented escape
/// hatch — see [`fetch_rows_blocking`]).
pub(super) fn where_clause(
    meta: &TableMeta,
    table: &str,
    filter: &FilterSpec,
) -> Result<WhereClause, AppError> {
    match filter {
        FilterSpec::Raw { sql } => {
            let trimmed = sql.trim();
            if trimmed.is_empty() {
                // An empty raw clause is "no filter", not a syntax error.
                return Ok(WhereClause::default());
            }
            // Interpolated verbatim, wrapped in parens (escape hatch). No
            // parameters — the string carries its own literals.
            Ok(WhereClause {
                sql: Some(format!("({trimmed})")),
                params: Vec::new(),
            })
        }
        FilterSpec::Conditions { items, combinator } => {
            let mut fragments: Vec<String> = Vec::with_capacity(items.len());
            let mut params: Vec<SqlValue> = Vec::new();
            for condition in items {
                let fragment = condition_sql(meta, table, condition, &mut params)?;
                fragments.push(fragment);
            }
            if fragments.is_empty() {
                // No conditions → no predicate (whole table).
                return Ok(WhereClause::default());
            }
            let joiner = format!(" {} ", combinator.sql_keyword());
            Ok(WhereClause {
                sql: Some(fragments.join(&joiner)),
                params,
            })
        }
    }
}

/// Compile one structured [`Condition`] into a SQL fragment, pushing any bound
/// values onto `params`. The column is validated against `meta` (a §5 error
/// for an unknown column, identical to the sort-column check); the operator
/// selects a fixed fragment; values are bound, never interpolated.
fn condition_sql(
    meta: &TableMeta,
    table: &str,
    condition: &Condition,
    params: &mut Vec<SqlValue>,
) -> Result<String, AppError> {
    validate_column(meta, table, &condition.column)?;
    let col = quote_ident(&condition.column);

    match condition.op {
        FilterOp::IsNull => Ok(format!("{col} IS NULL")),
        FilterOp::IsNotNull => Ok(format!("{col} IS NOT NULL")),
        FilterOp::Eq
        | FilterOp::Ne
        | FilterOp::Gt
        | FilterOp::Gte
        | FilterOp::Lt
        | FilterOp::Lte => {
            let value = require_scalar(condition)?;
            params.push(if condition.binary {
                json_to_blob_operand(value)?
            } else {
                json_to_sql_value(value)?
            });
            let operator = match condition.op {
                FilterOp::Eq => "=",
                FilterOp::Ne => "<>",
                FilterOp::Gt => ">",
                FilterOp::Gte => ">=",
                FilterOp::Lt => "<",
                FilterOp::Lte => "<=",
                _ => unreachable!("comparison arm"),
            };
            Ok(format!("{col} {operator} ?"))
        }
        FilterOp::Contains | FilterOp::NotContains | FilterOp::BeginsWith | FilterOp::EndsWith => {
            let value = require_scalar(condition)?;
            let text = like_operand(value)?;
            let escaped = escape_like(&text);
            let pattern = match condition.op {
                FilterOp::Contains | FilterOp::NotContains => format!("%{escaped}%"),
                FilterOp::BeginsWith => format!("{escaped}%"),
                FilterOp::EndsWith => format!("%{escaped}"),
                _ => unreachable!("like arm"),
            };
            params.push(SqlValue::Text(pattern));
            let keyword = if matches!(condition.op, FilterOp::NotContains) {
                "NOT LIKE"
            } else {
                "LIKE"
            };
            Ok(format!("{col} {keyword} ? ESCAPE '{LIKE_ESCAPE}'"))
        }
        FilterOp::InList => {
            let values = match &condition.value {
                Some(FilterValue::List(values)) => values,
                Some(FilterValue::Scalar(_)) => {
                    return Err(AppError::Database(format!(
                        "The 'in list' filter on '{}' needs a list of values.",
                        condition.column
                    )));
                }
                None => return Err(missing_value_error(condition)),
            };
            if values.is_empty() {
                return Err(AppError::Database(format!(
                    "The 'in list' filter on '{}' needs at least one value.",
                    condition.column
                )));
            }
            let mut placeholders = Vec::with_capacity(values.len());
            for value in values {
                params.push(if condition.binary {
                    json_to_blob_operand(value)?
                } else {
                    json_to_sql_value(value)?
                });
                placeholders.push("?");
            }
            Ok(format!("{col} IN ({})", placeholders.join(", ")))
        }
    }
}

/// The single scalar a comparison / LIKE operator requires. A missing value or
/// a list where a scalar is expected is a §5 error.
fn require_scalar(condition: &Condition) -> Result<&serde_json::Value, AppError> {
    match &condition.value {
        Some(FilterValue::Scalar(value)) => Ok(value),
        Some(FilterValue::List(_)) => Err(AppError::Database(format!(
            "The filter on '{}' expects a single value, not a list.",
            condition.column
        ))),
        None => Err(missing_value_error(condition)),
    }
}

/// §5 error for an operator that needs a value but received none.
fn missing_value_error(condition: &Condition) -> AppError {
    AppError::Database(format!(
        "The filter on '{}' needs a value.",
        condition.column
    ))
}

/// Map a JSON scalar to a bound SQLite value. NULL is rejected with the §5
/// "use IS NULL / IS NOT NULL" message (matching `engine.js`) — `col = NULL`
/// never matches, so a NULL comparison is always a mistake. Nested
/// arrays/objects are not valid scalars.
pub(super) fn json_to_sql_value(value: &serde_json::Value) -> Result<SqlValue, AppError> {
    match value {
        serde_json::Value::Null => Err(AppError::Database(
            "Use IS NULL / IS NOT NULL to compare with NULL.".to_string(),
        )),
        serde_json::Value::Bool(b) => Ok(SqlValue::Integer(i64::from(*b))),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Ok(SqlValue::Integer(i))
            } else if let Some(f) = n.as_f64() {
                Ok(SqlValue::Real(f))
            } else {
                // u64 beyond i64::MAX — preserve as text rather than lose it.
                Ok(SqlValue::Text(n.to_string()))
            }
        }
        serde_json::Value::String(s) => Ok(SqlValue::Text(s.clone())),
        serde_json::Value::Array(_) | serde_json::Value::Object(_) => Err(AppError::Database(
            "A filter value must be a single text, number, or boolean.".to_string(),
        )),
    }
}

/// The text operand for a LIKE-family operator. Numbers/bools are stringified
/// (a `contains` on a numeric column still makes sense); NULL is rejected like
/// any other NULL comparison.
fn like_operand(value: &serde_json::Value) -> Result<String, AppError> {
    match value {
        serde_json::Value::Null => Err(AppError::Database(
            "Use IS NULL / IS NOT NULL to compare with NULL.".to_string(),
        )),
        serde_json::Value::String(s) => Ok(s.clone()),
        serde_json::Value::Bool(b) => Ok(b.to_string()),
        serde_json::Value::Number(n) => Ok(n.to_string()),
        serde_json::Value::Array(_) | serde_json::Value::Object(_) => Err(AppError::Database(
            "A filter value must be a single text, number, or boolean.".to_string(),
        )),
    }
}

/// Escape the LIKE metacharacters (`%`, `_`) and the escape character itself
/// in a user-supplied operand, so they match literally under `ESCAPE '\'`.
/// The escape char is doubled first so it cannot accidentally escape a real
/// metacharacter the user typed.
pub(super) fn escape_like(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        if ch == LIKE_ESCAPE || ch == '%' || ch == '_' {
            out.push(LIKE_ESCAPE);
        }
        out.push(ch);
    }
    out
}

/// Build the validated, quoted ORDER BY body for a single-column sort:
/// `"column" ASC|DESC`. The column MUST exist in `meta` (else a §5 error
/// listing the available columns); the direction is the enum's fixed keyword.
pub(super) fn order_by_clause(
    meta: &TableMeta,
    table: &str,
    sort: &SortSpec,
) -> Result<String, AppError> {
    validate_column(meta, table, &sort.column)?;
    Ok(format!(
        "{} {}",
        quote_ident(&sort.column),
        sort.direction.sql_keyword()
    ))
}

/// Quote an identifier for interpolation into SQLite SQL: wrap in double
/// quotes, doubling embedded quotes.
pub(super) fn quote_ident(ident: &str) -> String {
    format!("\"{}\"", ident.replace('"', "\"\""))
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::{Arc, Mutex};

    use rusqlite::Connection;

    use super::super::{sqlite_engine_info, SqliteEngineConnection};

    #[test]
    fn quote_ident_doubles_embedded_quotes() {
        assert_eq!(quote_ident("plain"), "\"plain\"");
        assert_eq!(quote_ident("we\"ird"), "\"we\"\"ird\"");
    }

    #[test]
    fn escape_like_escapes_metacharacters_and_the_escape_char() {
        assert_eq!(escape_like("plain"), "plain");
        assert_eq!(escape_like("100%"), "100\\%");
        assert_eq!(escape_like("a_b"), "a\\_b");
        // The escape char itself is doubled so it cannot escape a real meta.
        assert_eq!(escape_like("a\\b"), "a\\\\b");
    }

    // ---- M15 truncate + identifier quoting ----

    #[test]
    fn quote_identifier_uses_double_quotes_and_doubles_embedded() {
        let conn = SqliteEngineConnection {
            conn: Arc::new(Mutex::new(Connection::open_in_memory().unwrap())),
            info: sqlite_engine_info(),
        };
        assert_eq!(conn.quote_identifier("users"), "\"users\"");
        assert_eq!(conn.quote_identifier("we\"ird"), "\"we\"\"ird\"");
    }
}
