//! Shared kernel: the only cross-slice surface (errors, engine abstraction).
//!
//! Slices must never reach into each other's internals — anything reused
//! between slices lives here.

pub mod error;

// Engine port families are grouped under `ports/`; re-exported here at their
// historical paths so `crate::shared::engine` (= the SQL family) /
// `crate::shared::keyvalue` / … keep resolving unchanged (the grouping is
// physical only).
mod ports;
pub use ports::sql as engine;
pub use ports::{document, keyvalue, mongo, widecolumn};
