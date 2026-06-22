//! Infrastructure adapters for the settings slice.

use std::fs;
use std::path::PathBuf;

use crate::shared::error::AppError;

use super::domain::Settings;
use super::ports::SettingsStore;

/// Stores settings as pretty-printed JSON at a fixed path
/// (`<app_config_dir>/settings.json` in production; any path in tests).
///
/// Behavior choices mirror the preferences store deliberately:
/// - Missing file → defaults. First launch is not an error.
/// - Corrupt file → defaults, with a log line on stderr. Settings are
///   low-stakes; silently resetting beats blocking startup. The corrupt file
///   is left in place and overwritten on the next save.
/// - Saves are atomic: write to a sibling temp file, then rename over the
///   target, so a crash mid-write never leaves a truncated file.
pub struct JsonFileSettingsStore {
    path: PathBuf,
}

impl JsonFileSettingsStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }
}

impl SettingsStore for JsonFileSettingsStore {
    fn load(&self) -> Result<Settings, AppError> {
        let contents = match fs::read_to_string(&self.path) {
            Ok(contents) => contents,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Settings::default());
            }
            Err(err) => return Err(err.into()),
        };
        match serde_json::from_str(&contents) {
            Ok(settings) => Ok(settings),
            Err(err) => {
                eprintln!(
                    "settings: {} is corrupt ({err}); falling back to defaults",
                    self.path.display()
                );
                Ok(Settings::default())
            }
        }
    }

    fn save(&self, settings: &Settings) -> Result<(), AppError> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(settings)?;
        let tmp_path = self.path.with_extension("json.tmp");
        fs::write(&tmp_path, json)?;
        fs::rename(&tmp_path, &self.path)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::settings::domain::Theme;

    fn store_in(dir: &tempfile::TempDir) -> JsonFileSettingsStore {
        JsonFileSettingsStore::new(dir.path().join("settings.json"))
    }

    #[test]
    fn load_missing_file_returns_defaults() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = store_in(&dir);
        assert_eq!(store.load().expect("load"), Settings::default());
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = store_in(&dir);
        let settings = Settings {
            theme: Theme::Gruvbox,
            font_size: 15,
            relative_time: true,
            ..Settings::default()
        };
        store.save(&settings).expect("save");
        assert_eq!(store.load().expect("load"), settings);
    }

    #[test]
    fn save_writes_pretty_json_and_leaves_no_temp_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = store_in(&dir);
        store.save(&Settings::default()).expect("save");
        let contents = fs::read_to_string(dir.path().join("settings.json")).expect("read back");
        assert!(contents.contains('\n'), "expected pretty-printed JSON");
        assert!(contents.contains("\"theme\": \"charcoal\""));
        assert!(!dir.path().join("settings.json.tmp").exists());
    }

    #[test]
    fn corrupt_file_falls_back_to_defaults() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("settings.json");
        fs::write(&path, "{ not valid json !!!").expect("write corrupt file");
        let store = JsonFileSettingsStore::new(path);
        assert_eq!(store.load().expect("load"), Settings::default());
    }

    #[test]
    fn partial_file_merges_over_defaults() {
        // A file an older build wrote with only a couple of keys still loads.
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("settings.json");
        fs::write(&path, r#"{"theme":"dracula","fontSize":16}"#).expect("write");
        let store = JsonFileSettingsStore::new(path);
        let loaded = store.load().expect("load");
        assert_eq!(loaded.theme, Theme::Dracula);
        assert_eq!(loaded.font_size, 16);
        assert_eq!(loaded.mono_font, "jetbrains");
        assert!(loaded.restore_tabs);
    }
}
