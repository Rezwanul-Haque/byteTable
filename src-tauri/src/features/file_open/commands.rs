//! Tauri command handler for the file-association slice: the queue the OS
//! fills before the frontend exists, and the one command that drains it.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::State;

use crate::shared::error::AppError;

use super::{describe, PendingOpen};

/// Largest SQL script loaded into an editor tab. A `.sql` file can be a
/// multi-gigabyte dump, and the editor holds its text in memory in the webview
/// — refusing with a clear message beats freezing the window. Generous enough
/// for any hand-written migration or schema dump.
const MAX_SCRIPT_BYTES: u64 = 8 * 1024 * 1024;

/// Paths the OS asked us to open that the frontend has not taken yet.
///
/// Stateful by necessity, like the metrics sampler: a double-click that LAUNCHES
/// the app delivers its path long before there is a webview to emit to, so the
/// path has to wait somewhere that outlives the request.
#[derive(Default)]
pub struct PendingOpens {
    paths: Mutex<Vec<PathBuf>>,
}

impl PendingOpens {
    /// Queue `paths`, skipping any already waiting — a file can be delivered
    /// twice (argv on a cold start AND an `Opened` event on macOS), and opening
    /// the same database twice would be two workspaces on one file.
    pub fn push(&self, paths: Vec<PathBuf>) {
        let mut queue = self.paths.lock().unwrap();
        for path in paths {
            if !queue.contains(&path) {
                queue.push(path);
            }
        }
    }

    /// Take everything queued, leaving it empty.
    pub fn take(&self) -> Vec<PathBuf> {
        std::mem::take(&mut *self.paths.lock().unwrap())
    }
}

/// Drain the queue of files the OS asked us to open, each tagged with what to
/// do about it. Called once by the frontend on mount; returns `[]` on an
/// ordinary launch.
#[tauri::command]
pub fn file_open_take_pending(
    state: State<'_, PendingOpens>,
) -> Result<Vec<PendingOpen>, AppError> {
    Ok(describe(state.take()))
}

/// Read a `.sql` script for an editor tab.
///
/// Here rather than in the frontend because ByteTable ships no filesystem
/// plugin — the renderer cannot read an arbitrary path, and granting it that
/// to load one script would be a much wider permission than the feature needs.
///
/// Decoded lossily: a script with a stray non-UTF-8 byte (a Latin-1 comment in
/// an old dump) should still open, with that byte visible as a replacement
/// character, rather than refuse entirely.
#[tauri::command]
pub fn file_open_read_script(path: String) -> Result<String, AppError> {
    let path = Path::new(&path);
    let meta = std::fs::metadata(path)
        .map_err(|e| AppError::Io(format!("Could not read {}: {e}", path.display())))?;
    if !meta.is_file() {
        return Err(AppError::Invalid(format!(
            "{} is not a file",
            path.display()
        )));
    }
    if meta.len() > MAX_SCRIPT_BYTES {
        return Err(AppError::Invalid(format!(
            "{} is {:.1} MB — too large to open in the editor (limit {} MB)",
            path.display(),
            meta.len() as f64 / (1024.0 * 1024.0),
            MAX_SCRIPT_BYTES / (1024 * 1024)
        )));
    }
    let bytes = std::fs::read(path)
        .map_err(|e| AppError::Io(format!("Could not read {}: {e}", path.display())))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_script_as_text() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("seed.sql");
        std::fs::write(&path, "SELECT 1;\n").expect("write");
        let text = file_open_read_script(path.to_string_lossy().into_owned()).expect("read");
        assert_eq!(text, "SELECT 1;\n");
    }

    #[test]
    fn decodes_a_stray_non_utf8_byte_instead_of_refusing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("latin1.sql");
        std::fs::write(&path, b"-- caf\xe9\nSELECT 1;").expect("write");
        let text = file_open_read_script(path.to_string_lossy().into_owned()).expect("read");
        assert!(text.contains("SELECT 1;"), "script body survives: {text}");
    }

    #[test]
    fn refuses_a_directory() {
        let dir = tempfile::tempdir().expect("tempdir");
        let err = file_open_read_script(dir.path().to_string_lossy().into_owned())
            .expect_err("a directory is not a script");
        assert!(matches!(err, AppError::Invalid(_)));
    }

    #[test]
    fn reports_a_missing_file_as_io() {
        let err = file_open_read_script("/nope/missing.sql".into()).expect_err("missing");
        assert!(matches!(err, AppError::Io(_)));
    }

    #[test]
    fn dedupes_the_queue_so_one_file_opens_once() {
        let queue = PendingOpens::default();
        queue.push(vec![PathBuf::from("/d/a.db"), PathBuf::from("/d/a.db")]);
        queue.push(vec![PathBuf::from("/d/a.db")]);
        assert_eq!(queue.take(), vec![PathBuf::from("/d/a.db")]);
        assert!(queue.take().is_empty(), "taking empties the queue");
    }
}
