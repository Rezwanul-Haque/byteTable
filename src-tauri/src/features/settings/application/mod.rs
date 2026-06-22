//! Use-cases for the settings slice. Depend on domain + ports only.

use crate::shared::error::AppError;

use super::domain::Settings;
use super::ports::SettingsStore;

/// Fetch the user's current settings (the on-disk mirror).
///
/// `?Sized` lets callers pass trait objects (`&dyn SettingsStore + ...`) as
/// well as concrete adapters and test fakes.
pub fn get_settings<S: SettingsStore + ?Sized>(store: &S) -> Result<Settings, AppError> {
    store.load()
}

/// Persist new settings to the on-disk mirror.
pub fn set_settings<S: SettingsStore + ?Sized>(
    store: &S,
    settings: Settings,
) -> Result<(), AppError> {
    store.save(&settings)
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;
    use crate::features::settings::domain::Theme;

    /// In-memory fake implementing the port.
    #[derive(Default)]
    struct FakeStore {
        saved: RefCell<Option<Settings>>,
        fail: bool,
    }

    impl SettingsStore for FakeStore {
        fn load(&self) -> Result<Settings, AppError> {
            if self.fail {
                return Err(AppError::Io("disk on fire".into()));
            }
            Ok(self.saved.borrow().clone().unwrap_or_default())
        }

        fn save(&self, settings: &Settings) -> Result<(), AppError> {
            if self.fail {
                return Err(AppError::Io("disk on fire".into()));
            }
            *self.saved.borrow_mut() = Some(settings.clone());
            Ok(())
        }
    }

    #[test]
    fn get_settings_returns_defaults_from_empty_store() {
        let store = FakeStore::default();
        assert_eq!(get_settings(&store).expect("load"), Settings::default());
    }

    #[test]
    fn set_then_get_round_trips() {
        let store = FakeStore::default();
        let wanted = Settings {
            theme: Theme::Monokai,
            confirm_prod: false,
            ..Settings::default()
        };
        set_settings(&store, wanted.clone()).expect("save");
        assert_eq!(get_settings(&store).expect("load"), wanted);
    }

    #[test]
    fn store_failures_propagate() {
        let store = FakeStore {
            fail: true,
            ..FakeStore::default()
        };
        assert!(get_settings(&store).is_err());
        assert!(set_settings(&store, Settings::default()).is_err());
    }
}
