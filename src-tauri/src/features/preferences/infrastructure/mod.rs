//! Infrastructure adapters for the preferences slice.

use std::fs;
use std::path::PathBuf;

use crate::shared::error::AppError;

use super::domain::Preferences;
use super::ports::PreferencesStore;

/// Stores preferences as pretty-printed JSON at a fixed path
/// (`<app_config_dir>/preferences.json` in production; any path in tests).
///
/// Behavior choices (documented deliberately):
/// - Missing file → defaults. First launch is not an error.
/// - Corrupt file → defaults, with a log line on stderr. Appearance settings
///   are low-stakes; silently resetting beats blocking startup. The corrupt
///   file is left in place and will be overwritten on the next save.
/// - Saves are atomic: write to a sibling temp file, then rename over the
///   target, so a crash mid-write never leaves a truncated file.
pub struct JsonFilePreferencesStore {
    path: PathBuf,
}

impl JsonFilePreferencesStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }
}

impl PreferencesStore for JsonFilePreferencesStore {
    fn load(&self) -> Result<Preferences, AppError> {
        let contents = match fs::read_to_string(&self.path) {
            Ok(contents) => contents,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Preferences::default());
            }
            Err(err) => return Err(err.into()),
        };
        match serde_json::from_str(&contents) {
            Ok(preferences) => Ok(preferences),
            Err(err) => {
                eprintln!(
                    "preferences: {} is corrupt ({err}); falling back to defaults",
                    self.path.display()
                );
                Ok(Preferences::default())
            }
        }
    }

    fn save(&self, preferences: &Preferences) -> Result<(), AppError> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(preferences)?;
        let tmp_path = self.path.with_extension("json.tmp");
        fs::write(&tmp_path, json)?;
        fs::rename(&tmp_path, &self.path)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::preferences::domain::{Accent, Darkness, Density};

    fn store_in(dir: &tempfile::TempDir) -> JsonFilePreferencesStore {
        JsonFilePreferencesStore::new(dir.path().join("preferences.json"))
    }

    #[test]
    fn load_missing_file_returns_defaults() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = store_in(&dir);
        assert_eq!(store.load().expect("load"), Preferences::default());
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = store_in(&dir);
        let prefs = Preferences {
            accent: Accent::Blue,
            darkness: Darkness::Black,
            density: Density::Comfortable,
        };
        store.save(&prefs).expect("save");
        assert_eq!(store.load().expect("load"), prefs);
    }

    #[test]
    fn save_writes_pretty_json_and_leaves_no_temp_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = store_in(&dir);
        store.save(&Preferences::default()).expect("save");
        let contents = fs::read_to_string(dir.path().join("preferences.json")).expect("read back");
        assert!(contents.contains('\n'), "expected pretty-printed JSON");
        assert!(contents.contains("\"accent\": \"teal\""));
        assert!(!dir.path().join("preferences.json.tmp").exists());
    }

    #[test]
    fn save_creates_missing_parent_directories() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store =
            JsonFilePreferencesStore::new(dir.path().join("nested/deeper/preferences.json"));
        let prefs = Preferences {
            accent: Accent::Violet,
            ..Preferences::default()
        };
        store.save(&prefs).expect("save");
        assert_eq!(store.load().expect("load"), prefs);
    }

    #[test]
    fn corrupt_file_falls_back_to_defaults() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("preferences.json");
        fs::write(&path, "{ not valid json !!!").expect("write corrupt file");
        let store = JsonFilePreferencesStore::new(path);
        assert_eq!(store.load().expect("load"), Preferences::default());
    }

    #[test]
    fn save_overwrites_previous_value() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = store_in(&dir);
        store.save(&Preferences::default()).expect("first save");
        let updated = Preferences {
            darkness: Darkness::Soft,
            ..Preferences::default()
        };
        store.save(&updated).expect("second save");
        assert_eq!(store.load().expect("load"), updated);
    }
}
