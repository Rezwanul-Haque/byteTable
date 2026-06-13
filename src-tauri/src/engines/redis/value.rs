//! Pure mapping helpers between the `redis` crate's [`redis::Value`] and the
//! key-value port DTOs ([`RespReply`], stringly values). Kept driver-adjacent
//! but free of any I/O so they are unit-testable without a live server.

use redis::Value;

use crate::shared::keyvalue::RespReply;

/// Decode a RESP [`Value`] into a UTF-8 `String`, lossily for binary data
/// (ByteTable shows values as text; non-UTF-8 bytes become `�`). `Nil` maps to
/// the empty string — callers that care about nil check the variant first.
pub fn value_to_string(value: &Value) -> String {
    match value {
        Value::Nil => String::new(),
        Value::Int(n) => n.to_string(),
        Value::BulkString(bytes) => String::from_utf8_lossy(bytes).into_owned(),
        Value::SimpleString(s) => s.clone(),
        Value::Okay => "OK".to_string(),
        Value::Double(d) => format_f64(*d),
        Value::Boolean(b) => {
            if *b {
                "1".to_string()
            } else {
                "0".to_string()
            }
        }
        Value::BigNumber(n) => n.to_string(),
        // Aggregates have no single scalar form; the typed readers never call
        // this on them. Fall back to the debug-free joined form for safety.
        Value::Array(items) | Value::Set(items) => items
            .iter()
            .map(value_to_string)
            .collect::<Vec<_>>()
            .join(" "),
        Value::Map(pairs) => pairs
            .iter()
            .map(|(k, v)| format!("{}={}", value_to_string(k), value_to_string(v)))
            .collect::<Vec<_>>()
            .join(" "),
        Value::VerbatimString { text, .. } => text.clone(),
        Value::Attribute { data, .. } => value_to_string(data),
        Value::Push { data, .. } => data
            .iter()
            .map(value_to_string)
            .collect::<Vec<_>>()
            .join(" "),
        Value::ServerError(err) => err
            .details()
            .map(str::to_string)
            .unwrap_or_else(|| err.code().to_string()),
    }
}

/// Format an `f64` Redis score the way redis-cli prints it: integers without a
/// trailing `.0`, otherwise the shortest round-trippable decimal.
pub fn format_f64(d: f64) -> String {
    if d == d.trunc() && d.is_finite() && d.abs() < 1e15 {
        format!("{}", d as i64)
    } else {
        // `{}` on f64 already gives the shortest round-trip representation.
        format!("{d}")
    }
}

/// Map a RESP [`Value`] into the typed [`RespReply`] union for the CLI console,
/// **without formatting**. RESP3-only shapes are folded into the five wire
/// kinds the renderer understands (Map → flat array of k,v; Set → array;
/// Double/Boolean/BigNumber → bulk string; verbatim → bulk; a server error
/// `Value` → an `Error` reply, so `WRONGTYPE`/`ERR …` surface in the console
/// instead of throwing).
pub fn value_to_reply(value: Value) -> RespReply {
    match value {
        Value::Nil => RespReply::Bulk { value: None },
        Value::Int(n) => RespReply::Int { value: n },
        Value::BulkString(bytes) => RespReply::Bulk {
            value: Some(String::from_utf8_lossy(&bytes).into_owned()),
        },
        Value::SimpleString(s) => RespReply::Status { value: s },
        Value::Okay => RespReply::Status {
            value: "OK".to_string(),
        },
        Value::Array(items) | Value::Set(items) | Value::Push { data: items, .. } => {
            RespReply::Array {
                items: items.into_iter().map(value_to_reply).collect(),
            }
        }
        Value::Map(pairs) => {
            let mut items = Vec::with_capacity(pairs.len() * 2);
            for (k, v) in pairs {
                items.push(value_to_reply(k));
                items.push(value_to_reply(v));
            }
            RespReply::Array { items }
        }
        Value::Double(d) => RespReply::Bulk {
            value: Some(format_f64(d)),
        },
        Value::Boolean(b) => RespReply::Int {
            value: if b { 1 } else { 0 },
        },
        Value::BigNumber(n) => RespReply::Bulk {
            value: Some(n.to_string()),
        },
        Value::VerbatimString { text, .. } => RespReply::Bulk { value: Some(text) },
        Value::Attribute { data, .. } => value_to_reply(*data),
        Value::ServerError(err) => {
            // `ServerError` is not a nameable public type, but its `code()` /
            // `details()` accessors are public — build the redis-cli-style text
            // inline. The detail already begins with the code (`WRONGTYPE …`).
            let code = err.code();
            let text = match err.details() {
                Some(detail) if detail.starts_with(code) => detail.to_string(),
                Some(detail) => format!("{code} {detail}"),
                None => code.to_string(),
            };
            RespReply::Error { value: text }
        }
    }
}

/// The `redis-cli`-style error text for a driver [`redis::RedisError`] that the
/// server returned as an error reply (a top-level `-ERR`/`-WRONGTYPE`). Used by
/// `run_command` to turn a server error into a [`RespReply::Error`] rather than
/// an `AppError`. Returns `None` for non-server errors (I/O, parse) which are
/// real connection failures the caller surfaces as `AppError`.
pub fn redis_error_as_reply_text(err: &redis::RedisError) -> Option<String> {
    if err.is_io_error() || err.kind() == redis::ErrorKind::ParseError {
        return None;
    }
    let code = err.code().unwrap_or("ERR");
    match err.detail() {
        Some(detail) if detail.starts_with(code) => Some(detail.to_string()),
        Some(detail) => Some(format!("{code} {detail}")),
        None => Some(code.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_f64_drops_trailing_zero_for_integers() {
        assert_eq!(format_f64(42.0), "42");
        assert_eq!(format_f64(-7.0), "-7");
        assert_eq!(format_f64(12.5), "12.5");
        assert_eq!(format_f64(0.0), "0");
    }

    #[test]
    fn value_to_string_handles_scalars_and_lossy_utf8() {
        assert_eq!(value_to_string(&Value::Int(5)), "5");
        assert_eq!(
            value_to_string(&Value::BulkString(b"hello".to_vec())),
            "hello"
        );
        assert_eq!(value_to_string(&Value::Okay), "OK");
        assert_eq!(value_to_string(&Value::Double(3.5)), "3.5");
        assert_eq!(value_to_string(&Value::Nil), "");
        // invalid utf-8 becomes the replacement char, never panics
        let lossy = value_to_string(&Value::BulkString(vec![0xff, 0xfe]));
        assert!(lossy.contains('\u{fffd}'));
    }

    #[test]
    fn value_to_reply_maps_each_resp_shape() {
        assert_eq!(
            value_to_reply(Value::Okay),
            RespReply::Status { value: "OK".into() }
        );
        assert_eq!(value_to_reply(Value::Int(7)), RespReply::Int { value: 7 });
        assert_eq!(
            value_to_reply(Value::BulkString(b"hi".to_vec())),
            RespReply::Bulk {
                value: Some("hi".into())
            }
        );
        assert_eq!(value_to_reply(Value::Nil), RespReply::Bulk { value: None });

        // RESP3 Double folds to a bulk string formatted like redis-cli.
        assert_eq!(
            value_to_reply(Value::Double(2.0)),
            RespReply::Bulk {
                value: Some("2".into())
            }
        );

        // A nested array (HGETALL-shaped) keeps its structure.
        let nested = Value::Array(vec![
            Value::BulkString(b"field".to_vec()),
            Value::BulkString(b"value".to_vec()),
        ]);
        assert_eq!(
            value_to_reply(nested),
            RespReply::Array {
                items: vec![
                    RespReply::Bulk {
                        value: Some("field".into())
                    },
                    RespReply::Bulk {
                        value: Some("value".into())
                    },
                ]
            }
        );

        // A RESP3 map flattens to k,v,k,v.
        let map = Value::Map(vec![(
            Value::BulkString(b"k".to_vec()),
            Value::BulkString(b"v".to_vec()),
        )]);
        assert_eq!(
            value_to_reply(map),
            RespReply::Array {
                items: vec![
                    RespReply::Bulk {
                        value: Some("k".into())
                    },
                    RespReply::Bulk {
                        value: Some("v".into())
                    },
                ]
            }
        );
    }
}
