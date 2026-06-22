//! CQL value marshalling for the Cassandra adapter: `CqlValue` ⇄ JSON.
//!
//! Reading (`cql_to_json`) covers the full `CqlValue` surface so the wide-column
//! grid can render any column type. Writing (`json_to_cql`) converts a JSON
//! scalar to a `CqlValue` of a named CQL type for *bound* query/CRUD parameters —
//! values are always bound, never interpolated, so there is no CQL-injection
//! surface. Unsupported bind types surface a §5 human error rather than a silent
//! wrong-type bind.

use scylla::value::{CqlDate, CqlTime, CqlTimestamp, CqlValue};
use serde_json::{Number, Value};

use crate::shared::error::AppError;

/// JavaScript's safe-integer ceiling — i64s beyond this lose precision as JSON
/// numbers, so they cross the wire as strings (mirroring the SQL adapters).
const JS_SAFE_INT: i64 = 9_007_199_254_740_991;

/// Map an i64 to a JSON number when it is JS-safe, else to a string.
fn int_json(i: i64) -> Value {
    if i.abs() <= JS_SAFE_INT {
        Value::Number(Number::from(i))
    } else {
        Value::String(i.to_string())
    }
}

/// Render a `CqlDate` (days from the Unix epoch, offset by 2^31) as `YYYY-MM-DD`.
fn date_to_iso(date: CqlDate) -> String {
    // CqlDate stores `days_since_epoch + 2^31`.
    let days = date.0 as i64 - (1i64 << 31);
    civil_from_days(days)
}

/// Howard Hinnant's days→civil algorithm (no chrono dependency). `z` is days
/// since 1970-01-01; returns an ISO `YYYY-MM-DD` string.
fn civil_from_days(z: i64) -> String {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

/// Render a `CqlTime` (nanoseconds since midnight) as `HH:MM:SS.fffffffff`.
fn time_to_str(time: CqlTime) -> String {
    let nanos = time.0;
    let secs = nanos / 1_000_000_000;
    let frac = nanos % 1_000_000_000;
    let (h, m, s) = (secs / 3600, (secs % 3600) / 60, secs % 60);
    if frac == 0 {
        format!("{h:02}:{m:02}:{s:02}")
    } else {
        format!("{h:02}:{m:02}:{s:02}.{frac:09}")
    }
}

/// Convert a `CqlValue` to a JSON value for the renderer. Collections become
/// arrays (list/set/vector/tuple) or objects (map/UDT); temporal types render as
/// strings/millis the renderer's `CassValue` understands; blobs are `0x` hex.
pub fn cql_to_json(value: &CqlValue) -> Value {
    match value {
        CqlValue::Empty => Value::Null,
        CqlValue::Ascii(s) | CqlValue::Text(s) => Value::String(s.clone()),
        CqlValue::Boolean(b) => Value::Bool(*b),
        CqlValue::Int(i) => Value::Number(Number::from(*i)),
        CqlValue::SmallInt(i) => Value::Number(Number::from(*i)),
        CqlValue::TinyInt(i) => Value::Number(Number::from(*i)),
        CqlValue::BigInt(i) => int_json(*i),
        CqlValue::Counter(c) => int_json(c.0),
        CqlValue::Float(f) => Number::from_f64(*f as f64)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        CqlValue::Double(f) => Number::from_f64(*f)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        CqlValue::Decimal(_) | CqlValue::Varint(_) => {
            // Decimal/Varint have no lossless JSON number; render as their text.
            Value::String(format!("{value:?}"))
        }
        CqlValue::Timestamp(ts) => int_json(ts.0), // millis since epoch
        CqlValue::Date(d) => Value::String(date_to_iso(*d)),
        CqlValue::Time(t) => Value::String(time_to_str(*t)),
        CqlValue::Uuid(u) => Value::String(u.to_string()),
        CqlValue::Timeuuid(u) => Value::String(u.to_string()),
        CqlValue::Inet(ip) => Value::String(ip.to_string()),
        CqlValue::Blob(bytes) => Value::String(format!("0x{}", hex_encode(bytes))),
        CqlValue::Duration(d) => Value::String(format!("{d:?}")),
        CqlValue::List(items) | CqlValue::Set(items) | CqlValue::Vector(items) => {
            Value::Array(items.iter().map(cql_to_json).collect())
        }
        CqlValue::Map(pairs) => {
            let mut obj = serde_json::Map::new();
            for (k, v) in pairs {
                obj.insert(scalar_key(k), cql_to_json(v));
            }
            Value::Object(obj)
        }
        CqlValue::Tuple(items) => Value::Array(
            items
                .iter()
                .map(|o| o.as_ref().map(cql_to_json).unwrap_or(Value::Null))
                .collect(),
        ),
        CqlValue::UserDefinedType { fields, .. } => {
            let mut obj = serde_json::Map::new();
            for (name, v) in fields {
                obj.insert(
                    name.clone(),
                    v.as_ref().map(cql_to_json).unwrap_or(Value::Null),
                );
            }
            Value::Object(obj)
        }
        // Any future variant renders as its debug form rather than panicking.
        _ => Value::String(format!("{value:?}")),
    }
}

/// A best-effort CQL type label for a value, used to colour/shape a raw-CQL
/// result column whose declared type we don't separately introspect.
pub fn cql_value_type_label(v: &CqlValue) -> &'static str {
    match v {
        CqlValue::Ascii(_) | CqlValue::Text(_) => "text",
        CqlValue::Boolean(_) => "boolean",
        CqlValue::Int(_) => "int",
        CqlValue::SmallInt(_) => "smallint",
        CqlValue::TinyInt(_) => "tinyint",
        CqlValue::BigInt(_) => "bigint",
        CqlValue::Counter(_) => "counter",
        CqlValue::Float(_) => "float",
        CqlValue::Double(_) => "double",
        CqlValue::Decimal(_) => "decimal",
        CqlValue::Varint(_) => "varint",
        CqlValue::Timestamp(_) => "timestamp",
        CqlValue::Date(_) => "date",
        CqlValue::Time(_) => "time",
        CqlValue::Uuid(_) => "uuid",
        CqlValue::Timeuuid(_) => "timeuuid",
        CqlValue::Inet(_) => "inet",
        CqlValue::Blob(_) => "blob",
        CqlValue::Duration(_) => "duration",
        CqlValue::List(_) => "list",
        CqlValue::Set(_) => "set",
        CqlValue::Map(_) => "map",
        CqlValue::Tuple(_) => "tuple",
        CqlValue::Vector(_) => "vector",
        _ => "text",
    }
}

/// A map key rendered as a JSON object key (text passthrough, others stringified).
fn scalar_key(v: &CqlValue) -> String {
    match cql_to_json(v) {
        Value::String(s) => s,
        other => other.to_string(),
    }
}

pub fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Convert a JSON scalar to a bound `CqlValue` of the given CQL type. The head
/// type (`set<text>` → `set`) selects the conversion. Used to bind predicate /
/// CRUD values; unsupported bind types are a §5 human error.
pub fn json_to_cql(val: &Value, cql_type: &str) -> Result<CqlValue, AppError> {
    let bt = base_type(cql_type);
    // A blank string / null binds as a typed NULL-ish empty — callers guard
    // against null keys, so this only reaches non-key scalar writes.
    match bt {
        "text" | "varchar" | "ascii" => Ok(CqlValue::Text(as_string(val))),
        "int" => Ok(CqlValue::Int(as_i64(val)? as i32)),
        "smallint" => Ok(CqlValue::SmallInt(as_i64(val)? as i16)),
        "tinyint" => Ok(CqlValue::TinyInt(as_i64(val)? as i8)),
        "bigint" => Ok(CqlValue::BigInt(as_i64(val)?)),
        "double" => Ok(CqlValue::Double(as_f64(val)?)),
        "float" => Ok(CqlValue::Float(as_f64(val)? as f32)),
        "boolean" => Ok(CqlValue::Boolean(as_bool(val))),
        "uuid" => Ok(CqlValue::Uuid(parse_uuid(val)?)),
        "timeuuid" => Ok(CqlValue::Timeuuid(parse_timeuuid(val)?)),
        "timestamp" => Ok(CqlValue::Timestamp(CqlTimestamp(as_i64(val)?))),
        "inet" => {
            let s = as_string(val);
            s.parse()
                .map(CqlValue::Inet)
                .map_err(|_| AppError::Invalid(format!("'{s}' is not a valid IP address")))
        }
        "blob" => {
            let s = as_string(val);
            let hex = s.trim().strip_prefix("0x").unwrap_or(s.trim());
            decode_hex(hex).map(CqlValue::Blob).ok_or_else(|| {
                AppError::Invalid(format!("'{s}' is not valid hex (0x…) for a blob"))
            })
        }
        "list" | "set" => {
            let inner = inner_types(cql_type);
            let elem = inner.first().copied().unwrap_or("text");
            let arr = match val {
                Value::Array(a) => a.clone(),
                Value::Null => Vec::new(),
                other => vec![other.clone()],
            };
            let mut items = Vec::new();
            for x in &arr {
                items.push(json_to_cql(x, elem)?);
            }
            if bt == "set" {
                Ok(CqlValue::Set(items))
            } else {
                Ok(CqlValue::List(items))
            }
        }
        "map" => {
            let inner = inner_types(cql_type);
            let kt = inner.first().copied().unwrap_or("text");
            let vt = inner.get(1).copied().unwrap_or("text");
            let obj = match val {
                Value::Object(o) => o.clone(),
                _ => serde_json::Map::new(),
            };
            let mut pairs = Vec::new();
            for (k, v) in &obj {
                pairs.push((
                    json_to_cql(&Value::String(k.clone()), kt)?,
                    json_to_cql(v, vt)?,
                ));
            }
            Ok(CqlValue::Map(pairs))
        }
        other => Err(AppError::Unsupported(format!(
            "Filtering / editing a '{other}' value is not supported yet."
        ))),
    }
}

/// Split the parameter list of a parametric CQL type — `map<text,text>` →
/// `["text", "text"]`, `set<text>` → `["text"]`, scalar → `[]`. Splits on the
/// top-level comma only (so nested generics survive).
fn inner_types(cql_type: &str) -> Vec<&str> {
    let start = match cql_type.find('<') {
        Some(i) => i + 1,
        None => return Vec::new(),
    };
    let end = cql_type.rfind('>').unwrap_or(cql_type.len());
    let inner = &cql_type[start..end];
    let mut parts = Vec::new();
    let mut depth = 0;
    let mut last = 0;
    for (i, ch) in inner.char_indices() {
        match ch {
            '<' => depth += 1,
            '>' => depth -= 1,
            ',' if depth == 0 => {
                parts.push(inner[last..i].trim());
                last = i + 1;
            }
            _ => {}
        }
    }
    parts.push(inner[last..].trim());
    parts.into_iter().filter(|s| !s.is_empty()).collect()
}

/// Decode a lowercase/uppercase hex string (even length) to bytes.
pub fn decode_hex(hex: &str) -> Option<Vec<u8>> {
    if !hex.len().is_multiple_of(2) {
        return None;
    }
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).ok())
        .collect()
}

/// The head of a CQL type — `set<text>` → `set`, `map<a,b>` → `map`.
pub fn base_type(t: &str) -> &str {
    match t.split_once('<') {
        Some((head, _)) => head.trim(),
        None => t.trim(),
    }
}

fn as_string(val: &Value) -> String {
    match val {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn as_i64(val: &Value) -> Result<i64, AppError> {
    match val {
        Value::Number(n) => n
            .as_i64()
            .or_else(|| n.as_f64().map(|f| f as i64))
            .ok_or_else(|| AppError::Invalid("expected an integer".into())),
        Value::String(s) => s
            .trim()
            .parse()
            .map_err(|_| AppError::Invalid(format!("'{s}' is not a valid integer"))),
        _ => Err(AppError::Invalid("expected an integer".into())),
    }
}

fn as_f64(val: &Value) -> Result<f64, AppError> {
    match val {
        Value::Number(n) => n
            .as_f64()
            .ok_or_else(|| AppError::Invalid("expected a number".into())),
        Value::String(s) => s
            .trim()
            .parse()
            .map_err(|_| AppError::Invalid(format!("'{s}' is not a valid number"))),
        _ => Err(AppError::Invalid("expected a number".into())),
    }
}

fn as_bool(val: &Value) -> bool {
    match val {
        Value::Bool(b) => *b,
        Value::String(s) => s.eq_ignore_ascii_case("true"),
        _ => false,
    }
}

fn parse_uuid(val: &Value) -> Result<uuid::Uuid, AppError> {
    let s = as_string(val);
    uuid::Uuid::parse_str(s.trim())
        .map_err(|_| AppError::Invalid(format!("'{s}' is not a valid uuid")))
}

fn parse_timeuuid(val: &Value) -> Result<scylla::value::CqlTimeuuid, AppError> {
    Ok(scylla::value::CqlTimeuuid::from(parse_uuid(val)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_from_days_matches_known_dates() {
        assert_eq!(civil_from_days(0), "1970-01-01");
        assert_eq!(civil_from_days(19_723), "2024-01-01");
    }

    #[test]
    fn cql_to_json_maps_scalars_and_collections() {
        assert_eq!(
            cql_to_json(&CqlValue::Text("hi".into())),
            Value::String("hi".into())
        );
        assert_eq!(cql_to_json(&CqlValue::Int(7)), serde_json::json!(7));
        assert_eq!(
            cql_to_json(&CqlValue::Boolean(true)),
            serde_json::json!(true)
        );
        let set = CqlValue::Set(vec![CqlValue::Text("a".into()), CqlValue::Text("b".into())]);
        assert_eq!(cql_to_json(&set), serde_json::json!(["a", "b"]));
        let map = CqlValue::Map(vec![(
            CqlValue::Text("k".into()),
            CqlValue::Text("v".into()),
        )]);
        assert_eq!(cql_to_json(&map), serde_json::json!({ "k": "v" }));
    }

    #[test]
    fn json_to_cql_binds_common_types() {
        assert!(matches!(
            json_to_cql(&serde_json::json!("42"), "int").unwrap(),
            CqlValue::Int(42)
        ));
        assert!(matches!(
            json_to_cql(&serde_json::json!(true), "boolean").unwrap(),
            CqlValue::Boolean(true)
        ));
        assert!(json_to_cql(&serde_json::json!("not-a-uuid"), "uuid").is_err());
        assert!(json_to_cql(&serde_json::json!("x"), "blob").is_err());
    }

    #[test]
    fn base_type_strips_parameters() {
        assert_eq!(base_type("set<text>"), "set");
        assert_eq!(base_type("map<text,text>"), "map");
        assert_eq!(base_type("uuid"), "uuid");
    }

    #[test]
    fn inner_types_splits_top_level_params() {
        assert_eq!(inner_types("set<text>"), vec!["text"]);
        assert_eq!(inner_types("map<text,int>"), vec!["text", "int"]);
        assert_eq!(
            inner_types("map<text,frozen<list<int>>>"),
            vec!["text", "frozen<list<int>>"]
        );
        assert!(inner_types("uuid").is_empty());
    }

    #[test]
    fn json_to_cql_binds_collections() {
        let set = json_to_cql(&serde_json::json!(["a", "b"]), "set<text>").unwrap();
        assert!(matches!(set, CqlValue::Set(ref v) if v.len() == 2));
        let map = json_to_cql(&serde_json::json!({ "k": "v" }), "map<text,text>").unwrap();
        assert!(matches!(map, CqlValue::Map(ref v) if v.len() == 1));
    }

    #[test]
    fn decode_hex_round_trips() {
        assert_eq!(decode_hex("0a1b"), Some(vec![0x0a, 0x1b]));
        assert_eq!(decode_hex("abc"), None);
    }
}
