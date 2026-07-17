//! Engine **port families** — the trait + DTO contracts each engine kind
//! exposes to the slices, one family per fundamentally-different engine shape.
//! Adapters in `crate::engines::*` implement these; `features::*` slices call
//! through them (ports-and-adapters). The families do NOT share an operation
//! surface, so each is its own module rather than one bloated trait:
//!
//! - [`sql`]        — relational SQL (SQLite / MySQL / Postgres), `EngineConnection`
//! - [`keyvalue`]   — Redis keyspace, `KeyValueConnection`
//! - [`document`]   — DynamoDB items, `DocumentStoreConnection`
//! - [`mongo`]      — MongoDB documents, `MongoConnection`
//! - [`widecolumn`] — Cassandra wide-column, `WideColumnConnection`
//!
//! `shared` re-exports each at its historical path (`crate::shared::engine` =
//! [`sql`], `crate::shared::keyvalue`, …) so the grouping is physical only.

pub mod document;
pub mod keyvalue;
pub mod mongo;
pub mod sql;
pub mod widecolumn;

use std::sync::Arc;

use serde::{Deserialize, Serialize};

use document::DocumentStoreConnection;
use keyvalue::KeyValueConnection;
use sql::{EngineConnection, EngineInfo};

/// What a [`Connector::open`] yields: a live connection of one of the two
/// engine *kinds* ByteTable supports (M13 connection-kind seam).
///
/// ByteTable has two fundamentally different engine families that do NOT share
/// an operation surface:
/// - **SQL** (`Sqlite`/`Mysql`/`Postgres`) — relational; implements
///   [`EngineConnection`] (schemas, tables, queries, rows, ALTERs, …).
/// - **Key-value** (`Redis`, M13) — a keyspace; implements
///   [`KeyValueConnection`] (scan, typed reads/writes, raw commands).
///
/// Forcing Redis into [`EngineConnection`] would litter it with `Unsupported`
/// stubs and lie about its shape, so the two are distinct traits. This enum is
/// the single seam that lets the [`crate::features::connections::application::ConnectionManager`]
/// store either behind one [`crate::features::connections::application::ConnectionHandleId`].
/// The manager's `get_sql` / `get_kv` accessors return a §5 "not available for
/// this engine" error on a kind mismatch, so a SQL command can never reach a
/// Redis connection or vice-versa.
///
/// Both arms hold an `Arc` so the manager hands out cheap clones and drops its
/// lock before awaiting driver work (matching the M2 manager contract).
pub enum OpenConnection {
    /// A relational SQL connection (`Sqlite`/`Mysql`/`Postgres`).
    Sql(Arc<dyn EngineConnection>),
    /// A key-value connection (`Redis`, M13).
    Kv(Arc<dyn KeyValueConnection>),
    /// A document-store connection (`Dynamodb`, M17).
    Document(Arc<dyn DocumentStoreConnection>),
    /// A MongoDB connection (`Mongodb`, M18).
    Mongo(Arc<dyn crate::shared::mongo::MongoConnection>),
    /// A Cassandra wide-column connection (`Cassandra`, M19).
    WideColumn(Arc<dyn crate::shared::widecolumn::WideColumnConnection>),
}

impl OpenConnection {
    /// The engine family discriminator (`"sql"` / `"kv"` / `"document"`) —
    /// surfaced to the renderer in the open-result so it can route to the right
    /// workspace.
    pub fn kind(&self) -> ConnectionKind {
        match self {
            Self::Sql(_) => ConnectionKind::Sql,
            Self::Kv(_) => ConnectionKind::Kv,
            Self::Document(_) => ConnectionKind::Document,
            Self::Mongo(_) => ConnectionKind::Mongo,
            Self::WideColumn(_) => ConnectionKind::WideColumn,
        }
    }

    /// The engine + version of the open connection, whichever kind it is.
    pub fn engine_info(&self) -> EngineInfo {
        match self {
            Self::Sql(c) => c.engine_info(),
            Self::Kv(c) => c.engine_info(),
            Self::Document(c) => c.engine_info(),
            Self::Mongo(c) => c.engine_info(),
            Self::WideColumn(c) => c.engine_info(),
        }
    }

    /// Wrap a SQL connection. Connectors and tests use this so the `Arc`
    /// boxing of a concrete [`EngineConnection`] lives in one place.
    pub fn sql(connection: impl EngineConnection + 'static) -> Self {
        Self::Sql(Arc::new(connection))
    }

    /// Wrap a key-value connection (the `engines::redis` adapter).
    pub fn kv(connection: impl KeyValueConnection + 'static) -> Self {
        Self::Kv(Arc::new(connection))
    }

    /// Wrap a document-store connection (the `engines::dynamo` adapter).
    pub fn document(connection: impl DocumentStoreConnection + 'static) -> Self {
        Self::Document(Arc::new(connection))
    }

    /// Wrap a MongoDB connection (the `engines::mongo` adapter).
    pub fn mongo(connection: impl crate::shared::mongo::MongoConnection + 'static) -> Self {
        Self::Mongo(Arc::new(connection))
    }

    /// Wrap a Cassandra wide-column connection (the `engines::cassandra` adapter).
    pub fn wide_column(
        connection: impl crate::shared::widecolumn::WideColumnConnection + 'static,
    ) -> Self {
        Self::WideColumn(Arc::new(connection))
    }

    /// The SQL connection, consuming the enum, or `None` for a key-value one.
    /// Used by the SQL adapters' own tests, which open a connector and then
    /// exercise the [`EngineConnection`] surface directly.
    pub fn into_sql(self) -> Option<Arc<dyn EngineConnection>> {
        match self {
            Self::Sql(c) => Some(c),
            Self::Kv(_) | Self::Document(_) | Self::Mongo(_) | Self::WideColumn(_) => None,
        }
    }

    /// The key-value connection, consuming the enum, or `None` otherwise. Used
    /// by the `engines::redis` integration tests.
    pub fn into_kv(self) -> Option<Arc<dyn KeyValueConnection>> {
        match self {
            Self::Kv(c) => Some(c),
            Self::Sql(_) | Self::Document(_) | Self::Mongo(_) | Self::WideColumn(_) => None,
        }
    }

    /// The document-store connection, consuming the enum, or `None` otherwise.
    /// Used by the `engines::dynamo` integration tests.
    pub fn into_document(self) -> Option<Arc<dyn DocumentStoreConnection>> {
        match self {
            Self::Document(c) => Some(c),
            Self::Sql(_) | Self::Kv(_) | Self::Mongo(_) | Self::WideColumn(_) => None,
        }
    }

    /// The MongoDB connection, consuming the enum, or `None` otherwise. Used by
    /// the `engines::mongo` integration tests.
    pub fn into_mongo(self) -> Option<Arc<dyn crate::shared::mongo::MongoConnection>> {
        match self {
            Self::Mongo(c) => Some(c),
            Self::Sql(_) | Self::Kv(_) | Self::Document(_) | Self::WideColumn(_) => None,
        }
    }

    /// The Cassandra wide-column connection, consuming the enum, or `None`
    /// otherwise. Used by the `engines::cassandra` integration tests.
    pub fn into_wide_column(
        self,
    ) -> Option<Arc<dyn crate::shared::widecolumn::WideColumnConnection>> {
        match self {
            Self::WideColumn(c) => Some(c),
            Self::Sql(_) | Self::Kv(_) | Self::Document(_) | Self::Mongo(_) => None,
        }
    }
}

/// The engine *family* of an open connection — the discriminator the renderer
/// routes on (`redis` → the key-value workspace, the rest → the relational
/// one). Lowercase on the wire (`"sql"` / `"kv"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionKind {
    Sql,
    Kv,
    /// A document store (`Dynamodb`, M17) → the DynamoDB workspace.
    Document,
    /// A MongoDB connection (M18) → the MongoDB workspace.
    Mongo,
    /// A Cassandra wide-column connection (M19) → the Cassandra workspace. The
    /// wire token is `"cassandra"` (not the family name) so the renderer routes
    /// on the engine the user recognises, matching MILESTONE_19 §19.0.
    #[serde(rename = "cassandra")]
    WideColumn,
}
