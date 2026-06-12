//! Preferences slice: theme darkness, accent color, and UI density.
//!
//! Layering (dependencies point left): domain ← application ← (infrastructure | commands).

pub mod application;
pub mod commands;
pub mod domain;
pub mod infrastructure;
pub mod ports;
