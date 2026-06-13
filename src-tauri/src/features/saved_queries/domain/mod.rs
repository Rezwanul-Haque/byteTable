//! Domain model for saved queries. Pure value objects; the only outward
//! dependency is `serde`.
//!
//! Design note: as in the connections slice, the plain `serde` derives below
//! double as the wire/persisted representation (camelCase fields) so the
//! renderer's TS literals match exactly.

use serde::{Deserialize, Serialize};

/// A named SQL snippet the user has saved. The store is global — the same
/// entry is visible from every workspace.
///
/// - `id` is a UUID assigned by the save use-case when empty (new entry).
/// - `saved_at` is Unix epoch milliseconds, assigned on first save (kept as a
///   plain integer to avoid pulling a date-time crate for one field, mirroring
///   connections' `created_at`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedQuery {
    pub id: String,
    pub name: String,
    pub sql: String,
    pub saved_at: u64,
}

impl SavedQuery {
    /// Validate a saved query's user-supplied fields. Returns a human message
    /// (DESIGN_SPEC §5) on the first blank field, in field order: name, then
    /// SQL. Both are required and are checked after trimming whitespace so a
    /// spaces-only entry is rejected like an empty one.
    pub fn validation_error(&self) -> Option<&'static str> {
        if self.name.trim().is_empty() {
            return Some("Query name is required.");
        }
        if self.sql.trim().is_empty() {
            return Some("Query SQL is required.");
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
        }
    }

    #[test]
    fn wire_format_is_camel_case() {
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
}
