//! MSSQL driver-error → AppError mapping and message humanising.

use crate::shared::error::AppError;

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

pub(super) fn map_connect_error(message: String) -> AppError {
    AppError::Database(format!(
        "Could not connect to the SQL Server: {}.",
        message.trim_end_matches('.')
    ))
}

/// Map a query-time tiberius error to a §5-style human message. SQL Server
/// errors carry the server's own message (already a clear sentence).
pub(super) fn map_query_error(err: tiberius::error::Error) -> AppError {
    let message = match &err {
        tiberius::error::Error::Server(token) => token.message().to_string(),
        other => other.to_string(),
    };
    AppError::Database(humanize(&message))
}

/// Capitalize the first letter and ensure a trailing period (matches the other
/// adapters' `humanize`).
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
