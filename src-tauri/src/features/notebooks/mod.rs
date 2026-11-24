//! Query notebooks slice (M47): the parts of a notebook that need the OS or a
//! connection. The notebook itself — the Markdown file format, the cells, what
//! runs when — is the renderer's; this slice only gives it:
//!
//! - `domain` — classifying a cell's statement (read / write / transaction
//!   control), on the shared read-only check. Pure and unit-tested.
//! - `files` — reading a `.md` file, writing one atomically (a temporary file
//!   renamed over the target, so a crash never leaves half a notebook), and a
//!   cheap stat the renderer polls to notice a change on disk (`git pull`).
//! - `commands` — those, plus a query run a Stop can cancel, and the quit
//!   guard that keeps ⌘Q / tray Quit from discarding unsaved notebooks.

pub mod commands;
pub mod domain;
pub mod files;
