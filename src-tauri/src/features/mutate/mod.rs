//! Mutate slice: single-cell UPDATE for M11 inline editing (DESIGN_SPEC §3.5).
//! ARCHITECTURE names this feature ("Cell updates, future insert/delete",
//! command `row_update`).
//!
//! Like browse and insights, this slice is deliberately thin: no domain or
//! infrastructure of its own. The wire DTOs (`UpdateCellRequest`,
//! `PkPredicate`, `UpdateResult`) live in `crate::shared::engine` — shared by
//! every slice that talks to a connection — and the engine-specific SQL lives
//! in `crate::engines::*` adapters behind the `EngineConnection` port.
//!
//! Safety: this is the one slice (so far) that MUTATES user data. The mutation
//! safety contract — parameterized binding of the new value AND the pk
//! predicate values, full-primary-key targeting (mass-update prevention), and
//! the transactional affected-count guard — is enforced in the adapter (see
//! `EngineConnection::update_cell`). This slice only routes the request.
//!
//! Cross-feature note: open connection handles are owned by the connections
//! feature's `ConnectionManager`. This slice consumes it at the application
//! layer (and its commands read `ConnectionsState`) — application-level
//! composition over another feature's public application API, the same pattern
//! browse and insights use. The layering rule holds: domain ← application ←
//! (infrastructure | commands), dependencies pointing left within each slice.

pub mod application;
pub mod commands;
