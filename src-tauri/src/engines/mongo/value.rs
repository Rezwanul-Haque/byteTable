//! BSON ⇄ tagged-`serde_json::Value` marshalling (M18).
//!
//! The renderer never sees raw `bson` Extended JSON. The MongoDB port family
//! ([`crate::shared::mongo`]) speaks plain JSON with the prototype's
//! Extended-JSON tags (`mongo-data.js` `OID`/`DATE`):
//!
//! - an ObjectId is `{ "$oid": "<24 hex>" }`,
//! - an ISODate is `{ "$date": "<rfc3339>" }`,
//! - everything else is a plain JSON scalar / array / object.
//!
//! `bson_to_json` unmarshals a driver value into that tagged shape;
//! `json_to_bson` marshals it back for writes, so an ObjectId / ISODate
//! survives read → edit → write (MILESTONE_18 safety contract).

use mongodb::bson::{Bson, Document};
use serde_json::{Map, Number, Value};

/// Unmarshal one BSON value into a tagged plain-JSON value.
pub fn bson_to_json(b: &Bson) -> Value {
    match b {
        Bson::ObjectId(oid) => {
            let mut m = Map::new();
            m.insert("$oid".into(), Value::String(oid.to_hex()));
            Value::Object(m)
        }
        Bson::DateTime(dt) => {
            let mut m = Map::new();
            let iso = dt
                .try_to_rfc3339_string()
                .unwrap_or_else(|_| dt.to_string());
            m.insert("$date".into(), Value::String(iso));
            Value::Object(m)
        }
        Bson::Double(f) => Number::from_f64(*f)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        Bson::Int32(i) => Value::Number((*i).into()),
        Bson::Int64(i) => Value::Number((*i).into()),
        Bson::String(s) => Value::String(s.clone()),
        Bson::Boolean(v) => Value::Bool(*v),
        Bson::Null | Bson::Undefined => Value::Null,
        Bson::Array(a) => Value::Array(a.iter().map(bson_to_json).collect()),
        Bson::Document(d) => doc_to_json(d),
        Bson::Decimal128(d) => Value::String(d.to_string()),
        Bson::Binary(bin) => {
            use base64::Engine as _;
            Value::String(base64::engine::general_purpose::STANDARD.encode(&bin.bytes))
        }
        Bson::RegularExpression(re) => Value::String(format!("/{}/{}", re.pattern, re.options)),
        Bson::Timestamp(ts) => {
            let mut m = Map::new();
            m.insert(
                "$timestamp".into(),
                Value::String(format!("{}:{}", ts.time, ts.increment)),
            );
            Value::Object(m)
        }
        // Forward-compat: any other variant stringifies rather than panics.
        other => Value::String(format!("{other:?}")),
    }
}

/// Unmarshal a whole BSON document into a JSON object.
pub fn doc_to_json(doc: &Document) -> Value {
    let mut obj = Map::new();
    for (k, v) in doc {
        obj.insert(k.clone(), bson_to_json(v));
    }
    Value::Object(obj)
}

/// The single string value of a one-key tagged object (`{ "$oid": "…" }`),
/// when `value` has exactly that key and a string payload.
fn tagged_str<'a>(value: &'a Value, tag: &str) -> Option<&'a str> {
    let obj = value.as_object()?;
    if obj.len() != 1 {
        return None;
    }
    obj.get(tag)?.as_str()
}

/// Marshal one tagged JSON value back into BSON (the inverse of
/// [`bson_to_json`]). A `{$oid}` / `{$date}` tag round-trips to a real
/// `ObjectId` / `DateTime`; a malformed tag falls back to a plain document so
/// the write is never silently dropped.
pub fn json_to_bson(value: &Value) -> Bson {
    match value {
        Value::Null => Bson::Null,
        Value::Bool(b) => Bson::Boolean(*b),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                if let Ok(small) = i32::try_from(i) {
                    Bson::Int32(small)
                } else {
                    Bson::Int64(i)
                }
            } else if let Some(u) = n.as_u64() {
                Bson::Int64(u as i64)
            } else {
                Bson::Double(n.as_f64().unwrap_or(0.0))
            }
        }
        Value::String(s) => Bson::String(s.clone()),
        Value::Array(a) => Bson::Array(a.iter().map(json_to_bson).collect()),
        Value::Object(_) => {
            if let Some(hex) = tagged_str(value, "$oid") {
                if let Ok(oid) = mongodb::bson::oid::ObjectId::parse_str(hex) {
                    return Bson::ObjectId(oid);
                }
            }
            if let Some(iso) = tagged_str(value, "$date") {
                if let Ok(dt) = mongodb::bson::DateTime::parse_rfc3339_str(iso) {
                    return Bson::DateTime(dt);
                }
            }
            Bson::Document(json_to_doc(value))
        }
    }
}

/// Marshal a JSON object into a BSON document. Non-object input yields an empty
/// document — callers validate shape first.
pub fn json_to_doc(value: &Value) -> Document {
    let mut doc = Document::new();
    if let Value::Object(obj) = value {
        for (k, v) in obj {
            doc.insert(k.clone(), json_to_bson(v));
        }
    }
    doc
}

/// The BSON type name of a tagged JSON value, mirroring `mongo-engine.js`
/// `bsonType` (used by schema inference). Integers vs doubles are distinguished
/// the same way the prototype does (`Number.isInteger`).
pub fn json_bson_type(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "bool",
        Value::Number(n) => {
            if n.is_f64() && n.as_f64().map(|f| f.fract() != 0.0).unwrap_or(false) {
                "double"
            } else {
                "int"
            }
        }
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => {
            if tagged_str(v, "$oid").is_some() {
                "objectId"
            } else if tagged_str(v, "$date").is_some() {
                "date"
            } else {
                "object"
            }
        }
    }
}

/// First-seen-order field union across documents, for the schemaless grid's
/// column set (matches `mongo-engine.js` `fieldUnion`). The renderer computes
/// the grid's column union itself; this is kept for backend-side use (export).
#[allow(dead_code)]
pub fn field_union(docs: &[Value]) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut cols = Vec::new();
    for d in docs {
        if let Value::Object(obj) = d {
            for k in obj.keys() {
                if seen.insert(k.clone()) {
                    cols.push(k.clone());
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
    fn object_id_round_trips_through_the_oid_tag() {
        let oid = mongodb::bson::oid::ObjectId::parse_str("64a1b00c0d0e0f1011121314").unwrap();
        let json = bson_to_json(&Bson::ObjectId(oid));
        assert_eq!(json["$oid"], "64a1b00c0d0e0f1011121314");
        let back = json_to_bson(&json);
        assert_eq!(back, Bson::ObjectId(oid));
    }

    #[test]
    fn date_round_trips_through_the_date_tag() {
        let dt = mongodb::bson::DateTime::parse_rfc3339_str("2026-06-18T12:00:00Z").unwrap();
        let json = bson_to_json(&Bson::DateTime(dt));
        assert!(json["$date"].is_string());
        assert_eq!(json_to_bson(&json), Bson::DateTime(dt));
    }

    #[test]
    fn nested_doc_and_scalars_round_trip() {
        let doc = json_to_doc(&serde_json::json!({
            "sku": "KEY-1001",
            "price": 129,
            "active": true,
            "attributes": { "weightG": 800 },
            "tags": ["rgb", "hotswap"],
        }));
        let back = doc_to_json(&doc);
        assert_eq!(back["sku"], "KEY-1001");
        assert_eq!(back["price"], 129);
        assert_eq!(back["active"], true);
        assert_eq!(back["attributes"]["weightG"], 800);
        assert_eq!(back["tags"][0], "rgb");
    }

    #[test]
    fn bson_type_distinguishes_tags_and_numbers() {
        assert_eq!(
            json_bson_type(&serde_json::json!({ "$oid": "x" })),
            "objectId"
        );
        assert_eq!(json_bson_type(&serde_json::json!({ "$date": "x" })), "date");
        assert_eq!(json_bson_type(&serde_json::json!(12)), "int");
        assert_eq!(json_bson_type(&serde_json::json!(12.5)), "double");
        assert_eq!(json_bson_type(&serde_json::json!("hi")), "string");
    }
}
