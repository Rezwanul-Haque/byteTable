//! Search slice (M30 backend): the Typesense cluster dashboard, schema and
//! document browse, search playground, curation/keys views and HTTP console as
//! its own vertical feature, over the search port family
//! ([`crate::shared::search`]).
//!
//! Like the other NoSQL slices, this is deliberately thin: no domain or
//! infrastructure of its own — the wire DTOs live in `crate::shared::search` and
//! the engine-specific HTTP work lives in `crate::engines::typesense` behind the
//! search port traits.
//!
//! Named for the *family*, not the engine (`search`, not `typesense`), matching
//! `keyvalue` and `cassandra`'s precedent of slicing by capability: a second
//! search engine would implement the same ports and reuse this slice whole.
//!
//! Cross-feature note: open connection handles are owned by the connections
//! feature's `ConnectionManager`. This slice consumes its `get_search` accessor
//! at the application layer (and its commands read `ConnectionsState`), the same
//! application-level composition the other browse slices use. `get_search`
//! returns a §5 error if the handle holds a connection of any other family, so a
//! search command can never reach the wrong connection.

pub mod application;
pub mod commands;
