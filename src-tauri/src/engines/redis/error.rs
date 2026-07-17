//! Redis driver-error → AppError mapping.

use crate::shared::error::AppError;

// ---------------------------------------------------------------------------
// Error mapping (§5 human sentences)
// ---------------------------------------------------------------------------

/// Map a connect-time driver error to a §5 human sentence. Never leaks driver
/// internals or secrets.
pub(super) fn map_connect_error(err: redis::RedisError) -> AppError {
    if err.kind() == redis::ErrorKind::AuthenticationFailed {
        return AppError::Database(
            "Redis authentication failed. Check the password and ACL user.".into(),
        );
    }
    // A password-protected server rejects the unauthenticated RESP3 `HELLO`
    // handshake (or any command) with NOAUTH / a "HELLO … authenticated"
    // message rather than the AuthenticationFailed kind. Surface the actionable
    // §5 sentence instead of the raw server text.
    let lower = err.to_string().to_lowercase();
    if err.code() == Some("NOAUTH")
        || lower.contains("noauth")
        || (lower.contains("hello") && lower.contains("authenticated"))
    {
        return AppError::Database(
            "This Redis server requires a password. Enter it in the Password field \
             (and the ACL user if your server uses a named user)."
                .into(),
        );
    }
    if err.is_io_error() || err.is_connection_refusal() || err.is_timeout() {
        return AppError::Database(format!(
            "Could not reach the Redis server: {}",
            short_reason(&err)
        ));
    }
    AppError::Database(format!(
        "Could not open the Redis connection: {}",
        short_reason(&err)
    ))
}

/// Map a query-time driver error to a §5 human sentence.
pub(super) fn map_query_error(err: redis::RedisError) -> AppError {
    if err.is_io_error() {
        return AppError::Database(format!(
            "The Redis connection was interrupted: {}",
            short_reason(&err)
        ));
    }
    AppError::Database(format!("The Redis command failed: {}", short_reason(&err)))
}

/// A short, secret-free reason string from a driver error (its detail or code).
pub(super) fn short_reason(err: &redis::RedisError) -> String {
    err.detail()
        .map(str::to_string)
        .or_else(|| err.code().map(str::to_string))
        .unwrap_or_else(|| "the server closed the connection".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connect_error_maps_hello_noauth_to_password_hint() {
        // The RESP3 HELLO handshake against a password-protected server fails
        // with this server text (not the AuthenticationFailed kind).
        let err = redis::RedisError::from((
            redis::ErrorKind::ResponseError,
            "hello error",
            "HELLO must be called with the client already authenticated, otherwise the \
             HELLO <proto> AUTH <user> <pass> option can be used"
                .to_string(),
        ));
        let mapped = map_connect_error(err);
        assert!(
            matches!(&mapped, AppError::Database(m) if m.contains("requires a password")),
            "got: {mapped:?}"
        );
    }
}
