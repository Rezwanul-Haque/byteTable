//! The single application error type, shared by every slice.
//!
//! At the Tauri command boundary the error is serialized as a plain
//! human-readable message string (see the `Serialize` impl) — the renderer
//! never receives stack traces or debug formatting.

use thiserror::Error;

/// One error type for the whole backend. Use-cases and adapters return this;
/// command handlers surface it to the renderer as a message string.
#[derive(Debug, Error)]
pub enum AppError {
    /// Reading or writing files / OS resources failed.
    #[error("A file operation failed: {0}")]
    Io(String),

    /// Encoding or decoding data (e.g. JSON) failed.
    #[error("Data could not be read or written in the expected format: {0}")]
    Serialization(String),

    /// A requested resource does not exist.
    #[error("Not found: {0}")]
    NotFound(String),

    /// Input or state failed validation.
    #[error("Invalid: {0}")]
    Invalid(String),
}

impl From<std::io::Error> for AppError {
    fn from(err: std::io::Error) -> Self {
        Self::Io(err.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(err: serde_json::Error) -> Self {
        Self::Serialization(err.to_string())
    }
}

/// Command-boundary mapping: Tauri requires command error types to be
/// serializable. We serialize only the human-readable `Display` message.
impl serde::Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_to_human_readable_message_string() {
        let err = AppError::NotFound("connection 42".into());
        let json = serde_json::to_string(&err).expect("serialize");
        assert_eq!(json, "\"Not found: connection 42\"");
    }

    #[test]
    fn converts_io_errors() {
        let io = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "denied");
        let err: AppError = io.into();
        assert!(matches!(err, AppError::Io(_)));
        assert!(err.to_string().contains("denied"));
    }
}
