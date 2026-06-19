//! DynamoDB `AttributeValue` ⇄ `serde_json::Value` marshalling (M17).
//!
//! The renderer never sees DynamoDB-typed JSON (`{"S":"…"}`) — the document
//! port family ([`crate::shared::document`]) speaks plain JSON. This module is
//! the translation layer, mirroring the prototype's `marshal`/`unmarshal`
//! (`bytetable/dynamo-export.js` / `dynamo-import.js`):
//!
//! - **Unmarshal** (`attr_to_json`): `S`→string, `N`→number (i64/u64/f64, else
//!   string to preserve precision), `BOOL`→bool, `NULL`→null, `L`→array,
//!   `M`→object, `SS`→string array, `NS`→number array, `B`/`BS`→base64 string.
//! - **Marshal** (`json_to_attr`): the inverse for writes — string→`S`,
//!   number→`N` (stringified), bool→`BOOL`, null→`NULL`, array→`L`, object→`M`.

use std::collections::HashMap;

use aws_sdk_dynamodb::types::AttributeValue;
use base64::Engine as _;
use serde_json::{Map, Value};

/// Parse a DynamoDB `N` string into the tightest JSON number, falling back to a
/// string when it would lose precision or isn't finite (the CellValue-style
/// precision contract: never silently mangle a big number).
fn number_from_n(n: &str) -> Value {
    if let Ok(i) = n.parse::<i64>() {
        return Value::from(i);
    }
    if let Ok(u) = n.parse::<u64>() {
        return Value::from(u);
    }
    // Only take the lossy f64 path for genuine decimals/scientific notation. A
    // pure integer that overflowed i64/u64 would lose precision as an f64, so it
    // stays a string (the CellValue-style precision contract). DynamoDB allows
    // 38 significant digits — well beyond f64.
    if n.contains(['.', 'e', 'E']) {
        if let Ok(f) = n.parse::<f64>() {
            if let Some(num) = serde_json::Number::from_f64(f) {
                return Value::Number(num);
            }
        }
    }
    Value::String(n.to_string())
}

/// Unmarshal one `AttributeValue` into a plain JSON value.
pub fn attr_to_json(av: &AttributeValue) -> Value {
    match av {
        AttributeValue::S(s) => Value::String(s.clone()),
        AttributeValue::N(n) => number_from_n(n),
        AttributeValue::Bool(b) => Value::Bool(*b),
        AttributeValue::Null(_) => Value::Null,
        AttributeValue::L(list) => Value::Array(list.iter().map(attr_to_json).collect()),
        AttributeValue::M(map) => {
            let mut obj = Map::new();
            for (k, v) in map {
                obj.insert(k.clone(), attr_to_json(v));
            }
            Value::Object(obj)
        }
        AttributeValue::Ss(items) => {
            Value::Array(items.iter().map(|s| Value::String(s.clone())).collect())
        }
        AttributeValue::Ns(items) => Value::Array(items.iter().map(|n| number_from_n(n)).collect()),
        AttributeValue::B(blob) => {
            Value::String(base64::engine::general_purpose::STANDARD.encode(blob.as_ref()))
        }
        AttributeValue::Bs(blobs) => Value::Array(
            blobs
                .iter()
                .map(|b| {
                    Value::String(base64::engine::general_purpose::STANDARD.encode(b.as_ref()))
                })
                .collect(),
        ),
        // Forward-compat: any new variant unmarshals to null rather than panics.
        _ => Value::Null,
    }
}

/// Marshal one plain JSON value into a DynamoDB `AttributeValue`.
pub fn json_to_attr(value: &Value) -> AttributeValue {
    match value {
        Value::Null => AttributeValue::Null(true),
        Value::Bool(b) => AttributeValue::Bool(*b),
        Value::Number(n) => AttributeValue::N(n.to_string()),
        Value::String(s) => AttributeValue::S(s.clone()),
        Value::Array(items) => AttributeValue::L(items.iter().map(json_to_attr).collect()),
        Value::Object(obj) => {
            let mut map = HashMap::new();
            for (k, v) in obj {
                map.insert(k.clone(), json_to_attr(v));
            }
            AttributeValue::M(map)
        }
    }
}

/// Unmarshal a whole item (the DynamoDB `HashMap` form) into a JSON object.
pub fn item_to_json(item: &HashMap<String, AttributeValue>) -> Value {
    let mut obj = Map::new();
    for (k, v) in item {
        obj.insert(k.clone(), attr_to_json(v));
    }
    Value::Object(obj)
}

/// Marshal a JSON object into a DynamoDB item (`HashMap`). Non-object input
/// yields an empty item — callers validate shape before calling.
pub fn json_to_item(value: &Value) -> HashMap<String, AttributeValue> {
    let mut map = HashMap::new();
    if let Value::Object(obj) = value {
        for (k, v) in obj {
            map.insert(k.clone(), json_to_attr(v));
        }
    }
    map
}

/// First-seen-order attribute union across items, for the schemaless grid's
/// column set (matches the prototype's `attributeUnion`).
pub fn attribute_union(items: &[Value]) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut cols = Vec::new();
    for item in items {
        if let Value::Object(obj) = item {
            for key in obj.keys() {
                if seen.insert(key.clone()) {
                    cols.push(key.clone());
                }
            }
        }
    }
    cols
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_scalars_and_collections() {
        let item: Value = serde_json::json!({
            "PK": "USER#1",
            "count": 42,
            "price": 12.5,
            "active": true,
            "deleted": null,
            "tags": ["a", "b"],
            "shipping": { "method": "express", "fast": true }
        });
        let marshalled = json_to_item(&item);
        let back = item_to_json(&marshalled);
        assert_eq!(back["PK"], "USER#1");
        assert_eq!(back["count"], 42);
        assert_eq!(back["price"], 12.5);
        assert_eq!(back["active"], true);
        assert!(back["deleted"].is_null());
        assert_eq!(back["tags"][1], "b");
        assert_eq!(back["shipping"]["method"], "express");
    }

    #[test]
    fn big_number_n_falls_back_to_string_to_keep_precision() {
        let v = attr_to_json(&AttributeValue::N("123456789012345678901234567890".into()));
        assert!(v.is_string());
    }

    #[test]
    fn attribute_union_preserves_first_seen_order() {
        let items = vec![
            serde_json::json!({ "PK": "1", "name": "a" }),
            serde_json::json!({ "PK": "2", "email": "x@y" }),
        ];
        assert_eq!(attribute_union(&items), vec!["PK", "name", "email"]);
    }
}
