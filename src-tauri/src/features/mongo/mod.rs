//! MongoDB slice (M18 backend): the database/collection browse, find, document
//! editing, aggregation, explain/structure, mongosh, and export/import surface
//! as its own vertical feature, mirroring the DynamoDB slice but over the
//! MongoDB port family ([`crate::shared::mongo`]) instead of
//! [`crate::shared::document`].
//!
//! Like the other NoSQL slices, this is deliberately thin: no domain or
//! infrastructure of its own — the wire DTOs live in `crate::shared::mongo` and
//! the engine-specific driver work lives in `crate::engines::mongo` behind the
//! MongoDB port traits.
//!
//! Cross-feature note: open connection handles are owned by the connections
//! feature's `ConnectionManager`. This slice consumes its `get_mongo` accessor
//! at the application layer (and its commands read `ConnectionsState`), the same
//! application-level composition the other browse slices use. `get_mongo`
//! returns a §5 error if the handle holds a SQL, key-value, or DynamoDB
//! connection, so a MongoDB command can never reach the wrong connection.

pub mod application;
pub mod commands;
