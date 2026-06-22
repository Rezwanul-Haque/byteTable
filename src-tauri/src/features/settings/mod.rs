//! Settings slice (M20): theme, accent, fonts, sizes, and behavior flags —
//! the full preferences contract surfaced by the Settings modal.
//!
//! Layering (dependencies point left): domain ← application ← (infrastructure | commands).
//!
//! Like the preferences slice, this deliberately uses *sync* commands and a
//! sync port: it only reads/writes a tiny local JSON file, which is
//! effectively instant. The renderer's localStorage copy is the source of
//! truth; this on-disk file is a mirror (survives a localStorage clear, is
//! file-editable).

pub mod application;
pub mod commands;
pub mod domain;
pub mod infrastructure;
pub mod ports;
