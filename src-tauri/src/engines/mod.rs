//! Engine adapters: the infrastructure implementations of the port traits
//! in `crate::shared::engine` (per ARCHITECTURE.md, "each engine implements
//! them as an infrastructure crate/module").
//!
//! Location note: these live at the crate root (not inside `shared/`) so
//! `shared/` stays a pure, driver-free kernel — the dependency direction is
//! `engines → shared`, never the reverse. Feature slices never import from
//! here; only the composition root (`lib.rs`) does, to register connectors.
//!
//! ALL engine-specific SQL (introspection queries, identifier quoting,
//! error-message vocabularies) lives exclusively in these modules.
//! `engines::postgres` (M12 Task 1) and `engines::mysql` (M12 Task 2) join the
//! original `engines::sqlite`.

pub mod dynamo;
pub mod mysql;
pub mod postgres;
pub mod redis;
pub mod sqlite;
pub mod ssh;
