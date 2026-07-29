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
/// protocol and must fall back to the text protocol (`raw_sql`) — MySQL error
/// 1295, a command the prepared-statement protocol does not support
/// (CREATE/DROP FUNCTION/PROCEDURE/TRIGGER, etc.).
///
/// This is a clean `Database` error: the server sent a well-formed ERR packet,
/// sqlx read it fully, and **the connection is still usable**, so the caller
/// may retry on that same connection. Contrast [`prepare_desynchronized`].
pub(super) fn is_unpreparable(err: &sqlx::Error) -> bool {
    match err {
        sqlx::Error::Database(db) => db.message().contains("prepared statement protocol"),
        _ => false,
    }
}

/// True when a `COM_STMT_PREPARE` reply left the connection's protocol state
/// **desynchronized**, so the connection must be discarded rather than reused.
///
/// sqlx fails here with a protocol decode error like
/// `PrepareOk expected 12 bytes but got 7 bytes` — it committed to reading a
/// PrepareOk packet and got something else (in practice an ERR packet: MySQL
/// rejects `SET GLOBAL wait_timeout=…` at prepare time with 1227 when the user
/// lacks SUPER / SYSTEM_VARIABLES_ADMIN). Because the packet was only partly
/// consumed, unread bytes remain in the stream and **the next command on that
/// connection blocks forever** waiting for a reply that never aligns.
///
/// This used to be lumped in with [`is_unpreparable`], so the text-protocol
/// retry ran on the poisoned connection and hung — the Tauri command never
/// returned, the editor's Run button spun forever, and the real error (1227)
/// was never shown. Retrying on a *fresh* connection surfaces it immediately.
pub(super) fn prepare_desynchronized(err: &sqlx::Error) -> bool {
    match err {
        // A real ERR packet is never a desync — see `is_unpreparable`.
        sqlx::Error::Database(_) => false,
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

    /// Minimal `DatabaseError` so the `Database` arm of the two predicates can
    /// be exercised without a live server.
    #[derive(Debug)]
    struct FakeDbError(String);

    impl std::fmt::Display for FakeDbError {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(&self.0)
        }
    }

    impl std::error::Error for FakeDbError {}

    impl sqlx::error::DatabaseError for FakeDbError {
        fn message(&self) -> &str {
            &self.0
        }
        fn kind(&self) -> sqlx::error::ErrorKind {
            sqlx::error::ErrorKind::Other
        }
        fn as_error(&self) -> &(dyn std::error::Error + Send + Sync + 'static) {
            self
        }
        fn as_error_mut(&mut self) -> &mut (dyn std::error::Error + Send + Sync + 'static) {
            self
        }
        fn into_error(self: Box<Self>) -> Box<dyn std::error::Error + Send + Sync + 'static> {
            self
        }
    }

    fn db_error(message: &str) -> sqlx::Error {
        sqlx::Error::Database(Box::new(FakeDbError(message.to_string())))
    }

    #[test]
    fn error_1295_is_unpreparable_and_leaves_the_connection_usable() {
        let err = db_error("This command is not supported in the prepared statement protocol yet");
        assert!(is_unpreparable(&err));
        assert!(
            !prepare_desynchronized(&err),
            "a clean ERR packet is fully read — the connection stays usable, so the \
             text-protocol retry may reuse it"
        );
    }

    /// The regression this pair was split for: a PrepareOk decode failure must
    /// NOT be treated as a plain unpreparable statement, because retrying on the
    /// same connection blocks forever (it is protocol-desynchronized).
    #[test]
    fn prepare_ok_decode_failure_is_a_desync_not_an_unpreparable_statement() {
        for message in [
            "encountered unexpected or invalid data: PrepareOk expected 12 bytes but got 7 bytes",
            "error occurred while decoding prepare_ok",
        ] {
            let err = sqlx::Error::Protocol(message.to_string());
            assert!(
                prepare_desynchronized(&err),
                "should be flagged as a desync: {message}"
            );
            assert!(
                !is_unpreparable(&err),
                "must NOT reuse the poisoned connection: {message}"
            );
        }
    }

    #[test]
    fn ordinary_errors_are_neither() {
        let err = db_error("Table 'byteshop.nope' doesn't exist");
        assert!(!is_unpreparable(&err));
        assert!(!prepare_desynchronized(&err));

        let protocol = sqlx::Error::Protocol("something else entirely".to_string());
        assert!(!is_unpreparable(&protocol));
        assert!(!prepare_desynchronized(&protocol));
    }
}
