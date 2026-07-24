//! Processes slice (M26): the live server session / operation / client list and
//! the per-row / bulk **kill** action, across the server engines (Postgres,
//! MySQL, SQL Server, ClickHouse), Redis, and MongoDB.
//!
//! Layering (per ARCHITECTURE): the slice owns no domain of its own — listing
//! and killing are engine-specific and live in `crate::engines::*` behind the
//! [`crate::shared::process::ProcessReader`] port. The application layer consumes
//! the connections feature's `ConnectionManager` (the same cross-feature
//! composition as introspection/structure); commands read `ConnectionsState`.

pub mod application;
pub mod commands;
