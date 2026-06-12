//! Introspection slice: schema/table/column metadata as its own vertical
//! feature (per ARCHITECTURE). M3 starts it with column-level metadata for
//! the sidebar's expandable column lists (`table_meta`).
//!
//! The slice is deliberately thin: no domain or infrastructure of its own —
//! the wire DTOs live in `crate::shared::engine` (every slice that talks to
//! a connection shares them) and the engine-specific SQL lives in
//! `crate::engines::*` adapters behind the `EngineConnection` port.
//!
//! Cross-feature note: open connection handles are owned by the connections
//! feature's `ConnectionManager`. This slice consumes it at the application
//! layer (and its commands read `ConnectionsState`) — application-level
//! composition over another feature's public application API, the same way
//! commands access managed state. That keeps the layering rule intact:
//! domain ← application ← (infrastructure | commands), with dependencies
//! still pointing left within each slice.
//!
//! The older introspection surface (`connection_schemas` /
//! `connection_tables`) still lives in the connections feature; NEW
//! introspection surface lands here, and consolidating the old commands is
//! deferred.

pub mod application;
pub mod commands;
