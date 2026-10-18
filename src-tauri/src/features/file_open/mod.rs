//! OS file-association slice: opening a `.sqlite` / `.sqlite3` / `.db` file by
//! double-clicking it in Finder / Explorer / a file manager.
//!
//! The association itself is declared in `tauri.conf.json` (`bundle
//! .fileAssociations`) — that is what puts ByteTable in the OS "Open With"
//! list and lets the user make it the default. This slice is the RUNTIME half:
//! receiving the path the OS hands us and getting it to the frontend, which
//! already knows how to open a SQLite path (`useOpenSqliteFile`) and SQL text
//! (`openSqlTabWith`).
//!
//! THE PATH ARRIVES TWO COMPLETELY DIFFERENT WAYS, which is the whole reason
//! this is a slice and not three lines in `lib.rs`:
//!
//!   - macOS sends an Apple Event, surfaced by Tauri as `RunEvent::Opened`,
//!     both on cold start and while the app is already running. The process is
//!     NOT relaunched and the path is NOT in `argv`.
//!   - Windows and Linux pass the path as a command-line argument. On a cold
//!     start it is in `std::env::args()`; when an instance is already running
//!     the second process hands its argv to the single-instance plugin, which
//!     forwards it to the running one (see `lib.rs`).
//!
//! THE COLD-START RACE: the open request routinely lands before the frontend
//! is listening, so THE QUEUE IS THE ONLY SOURCE OF TRUTH and
//! `file_open_take_pending` is the only way a path leaves it. The event carries
//! NO PAYLOAD — it is a nudge meaning "drain the queue", nothing more.
//!
//! An earlier version emitted the paths themselves and only queued them when no
//! window existed yet. That lost every cold open: the window is created during
//! `build()`, so it already exists when the Apple Event arrives, and the paths
//! were emitted to a webview that had not loaded its JavaScript yet. "A window
//! exists" is not "the frontend has subscribed", and nothing here can know when
//! the latter becomes true — hence a queue the frontend pulls from, rather than
//! a push that assumes someone is home.

pub mod commands;

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

pub use commands::PendingOpens;

/// Nudge telling the frontend to drain the queue. Carries NO payload: the
/// paths live in `PendingOpens`, and a copy in the event would be a second
/// source of truth that an unmounted listener could silently drop. Namespaced
/// like `tray://…`.
pub const FILE_OPEN_EVENT: &str = "file-open://pending";

/// What the frontend should DO with an opened path. Classification lives here,
/// beside the extension lists, so the frontend never re-derives it from a file
/// name — the two would drift the first time an extension is added.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum OpenKind {
    /// A SQLite database: open it as a workspace, as the connect screen does.
    Database,
    /// A SQL script: load its text into an editor tab. NOT a connection — a
    /// script has no database of its own, which is why it needs one open.
    Script,
}

/// One path the OS asked us to open, with what to do about it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PendingOpen {
    pub path: String,
    pub kind: OpenKind,
}

/// Database extensions. MUST stay in step with TWO other lists, which is the
/// whole reason this comment exists:
///
///   - `bundle.fileAssociations` in `tauri.conf.json` — the config decides what
///     the OS offers us, this decides what we accept, and a path that is
///     offered but not accepted would be silently dropped;
///   - the "Open SQLite file…" picker filter in `src/features/connections/
///     dialog.ts` — a file the app will open from its own dialog but not from a
///     double-click is a difference a user has no way to explain.
const DATABASE_EXTENSIONS: [&str; 4] = ["sqlite", "sqlite3", "db", "db3"];

/// Script extensions. Separate list, not a flag on the one above, because the
/// two take completely different routes through the app: a database becomes a
/// workspace, a script becomes text in a tab belonging to a workspace that
/// already exists.
const SCRIPT_EXTENSIONS: [&str; 1] = ["sql"];

/// What `path` is to us, by extension, case-insensitively. `None` for anything
/// we do not claim.
fn classify(path: &Path) -> Option<OpenKind> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    if DATABASE_EXTENSIONS.contains(&ext.as_str()) {
        Some(OpenKind::Database)
    } else if SCRIPT_EXTENSIONS.contains(&ext.as_str()) {
        Some(OpenKind::Script)
    } else {
        None
    }
}

/// Classify a queue of paths for the frontend. `to_string_lossy` rather than a
/// failure on non-UTF-8: a path we cannot represent is better surfaced as a
/// "could not open" in the UI than silently dropped here.
pub fn describe(paths: Vec<PathBuf>) -> Vec<PendingOpen> {
    paths
        .into_iter()
        .filter_map(|p| {
            classify(&p).map(|kind| PendingOpen {
                path: p.to_string_lossy().into_owned(),
                kind,
            })
        })
        .collect()
}

/// The database paths in a process argv, ignoring the binary itself and any
/// flags. Used for the Windows/Linux cold start and for the argv the
/// single-instance plugin forwards.
///
/// Deliberately filtered by extension rather than taking "the first argument":
/// a launcher may pass flags, and on Linux a `.desktop` `Exec` line with `%F`
/// can pass several files at once.
pub fn paths_from_args<I, S>(args: I) -> Vec<PathBuf>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter()
        .skip(1) // argv[0] is the binary
        .map(|a| PathBuf::from(a.as_ref()))
        .filter(|p| classify(p).is_some())
        .collect()
}

/// Queue `paths` for the frontend and nudge it to come and get them.
///
/// `try_state`, never `state`: the latter PANICS when the type is not managed,
/// and with `panic = "abort"` that kills the process. This runs at the earliest
/// moment in the app's life — macOS delivers the open-documents Apple Event
/// before `setup` — so "not managed yet" has to degrade into a dropped file
/// open, never a crash. The builder manages the queue precisely so this cannot
/// happen; this is the second lock on that door.
///
/// The emit is best-effort and deliberately unconditional: if nobody is
/// listening yet the nudge is lost, and the frontend's own drain-on-mount
/// collects the paths instead. Nothing is removed from the queue here.
pub fn queue_open(app: &AppHandle, paths: Vec<PathBuf>) {
    if paths.is_empty() {
        return;
    }
    let Some(state) = app.try_state::<PendingOpens>() else {
        return;
    };
    state.push(paths);
    let _ = app.emit(FILE_OPEN_EVENT, ());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_databases_case_insensitively() {
        for name in ["a.sqlite", "a.SQLite", "a.sqlite3", "a.DB", "a.db", "a.db3"] {
            assert_eq!(
                classify(Path::new(name)),
                Some(OpenKind::Database),
                "{name}"
            );
        }
    }

    #[test]
    fn classifies_scripts_separately_from_databases() {
        for name in ["a.sql", "a.SQL", "migrations/001_init.sql"] {
            assert_eq!(classify(Path::new(name)), Some(OpenKind::Script), "{name}");
        }
    }

    #[test]
    fn rejects_everything_else() {
        for name in ["a.csv", "a.txt", "a", "a.dbf", ".db"] {
            assert_eq!(classify(Path::new(name)), None, "{name}");
        }
    }

    #[test]
    fn describe_tags_each_path_with_what_to_do_about_it() {
        let described = describe(vec![
            PathBuf::from("/d/app.db"),
            PathBuf::from("/d/seed.sql"),
        ]);
        assert_eq!(
            described,
            vec![
                PendingOpen {
                    path: "/d/app.db".into(),
                    kind: OpenKind::Database
                },
                PendingOpen {
                    path: "/d/seed.sql".into(),
                    kind: OpenKind::Script
                },
            ]
        );
    }

    #[test]
    fn argv_skips_the_binary_and_any_flags() {
        let args = [
            "/usr/bin/bytetable",
            "--flag",
            "/data/app.sqlite",
            "notes.txt",
        ];
        assert_eq!(
            paths_from_args(args),
            vec![PathBuf::from("/data/app.sqlite")]
        );
    }

    #[test]
    fn argv_takes_every_file_a_desktop_entry_passed() {
        let args = ["bytetable", "one.db", "two.sqlite3"];
        assert_eq!(
            paths_from_args(args),
            vec![PathBuf::from("one.db"), PathBuf::from("two.sqlite3")]
        );
    }

    #[test]
    fn argv_with_no_files_is_an_ordinary_launch() {
        assert!(paths_from_args(["bytetable"]).is_empty());
        assert!(paths_from_args(Vec::<String>::new()).is_empty());
    }
}
