//! MySQL driver-error → AppError mapping and message humanising.

use crate::shared::error::AppError;

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

/// Map a connect-time sqlx error to a §5-style human message.
pub(super) fn map_connect_error(err: sqlx::Error) -> AppError {
    AppError::Database(format!(
        "Could not connect to the MySQL server: {}.",
        driver_message(&err)
    ))
}

/// Map a query-time sqlx error to a §5-style human message. Database errors
/// carry the server's own message (already a clear sentence); other errors are
/// humanized.
pub(super) fn map_query_error(err: sqlx::Error) -> AppError {
    if let sqlx::Error::Database(db) = &err {
        return AppError::Database(humanize(db.message()));
    }
    AppError::Database(humanize(&err.to_string()))
}

/// True when a statement cannot run over the prepared-statement (binary)
/// protocol and must fall back to the text protocol (`raw_sql`). Two cases:
///
/// 1. MySQL error 1295 — a command the prepared-statement protocol does not
///    support (CREATE/DROP FUNCTION/PROCEDURE/TRIGGER, etc.). Surfaces as a
///    `Database` error.
/// 2. A `COM_STMT_PREPARE` reply sqlx cannot decode — e.g. `SET GLOBAL
///    time_zone=...` and some admin statements make the server send a
///    short/non-standard PrepareOk packet, and sqlx fails with a protocol
///    decode error ("PrepareOk expected 12 bytes but got 7 bytes"). This is a
///    `Protocol` error, NOT a `Database` error, so it must be matched
///    separately or the text-protocol fallback never fires.
pub(super) fn is_unpreparable(err: &sqlx::Error) -> bool {
    match err {
        sqlx::Error::Database(db) => db.message().contains("prepared statement protocol"),
        other => {
            let msg = other.to_string();
            msg.contains("PrepareOk") || msg.contains("prepare_ok")
        }
    }
}

/// The bare driver message for an error (strip sqlx's wrapping).
pub(super) fn driver_message(err: &sqlx::Error) -> String {
    match err {
        sqlx::Error::Database(db) => db.message().to_string(),
        other => other.to_string(),
    }
}

/// Capitalize the first letter and ensure a trailing period (matches the
/// SQLite/Postgres adapters' `humanize`).
pub(super) fn humanize(message: &str) -> String {
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
    fn humanize_capitalizes_and_terminates() {
        assert_eq!(humanize("table doesn't exist"), "Table doesn't exist.");
        assert_eq!(humanize("Already fine."), "Already fine.");
        assert_eq!(humanize(""), "The database reported an unknown error.");
    }
}
