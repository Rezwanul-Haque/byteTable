//! A notebook on disk: read it, write it atomically, and stat it.
//!
//! Here rather than in the renderer because ByteTable ships no filesystem
//! plugin, and granting the webview arbitrary file access to save one
//! Markdown file would be a far wider permission than the feature needs. The
//! path always comes from the user: a save / open dialog, a drop, the OS
//! "Open With", or the recent list built from those.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

use crate::shared::error::AppError;

/// Largest notebook read. A notebook is prose, SQL and at most 20 rows per
/// result; anything near this is not one.
pub const MAX_NOTEBOOK_BYTES: u64 = 8 * 1024 * 1024;

/// Extensions a notebook may be WRITTEN to. Writing is the dangerous half, so
/// it is held to Markdown: a renderer bug can never overwrite a database file
/// or a script through this command.
const WRITABLE: [&str; 2] = ["md", "markdown"];

fn io(path: &Path, e: std::io::Error) -> AppError {
    AppError::Io(format!("{}: {e}", path.display()))
}

/// Read a notebook file as text. Lossy UTF-8, like the script reader: a stray
/// byte should show as a replacement character, not refuse the file.
pub fn read(path: &Path) -> Result<String, AppError> {
    let meta = std::fs::metadata(path).map_err(|e| io(path, e))?;
    if !meta.is_file() {
        return Err(AppError::Invalid(format!(
            "{} is not a file",
            path.display()
        )));
    }
    if meta.len() > MAX_NOTEBOOK_BYTES {
        return Err(AppError::Invalid(format!(
            "{} is {:.1} MB — too large to open as a notebook",
            path.display(),
            meta.len() as f64 / (1024.0 * 1024.0)
        )));
    }
    let bytes = std::fs::read(path).map_err(|e| io(path, e))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Write `text` to `path` atomically: into a temporary file beside it, synced,
/// then renamed over the target. A crash leaves either the old file or the
/// new one, never half of either.
pub fn write(path: &Path, text: &str) -> Result<(), AppError> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if !WRITABLE.contains(&ext.as_str()) {
        return Err(AppError::Invalid(format!(
            "A notebook is saved as a Markdown file (.md); {} is not one.",
            path.display()
        )));
    }
    let dir = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "notebook.md".into());
    let tmp: PathBuf = dir.join(format!(".{name}.bt-{}.tmp", std::process::id()));
    let result = (|| {
        let mut f = std::fs::File::create(&tmp).map_err(|e| io(&tmp, e))?;
        f.write_all(text.as_bytes()).map_err(|e| io(&tmp, e))?;
        f.sync_all().map_err(|e| io(&tmp, e))?;
        std::fs::rename(&tmp, path).map_err(|e| io(path, e))
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// When a file last changed, and its size — enough to notice an outside edit
/// without reading the file. `None` when it is gone.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub modified_ms: u64,
    pub size: u64,
}

pub fn stat(path: &Path) -> Option<FileStat> {
    let meta = std::fs::metadata(path).ok().filter(|m| m.is_file())?;
    let modified_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64);
    Some(FileStat {
        modified_ms,
        size: meta.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_then_reads_back_and_leaves_no_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("review.md");
        write(&path, "# One\n").unwrap();
        write(&path, "# Two\n").unwrap();
        assert_eq!(read(&path).unwrap(), "# Two\n");
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["review.md"]);
    }

    #[test]
    fn refuses_to_write_anything_but_markdown() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["app.db", "seed.sql", "notes.txt", "noext"] {
            assert!(write(&dir.path().join(name), "x").is_err(), "{name}");
        }
        assert!(write(&dir.path().join("a.MARKDOWN"), "x").is_ok());
    }

    #[test]
    fn stat_sees_a_change_and_a_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("n.md");
        assert_eq!(stat(&path), None);
        write(&path, "a").unwrap();
        let first = stat(&path).unwrap();
        write(&path, "abc").unwrap();
        assert_eq!(stat(&path).unwrap().size, 3);
        assert_eq!(first.size, 1);
    }

    #[test]
    fn reads_lossily_and_refuses_a_directory() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("l.md");
        std::fs::write(&path, b"caf\xe9").unwrap();
        assert!(read(&path).unwrap().starts_with("caf"));
        assert!(read(dir.path()).is_err());
    }
}
