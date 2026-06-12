//! The single application error type, shared by every slice.
//!
//! At the Tauri command boundary the error is serialized as a structured
//! payload `{ "kind": "<discriminant>", "message": "<human message>" }`
//! (see the `Serialize` impl) — `kind` lets the renderer branch on the error
//! category while `message` stays human-readable; the renderer never receives
//! stack traces or debug formatting. The matching renderer type lives in
//! `src/shared/api/error.ts` (`AppErrorPayload`).

use thiserror::Error;

/// One error type for the whole backend. Use-cases and adapters return this;
/// command handlers surface it to the renderer as a `{ kind, message }`
/// payload.
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

impl AppError {
    /// Stable machine-readable discriminant for the command boundary.
    /// Mirrored by `AppErrorKind` in `src/shared/api/error.ts`.
    fn kind(&self) -> &'static str {
        match self {
            Self::Io(_) => "io",
            Self::Serialization(_) => "serialization",
            Self::NotFound(_) => "notFound",
            Self::Invalid(_) => "invalid",
        }
    }
}

/// Command-boundary mapping: Tauri requires command error types to be
/// serializable. We serialize a structured payload
/// `{ "kind": <discriminant>, "message": <human-readable Display message> }`.
impl serde::Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;

        let mut state = serializer.serialize_struct("AppError", 2)?;
        state.serialize_field("kind", self.kind())?;
        state.serialize_field("message", &self.to_string())?;
        state.end()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_to_structured_kind_and_message_payload() {
        let err = AppError::NotFound("connection 42".into());
        let json = serde_json::to_value(&err).expect("serialize");
        assert_eq!(
            json,
            serde_json::json!({
                "kind": "notFound",
                "message": "Not found: connection 42",
            })
        );
    }

    #[test]
    fn every_variant_maps_to_a_stable_kind() {
        let cases = [
            (AppError::Io("x".into()), "io"),
            (AppError::Serialization("x".into()), "serialization"),
            (AppError::NotFound("x".into()), "notFound"),
            (AppError::Invalid("x".into()), "invalid"),
        ];
        for (err, expected_kind) in cases {
            let json = serde_json::to_value(&err).expect("serialize");
            assert_eq!(json["kind"], expected_kind);
            assert!(json["message"].is_string());
        }
    }

    #[test]
    fn converts_io_errors() {
        let io = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "denied");
        let err: AppError = io.into();
        assert!(matches!(err, AppError::Io(_)));
        assert!(err.to_string().contains("denied"));
    }
}
