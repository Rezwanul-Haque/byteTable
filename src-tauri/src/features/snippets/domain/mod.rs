//! Domain model for snippets. Pure value objects; the only outward dependency
//! is `serde`.
//!
//! Design note: as in the saved-queries slice, the plain `serde` derives below
//! double as the wire/persisted representation (camelCase fields) so the
//! renderer's TS literals match exactly.

use serde::{Deserialize, Serialize};

/// A reusable SQL fragment, inserted at the caret.
///
/// - `id` is a UUID assigned by the save use-case when empty (new entry).
/// - `name` is the human label shown in the manager and in autocomplete.
/// - `abbreviation` is what the user types to trigger it from the editor's
///   completion list (`sel` → `SELECT …`). Optional: a snippet with none is
///   still insertable from the manager, it just has no shorthand. Matched
///   case-insensitively by the renderer.
/// - `body` is the fragment, which may contain `#{1:label}` tab stops (and
///   `#{0}` for the final caret). Their meaning is the EDITOR's (CodeMirror's
///   snippet syntax), so this slice stores the body verbatim and never parses
///   it.
/// - `engine` optionally restricts the snippet to one engine's workspaces
///   (`postgres`, `mysql`, …), for dialect-specific SQL. `None`/absent = offered
///   everywhere. Opaque and unvalidated here: the renderer owns the engine
///   vocabulary, and an unknown value simply matches no workspace rather than
///   making the whole library unreadable.
/// - `saved_at` is Unix epoch milliseconds, assigned on first save.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub abbreviation: Option<String>,
    pub body: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine: Option<String>,
    pub saved_at: u64,
}

impl Snippet {
    /// Validate a snippet's user-supplied fields. Returns a human message
    /// (DESIGN_SPEC §5) on the first blank required field, in field order:
    /// name, then body. Both are checked after trimming, so a spaces-only
    /// entry is rejected like an empty one.
    ///
    /// The abbreviation is NOT required and not checked for uniqueness: two
    /// snippets sharing one are a usability wrinkle (both show up in the
    /// completion list) rather than a correctness problem, and rejecting the
    /// save would be the more annoying answer.
    pub fn validation_error(&self) -> Option<&'static str> {
        if self.name.trim().is_empty() {
            return Some("Snippet name is required.");
        }
        if self.body.trim().is_empty() {
            return Some("Snippet body is required.");
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Snippet {
        Snippet {
            id: "abc-123".into(),
            name: "Recent rows".into(),
            abbreviation: Some("recent".into()),
            body: "SELECT *\nFROM #{1:table}\nORDER BY #{2:id} DESC\nLIMIT #{3:50};".into(),
            engine: None,
            saved_at: 1_700_000_000_000,
        }
    }

    #[test]
    fn wire_format_is_camel_case_and_omits_the_absent_optionals() {
        let json = serde_json::to_value(Snippet {
            abbreviation: None,
            ..sample()
        })
        .expect("serialize");
        assert_eq!(
            json,
            serde_json::json!({
                "id": "abc-123",
                "name": "Recent rows",
                "body": "SELECT *\nFROM #{1:table}\nORDER BY #{2:id} DESC\nLIMIT #{3:50};",
                "savedAt": 1_700_000_000_000u64,
            })
        );
        assert!(json.get("abbreviation").is_none());
        assert!(json.get("engine").is_none());
    }

    #[test]
    fn wire_format_includes_the_optionals_when_set() {
        let scoped = Snippet {
            engine: Some("postgres".into()),
            ..sample()
        };
        let json = serde_json::to_value(&scoped).expect("serialize");
        assert_eq!(json.get("abbreviation"), Some(&serde_json::json!("recent")));
        assert_eq!(json.get("engine"), Some(&serde_json::json!("postgres")));
        let back: Snippet = serde_json::from_value(json).expect("deserialize");
        assert_eq!(back, scoped);
    }

    #[test]
    fn optionals_are_optional_on_the_wire() {
        let json = serde_json::json!({
            "id": "x",
            "name": "n",
            "body": "SELECT 1",
            "savedAt": 0u64,
        });
        let snippet: Snippet = serde_json::from_value(json).expect("deserialize");
        assert_eq!(snippet.abbreviation, None);
        assert_eq!(snippet.engine, None);
    }

    #[test]
    fn tab_stops_in_the_body_round_trip_untouched() {
        // The body is the EDITOR's syntax; this slice must not interpret it.
        let snippet = sample();
        let json = serde_json::to_string(&snippet).expect("serialize");
        let back: Snippet = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back.body, snippet.body);
        assert!(back.body.contains("#{1:table}"));
    }

    #[test]
    fn validation_accepts_a_complete_snippet() {
        assert_eq!(sample().validation_error(), None);
    }

    #[test]
    fn validation_rejects_blank_name_first_then_blank_body() {
        let blank_name = Snippet {
            name: "  ".into(),
            ..sample()
        };
        assert_eq!(
            blank_name.validation_error(),
            Some("Snippet name is required.")
        );

        let blank_body = Snippet {
            body: "\t\n".into(),
            ..sample()
        };
        assert_eq!(
            blank_body.validation_error(),
            Some("Snippet body is required.")
        );
    }

    #[test]
    fn validation_accepts_a_snippet_with_no_abbreviation() {
        let bare = Snippet {
            abbreviation: None,
            ..sample()
        };
        assert_eq!(bare.validation_error(), None);
    }
}
