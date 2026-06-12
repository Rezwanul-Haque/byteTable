//! Ports: the traits the preferences use-cases need. Implemented by
//! infrastructure adapters, faked in application tests.

use crate::shared::error::AppError;

use super::domain::Preferences;

/// Persistence boundary for user preferences.
pub trait PreferencesStore {
    /// Load the stored preferences, falling back to defaults when nothing
    /// has been stored yet.
    fn load(&self) -> Result<Preferences, AppError>;

    /// Persist the given preferences.
    fn save(&self, preferences: &Preferences) -> Result<(), AppError>;
}
