//! Preferences slice: theme darkness, accent color, and UI density.
//!
//! Layering (dependencies point left): domain ← application ← (infrastructure | commands).
//!
//! This slice deliberately uses *sync* commands and a sync port: it only
//! reads/writes a tiny local JSON file, which is effectively instant. This is
//! the exception, not the template — DB-touching slices MUST use `async fn`
//! commands and async ports (see the async commands rule in
//! `crate::shared::engine`).

pub mod application;
pub mod commands;
pub mod domain;
pub mod infrastructure;
pub mod ports;
