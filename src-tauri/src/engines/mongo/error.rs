//! MongoDB driver-error → AppError mapping.

use crate::shared::error::AppError;

/// Map a driver error to a §5 human sentence.
pub(super) fn db_err(context: &str, error: mongodb::error::Error) -> AppError {
    AppError::Database(format!("{context}: {error}"))
}
