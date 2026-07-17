//! Engine abstraction: the port traits every database engine adapter
//! implements. Slices depend only on these traits; engine-specific SQL and
//! drivers live exclusively in adapter modules under `crate::engines`
//! (`engines::sqlite` today; `engines::mysql` / `engines::postgres` in M12).
//!
//! M2 note: the original `SchemaReader` / `QueryExecutor` stub traits were
//! folded into [`EngineConnection`] — introspection and query execution are
//! operations *on an open connection*, so one object owning the driver
//! handle is the natural seam. [`DdlDialect`] remains a stub until M8/M14.
//!
//! # Async commands rule
//!
//! Any slice that touches a database MUST expose `async fn` Tauri commands
//! and these port traits are async (`async_trait`). Sync commands run on the
//! main thread, so a slow query or connection attempt would freeze the
//! entire UI for its duration.
//!
//! Driver caveats:
//! - `rusqlite` is synchronous and its `Connection` is `!Sync` — the SQLite
//!   adapter wraps it in `Arc<std::sync::Mutex<…>>` and hops every operation
//!   through `tokio::task::spawn_blocking` so async executor threads never
//!   block (Tauri's async runtime *is* tokio).
//! - `sqlx` (MySQL/Postgres, M12) is natively async and can be awaited
//!   directly.
//!
//! The preferences slice is the one deliberate exception: it stays sync
//! because it only reads/writes a tiny local JSON file (see
//! `features::preferences`). Do not copy its sync commands into DB-touching
//! slices.

mod binary;
mod conn;
mod meta;
mod mutate;
mod params;
mod query;
mod script;

pub use binary::*;
pub use conn::*;
pub use meta::*;
pub use mutate::*;
pub use params::*;
pub use query::*;
pub use script::*;

// The cross-family `OpenConnection` seam lives on the neutral `ports` parent
// (it references every engine family). Re-exported here so the historical
// `crate::shared::engine::OpenConnection` path — and this module's own
// `Connector::open` return type — keep resolving.
pub use super::{ConnectionKind, OpenConnection};

/// serde `skip_serializing_if` helper: omit a `false` flag from the wire so
/// boolean flags only appear when set, keeping the JSON clean and the
/// wire-shape tests stable. Shared by the metadata / query / mutate types, so
/// it lives on the parent module and each submodule picks it up via `super::*`.
#[allow(clippy::trivially_copy_pass_by_ref)]
pub(crate) fn is_false(b: &bool) -> bool {
    !*b
}

#[cfg(test)]
mod tests;
