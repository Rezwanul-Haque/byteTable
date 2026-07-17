//! Oracle driver-error → [`AppError`] mapping and the single-row "optional"
//! helper. All errors carry human messages per DESIGN_SPEC §5 before they cross
//! the port boundary. Gated with the rest of the OCI driver behind
//! `engine-oracle`.

use crate::shared::error::AppError;

/// A `spawn_blocking` join failure (the Oracle worker panicked or was cancelled).
pub(super) fn join_err(e: tokio::task::JoinError) -> AppError {
    AppError::Database(format!("the Oracle worker task failed: {e}"))
}

/// Map a connect-time driver error (bad DSN, auth, listener down, no Instant
/// Client) to a §5 human error.
pub(super) fn map_ora_connect_err(e: oracle::Error) -> AppError {
    AppError::Database(format!("could not connect to Oracle: {e}"))
}

/// Map a query/DML/DDL driver error to a §5 human error (the ORA-xxxxx message
/// the driver already produces is human-readable).
pub(super) fn map_ora_query_err(e: oracle::Error) -> AppError {
    AppError::Database(e.to_string())
}

/// Turn rust-oracle's "no rows" (`NoDataFound`) error from a single-row
/// `query_row_as` into `Ok(None)`, so existence checks read cleanly. Any other
/// driver error maps through [`map_ora_query_err`].
pub(super) trait OptionalRow<T> {
    fn optional_or_none(self) -> Result<Option<T>, AppError>;
}

impl<T> OptionalRow<T> for Result<T, oracle::Error> {
    fn optional_or_none(self) -> Result<Option<T>, AppError> {
        match self {
            Ok(v) => Ok(Some(v)),
            Err(e) if e.kind() == oracle::ErrorKind::NoDataFound => Ok(None),
            Err(e) => Err(map_ora_query_err(e)),
        }
    }
}
