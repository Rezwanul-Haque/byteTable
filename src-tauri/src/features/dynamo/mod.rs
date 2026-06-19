//! DynamoDB slice (M17 backend): the table/item browse, query, item editing,
//! PartiQL, and export/import surface as its own vertical feature, mirroring the
//! key-value (Redis) slice but over the document port family
//! ([`crate::shared::document`]) instead of [`crate::shared::keyvalue`].
//!
//! Like the key-value slice, this is deliberately thin: no domain or
//! infrastructure of its own — the wire DTOs live in `crate::shared::document`
//! and the engine-specific AWS SDK work lives in `crate::engines::dynamo` behind
//! the document port traits.
//!
//! Cross-feature note: open connection handles are owned by the connections
//! feature's `ConnectionManager`. This slice consumes its `get_document`
//! accessor at the application layer (and its commands read `ConnectionsState`),
//! the same application-level composition the other browse slices use.
//! `get_document` returns a §5 error if the handle holds a SQL or key-value
//! connection, so a DynamoDB command can never reach the wrong connection.

pub mod application;
pub mod commands;
