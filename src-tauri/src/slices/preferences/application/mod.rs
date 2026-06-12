//! Use-cases for the preferences slice. Depend on domain + ports only.

use crate::shared::error::AppError;

use super::domain::Preferences;
use super::ports::PreferencesStore;

/// Fetch the user's current preferences.
pub fn get_preferences<S: PreferencesStore>(store: &S) -> Result<Preferences, AppError> {
    store.load()
}

/// Persist new preferences.
pub fn set_preferences<S: PreferencesStore>(
    store: &S,
    preferences: Preferences,
) -> Result<(), AppError> {
    store.save(&preferences)
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;
    use crate::slices::preferences::domain::{Accent, Darkness, Density};

    /// In-memory fake implementing the port.
    #[derive(Default)]
    struct FakeStore {
        saved: RefCell<Option<Preferences>>,
        fail: bool,
    }

    impl PreferencesStore for FakeStore {
        fn load(&self) -> Result<Preferences, AppError> {
            if self.fail {
                return Err(AppError::Io("disk on fire".into()));
            }
            Ok(self.saved.borrow().unwrap_or_default())
        }

        fn save(&self, preferences: &Preferences) -> Result<(), AppError> {
            if self.fail {
                return Err(AppError::Io("disk on fire".into()));
            }
            *self.saved.borrow_mut() = Some(*preferences);
            Ok(())
        }
    }

    #[test]
    fn get_preferences_returns_defaults_from_empty_store() {
        let store = FakeStore::default();
        let prefs = get_preferences(&store).expect("load");
        assert_eq!(prefs, Preferences::default());
    }

    #[test]
    fn set_then_get_round_trips() {
        let store = FakeStore::default();
        let wanted = Preferences {
            accent: Accent::Amber,
            darkness: Darkness::Soft,
            density: Density::Comfortable,
        };
        set_preferences(&store, wanted).expect("save");
        assert_eq!(get_preferences(&store).expect("load"), wanted);
    }

    #[test]
    fn store_failures_propagate() {
        let store = FakeStore {
            fail: true,
            ..FakeStore::default()
        };
        assert!(get_preferences(&store).is_err());
        assert!(set_preferences(&store, Preferences::default()).is_err());
    }
}
