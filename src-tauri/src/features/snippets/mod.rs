//! Snippets slice: a GLOBAL library of reusable SQL fragments with tab-stop
//! placeholders, expanded into the editor at the caret.
//!
//! Deliberately NOT part of the saved-queries slice, even though the two look
//! similar from a distance. A saved query is a whole buffer you LOAD and run; a
//! snippet is a fragment you INSERT mid-typing, it has an abbreviation that
//! triggers it from autocomplete, and its `#{1:table}` placeholders are
//! editor tab stops resolved at insert time — none of which a saved query
//! wants, and all of which would have to be nullable fields on it. Different
//! lifecycle, different store.
//!
//! (Not to be confused with query PARAMETERS, which resolve at RUN time and
//! belong to saved queries — see the `saved_queries` slice.)
//!
//! Layering (dependencies point left): domain ← application ← (infrastructure | commands).
//!
//! Like saved queries, the backing store is a small local JSON file so the
//! persistence port is *sync*, the commands are still `async fn` for
//! consistency, and the corrupt-file policy is the user-data one: a parse
//! error is an ERROR, never a silent reset that would throw someone's snippet
//! library away.

pub mod application;
pub mod commands;
pub mod domain;
pub mod infrastructure;
pub mod ports;
