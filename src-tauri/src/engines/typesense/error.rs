//! Typesense error → [`AppError`] mapping (DESIGN_SPEC §5: complete, human
//! sentences; never a raw status code or a driver Debug dump).
//!
//! Typesense reports failures as a JSON body `{"message": "…"}` alongside the
//! HTTP status. The status is what carries the *meaning*, so the mapping is
//! driven by it:
//!
//! - **401 / 403** → [`AppError::Unsupported`], not `Database`. A scoped
//!   (search-only) key hitting an admin endpoint is the expected, designed-for
//!   case, and `Unsupported` is the kind the renderer branches on to show the
//!   "admin key required" empty state instead of an error toast. Note Typesense
//!   answers 401 for an out-of-scope key, not the 403 the milestone assumed.
//! - **404** → [`AppError::NotFound`], naming the path so the console can say
//!   which route missed.
//! - everything else → [`AppError::Database`] with the server's own message.

use crate::shared::error::AppError;

/// Human sentence for a transport failure (host unreachable / timed out).
pub(super) fn map_connect_error(host: &str, port: u16, err: &reqwest::Error) -> AppError {
    if err.is_timeout() {
        AppError::Database(format!(
            "Timed out reaching the Typesense server at {host}:{port}. \
             Check the host, the port, and that the node is running."
        ))
    } else {
        AppError::Database(format!(
            "Could not reach the Typesense server at {host}:{port}. \
             Check the host, the port, and the protocol (http vs https)."
        ))
    }
}

/// Pull Typesense's `{"message": "…"}` out of an error body, falling back to
/// the raw body (trimmed) when it is not the documented shape.
pub(super) fn server_message(body: &str) -> String {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| {
            v.get("message")
                .and_then(|m| m.as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| body.trim().to_string())
}

/// Map a non-2xx response to the right [`AppError`] kind. `path` is the request
/// path (for 404s); `needs_admin` names the view that was being loaded so the
/// scope error reads as guidance rather than a bare refusal.
pub(super) fn map_status(
    status: u16,
    path: &str,
    body: &str,
    needs_admin: Option<&str>,
) -> AppError {
    let message = server_message(body);
    match status {
        401 | 403 => {
            let what = needs_admin.unwrap_or("this view");
            AppError::Unsupported(format!(
                "This API key is not allowed to read {what}. Typesense scopes keys by action and \
                 collection — reconnect with an admin key to use it."
            ))
        }
        404 => AppError::NotFound(format!("Typesense has no '{path}' ({message}).")),
        // 400 is almost always a malformed search parameter; pass the server's
        // own sentence through, it names the offending field.
        _ if message.is_empty() => AppError::Database(format!(
            "The Typesense server rejected the request to '{path}' (HTTP {status})."
        )),
        _ => AppError::Database(message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_out_of_scope_key_is_unsupported_not_a_database_error() {
        let err = map_status(
            401,
            "/keys",
            r#"{"message":"Forbidden - a valid `x-typesense-api-key` header must be sent."}"#,
            Some("API keys"),
        );
        assert!(matches!(err, AppError::Unsupported(_)));
        assert!(err.to_string().contains("API keys"));
        assert!(err.to_string().contains("admin key"));
    }

    #[test]
    fn a_missing_route_names_the_path() {
        let err = map_status(
            404,
            "/collections/nope",
            r#"{"message":"Not found."}"#,
            None,
        );
        assert!(matches!(err, AppError::NotFound(_)));
        assert!(err.to_string().contains("/collections/nope"));
    }

    #[test]
    fn other_failures_pass_the_servers_own_sentence_through() {
        let err = map_status(
            400,
            "/collections/products/documents/search",
            r#"{"message":"Could not find a field named `nope` in the schema."}"#,
            None,
        );
        assert_eq!(
            err.to_string(),
            "Could not find a field named `nope` in the schema."
        );
    }

    #[test]
    fn a_non_json_body_still_produces_a_sentence() {
        let err = map_status(500, "/health", "<html>oops</html>", None);
        assert!(matches!(err, AppError::Database(_)));
        assert!(err.to_string().contains("oops"));
    }

    #[test]
    fn an_empty_body_falls_back_to_naming_the_status_and_path() {
        let err = map_status(502, "/collections", "", None);
        assert!(err.to_string().contains("502"));
        assert!(err.to_string().contains("/collections"));
    }
}
