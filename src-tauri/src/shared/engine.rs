//! Engine abstraction: the port traits every database engine adapter will
//! implement in later milestones (M5+). Slices depend only on these traits;
//! engine-specific SQL and drivers live exclusively in infrastructure
//! adapters (`engine_sqlite`, `engine_mysql`, `engine_postgres`).
//!
//! These are intentionally stubs in M0 — they exist so the dependency shape
//! is fixed from the start. Method sets are filled in by the milestones that
//! need them.
//!
//! # Async commands rule
//!
//! Any slice that touches a database MUST expose `async fn` Tauri commands
//! and define its port traits as async. Sync commands run on the main
//! thread, so a slow query or connection attempt would freeze the entire UI
//! for its duration. When these traits grow methods, they grow *async*
//! methods.
//!
//! Driver caveats:
//! - `rusqlite` is synchronous — adapters must wrap calls in
//!   `tauri::async_runtime::spawn_blocking` (or an equivalent blocking-pool
//!   hop) so the async command never blocks an executor thread.
//! - `sqlx` (MySQL/Postgres) is natively async and can be awaited directly.
//!
//! The preferences slice is the one deliberate exception: it stays sync
//! because it only reads/writes a tiny local JSON file (see
//! `slices::preferences`). Do not copy its sync commands into DB-touching
//! slices.

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
