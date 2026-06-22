//! Ports: the traits the settings use-cases need. Implemented by
//! infrastructure adapters, faked in application tests.

use crate::shared::error::AppError;

use super::domain::Settings;

/// Persistence boundary for user settings. This is the on-disk *mirror* of the
/// renderer's localStorage copy (M20.1): the renderer remains the source of
/// truth, but the mirror lets settings survive a localStorage clear and be
/// edited as a file.
pub trait SettingsStore {
    /// Load the stored settings, falling back to defaults when nothing has
    /// been stored yet.
    fn load(&self) -> Result<Settings, AppError>;

    /// Persist the given settings.
    fn save(&self, settings: &Settings) -> Result<(), AppError>;
}
