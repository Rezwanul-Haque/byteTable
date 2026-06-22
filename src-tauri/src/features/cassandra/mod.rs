//! Cassandra slice (M19 backend): the keyspace/table browse, CQL-correct query,
//! wide-column CRUD, structure (indexes/MVs), cqlsh, create flows, and
//! export/import surface as its own vertical feature, mirroring the MongoDB slice
//! but over the wide-column port family ([`crate::shared::widecolumn`]).
//!
//! Like the other NoSQL slices, this is deliberately thin: no domain or
//! infrastructure of its own — the wire DTOs live in `crate::shared::widecolumn`
//! and the engine-specific driver work lives in `crate::engines::cassandra`
//! behind the wide-column port traits.
//!
//! Cross-feature note: open connection handles are owned by the connections
//! feature's `ConnectionManager`. This slice consumes its `get_wide_column`
//! accessor at the application layer (and its commands read `ConnectionsState`).
//! `get_wide_column` returns a §5 error if the handle holds a SQL, key-value,
//! DynamoDB, or MongoDB connection, so a Cassandra command can never reach the
//! wrong connection.

pub mod application;
pub mod commands;
