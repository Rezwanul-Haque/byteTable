//! Key-value slice (M13 Redis backend): the keyspace browse + CLI surface as
//! its own vertical feature, mirroring the SQL `introspection` / `browse`
//! slices but over the key-value port family ([`crate::shared::keyvalue`])
//! instead of [`crate::shared::engine::EngineConnection`].
//!
//! Like `introspection`, the slice is deliberately thin: no domain or
//! infrastructure of its own — the wire DTOs live in `crate::shared::keyvalue`
//! and the engine-specific Redis work lives in `crate::engines::redis` behind
//! the key-value port traits.
//!
//! Cross-feature note: open connection handles are owned by the connections
//! feature's `ConnectionManager`. This slice consumes its `get_kv` accessor at
//! the application layer (and its commands read `ConnectionsState`) — the same
//! application-level composition the SQL introspection slice uses, keeping the
//! layering rule intact (domain ← application ← (infrastructure | commands)).
//! `get_kv` returns a §5 error if the handle holds a SQL connection, so a Redis
//! command can never reach a relational connection.

pub mod application;
pub mod commands;
