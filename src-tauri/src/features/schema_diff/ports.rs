//! Ports: the read boundary the schema-diff use-cases need.
//!
//! One port, one direction: **read**. A [`SchemaReader`] hands back the
//! structure of a schema and nothing else — no rows, no counts, no sampling —
//! so "structure only, row data is never read" is a property of the boundary
//! rather than a promise made by each caller.
//!
//! Applying a migration deliberately does NOT go through a port here: it runs
//! the generated DDL through the connection the target already owns (see
//! `application::apply_migration`), reusing the engines' script path so the
//! statements land in one transaction where the engine supports DDL
//! transactions.

use async_trait::async_trait;

use crate::shared::error::AppError;

use super::domain::SchemaSnapshot;

/// Reads one schema's structure (tables → columns + indexes).
///
/// `Send + Sync`: the adapter wraps a shared open connection and is used from
/// Tauri's async command invocations.
#[async_trait]
pub trait SchemaReader: Send + Sync {
    /// The structural snapshot of `schema`: every base table with its columns
    /// and indexes. Views and materialized views are excluded — they carry no
    /// structure a migration can reconcile, and the prototype skips them too.
    async fn read_schema(&self, schema: &str) -> Result<SchemaSnapshot, AppError>;
}
