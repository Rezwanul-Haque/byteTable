//! Cassandra driver-error → AppError mapping.

use crate::shared::error::AppError;

/// Map any driver error (each `scylla` error type implements `Display`) to a §5
/// human sentence.
pub(super) fn db_err(context: &str, error: impl std::fmt::Display) -> AppError {
    AppError::Database(format!("{context}: {error}"))
}
