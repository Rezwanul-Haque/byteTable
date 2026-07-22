//! ClickHouse driver-error → [`AppError`] mapping. ClickHouse's HTTP interface
//! returns a non-200 status with a body like
//! `Code: 60. DB::Exception: Table default.x does not exist. (UNKNOWN_TABLE) (version 24.8…)`.
//! We surface the human sentence (DESIGN_SPEC §5) and drop the trailing
//! `(version …)` noise.

use crate::shared::error::AppError;

/// Map a transport failure (could-not-reach) to a §5 human error.
pub fn map_connect_error(host: &str, port: u16, detail: impl std::fmt::Display) -> AppError {
    AppError::Database(format!(
        "Could not reach ClickHouse at {host}:{port} ({detail})."
    ))
}

/// Map a ClickHouse error-response body (or a transport error during a query) to
/// a §5 human error, keeping the `DB::Exception` sentence and trimming the
/// `(version …)` suffix ClickHouse appends.
pub fn map_query_error(body: impl Into<String>) -> AppError {
    AppError::Database(humanize(&body.into()))
}

/// Clean a raw ClickHouse error: if the body is a `FORMAT JSON*` payload with an
/// `exception` field (ClickHouse embeds the error there when it fails after the
/// 200 headers, or in the 500 body), pull that sentence out first; then strip a
/// trailing `(version …)` and collapse whitespace so it reads as one sentence.
pub fn humanize(raw: &str) -> String {
    let trimmed = raw.trim();
    // Prefer the `exception` field of a JSON error body over the raw JSON blob.
    let source = serde_json::from_str::<serde_json::Value>(trimmed)
        .ok()
        .and_then(|v| {
            v.get("exception")
                .and_then(|e| e.as_str())
                .map(str::to_string)
        });
    let trimmed = source.as_deref().unwrap_or(trimmed);
    // Drop a trailing "(version 24.8.2.3 (official build))" style suffix.
    let without_version = match trimmed.rfind("(version ") {
        Some(idx) => trimmed[..idx].trim_end(),
        None => trimmed,
    };
    let cleaned = without_version
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if cleaned.is_empty() {
        return "ClickHouse returned an error.".to_string();
    }
    friendly(&cleaned)
}

/// Turn a cleaned ClickHouse error into a calm §5 sentence: map the common,
/// alarming ones (auth failure, unknown db/table) to a short line, and for
/// everything else strip the `Code: N. DB::Exception:` prefix and the trailing
/// `(ERROR_NAME)` marker so the user sees the plain sentence, not a stack of
/// codes and a "reset your password in /etc/clickhouse-server/…" wall of text.
fn friendly(cleaned: &str) -> String {
    let upper = cleaned.to_ascii_uppercase();
    // ClickHouse dumps a long "you can reset it in the configuration file…"
    // paragraph on auth failure — replace it wholesale with one calm line.
    if upper.contains("AUTHENTICATION_FAILED")
        || upper.contains("AUTHENTICATION FAILED")
        || upper.contains("REQUIRED_PASSWORD")
    {
        return "Authentication failed — check the user name and password.".to_string();
    }
    if upper.contains("UNKNOWN_DATABASE") {
        return "That database does not exist — check the Database field.".to_string();
    }

    // Strip the leading "Code: N. DB::Exception: " prefix, if present.
    let body = match cleaned.find("DB::Exception: ") {
        Some(idx) => &cleaned[idx + "DB::Exception: ".len()..],
        None => cleaned,
    };
    // Strip a trailing " (ERROR_NAME)" marker (ALL-CAPS / digits / underscore).
    let body = strip_error_marker(body);
    if body.is_empty() {
        "ClickHouse returned an error.".to_string()
    } else {
        body.to_string()
    }
}

/// Drop a trailing ` (ERROR_NAME)` token when it is ClickHouse's ALL-CAPS error
/// name (e.g. `(UNKNOWN_TABLE)`), leaving the human sentence before it.
fn strip_error_marker(body: &str) -> &str {
    let body = body.trim_end();
    if let Some(open) = body.rfind('(') {
        if body.ends_with(')') {
            let inner = &body[open + 1..body.len() - 1];
            let is_marker = !inner.is_empty()
                && inner
                    .chars()
                    .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_');
            if is_marker {
                return body[..open].trim_end();
            }
        }
    }
    body
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn humanize_strips_prefix_marker_and_version() {
        let raw = "Code: 60. DB::Exception: Table default.x does not exist. (UNKNOWN_TABLE) (version 24.8.2.3 (official build))";
        // Prefix (`Code: N. DB::Exception:`), trailing `(UNKNOWN_TABLE)` marker,
        // and the `(version …)` suffix are all stripped → a plain sentence.
        assert_eq!(humanize(raw), "Table default.x does not exist.");
    }

    #[test]
    fn humanize_maps_auth_failure_to_a_calm_line() {
        // ClickHouse's real auth error is a scary multi-line "reset your password
        // in /etc/clickhouse-server/…" wall of text — collapse it to one line.
        let raw = "Code: 516. DB::Exception: default: Authentication failed: password is incorrect, or there is no user with such name. If you have installed ClickHouse and forgot password you can reset it in the configuration file. The password for default user is typically located at /etc/clickhouse-server/users.d/default-password.xml and deleting this file will reset the password. See also /etc/clickhouse-server/users.xml on the server where ClickHouse is installed. . (AUTHENTICATION_FAILED) (version 24.10.2.80 (official build))";
        assert_eq!(
            humanize(raw),
            "Authentication failed — check the user name and password."
        );
    }

    #[test]
    fn humanize_collapses_whitespace_and_handles_empty() {
        assert_eq!(humanize("  a   b \n c "), "a b c");
        assert_eq!(humanize("   "), "ClickHouse returned an error.");
    }

    #[test]
    fn humanize_extracts_exception_from_json_error_body() {
        // ClickHouse returns a JSONCompact-shaped body with an `exception` field
        // for a mid-stream / 500 error (e.g. browsing `system.certificates`).
        let body = r#"{ "meta": [], "data": [], "rows": 0, "exception": "Poco::Exception. Code: 1000, e.code() = 0, SSL Exception: Configuration error: no certificate file has been specified (version 24.10.2.80 (official build))" }"#;
        assert_eq!(
            humanize(body),
            "Poco::Exception. Code: 1000, e.code() = 0, SSL Exception: Configuration error: no certificate file has been specified"
        );
    }
}
