//! DynamoDB driver-error → AppError mapping.

use crate::shared::error::AppError;

/// Maps an SDK error (any error in the chain) to a §5 human sentence. Walks the
/// `source()` chain so the underlying AWS message surfaces, not the generic
/// SdkError Display wrapper.
pub(super) fn db_err<E: std::error::Error>(context: &str, error: E) -> AppError {
    let mut message = error.to_string();
    let mut source = error.source();
    while let Some(inner) = source {
        let text = inner.to_string();
        if !text.is_empty() && !message.contains(&text) {
            message.push_str(": ");
            message.push_str(&text);
        }
        source = inner.source();
    }
    AppError::Database(format!("{context}: {message}"))
}
