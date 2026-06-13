//! Insights slice: per-column statistics over the current filtered set (M10
//! "column insights", DESIGN_SPEC §3.5) — distinct/null counts, min/max, avg
//! for numerics, and the top-5 most frequent values. ARCHITECTURE names this
//! feature ("Column statistics", command `column_stats`).
//!
//! Like introspection and browse, this slice is deliberately thin: no domain
//! or infrastructure of its own. The wire DTOs (`ColumnStatsRequest`,
//! `ColumnStats`, `FreqEntry`) live in `crate::shared::engine` — shared by
//! every slice that talks to a connection — and the engine-specific SQL lives
//! in `crate::engines::*` adapters behind the `EngineConnection` port. The
//! stats reuse the adapter's existing `where_clause` filter compilation so the
//! insights match the grid's visible filtered set.
//!
//! Cross-feature note: open connection handles are owned by the connections
//! feature's `ConnectionManager`. This slice consumes it at the application
//! layer (and its commands read `ConnectionsState`) — application-level
//! composition over another feature's public application API, the same pattern
//! introspection and browse use. The layering rule holds: domain ←
//! application ← (infrastructure | commands), dependencies pointing left
//! within each slice.

pub mod application;
pub mod commands;
