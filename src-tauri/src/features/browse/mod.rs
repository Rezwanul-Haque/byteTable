//! Browse slice: paged, sorted row fetch for the M4 data grid
//! (DESIGN_SPEC §3.5). A page-wise `LIMIT`/`OFFSET` fetch with a single
//! optional `ORDER BY` and an exact unfiltered `COUNT(*)` for the "N rows"
//! status. Row filtering is M5 — there is no predicate surface yet.
//!
//! Like the introspection slice, this is deliberately thin: no domain or
//! infrastructure of its own. The wire DTOs (`FetchRowsRequest`,
//! `RowsPage`, …) live in `crate::shared::engine` — shared by every slice
//! that talks to a connection — and the engine-specific SQL lives in
//! `crate::engines::*` adapters behind the `EngineConnection` port.
//!
//! Cross-feature note: open connection handles are owned by the connections
//! feature's `ConnectionManager`. This slice consumes it at the application
//! layer (and its commands read `ConnectionsState`) — application-level
//! composition over another feature's public application API, the same
//! pattern introspection uses. The layering rule holds: domain ←
//! application ← (infrastructure | commands), dependencies pointing left
//! within each slice.

pub mod application;
pub mod commands;
