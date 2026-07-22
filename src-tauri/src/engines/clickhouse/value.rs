//! Tiny helpers for reading `FORMAT JSONCompact` scalar values. ClickHouse
//! encodes strings/64-bit-ints/decimals/dates as JSON strings and small ints as
//! JSON numbers; these coerce either shape to what an introspection query needs.

/// A JSON value as a plain string: strings verbatim, null → `""`, anything else
/// via its JSON text.
pub fn as_string(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// A JSON value as a `u64`: a JSON number, or a numeric string (ClickHouse
/// quotes 64-bit ints), or `None` for null / non-numeric.
pub fn as_u64(value: &serde_json::Value) -> Option<u64> {
    match value {
        serde_json::Value::Number(n) => n.as_u64(),
        serde_json::Value::String(s) => s.parse::<u64>().ok(),
        _ => None,
    }
}
