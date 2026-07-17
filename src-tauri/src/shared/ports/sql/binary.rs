// Binary value <-> JSON rendering, shared by every engine adapter so SQLite /
// MySQL / Postgres represent binary identically (hex inlining, UUID / hex
// parsing, the `[N bytes]` placeholder).

use crate::shared::error::AppError;

/// Upper bound (bytes) for inlining a binary/blob value as hex. Covers the
/// common fixed-size cases — UUID (16), SHA-1 (20), SHA-256 (32) — which are
/// routinely used as keys / foreign keys. Larger values stay a placeholder.
pub const INLINE_BINARY_MAX_BYTES: usize = 32;

/// Render a binary/blob column value as JSON, shared by every engine adapter so
/// SQLite/MySQL/Postgres represent binary identically.
///
/// Small values (≤ [`INLINE_BINARY_MAX_BYTES`]) become a `0x`-prefixed
/// lowercase-hex string — readable in the grid AND usable as a real value (e.g.
/// a binary primary/foreign key). Larger blobs keep the `[N bytes]` placeholder:
/// there is no blob viewer yet, and shipping megabytes of hex across IPC for one
/// grid cell helps no one.
/// True for binary column types (binary / varbinary / blob / bytea), matched
/// case-insensitively on the declared type text. Used by the SQL export to emit
/// hex literals for binary columns so they round-trip.
pub fn is_binary_type(data_type: &str) -> bool {
    let t = data_type.to_ascii_lowercase();
    t.contains("binary") || t.contains("blob") || t.contains("bytea")
}

/// True if `s` is a canonical 8-4-4-4-12 hex UUID.
fn is_uuid_str(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b[8] == b'-'
        && b[13] == b'-'
        && b[18] == b'-'
        && b[23] == b'-'
        && s.chars()
            .enumerate()
            .all(|(i, c)| matches!(i, 8 | 13 | 18 | 23) || c.is_ascii_hexdigit())
}

/// Decode an even-length hex string to bytes; `None` on odd length or a non-hex
/// digit.
fn decode_hex(hex: &str) -> Option<Vec<u8>> {
    if !hex.len().is_multiple_of(2) {
        return None;
    }
    let bytes = hex.as_bytes();
    let mut out = Vec::with_capacity(hex.len() / 2);
    let mut i = 0;
    while i < bytes.len() {
        let hi = (bytes[i] as char).to_digit(16)?;
        let lo = (bytes[i + 1] as char).to_digit(16)?;
        out.push((hi * 16 + lo) as u8);
        i += 2;
    }
    Some(out)
}

/// Parse a binary cell value (as the renderer sends it for a binary column — a
/// `0x`-hex string, a canonical UUID, or bare hex) into raw bytes for binding to
/// a BINARY/BLOB/BYTEA column. `null` → `None` (binds NULL). A non-string value
/// or malformed hex is a §5 `Invalid` error.
pub fn parse_binary_value(value: &serde_json::Value) -> Result<Option<Vec<u8>>, AppError> {
    match value {
        serde_json::Value::Null => Ok(None),
        serde_json::Value::String(s) => {
            let t = s.trim();
            let hex: String = if is_uuid_str(t) {
                t.chars().filter(|c| *c != '-').collect()
            } else {
                t.strip_prefix("0x")
                    .or_else(|| t.strip_prefix("0X"))
                    .unwrap_or(t)
                    .to_string()
            };
            decode_hex(&hex).map(Some).ok_or_else(|| {
                AppError::Invalid(format!("'{s}' is not valid binary (hex or UUID)"))
            })
        }
        other => Err(AppError::Invalid(format!(
            "a binary value must be a hex/UUID string, got {other}"
        ))),
    }
}

pub fn binary_to_json(bytes: &[u8]) -> serde_json::Value {
    use std::fmt::Write as _;
    if bytes.len() <= INLINE_BINARY_MAX_BYTES {
        let mut s = String::with_capacity(2 + bytes.len() * 2);
        s.push_str("0x");
        for b in bytes {
            let _ = write!(s, "{b:02x}");
        }
        serde_json::Value::String(s)
    } else {
        serde_json::Value::String(format!("[{} bytes]", bytes.len()))
    }
}
