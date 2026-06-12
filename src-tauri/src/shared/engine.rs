//! Engine abstraction: the port traits every database engine adapter will
//! implement in later milestones (M5+). Slices depend only on these traits;
//! engine-specific SQL and drivers live exclusively in infrastructure
//! adapters (`engine_sqlite`, `engine_mysql`, `engine_postgres`).
//!
//! These are intentionally stubs in M0 — they exist so the dependency shape
//! is fixed from the start. Method sets are filled in by the milestones that
//! need them.

/// Database engines ByteTable supports.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Engine {
    Sqlite,
    Mysql,
    Postgres,
}

/// Opens, tests, and closes connections for one engine (M5, M12).
///
/// Will grow methods such as `connect`, `test`, and `close`; the renderer
/// only ever sees opaque connection ids, never driver handles.
pub trait Connector {}

/// Introspects schemas, tables, columns, indexes, and foreign keys (M6).
pub trait SchemaReader {}

/// Executes SQL with parameter binding, timing, and cancellation (M7).
pub trait QueryExecutor {}

/// Generates engine-specific DDL: ALTER dialects, identifier quoting,
/// type mappings (M14).
pub trait DdlDialect {}
