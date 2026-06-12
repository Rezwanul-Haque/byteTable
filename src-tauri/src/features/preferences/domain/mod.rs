//! Domain model for user preferences. Pure value objects with no outward
//! dependencies.
//!
//! Design note: the plain `serde` derives below double as the wire/persisted
//! representation (`rename_all = "lowercase"` so enum values match the
//! renderer's TS string literals exactly, e.g. `"teal"`). This is the
//! documented exception to "no serde in domain" — these are dependency-free
//! value objects and a separate DTO layer would duplicate them 1:1.

use serde::{Deserialize, Serialize};

/// Accent color used for interactive elements.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Accent {
    #[default]
    Teal,
    Blue,
    Violet,
    Amber,
}

/// Background darkness of the theme.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Darkness {
    #[default]
    Charcoal,
    Black,
    Soft,
}

/// Vertical density of the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Density {
    #[default]
    Compact,
    Comfortable,
}

/// The user's appearance preferences. Defaults to teal / charcoal / compact.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    pub accent: Accent,
    pub darkness: Darkness,
    pub density: Density,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_teal_charcoal_compact() {
        let prefs = Preferences::default();
        assert_eq!(prefs.accent, Accent::Teal);
        assert_eq!(prefs.darkness, Darkness::Charcoal);
        assert_eq!(prefs.density, Density::Compact);
    }

    #[test]
    fn wire_format_uses_lowercase_string_literals() {
        let json = serde_json::to_string(&Preferences::default()).expect("serialize");
        assert_eq!(
            json,
            r#"{"accent":"teal","darkness":"charcoal","density":"compact"}"#
        );
    }

    #[test]
    fn serde_round_trip_preserves_all_fields() {
        let prefs = Preferences {
            accent: Accent::Violet,
            darkness: Darkness::Black,
            density: Density::Comfortable,
        };
        let json = serde_json::to_string(&prefs).expect("serialize");
        let back: Preferences = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, prefs);
    }

    #[test]
    fn rejects_unknown_enum_values() {
        let result = serde_json::from_str::<Preferences>(
            r#"{"accent":"crimson","darkness":"charcoal","density":"compact"}"#,
        );
        assert!(result.is_err());
    }
}
