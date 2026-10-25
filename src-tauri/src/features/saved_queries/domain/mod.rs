//! Domain model for saved queries. Pure value objects; the only outward
//! dependency is `serde`.
//!
//! Design note: as in the connections slice, the plain `serde` derives below
//! double as the wire/persisted representation (camelCase fields) so the
//! renderer's TS literals match exactly.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// One declared query parameter of a saved query: what to call it, how to ask
/// for it, and what to start from.
///
/// `kind` is deliberately an OPAQUE STRING, not an enum. Parameter substitution
/// happens entirely in the renderer (see `src/features/workspaces/sqlParams.ts`
/// for why the model is substitution rather than driver binding), so this slice
/// only stores and returns the kind — it never interprets it. Typing it here
/// would buy no safety and would cost real robustness: a kind written by a
/// newer build, or hand-edited in the JSON file, would fail to deserialize and
/// take the user's ENTIRE saved-query list down with it, against this slice's
/// "corrupt file = error, never silent data loss" stance. The renderer treats
/// an unknown kind as plain text.
///
/// Every field but `name` is optional and omitted from the wire when empty, so
/// a query with a bare `{ "name": "status" }` declaration stays that small.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParamDef {
    /// The placeholder name, without its `:` / `${}` (or "1", "2", … for a
    /// positional `?`).
    pub name: String,
    /// Prompt label; the renderer falls back to `name`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// How the value is rendered into SQL (`text`, `number`, `boolean`,
    /// `date`, `list`, `null`, `raw`). See the type docs on why this is a
    /// string.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// Starting value, used when nothing has been entered.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
    /// When non-empty, the prompt offers these instead of a free-text input.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub choices: Vec<String>,
}

/// A named SQL snippet the user has saved. The store is global, but a query
/// may optionally be attached to a single workspace.
///
/// - `id` is a UUID assigned by the save use-case when empty (new entry).
/// - `saved_at` is Unix epoch milliseconds, assigned on first save (kept as a
///   plain integer to avoid pulling a date-time crate for one field, mirroring
///   connections' `created_at`).
/// - `connection_id` is the OPTIONAL workspace attachment. Workspaces are
///   ephemeral (session-only `ws-<uuid>` ids), but their underlying
///   `SavedConnection` id is persisted, so the durable "attachment" is that
///   connection id. `None`/absent = global (visible in every workspace);
///   `Some(id)` = scoped to that saved connection's workspace. Opaque and
///   unvalidated. Serialized like connections' `created_at`: omitted from the
///   wire when `None`, so global queries keep their original shape.
/// - `params` declares the query's parameters ([`ParamDef`]) and
///   `param_values` remembers the values it last ran with, so reopening a
///   report query comes back ready to run. Both default to empty and are
///   omitted from the wire when empty, so every query saved before this
///   feature loads unchanged and is rewritten in its original shape.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedQuery {
    pub id: String,
    pub name: String,
    pub sql: String,
    pub saved_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
    /// Declared parameters, in prompt order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub params: Vec<ParamDef>,
    /// The values this query last ran with, keyed by parameter name.
    ///
    /// A `BTreeMap` rather than a `HashMap` so the JSON file has a stable key
    /// order — the store is pretty-printed user data that people do read and
    /// diff, and a map that reshuffles on every save makes that needlessly
    /// noisy. Values are kept as the raw text the user typed; the renderer
    /// turns them into SQL literals.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub param_values: BTreeMap<String, String>,
}

impl SavedQuery {
    /// Validate a saved query's user-supplied fields. Returns a human message
    /// (DESIGN_SPEC §5) on the first blank field, in field order: name, then
    /// SQL. Both are required and are checked after trimming whitespace so a
    /// spaces-only entry is rejected like an empty one.
    ///
    /// Parameter declarations are checked too: a blank or duplicated parameter
    /// name is rejected. Duplicates matter because the renderer resolves a
    /// declaration by name — two entries for `status` would make which one
    /// applies arbitrary, so the store must never hold them. The KIND is not
    /// validated here; it is opaque to this slice (see [`ParamDef`]).
    pub fn validation_error(&self) -> Option<&'static str> {
        if self.name.trim().is_empty() {
            return Some("Query name is required.");
        }
        if self.sql.trim().is_empty() {
            return Some("Query SQL is required.");
        }
        let mut seen: Vec<&str> = Vec::with_capacity(self.params.len());
        for param in &self.params {
            let name = param.name.trim();
            if name.is_empty() {
                return Some("Parameter name is required.");
            }
            if seen.contains(&name) {
                return Some("Parameter names must be unique.");
            }
            seen.push(name);
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> SavedQuery {
        SavedQuery {
            id: "abc-123".into(),
            name: "Recent users".into(),
            sql: "SELECT * FROM users".into(),
            saved_at: 1_700_000_000_000,
            connection_id: None,
            params: Vec::new(),
            param_values: BTreeMap::new(),
        }
    }

    fn param(name: &str) -> ParamDef {
        ParamDef {
            name: name.into(),
            label: None,
            kind: None,
            default: None,
            choices: Vec::new(),
        }
    }

    #[test]
    fn wire_format_is_camel_case_and_omits_connection_id_when_global() {
        let json = serde_json::to_value(sample()).expect("serialize");
        assert_eq!(
            json,
            serde_json::json!({
                "id": "abc-123",
                "name": "Recent users",
                "sql": "SELECT * FROM users",
                "savedAt": 1_700_000_000_000u64,
            })
        );
        // A global query must NOT carry the key at all.
        assert!(json.get("connectionId").is_none());
    }

    #[test]
    fn wire_format_includes_connection_id_when_scoped() {
        let scoped = SavedQuery {
            connection_id: Some("conn-1".into()),
            ..sample()
        };
        let json = serde_json::to_value(scoped).expect("serialize");
        assert_eq!(
            json,
            serde_json::json!({
                "id": "abc-123",
                "name": "Recent users",
                "sql": "SELECT * FROM users",
                "savedAt": 1_700_000_000_000u64,
                "connectionId": "conn-1",
            })
        );
    }

    #[test]
    fn wire_format_omits_empty_params_so_pre_feature_queries_keep_their_shape() {
        let json = serde_json::to_value(sample()).expect("serialize");
        assert!(json.get("params").is_none());
        assert!(json.get("paramValues").is_none());
    }

    #[test]
    fn wire_format_includes_params_and_values_when_declared() {
        let mut values = BTreeMap::new();
        values.insert("status".to_string(), "paid".to_string());
        let parameterized = SavedQuery {
            sql: "SELECT * FROM orders WHERE status = :status".into(),
            params: vec![ParamDef {
                name: "status".into(),
                label: Some("Order status".into()),
                kind: Some("text".into()),
                default: Some("paid".into()),
                choices: vec!["paid".into(), "due".into()],
            }],
            param_values: values,
            ..sample()
        };
        let json = serde_json::to_value(&parameterized).expect("serialize");
        assert_eq!(
            json.get("params"),
            Some(&serde_json::json!([{
                "name": "status",
                "label": "Order status",
                "kind": "text",
                "default": "paid",
                "choices": ["paid", "due"],
            }]))
        );
        assert_eq!(
            json.get("paramValues"),
            Some(&serde_json::json!({ "status": "paid" }))
        );
        // And the whole thing survives a round trip.
        let back: SavedQuery = serde_json::from_value(json).expect("deserialize");
        assert_eq!(back, parameterized);
    }

    #[test]
    fn a_param_def_omits_every_field_it_has_nothing_for() {
        let json = serde_json::to_value(param("status")).expect("serialize");
        assert_eq!(json, serde_json::json!({ "name": "status" }));
    }

    #[test]
    fn params_and_values_are_optional_on_the_wire() {
        // The exact shape a build from before this feature wrote.
        let json = serde_json::json!({
            "id": "x",
            "name": "n",
            "sql": "SELECT 1",
            "savedAt": 0u64,
        });
        let query: SavedQuery = serde_json::from_value(json).expect("deserialize");
        assert!(query.params.is_empty());
        assert!(query.param_values.is_empty());
    }

    #[test]
    fn an_unknown_param_kind_still_deserializes() {
        // The kind is opaque on purpose: a value written by a newer build must
        // not make the whole store unreadable.
        let json = serde_json::json!({
            "id": "x",
            "name": "n",
            "sql": "SELECT :a",
            "savedAt": 0u64,
            "params": [{ "name": "a", "kind": "something-new" }],
        });
        let query: SavedQuery = serde_json::from_value(json).expect("deserialize");
        assert_eq!(query.params[0].kind.as_deref(), Some("something-new"));
    }

    #[test]
    fn connection_id_is_optional_on_the_wire() {
        let json = serde_json::json!({
            "id": "x",
            "name": "n",
            "sql": "SELECT 1",
            "savedAt": 0u64,
        });
        let query: SavedQuery = serde_json::from_value(json).expect("deserialize");
        assert_eq!(query.connection_id, None);
    }

    #[test]
    fn serde_round_trip_preserves_all_fields() {
        let query = sample();
        let json = serde_json::to_string(&query).expect("serialize");
        let back: SavedQuery = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, query);
    }

    #[test]
    fn validation_accepts_a_complete_query() {
        assert_eq!(sample().validation_error(), None);
    }

    #[test]
    fn validation_rejects_blank_name_first_then_blank_sql() {
        let blank_name = SavedQuery {
            name: "   ".into(),
            ..sample()
        };
        assert_eq!(
            blank_name.validation_error(),
            Some("Query name is required.")
        );

        let blank_sql = SavedQuery {
            sql: "\t\n".into(),
            ..sample()
        };
        assert_eq!(blank_sql.validation_error(), Some("Query SQL is required."));
    }

    #[test]
    fn validation_rejects_a_blank_parameter_name() {
        let query = SavedQuery {
            params: vec![param("  ")],
            ..sample()
        };
        assert_eq!(
            query.validation_error(),
            Some("Parameter name is required.")
        );
    }

    #[test]
    fn validation_rejects_duplicate_parameter_names() {
        let query = SavedQuery {
            params: vec![param("status"), param("status")],
            ..sample()
        };
        assert_eq!(
            query.validation_error(),
            Some("Parameter names must be unique.")
        );
    }

    #[test]
    fn validation_accepts_distinct_parameters_and_ignores_the_kind() {
        let query = SavedQuery {
            params: vec![
                ParamDef {
                    kind: Some("nonsense".into()),
                    ..param("status")
                },
                param("since"),
            ],
            ..sample()
        };
        assert_eq!(query.validation_error(), None);
    }
}
