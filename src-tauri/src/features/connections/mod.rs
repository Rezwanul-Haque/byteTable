//! Connections slice: the saved-connection registry and live connection
//! handles (open/test/close, schema + table introspection, minimal query
//! execution for M2).
//!
//! Layering (dependencies point left): domain ← application ← (infrastructure | commands).
//!
//! This slice touches databases, so all commands are `async fn` and the
//! engine ports are async (see the async-commands rule in
//! `crate::shared::engine`). Engine-specific code never appears here — it
//! lives in `crate::engines::*` adapters reached through the shared
//! `Connector`/`EngineConnection` traits.

pub mod application;
pub mod commands;
pub mod domain;
pub mod infrastructure;
pub mod ports;
