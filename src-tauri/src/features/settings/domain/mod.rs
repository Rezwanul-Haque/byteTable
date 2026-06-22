//! Domain model for the full user-settings contract (M20): theme, accent,
//! fonts, sizes, and behavior flags. Pure value objects with no outward
//! dependencies.
//!
//! Design note: as in the preferences slice, the plain `serde` derives below
//! double as the wire/persisted representation. Enums use `rename_all =
//! "camelCase"` so their values match the renderer's TS string-literal ids
//! exactly (e.g. `"oneDark"`, `"tokyoNight"`), and the struct uses
//! `rename_all = "camelCase"` to match the TS `Settings` keys (`monoFont`,
//! `fontSize`, …).
//!
//! Forward-merge: every field carries `#[serde(default = ...)]`, so a settings
//! file written by an older build (missing keys) loads cleanly with the
//! missing keys filled from `DEFAULTS`, and unknown/removed keys are ignored
//! (no `deny_unknown_fields`). This is the "merge over DEFAULTS" rule.

use serde::{Deserialize, Serialize};

/// One of the twelve curated theme palettes. The renderer owns the actual
/// color values (`catalogs.ts`); the domain only needs the identity so it can
/// round-trip the user's choice.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Theme {
    #[default]
    Charcoal,
    Midnight,
    Slate,
    OneDark,
    Dracula,
    Nord,
    TokyoNight,
    Monokai,
    Solarized,
    Gruvbox,
    GithubDark,
    Daybreak,
    Parchment,
    Sky,
}

/// UI (chrome) font family. The mono font is a free-form id (curated key or
/// `"sys:<Family>"`), so it stays a `String`; the UI font is a closed set.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UiFont {
    #[default]
    PlexSans,
    System,
    Jakarta,
    PublicSans,
}

/// Vertical density of the data grid.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Density {
    #[default]
    Compact,
    Comfortable,
}

fn default_theme() -> Theme {
    Theme::default()
}
fn default_accent() -> String {
    "auto".to_string()
}
fn default_mono_font() -> String {
    "jetbrains".to_string()
}
fn default_ui_font() -> UiFont {
    UiFont::default()
}
fn default_font_size() -> u8 {
    13
}
fn default_density() -> Density {
    Density::default()
}
fn default_default_limit() -> u32 {
    300
}
fn default_true() -> bool {
    true
}

/// The full settings contract. Defaults mirror `DEFAULTS` in `settings.js` /
/// `api.ts` exactly.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default = "default_theme")]
    pub theme: Theme,
    /// `"auto"` (use the theme's own accent) or a `#rrggbb` hex string.
    #[serde(default = "default_accent")]
    pub accent: String,
    /// Curated key (`"jetbrains"`) or a probed system face (`"sys:SF Mono"`).
    #[serde(default = "default_mono_font")]
    pub mono_font: String,
    #[serde(default = "default_ui_font")]
    pub ui_font: UiFont,
    /// Monospace base size in px (editor); the grid renders at `font_size - 1`.
    /// Clamped to 10..=18 by the renderer's `apply`.
    #[serde(default = "default_font_size")]
    pub font_size: u8,
    #[serde(default = "default_density")]
    pub density: Density,
    #[serde(default = "default_true")]
    pub ligatures: bool,
    #[serde(default)]
    pub reduce_motion: bool,
    #[serde(default = "default_true")]
    pub highlight_row: bool,
    #[serde(default)]
    pub relative_time: bool,
    #[serde(default = "default_true")]
    pub confirm_prod: bool,
    /// Rows fetched before paging — 100, 300, or 1000 in the UI.
    #[serde(default = "default_default_limit")]
    pub default_limit: u32,
    #[serde(default = "default_true")]
    pub restore_tabs: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: default_theme(),
            accent: default_accent(),
            mono_font: default_mono_font(),
            ui_font: default_ui_font(),
            font_size: default_font_size(),
            density: default_density(),
            ligatures: true,
            reduce_motion: false,
            highlight_row: true,
            relative_time: false,
            confirm_prod: true,
            default_limit: default_default_limit(),
            restore_tabs: true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_matches_the_contract() {
        let s = Settings::default();
        assert_eq!(s.theme, Theme::Charcoal);
        assert_eq!(s.accent, "auto");
        assert_eq!(s.mono_font, "jetbrains");
        assert_eq!(s.ui_font, UiFont::PlexSans);
        assert_eq!(s.font_size, 13);
        assert_eq!(s.density, Density::Compact);
        assert!(s.ligatures);
        assert!(!s.reduce_motion);
        assert!(s.highlight_row);
        assert!(!s.relative_time);
        assert!(s.confirm_prod);
        assert_eq!(s.default_limit, 300);
        assert!(s.restore_tabs);
    }

    #[test]
    fn wire_format_uses_camelcase_keys_and_enum_ids() {
        let json = serde_json::to_string(&Settings {
            theme: Theme::TokyoNight,
            ui_font: UiFont::PublicSans,
            ..Settings::default()
        })
        .expect("serialize");
        assert!(json.contains(r#""theme":"tokyoNight""#), "{json}");
        assert!(json.contains(r#""uiFont":"publicSans""#), "{json}");
        assert!(json.contains(r#""monoFont":"jetbrains""#), "{json}");
        assert!(json.contains(r#""fontSize":13"#), "{json}");
        assert!(json.contains(r#""reduceMotion":false"#), "{json}");
        assert!(json.contains(r#""defaultLimit":300"#), "{json}");
    }

    #[test]
    fn round_trip_preserves_every_field() {
        let s = Settings {
            theme: Theme::Dracula,
            accent: "#5aa7f5".to_string(),
            mono_font: "sys:SF Mono".to_string(),
            ui_font: UiFont::Jakarta,
            font_size: 16,
            density: Density::Comfortable,
            ligatures: false,
            reduce_motion: true,
            highlight_row: false,
            relative_time: true,
            confirm_prod: false,
            default_limit: 1000,
            restore_tabs: false,
        };
        let json = serde_json::to_string(&s).expect("serialize");
        let back: Settings = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, s);
    }

    #[test]
    fn partial_json_fills_missing_keys_from_defaults() {
        // A file written by an older build that only knew about theme + accent.
        let back: Settings =
            serde_json::from_str(r##"{"theme":"nord","accent":"#b08cff"}"##).expect("deserialize");
        assert_eq!(back.theme, Theme::Nord);
        assert_eq!(back.accent, "#b08cff");
        // Everything else falls back to the contract defaults.
        assert_eq!(back.mono_font, "jetbrains");
        assert_eq!(back.font_size, 13);
        assert!(back.ligatures);
        assert_eq!(back.default_limit, 300);
        assert!(back.restore_tabs);
    }

    #[test]
    fn unknown_or_removed_keys_are_ignored() {
        // `darkness` was a preferences-era key; a future build might drop a key.
        let back: Settings =
            serde_json::from_str(r#"{"theme":"slate","darkness":"black","someFutureKey":42}"#)
                .expect("deserialize");
        assert_eq!(back.theme, Theme::Slate);
        assert_eq!(
            back,
            Settings {
                theme: Theme::Slate,
                ..Settings::default()
            }
        );
    }

    #[test]
    fn empty_object_is_all_defaults() {
        let back: Settings = serde_json::from_str("{}").expect("deserialize");
        assert_eq!(back, Settings::default());
    }
}
