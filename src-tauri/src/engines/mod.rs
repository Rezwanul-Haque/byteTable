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
//! `engines::mysql` and `engines::postgres` arrive in M12.

pub mod sqlite;
