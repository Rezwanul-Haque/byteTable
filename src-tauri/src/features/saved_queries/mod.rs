//! Saved-queries slice: a GLOBAL store of named SQL snippets, shared across
//! every workspace (DESIGN_SPEC §3.7 — "saved queries: global store,
//! persisted"; MILESTONES M6 — "save a query in workspace A, load it from
//! workspace B"). There is exactly one registry for the whole app, not one
//! per workspace.
//!
//! Layering (dependencies point left): domain ← application ← (infrastructure | commands).
//!
//! Like the preferences and connections slices, the backing store is a small
//! local JSON file, so the persistence port is *sync*. The Tauri commands are
//! still `async fn` for consistency with the rest of the app's command
//! surface; calling the sync port inline from them is fine because each call
//! is effectively instant (see the note on `SavedQueryRepository`).
//!
//! Saved queries are USER DATA, so this slice follows the connections slice's
//! "corrupt file = error, not silent reset" stance rather than the
//! preferences slice's "corrupt = default".

pub mod application;
pub mod commands;
pub mod domain;
pub mod infrastructure;
pub mod ports;
